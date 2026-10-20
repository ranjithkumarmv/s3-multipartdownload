import type { S3Client, GetObjectCommandInput } from '@aws-sdk/client-s3'

export interface DownloadProgress {
    downloadedBytes: number
    totalBytes: number
}

export interface DownloadOptions {
    /** Output directory, created if missing. Default `"."`. */
    download_dir?: string
    /** Output file name. Defaults to the basename of `Key`. */
    file_name?: string
    /** Maximum concurrent range requests. Default `3`. */
    parallel_count?: number
    /** Bytes per range request. Default 8 MiB. */
    part_size?: number
    /** Extra attempts per part on network/5xx errors. Default `3`. */
    retries?: number
    /** Cancels the download and removes the temp file. */
    abortSignal?: AbortSignal
    /** Called as bytes are written. */
    onProgress?: (progress: DownloadProgress) => void
}

/**
 * Download an S3 object using parallel byte-range requests, streaming each
 * range to its offset in the output file. Resolves to the output file path.
 */
export function download(
    s3Client: S3Client,
    s3Params: Omit<GetObjectCommandInput, 'Range'> & { Range?: string },
    options?: DownloadOptions
): Promise<string>

/** Inclusive `[start, end]` byte ranges covering `0..totalBytes-1`. */
export function getRanges(totalBytes: number, partSize: number): Array<[number, number]>
