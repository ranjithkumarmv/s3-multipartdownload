# Benchmark results

- **Mode:** simulated S3 (local server, 40 MB/s per connection, 400 MB/s total, 20 ms latency)
- **Machine:** darwin arm64 (Apple M1, 8 cores), Node v22.16.0
- **Part size:** 8 MiB · **Runs:** median of 3 · **Date:** 2026-10-20

## 100 MB object

| Strategy | Time | Throughput | Speed-up | Peak RSS | SHA-256 |
| --- | ---: | ---: | ---: | ---: | :---: |
| Single GetObject (baseline) | 2.91 s | 34.4 MB/s | 1.00× | 134 MB | ✅ |
| s3-multipartdownload ×4 | 1.01 s | 98.9 MB/s | 2.88× | 117 MB | ✅ |
| s3-multipartdownload ×8 | 0.55 s | 181.0 MB/s | 5.26× | 113 MB | ✅ |
| s3-multipartdownload ×16 | 0.41 s | 246.7 MB/s | 7.17× | 120 MB | ✅ |

## 500 MB object

| Strategy | Time | Throughput | Speed-up | Peak RSS | SHA-256 |
| --- | ---: | ---: | ---: | ---: | :---: |
| Single GetObject (baseline) | 14.29 s | 35.0 MB/s | 1.00× | 134 MB | ✅ |
| s3-multipartdownload ×4 | 4.48 s | 111.7 MB/s | 3.19× | 133 MB | ✅ |
| s3-multipartdownload ×8 | 2.49 s | 201.0 MB/s | 5.74× | 130 MB | ✅ |
| s3-multipartdownload ×16 | 2.01 s | 248.5 MB/s | 7.10× | 127 MB | ✅ |
