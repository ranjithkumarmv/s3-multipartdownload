const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { parseCli, parseSize } = require('../cli')
const { startMockS3 } = require('../bench/mock-s3-server')

const CLI = path.join(__dirname, '..', 'cli.js')

// Run the real CLI in a child process with a clean, offline AWS environment.
function runCli(args, { cwd } = {}) {
    const env = {
        PATH: process.env.PATH,
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        AWS_REGION: 'us-east-1',
        AWS_CONFIG_FILE: path.join(os.tmpdir(), 'no-such-aws-config'),
        AWS_SHARED_CREDENTIALS_FILE: path.join(os.tmpdir(), 'no-such-aws-credentials')
    }
    return new Promise(resolve => {
        execFile(process.execPath, [CLI, ...args], { env, cwd }, (err, stdout, stderr) => {
            resolve({ code: err ? err.code : 0, stdout, stderr })
        })
    })
}

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 's3mpd-cli-'))
}

test('parseSize accepts bytes and binary K/M/G suffixes', () => {
    assert.strictEqual(parseSize('1048576'), 1048576)
    assert.strictEqual(parseSize('8MiB'), 8 * 1024 * 1024)
    assert.strictEqual(parseSize('8M'), 8 * 1024 * 1024)
    assert.strictEqual(parseSize('16mb'), 16 * 1024 * 1024)
    assert.strictEqual(parseSize('512k'), 512 * 1024)
    assert.strictEqual(parseSize('1.5G'), 1.5 * 1024 ** 3)
    for (const bad of ['', '0', 'abc', '8 TB', '-1']) {
        assert.throws(() => parseSize(bad), /--part-size/)
    }
})

test('parseCli resolves the destination like aws s3 cp', () => {
    const dir = tmpDir()
    const src = 's3://bucket/a/b/file.bin'

    let a = parseCli([src])
    assert.deepStrictEqual([a.bucket, a.key, a.downloadDir, a.fileName], ['bucket', 'a/b/file.bin', '.', 'file.bin'])

    a = parseCli([src, dir]) // existing directory
    assert.deepStrictEqual([a.downloadDir, a.fileName], [dir, 'file.bin'])

    a = parseCli([src, 'new-dir/']) // trailing slash means directory
    assert.deepStrictEqual([a.downloadDir, a.fileName], ['new-dir/', 'file.bin'])

    a = parseCli([src, 'out/renamed.bin']) // anything else is a file path
    assert.deepStrictEqual([a.downloadDir, a.fileName], ['out', 'renamed.bin'])
})

test('parseCli maps flags and applies the CLI default concurrency', () => {
    let a = parseCli(['s3://b/k'])
    assert.strictEqual(a.parallel, 8)
    assert.strictEqual(a.partSize, undefined)
    assert.strictEqual(a.retries, undefined)

    a = parseCli(['s3://b/k', '-p', '16', '-s', '16MiB', '-r', '0', '--region', 'eu-west-1',
        '--endpoint', 'http://localhost:9000', '--path-style', '--no-sign-request',
        '--version-id', 'v1', '--request-payer', '-q'])
    assert.strictEqual(a.parallel, 16)
    assert.strictEqual(a.partSize, 16 * 1024 * 1024)
    assert.strictEqual(a.retries, 0)
    assert.strictEqual(a.region, 'eu-west-1')
    assert.strictEqual(a.endpoint, 'http://localhost:9000')
    assert.ok(a.pathStyle && a.noSignRequest && a.requestPayer && a.quiet)
    assert.strictEqual(a.versionId, 'v1')
})

test('parseCli rejects bad input', () => {
    assert.throws(() => parseCli([]), /missing source/)
    assert.throws(() => parseCli(['bucket/key']), /s3:\/\/bucket\/key/)
    assert.throws(() => parseCli(['s3://bucket']), /s3:\/\/bucket\/key/)
    assert.throws(() => parseCli(['s3://bucket/folder/']), /folder/)
    assert.throws(() => parseCli(['s3://b/k', 'x', 'y']), /unexpected argument/)
    assert.throws(() => parseCli(['s3://b/k', '-p', '0']), /--parallel/)
    assert.throws(() => parseCli(['s3://b/k', '-r', '-1']), /--retries/)
})

test('CLI downloads from an S3-compatible endpoint end to end', async t => {
    const data = crypto.randomBytes(3 * 1024 * 1024 + 17)
    const { server, endpoint } = await startMockS3({
        objects: new Map([['data/big.bin', data]]),
        perConnMBps: 1000, aggregateMBps: 10000, latencyMs: 0
    })
    t.after(() => server.close())
    const dir = tmpDir()

    // Into a directory, with the key's basename.
    let r = await runCli(['s3://bucket/data/big.bin', dir + '/', '--endpoint', endpoint, '--path-style',
        '-p', '4', '-s', '512KiB'])
    assert.strictEqual(r.code, 0, r.stderr)
    assert.strictEqual(r.stdout.trim(), path.join(dir, 'big.bin'))
    assert.ok(fs.readFileSync(path.join(dir, 'big.bin')).equals(data))
    assert.strictEqual(r.stderr, '') // not a TTY, so no progress output

    // To an explicit file path, anonymously.
    r = await runCli(['s3://bucket/data/big.bin', 'copy.bin', '--endpoint', endpoint, '--path-style',
        '--no-sign-request'], { cwd: dir })
    assert.strictEqual(r.code, 0, r.stderr)
    assert.ok(fs.readFileSync(path.join(dir, 'copy.bin')).equals(data))
})

test('CLI reports a missing object and exits 1', async t => {
    const { server, endpoint } = await startMockS3({ objects: new Map(), latencyMs: 0 })
    t.after(() => server.close())
    const dir = tmpDir()
    const r = await runCli(['s3://bucket/missing.bin', '--endpoint', endpoint, '--path-style'], { cwd: dir })
    assert.strictEqual(r.code, 1)
    assert.match(r.stderr, /s3:\/\/bucket\/missing\.bin not found/)
    assert.deepStrictEqual(fs.readdirSync(dir), [])
})

test('CLI usage errors exit 2; --help and --version exit 0', async () => {
    let r = await runCli([])
    assert.strictEqual(r.code, 2)
    assert.match(r.stderr, /missing source/)

    r = await runCli(['s3://b/k', '--bogus'])
    assert.strictEqual(r.code, 2)
    assert.match(r.stderr, /--bogus/)

    r = await runCli(['--help'])
    assert.strictEqual(r.code, 0)
    assert.match(r.stdout, /^Usage: s3-multipartdownload/)

    r = await runCli(['--version'])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.stdout.trim(), require('../package.json').version)
})
