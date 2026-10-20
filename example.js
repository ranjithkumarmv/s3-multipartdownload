const { S3Client } = require('@aws-sdk/client-s3')
const { download } = require('./index')

// Credentials and region come from the default provider chain
// (env vars, ~/.aws, SSO, instance role...).
const s3Client = new S3Client({})

const s3Params = {
    Bucket: process.argv[2], // required
    Key: process.argv[3]     // required
}

download(s3Client, s3Params, {
    download_dir: './data/download/',
    parallel_count: 8,
    onProgress: ({ downloadedBytes, totalBytes }) =>
        process.stdout.write(`\r${(downloadedBytes / totalBytes * 100 || 100).toFixed(1)}%`)
}).then(
    file => console.log('\nDownloaded to', file),
    err => { console.error('\nDownload failed:', err); process.exitCode = 1 }
)
