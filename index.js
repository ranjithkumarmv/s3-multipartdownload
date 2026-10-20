const fs = require('fs')
const path = require('path')
const { Transform } = require('stream')
const { pipeline } = require('stream/promises')
const { HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3')

const DEFAULT_PART_SIZE = 8 * 1024 * 1024
const DEFAULT_PARALLEL_COUNT = 3
const DEFAULT_RETRIES = 3

/**
 * Download an S3 object by fetching byte ranges in parallel and streaming
 * each range straight into its offset of the output file.
 *
 * @param {import('@aws-sdk/client-s3').S3Client} s3Client
 * @param {{ Bucket: string, Key: string, [k: string]: any }} s3Params
 *   Any HeadObject/GetObject params (VersionId, SSECustomer*, RequestPayer...).
 * @param {object} [options]
 * @param {string} [options.download_dir="."] directory for the output file
 * @param {string} [options.file_name] output file name (defaults to the key's basename)
 * @param {number} [options.parallel_count=3] max concurrent range requests
 * @param {number} [options.part_size=8MiB] bytes per range request
 * @param {number} [options.retries=3] extra attempts per part on failure
 * @param {AbortSignal} [options.abortSignal] cancels the download
 * @param {(p: { downloadedBytes: number, totalBytes: number }) => void} [options.onProgress]
 * @returns {Promise<string>} path of the downloaded file
 */
async function download(s3Client, s3Params, options = {}) {
    if (!s3Client || typeof s3Client.send !== 'function') {
        throw new TypeError('s3Client must be an AWS SDK v3 S3Client')
    }
    if (!s3Params || !s3Params.Bucket || !s3Params.Key) {
        throw new TypeError('s3Params.Bucket and s3Params.Key are required')
    }

    const parallelCount = positiveInt(options.parallel_count, DEFAULT_PARALLEL_COUNT, 'parallel_count')
    const partSize = positiveInt(options.part_size, DEFAULT_PART_SIZE, 'part_size')
    const retries = options.retries === undefined ? DEFAULT_RETRIES : options.retries
    if (!Number.isInteger(retries) || retries < 0) {
        throw new TypeError('options.retries must be a non-negative integer')
    }
    const { abortSignal, onProgress } = options

    // Never let a caller-supplied Range leak into our requests.
    const { Range, ...baseParams } = s3Params

    const head = await s3Client.send(new HeadObjectCommand(baseParams), { abortSignal })
    const totalBytes = head.ContentLength
    if (!Number.isInteger(totalBytes) || totalBytes < 0) {
        throw new Error('HeadObject did not return a valid ContentLength')
    }

    const downloadDir = options.download_dir || '.'
    const fileName = options.file_name || path.basename(baseParams.Key)
    if (!fileName) throw new Error(`Cannot derive a file name from key "${baseParams.Key}"`)
    await fs.promises.mkdir(downloadDir, { recursive: true })
    const outputPath = path.join(downloadDir, fileName)
    const tempPath = outputPath + '.download'

    // Pre-size the temp file so every part can write at its own offset.
    const handle = await fs.promises.open(tempPath, 'w')
    try {
        await handle.truncate(totalBytes)
    } finally {
        await handle.close()
    }

    let downloadedBytes = 0
    const report = delta => {
        downloadedBytes += delta
        if (onProgress) onProgress({ downloadedBytes, totalBytes })
    }

    const ranges = getRanges(totalBytes, partSize)
    // IfMatch pins every part to the version we sized the file from.
    const getParams = head.ETag ? { ...baseParams, IfMatch: head.ETag } : baseParams

    // Aborts in-flight parts when one part fails or the caller aborts.
    const internal = new AbortController()
    const signal = abortSignal ? AbortSignal.any([abortSignal, internal.signal]) : internal.signal

    try {
        await runPool(ranges, parallelCount, range =>
            downloadPart(s3Client, getParams, range, tempPath, { retries, abortSignal: signal, report }),
            () => internal.abort())
        await fs.promises.rename(tempPath, outputPath)
    } catch (err) {
        await fs.promises.rm(tempPath, { force: true })
        throw err
    }
    return outputPath
}

async function downloadPart(s3Client, params, [start, end], filePath, { retries, abortSignal, report }) {
    for (let attempt = 0; ; attempt++) {
        let written = 0
        try {
            const res = await s3Client.send(
                new GetObjectCommand({ ...params, Range: `bytes=${start}-${end}` }),
                { abortSignal })
            const counter = new Transform({
                transform(chunk, _enc, cb) {
                    written += chunk.length
                    report(chunk.length)
                    cb(null, chunk)
                }
            })
            await pipeline(
                res.Body,
                counter,
                fs.createWriteStream(filePath, { flags: 'r+', start }),
                { signal: abortSignal })
            const expected = end - start + 1
            if (written !== expected) {
                throw new Error(`Part bytes=${start}-${end} returned ${written} bytes, expected ${expected}`)
            }
            return
        } catch (err) {
            // Roll back progress from the failed attempt; it gets rewritten on retry.
            if (written) report(-written)
            if (attempt >= retries || !isRetryable(err, abortSignal)) throw err
            await sleep(Math.min(100 * 2 ** attempt, 2000))
        }
    }
}

function isRetryable(err, abortSignal) {
    if (abortSignal && abortSignal.aborted) return false
    if (err && err.name === 'AbortError') return false
    // 412 means the object changed mid-download; retrying would mix versions.
    const status = err && err.$metadata && err.$metadata.httpStatusCode
    if (status === 412 || (status >= 400 && status < 500 && status !== 408 && status !== 429)) return false
    return true
}

// Inclusive [start, end] byte ranges covering 0..totalBytes-1.
function getRanges(totalBytes, partSize) {
    const ranges = []
    for (let start = 0; start < totalBytes; start += partSize) {
        ranges.push([start, Math.min(start + partSize, totalBytes) - 1])
    }
    return ranges
}

// Run worker over items with at most `limit` in flight. On the first error,
// stop scheduling, call onFail, wait for in-flight work to settle, then throw it.
async function runPool(items, limit, worker, onFail) {
    let next = 0
    let firstError
    const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (firstError === undefined && next < items.length) {
            const item = items[next++]
            try {
                await worker(item)
            } catch (err) {
                if (firstError === undefined) {
                    firstError = err
                    onFail()
                }
            }
        }
    })
    await Promise.all(lanes)
    if (firstError !== undefined) throw firstError
}

function positiveInt(value, fallback, name) {
    if (value === undefined) return fallback
    if (!Number.isInteger(value) || value < 1) {
        throw new TypeError(`options.${name} must be a positive integer`)
    }
    return value
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

module.exports = { download, getRanges }
