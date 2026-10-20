#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const { parseArgs } = require('util')
const { download } = require('./index')
const { version } = require('./package.json')

const DEFAULT_CLI_PARALLEL = 8

const USAGE = `Usage: s3-multipartdownload <s3://bucket/key> [destination] [options]

Download one S3 object using parallel byte-range requests.

Destination:
  omitted                 save as ./<basename of key>
  existing dir, or ends /  save inside that directory
  anything else           save to exactly that file path

Options:
  -p, --parallel <n>      concurrent range requests (default ${DEFAULT_CLI_PARALLEL})
  -s, --part-size <size>  bytes per range: 8MiB, 16M, 1048576 (default 8MiB)
  -r, --retries <n>       extra attempts per part on network/5xx errors (default 3)
      --region <region>   AWS region (default: AWS_REGION or your profile)
      --profile <name>    named profile from ~/.aws/config
      --endpoint <url>    S3-compatible endpoint (MinIO, R2, Wasabi, ...)
      --path-style        use path-style URLs (needed by MinIO and some others)
      --no-sign-request   anonymous access, for public buckets
      --version-id <id>   download a specific object version
      --request-payer     acknowledge requester-pays charges
  -q, --quiet             no progress output
  -h, --help              show this help
  -v, --version           show the version

Prints the saved file path to stdout. Progress goes to stderr.

Examples:
  npx s3-multipartdownload s3://my-bucket/data/big.parquet
  npx s3-multipartdownload s3://my-bucket/video.mp4 ./downloads/ -p 16
  npx s3-multipartdownload s3://assets/build.tar.gz --endpoint http://localhost:9000 --path-style`

class UsageError extends Error {}

const OPTIONS = {
    parallel: { type: 'string', short: 'p' },
    'part-size': { type: 'string', short: 's' },
    retries: { type: 'string', short: 'r' },
    region: { type: 'string' },
    profile: { type: 'string' },
    endpoint: { type: 'string' },
    'path-style': { type: 'boolean' },
    'no-sign-request': { type: 'boolean' },
    'version-id': { type: 'string' },
    'request-payer': { type: 'boolean' },
    quiet: { type: 'boolean', short: 'q' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' }
}

/**
 * Run the CLI. Returns the process exit code instead of exiting, so tests can
 * call it directly with their own streams and client factory.
 */
async function main(argv, {
    stdout = process.stdout,
    stderr = process.stderr,
    createClient = defaultCreateClient,
    signal
} = {}) {
    let args
    try {
        args = parseCli(argv)
    } catch (err) {
        if (!(err instanceof UsageError) && err.code !== 'ERR_PARSE_ARGS_UNKNOWN_OPTION' &&
            err.code !== 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' &&
            err.code !== 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') throw err
        stderr.write(`error: ${err.message}\n\nRun with --help for usage.\n`)
        return 2
    }
    if (args.help) {
        stdout.write(USAGE + '\n')
        return 0
    }
    if (args.version) {
        stdout.write(version + '\n')
        return 0
    }

    const s3Params = { Bucket: args.bucket, Key: args.key }
    if (args.versionId) s3Params.VersionId = args.versionId
    if (args.requestPayer) s3Params.RequestPayer = 'requester'

    const progress = args.quiet || !stderr.isTTY ? null : progressPrinter(stderr)
    try {
        const file = await download(createClient(args), s3Params, {
            download_dir: args.downloadDir,
            file_name: args.fileName,
            parallel_count: args.parallel,
            part_size: args.partSize,
            retries: args.retries,
            abortSignal: signal,
            onProgress: progress && progress.update
        })
        if (progress) progress.done()
        stdout.write(file + '\n')
        return 0
    } catch (err) {
        if (progress) progress.done()
        if (signal && signal.aborted) {
            stderr.write('Cancelled.\n')
            return 130
        }
        stderr.write(`error: ${describeError(err, args)}\n`)
        return 1
    }
}

function parseCli(argv) {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
    if (values.help || values.version) return values
    if (positionals.length === 0) throw new UsageError('missing source, e.g. s3://my-bucket/path/to/file')
    if (positionals.length > 2) throw new UsageError(`unexpected argument "${positionals[2]}"`)

    const { bucket, key } = parseS3Url(positionals[0])
    const keyName = path.posix.basename(key)
    let downloadDir = '.'
    let fileName = keyName
    const dest = positionals[1]
    if (dest !== undefined) {
        if (/[\\/]$/.test(dest) || isDirectory(dest)) {
            downloadDir = dest
        } else {
            downloadDir = path.dirname(dest)
            fileName = path.basename(dest)
        }
    }

    return {
        bucket,
        key,
        downloadDir,
        fileName,
        parallel: intOption(values.parallel, '--parallel', 1, DEFAULT_CLI_PARALLEL),
        partSize: values['part-size'] === undefined ? undefined : parseSize(values['part-size']),
        retries: intOption(values.retries, '--retries', 0, undefined),
        region: values.region,
        profile: values.profile,
        endpoint: values.endpoint,
        pathStyle: !!values['path-style'],
        noSignRequest: !!values['no-sign-request'],
        versionId: values['version-id'],
        requestPayer: !!values['request-payer'],
        quiet: !!values.quiet
    }
}

function parseS3Url(url) {
    const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(url)
    if (!m) throw new UsageError(`source must look like s3://bucket/key, got "${url}"`)
    const [, bucket, key] = m
    if (key.endsWith('/')) {
        throw new UsageError(`"${url}" looks like a folder; this tool downloads a single object`)
    }
    return { bucket, key }
}

const SIZE_UNITS = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }

// Accepts plain bytes or a K/M/G suffix (binary units): 8MiB, 8M, 8mb, 16k.
function parseSize(text) {
    const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)(?:i?b)?$/i.exec(text.trim())
    const bytes = m && Math.floor(Number(m[1]) * SIZE_UNITS[m[2].toLowerCase()])
    if (!bytes || bytes < 1) throw new UsageError(`--part-size must be a size like 8MiB or 1048576, got "${text}"`)
    return bytes
}

function intOption(text, name, min, fallback) {
    if (text === undefined) return fallback
    const n = Number(text)
    if (!Number.isInteger(n) || n < min) {
        throw new UsageError(`${name} must be an integer >= ${min}, got "${text}"`)
    }
    return n
}

function isDirectory(p) {
    try {
        return fs.statSync(p).isDirectory()
    } catch {
        return false
    }
}

function defaultCreateClient(args) {
    const { S3Client } = require('@aws-sdk/client-s3')
    const config = { followRegionRedirects: true }
    if (args.region) config.region = args.region
    if (args.profile) config.profile = args.profile
    if (args.endpoint) config.endpoint = args.endpoint
    if (args.pathStyle) config.forcePathStyle = true
    if (args.noSignRequest) {
        // Anonymous requests: skip credential lookup and leave requests unsigned.
        config.credentials = { accessKeyId: '', secretAccessKey: '' }
        config.signer = { sign: async request => request }
    }
    return new S3Client(config)
}

// Turn the SDK's errors into something a person at a terminal can act on.
function describeError(err, args) {
    const status = err && err.$metadata && err.$metadata.httpStatusCode
    const target = `s3://${args.bucket}/${args.key}`
    if (status === 404 || err.name === 'NotFound' || err.name === 'NoSuchKey') {
        return `${target} not found (check the bucket, key and region)`
    }
    if (status === 403) {
        return `access denied to ${target}. Check your credentials or --profile` +
            (args.noSignRequest ? '' : ', or use --no-sign-request for a public bucket')
    }
    if (status === 412) return `${target} changed while downloading; run the command again`
    if (err.name === 'CredentialsProviderError') {
        return 'no AWS credentials found. Run `aws configure`, set AWS_PROFILE or pass --profile, ' +
            'or use --no-sign-request for a public bucket'
    }
    if (/region is missing/i.test(err.message)) return 'no AWS region set. Pass --region or set AWS_REGION'
    return err.message || String(err)
}

function progressPrinter(stream) {
    const started = Date.now()
    let lastDraw = 0
    let drawn = false
    const draw = ({ downloadedBytes, totalBytes }, force) => {
        const now = Date.now()
        if (!force && now - lastDraw < 100) return
        lastDraw = now
        const pct = totalBytes ? (downloadedBytes / totalBytes) * 100 : 100
        const rate = downloadedBytes / Math.max((now - started) / 1000, 0.001)
        stream.write(`\r\x1b[K${pct.toFixed(1).padStart(5)}%  ${formatBytes(downloadedBytes)} / ` +
            `${formatBytes(totalBytes)}  ${formatBytes(rate)}/s`)
        drawn = true
    }
    let last = { downloadedBytes: 0, totalBytes: 0 }
    return {
        update(p) {
            last = p
            draw(p, false)
        },
        done() {
            if (last.totalBytes) draw(last, true)
            if (drawn) stream.write('\n')
        }
    }
}

function formatBytes(n) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let i = 0
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024
        i++
    }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`
}

module.exports = { main, parseCli, parseSize }

if (require.main === module) {
    const controller = new AbortController()
    process.once('SIGINT', () => controller.abort())
    main(process.argv.slice(2), { signal: controller.signal }).then(code => {
        process.exitCode = code
    })
}
