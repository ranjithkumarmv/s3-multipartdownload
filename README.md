# s3-multipartdownload

Download large S3 objects faster by fetching byte ranges in parallel and streaming each range straight to its offset in the output file. Built on AWS SDK for JavaScript v3.

- Bounded concurrency over fixed-size parts (not one giant request per worker)
- Streams to disk — memory use stays flat regardless of object size
- Per-part retries, including failures mid-stream
- Pins every part to the object's ETag, so a concurrent overwrite fails the download instead of corrupting it
- Writes to `<file>.download` and renames on success; cleans up on failure
- Progress callback and `AbortSignal` support

## Installation

```bash
npm i s3-multipartdownload @aws-sdk/client-s3
```

Requires Node.js 20.3+.

## Usage

```js
const { S3Client } = require('@aws-sdk/client-s3')
const { download } = require('s3-multipartdownload')

const s3Client = new S3Client({ region: 'us-east-1' }) // credentials from the default provider chain

const file = await download(s3Client, { Bucket: 'my-bucket', Key: 'path/to/big.bin' }, {
    download_dir: './data/download/',
    parallel_count: 8,
    onProgress: ({ downloadedBytes, totalBytes }) => console.log(downloadedBytes, '/', totalBytes)
})
console.log('Saved to', file)
```

`s3Params` accepts any HeadObject/GetObject parameter (`VersionId`, `SSECustomerKey`, `RequestPayer`, ...). A `Range` you pass is ignored.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `download_dir` | `.` | Output directory (created if missing) |
| `file_name` | basename of `Key` | Output file name |
| `parallel_count` | `3` | Max concurrent range requests |
| `part_size` | `8 MiB` | Bytes per range request |
| `retries` | `3` | Extra attempts per part (5xx/network errors; 4xx other than 408/429 is not retried) |
| `abortSignal` | — | Cancels the download and removes the temp file |
| `onProgress` | — | Called with `{ downloadedBytes, totalBytes }` |

Returns a promise for the path of the downloaded file.

## Upgrading from 1.x

- Pass an SDK v3 `S3Client` instead of a v2 `AWS.S3` instance.
- `parallel_count` is now the concurrency limit; the object is split into `part_size` chunks rather than exactly `parallel_count` pieces.
- The promise resolves to the output file path, and the library no longer logs to the console or loads `.env`.

## Development

```bash
npm test
```

## License
[MIT](https://choosealicense.com/licenses/mit/)
