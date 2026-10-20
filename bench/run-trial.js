// Runs one download in a fresh process so timing and peak memory are isolated.
// Usage: node run-trial.js '<json config>'  → prints a JSON result line.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { pipeline } = require('stream/promises')
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3')
const { download } = require('..')

async function main() {
    const cfg = JSON.parse(process.argv[2])
    const client = new S3Client(cfg.endpoint ? {
        endpoint: cfg.endpoint,
        forcePathStyle: true,
        region: 'us-east-1',
        credentials: { accessKeyId: 'bench', secretAccessKey: 'bench' }
    } : { region: cfg.region })
    const params = { Bucket: cfg.bucket, Key: cfg.key }
    const outDir = cfg.outDir
    fs.mkdirSync(outDir, { recursive: true })

    const t0 = process.hrtime.bigint()
    let outPath
    if (cfg.strategy === 'single') {
        // Baseline: the standard SDK v3 way — one GetObject streamed to disk.
        outPath = path.join(outDir, 'single.bin')
        const res = await client.send(new GetObjectCommand(params))
        await pipeline(res.Body, fs.createWriteStream(outPath))
    } else {
        outPath = await download(client, params, {
            download_dir: outDir,
            file_name: `parallel-${cfg.parallel}.bin`,
            parallel_count: cfg.parallel,
            part_size: cfg.partSize
        })
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6

    const hash = crypto.createHash('sha256')
    await pipeline(fs.createReadStream(outPath), hash)
    const bytes = fs.statSync(outPath).size
    fs.rmSync(outPath)
    process.stdout.write(JSON.stringify({
        ms, bytes, sha256: hash.digest('hex'),
        maxRssMB: process.resourceUsage().maxRSS / 1024 // KiB → MiB
    }) + '\n')
}

main().catch(err => { console.error(err); process.exit(1) })
