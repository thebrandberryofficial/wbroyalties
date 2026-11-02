import { Readable } from "node:stream"
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web"
import unzipper from "unzipper"

/** Random-access view over a file's bytes. `read` yields bytes in [start, end). */
export type ByteSource = {
  size: number
  read(start: number, end: number): AsyncGenerator<Uint8Array>
}

/**
 * A file stored as ordered slices at public URLs (see /api/uploads/chunk),
 * read with HTTP range requests so any byte range can be fetched on its own.
 * `sizes` are the exact byte sizes of the slices, in order.
 */
export function urlSlicesSource(urls: string[], sizes: number[], signal: AbortSignal): ByteSource {
  const starts: number[] = []
  let size = 0
  for (const length of sizes) {
    starts.push(size)
    size += length
  }

  async function* read(start: number, end: number) {
    for (let i = 0; i < urls.length; i++) {
      const sliceStart = starts[i]
      const sliceEnd = sliceStart + sizes[i]
      if (sliceEnd <= start || sliceStart >= end) continue

      const from = Math.max(start, sliceStart) - sliceStart
      const to = Math.min(end, sliceEnd) - sliceStart // exclusive
      const response = await fetch(urls[i], {
        // identity: a compressed partial response wouldn't line up with the
        // byte offsets requested.
        headers: { Range: `bytes=${from}-${to - 1}`, "Accept-Encoding": "identity" },
        signal,
        cache: "no-store",
      })
      if (!response.ok || !response.body) {
        throw new Error("Couldn't download the uploaded file.")
      }

      // A server that ignores Range sends the whole slice (200, not 206).
      let skip = 0
      if (response.status === 206) {
        const rangeStart = Number(/bytes (\d+)-/.exec(response.headers.get("content-range") ?? "")?.[1])
        if (rangeStart !== from) throw new Error("Couldn't download the uploaded file.")
      } else {
        skip = from
      }
      let remaining = to - from
      for await (const chunk of Readable.fromWeb(
        response.body as unknown as NodeWebReadableStream<Uint8Array>
      )) {
        let bytes = chunk as Uint8Array
        if (skip > 0) {
          if (bytes.length <= skip) {
            skip -= bytes.length
            continue
          }
          bytes = bytes.subarray(skip)
          skip = 0
        }
        if (bytes.length > remaining) bytes = bytes.subarray(0, remaining)
        remaining -= bytes.length
        if (bytes.length > 0) yield bytes
        if (remaining <= 0) break
      }
      if (remaining > 0) {
        throw new Error("The uploaded file couldn't be read completely. Please try uploading it again.")
      }
    }
  }

  return { size, read }
}

const WORKSHEET_PATH = /^xl\/worksheets\/sheet\d+\.xml$/

/**
 * Streams an .xlsx with its worksheets moved to the end of the archive.
 *
 * ExcelJS's streaming reader needs xl/sharedStrings.xml before it can parse a
 * worksheet; when Excel stores the worksheet first (common for large
 * exports), ExcelJS unpacks the whole worksheet — often 400MB+ — to a temp
 * file. Serverless functions only have ~512MB of /tmp, so big reports failed
 * with ENOSPC. Each zip entry (local header, data, data descriptor) is copied
 * byte-for-byte, just in a different order, and the original central
 * directory is appended so the stream still ends like a normal zip.
 */
export async function* reorderedXlsx(source: ByteSource): AsyncGenerator<Uint8Array> {
  const directory = await unzipper.Open.custom({
    size: () => Promise.resolve(source.size),
    stream: (offset: number, length?: number) =>
      Readable.from(source.read(offset, length === undefined ? source.size : offset + length)),
  })
  const files = [...directory.files].sort(
    (a, b) => a.offsetToLocalFileHeader - b.offsetToLocalFileHeader
  )
  const centralDirectoryStart = directory.offsetToStartOfCentralDirectory

  const entries = files.map((file, index) => ({
    path: file.path,
    start: file.offsetToLocalFileHeader,
    end: index + 1 < files.length ? files[index + 1].offsetToLocalFileHeader : centralDirectoryStart,
  }))
  const ordered = [
    ...entries.filter((entry) => !WORKSHEET_PATH.test(entry.path)),
    ...entries.filter((entry) => WORKSHEET_PATH.test(entry.path)),
  ]

  for (const entry of ordered) {
    yield* source.read(entry.start, entry.end)
  }
  yield* source.read(centralDirectoryStart, source.size)
}
