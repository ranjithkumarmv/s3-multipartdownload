#!/usr/bin/env node
// Benchmark: plain single-stream GetObject vs s3-multipartdownload.
//
// Local simulation (default) — starts a throttled S3-compatible server:
//   node bench/benchmark.js [--sizes 100,500] [--runs 3] [--per-conn 40] [--aggregate 400] [--latency 20]
// Real S3 — uses your default AWS credentials:
//   node bench/benchmark.js --bucket my-bucket --key path/to/big.bin --region us-east-1 [--runs 3]
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const { startMockS3 } = require('./mock-s3-server')
const { renderChart } = require('./chart')

const args = parseArgs(process.argv.slice(2))
const runs = Number(args.runs || 3)
const partSize = Number(args['part-size'] || 8) * 1024 * 1024
const parallels = String(args.parallel || '4,8,16').split(',').map(Number)
const strategies = [{ name: 'single', label: 'Single GetObject (baseline)' }]
    .concat(parallels.map(p => ({ name: `parallel-${p}`, label: `s3-multipartdownload ×${p}`, parallel: p })))
const resultsDir = path.join(__dirname, 'results')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3mpd-bench-'))

async function main() {
    const report = {
        date: new Date().toISOString(),
        node: process.version,
        platform: `${os.platform()} ${os.arch()} (${os.cpus()[0].model}, ${os.cpus().length} cores)`,
        partSizeMB: partSize / 1024 / 1024,
        runs,
        mode: args.bucket ? 'real-s3' : 'simulated',
        network: null,
        cases: []
    }

    if (args.bucket) {
        report.network = { region: args.region || process.env.AWS_REGION }
        report.cases.push(await runCase({ bucket: args.bucket, key: args.key, region: args.region }, null))
    } else {
        const net = {
            perConnMBps: Number(args['per-conn'] || 40),
            aggregateMBps: Number(args.aggregate || 400),
            latencyMs: Number(args.latency || 20)
        }
        report.network = net
        const sizes = String(args.sizes || '100,500').split(',').map(Number)
        const objects = new Map(sizes.map(mb => [`object-${mb}MB.bin`, crypto.randomBytes(mb * 1024 * 1024)]))
        const { server, endpoint } = await startMockS3({ objects, ...net })
        try {
            for (const [key, buf] of objects) {
                const expected = crypto.createHash('sha256').update(buf).digest('hex')
                report.cases.push(await runCase({ endpoint, bucket: 'bench', key }, expected))
            }
        } finally {
            server.close()
        }
    }

    fs.rmSync(outDir, { recursive: true, force: true })
    fs.mkdirSync(resultsDir, { recursive: true })
    fs.writeFileSync(path.join(resultsDir, 'results.json'), JSON.stringify(report, null, 2) + '\n')
    fs.writeFileSync(path.join(resultsDir, 'RESULTS.md'), toMarkdown(report))
    fs.writeFileSync(path.join(resultsDir, 'throughput.svg'), renderChart(report.cases.at(-1), report))
    console.log('\n' + toMarkdown(report))
}

async function runCase(target, expectedSha) {
    const c = { key: target.key, sizeMB: null, results: [] }
    for (const s of strategies) {
        const trials = []
        for (let i = 0; i < runs; i++) {
            const cfg = { ...target, strategy: s.name, parallel: s.parallel, partSize, outDir }
            // Async so the in-process mock server keeps serving while the trial runs.
            const { stdout: out } = await execFileAsync(process.execPath,
                [path.join(__dirname, 'run-trial.js'), JSON.stringify(cfg)], { maxBuffer: 1 << 20 })
            const r = JSON.parse(out.trim().split('\n').pop())
            if (expectedSha && r.sha256 !== expectedSha) throw new Error(`${s.name}: checksum mismatch`)
            trials.push(r)
            process.stderr.write(`${target.key}  ${s.name.padEnd(12)} run ${i + 1}/${runs}  ${(r.ms / 1000).toFixed(2)}s\n`)
        }
        const bytes = trials[0].bytes
        c.sizeMB = bytes / 1024 / 1024
        const ms = median(trials.map(t => t.ms))
        c.results.push({
            strategy: s.name,
            label: s.label,
            parallel: s.parallel || 1,
            medianSeconds: ms / 1000,
            throughputMBps: c.sizeMB / (ms / 1000),
            peakRssMB: Math.max(...trials.map(t => t.maxRssMB)),
            checksumVerified: Boolean(expectedSha)
        })
    }
    const base = c.results[0].medianSeconds
    for (const r of c.results) r.speedup = base / r.medianSeconds
    return c
}

function toMarkdown(report) {
    const lines = []
    lines.push(`# Benchmark results`, '')
    lines.push(`- **Mode:** ${report.mode === 'simulated'
        ? `simulated S3 (local server, ${report.network.perConnMBps} MB/s per connection, ${report.network.aggregateMBps} MB/s total, ${report.network.latencyMs} ms latency)`
        : `real Amazon S3 (${report.network.region || 'default region'})`}`)
    lines.push(`- **Machine:** ${report.platform}, Node ${report.node}`)
    lines.push(`- **Part size:** ${report.partSizeMB} MiB · **Runs:** median of ${report.runs} · **Date:** ${report.date.slice(0, 10)}`, '')
    for (const c of report.cases) {
        lines.push(`## ${Math.round(c.sizeMB)} MB object`, '')
        lines.push('| Strategy | Time | Throughput | Speed-up | Peak RSS | SHA-256 |')
        lines.push('| --- | ---: | ---: | ---: | ---: | :---: |')
        for (const r of c.results) {
            lines.push(`| ${r.label} | ${r.medianSeconds.toFixed(2)} s | ${r.throughputMBps.toFixed(1)} MB/s | ${r.speedup.toFixed(2)}× | ${Math.round(r.peakRssMB)} MB | ${r.checksumVerified ? '✅' : '—'} |`)
        }
        lines.push('')
    }
    return lines.join('\n')
}

function parseArgs(argv) {
    const out = {}
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    }
    return out
}

function median(xs) {
    const s = [...xs].sort((a, b) => a - b)
    return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

main().catch(err => { console.error(err); process.exit(1) })
