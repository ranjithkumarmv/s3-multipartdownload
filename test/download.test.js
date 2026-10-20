const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { Readable } = require('stream')
const { HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3')
const { download, getRanges } = require('../index')

// Minimal stand-in for S3Client.send serving `data` with Range support.
function mockClient(data, { failRange, failTimes = 0, etag = '"abc"', chunk = 1000 } = {}) {
    const calls = []
    let inFlight = 0
    let maxInFlight = 0
    const failures = new Map()
    return {
        calls,
        get maxInFlight() { return maxInFlight },
        async send(command) {
            calls.push(command)
            if (command instanceof HeadObjectCommand) {
                return { ContentLength: data.length, ETag: etag }
            }
            assert.ok(command instanceof GetObjectCommand)
            const { Range, IfMatch } = command.input
            assert.strictEqual(IfMatch, etag)
            const [, s, e] = /^bytes=(\d+)-(\d+)$/.exec(Range)
            const body = data.subarray(Number(s), Number(e) + 1)
            inFlight++
            maxInFlight = Math.max(maxInFlight, inFlight)
            await new Promise(r => setImmediate(r))
            const n = failures.get(Range) || 0
            if (Range === failRange && n < failTimes) {
                failures.set(Range, n + 1)
                inFlight--
                // Stream half the part, then error mid-body.
                return {
                    Body: Readable.from((async function* () {
                        yield body.subarray(0, body.length >> 1)
                        throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
                    })())
                }
            }
            inFlight--
            return {
                Body: Readable.from((function* () {
                    for (let i = 0; i < body.length; i += chunk) yield body.subarray(i, i + chunk)
                })())
            }
        }
    }
}

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 's3mpd-'))
}

test('getRanges covers every byte exactly once', () => {
    assert.deepStrictEqual(getRanges(0, 10), [])
    assert.deepStrictEqual(getRanges(1, 10), [[0, 0]])
    assert.deepStrictEqual(getRanges(10, 10), [[0, 9]])
    assert.deepStrictEqual(getRanges(25, 10), [[0, 9], [10, 19], [20, 24]])
})

test('downloads the object byte-for-byte in parallel', async () => {
    const data = crypto.randomBytes(100_003)
    const client = mockClient(data)
    const dir = path.join(tmpDir(), 'nested', 'dir') // must be created
    const progress = []
    const out = await download(client, { Bucket: 'b', Key: 'a/b/file.bin' }, {
        download_dir: dir,
        part_size: 10_000,
        parallel_count: 4,
        onProgress: p => progress.push(p.downloadedBytes)
    })
    assert.strictEqual(out, path.join(dir, 'file.bin'))
    assert.ok(fs.readFileSync(out).equals(data))
    assert.ok(!fs.existsSync(out + '.download'))
    assert.strictEqual(client.calls.length, 1 + 11)
    assert.ok(client.maxInFlight <= 4)
    assert.strictEqual(progress.at(-1), data.length)
})

test('does not mutate caller params or forward a caller Range', async () => {
    const data = crypto.randomBytes(5000)
    const client = mockClient(data)
    const params = { Bucket: 'b', Key: 'k', Range: 'bytes=0-1' }
    const out = await download(client, params, { download_dir: tmpDir(), part_size: 1000 })
    assert.deepStrictEqual(params, { Bucket: 'b', Key: 'k', Range: 'bytes=0-1' })
    assert.ok(fs.readFileSync(out).equals(data))
})

test('handles empty objects and objects smaller than parallel_count', async () => {
    const dir = tmpDir()
    const empty = await download(mockClient(Buffer.alloc(0)), { Bucket: 'b', Key: 'empty' }, { download_dir: dir })
    assert.strictEqual(fs.statSync(empty).size, 0)
    const tiny = Buffer.from('hi')
    const small = await download(mockClient(tiny), { Bucket: 'b', Key: 'tiny' }, { download_dir: dir, parallel_count: 8, part_size: 1 })
    assert.ok(fs.readFileSync(small).equals(tiny))
})

test('retries a part that fails mid-stream and keeps progress accurate', async () => {
    const data = crypto.randomBytes(30_000)
    const client = mockClient(data, { failRange: 'bytes=10000-19999', failTimes: 2 })
    let last
    const out = await download(client, { Bucket: 'b', Key: 'k' }, {
        download_dir: tmpDir(), part_size: 10_000, onProgress: p => { last = p.downloadedBytes }
    })
    assert.ok(fs.readFileSync(out).equals(data))
    assert.strictEqual(last, data.length)
})

test('fails after retries are exhausted and leaves no files behind', async () => {
    const data = crypto.randomBytes(30_000)
    const client = mockClient(data, { failRange: 'bytes=10000-19999', failTimes: 5 })
    const dir = tmpDir()
    await assert.rejects(
        download(client, { Bucket: 'b', Key: 'k' }, { download_dir: dir, part_size: 10_000, retries: 1 }),
        /socket reset/)
    assert.deepStrictEqual(fs.readdirSync(dir), [])
})

test('does not retry client errors such as 412 Precondition Failed', async () => {
    let gets = 0
    const client = {
        async send(command) {
            if (command instanceof HeadObjectCommand) return { ContentLength: 10, ETag: '"x"' }
            gets++
            throw Object.assign(new Error('PreconditionFailed'), { $metadata: { httpStatusCode: 412 } })
        }
    }
    await assert.rejects(download(client, { Bucket: 'b', Key: 'k' }, { download_dir: tmpDir() }), /PreconditionFailed/)
    assert.strictEqual(gets, 1)
})

test('honours an AbortSignal', async () => {
    const ac = new AbortController()
    ac.abort()
    const client = mockClient(crypto.randomBytes(1000))
    const dir = tmpDir()
    await assert.rejects(
        download(client, { Bucket: 'b', Key: 'k' }, { download_dir: dir, part_size: 100, abortSignal: ac.signal }),
        { name: 'AbortError' })
    assert.deepStrictEqual(fs.readdirSync(dir), [])
})

test('validates arguments', async () => {
    await assert.rejects(download({}, { Bucket: 'b', Key: 'k' }), TypeError)
    await assert.rejects(download(mockClient(Buffer.alloc(1)), { Bucket: 'b' }), TypeError)
    await assert.rejects(download(mockClient(Buffer.alloc(1)), { Bucket: 'b', Key: 'k' }, { parallel_count: 0 }), TypeError)
})
