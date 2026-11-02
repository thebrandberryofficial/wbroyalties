import ExcelJS from "exceljs"
import { Readable, Transform } from "node:stream"
import { reorderedXlsx, urlSlicesSource, type ByteSource } from "@/lib/xlsx-reorder"

export const EXPECTED_HEADERS = {
  catalogNumber: "Catalog Number",
  productTitle: "Product Title",
  productArtistName: "Product Artist Name",
  productAlbumName: "Product Album Name",
  upc: "UPC",
  isrc: "ISRC",
  labelName: "Label Name",
  vendorName: "Vendor name",
  transactionDate: "Transaction Date",
  country: "Country Name",
  countryCode: "Country Code",
  audioOrVideo: "Audio or Video",
  saleType: "Sale Type",
  saleUnits: "Sale Units",
  grossRevenue: "Gross Revenue",
  revDsp: "Rev DSP",
  period: "Period",
  postedPeriodCode: "Posted Period Code",
  dspBreak: "DSP Break",
  customerRevenueType: "Customer Revenue Type",
  transactionMonthForSummary: "Transaction Month For Summary",
} as const

/** Columns read when present; older exports don't have them. */
export const OPTIONAL_HEADERS = {
  globalCustomerName: "Global Customer Name",
} as const

type ColumnKey = keyof typeof EXPECTED_HEADERS
type OptionalColumnKey = keyof typeof OPTIONAL_HEADERS
type HeaderMap = Record<ColumnKey, number> & Partial<Record<OptionalColumnKey, number>>

export type ParsedRoyaltyRow = {
  catalogNumber: string | null
  productTitle: string | null
  productArtistName: string | null
  productAlbumName: string | null
  upc: string | null
  isrc: string | null
  labelName: string | null
  vendorName: string
  transactionDate: Date | null
  country: string | null
  countryCode: string | null
  audioOrVideo: string | null
  saleType: string | null
  saleUnits: number
  grossRevenue: number
  revDsp: string | null
  period: string | null
  postedPeriodCode: string | null
  dspBreak: "Youtube" | "Others" | null
  customerRevenueType: string | null
  transactionMonthForSummary: string | null
  globalCustomerName: string | null
  summaryMonthKey: string | null
  summaryMonthLabel: string | null
}

/** Target in-memory size of each parsed-row flush to MongoDB. */
export const IMPORT_BATCH_TARGET_BYTES = 25 * 1024 * 1024
/** Hard cap so a single insertMany stays within MongoDB bulk limits. */
export const IMPORT_BATCH_MAX_ROWS = 12_000

/** Parses "202606 (MAR)" into a sortable "2026-06" key and a "MAR 2026" label. */
function parseSummaryMonth(raw: string | null): { key: string; label: string } | null {
  if (!raw) return null
  const match = raw.match(/^(\d{4})(\d{2})\s*(?:\(([^)]+)\))?/)
  if (!match) return { key: raw, label: raw }
  const [, year, month, monthAbbr] = match
  const key = `${year}-${month}`
  const label = monthAbbr ? `${monthAbbr} ${year}` : key
  return { key, label }
}

function buildHeaderMap(headerRowValues: ExcelJS.CellValue[]): HeaderMap {
  const indexByText = new Map<string, number>()
  headerRowValues.forEach((value, index) => {
    if (typeof value === "string") {
      indexByText.set(value.trim(), index)
    }
  })

  const map = {} as HeaderMap
  const missing: string[] = []
  for (const [key, headerText] of Object.entries(EXPECTED_HEADERS) as [
    ColumnKey,
    string,
  ][]) {
    const index = indexByText.get(headerText)
    if (index === undefined) {
      missing.push(headerText)
    } else {
      map[key] = index
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `The uploaded file is missing expected column(s): ${missing.join(", ")}`
    )
  }

  for (const [key, headerText] of Object.entries(OPTIONAL_HEADERS) as [
    OptionalColumnKey,
    string,
  ][]) {
    const index = indexByText.get(headerText)
    if (index !== undefined) map[key] = index
  }

  return map
}

function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "object") {
    if ("text" in value && value.text !== undefined) return String(value.text).trim()
    if ("result" in value && value.result !== undefined)
      return String(value.result).trim()
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("").trim()
    }
    return null
  }
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

function cellNumber(value: ExcelJS.CellValue): number {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30)

function cellDate(value: ExcelJS.CellValue): Date | null {
  if (value instanceof Date) return value
  if (typeof value === "number" && Number.isFinite(value)) {
    // Fallback for date-formatted cells read without style info (raw Excel serial number).
    return new Date(EXCEL_EPOCH_UTC + value * 86400000)
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

function createReader(stream: Readable) {
  // styles must be "cache" (not "ignore") so ExcelJS can resolve date-formatted
  // numeric cells (like Transaction Date) into JS Date objects instead of raw
  // serial numbers.
  return new ExcelJS.stream.xlsx.WorkbookReader(stream, {
    sharedStrings: "cache",
    styles: "cache",
    hyperlinks: "ignore",
    worksheets: "emit",
  })
}

/**
 * YouTube vs. other-platform split, which drives the Platform filter and
 * whether a vendor's YouTube or OTT commission applies. Exports leave "DSP
 * Break" blank, so the platform is taken from "Global Customer Name" (or "Rev
 * DSP" in older exports without it). Only YouTube itself counts as YouTube —
 * YouTube Music is settled at the OTT rate like other music platforms.
 */
export function parseDspBreak(
  dspBreak: string | null,
  globalCustomerName: string | null,
  revDsp: string | null
): "Youtube" | "Others" | null {
  if (dspBreak === "Youtube" || dspBreak === "Others") return dspBreak
  const platform = globalCustomerName ?? revDsp
  if (!platform) return null
  return platform.trim().toLowerCase() === "youtube" ? "Youtube" : "Others"
}

function toRow(headerMap: HeaderMap, values: ExcelJS.CellValue[]): ParsedRoyaltyRow | null {
  const vendorName = cellText(values[headerMap.vendorName])
  if (!vendorName) return null

  const revDsp = cellText(values[headerMap.revDsp])
  const globalCustomerName =
    headerMap.globalCustomerName === undefined
      ? null
      : cellText(values[headerMap.globalCustomerName])
  const dspBreak = parseDspBreak(cellText(values[headerMap.dspBreak]), globalCustomerName, revDsp)

  const transactionMonthForSummary = cellText(values[headerMap.transactionMonthForSummary])
  const summaryMonth = parseSummaryMonth(transactionMonthForSummary)

  return {
    catalogNumber: cellText(values[headerMap.catalogNumber]),
    productTitle: cellText(values[headerMap.productTitle]),
    productArtistName: cellText(values[headerMap.productArtistName]),
    productAlbumName: cellText(values[headerMap.productAlbumName]),
    upc: cellText(values[headerMap.upc]),
    isrc: cellText(values[headerMap.isrc]),
    labelName: cellText(values[headerMap.labelName]),
    vendorName,
    transactionDate: cellDate(values[headerMap.transactionDate]),
    country: cellText(values[headerMap.country]),
    countryCode: cellText(values[headerMap.countryCode]),
    audioOrVideo: cellText(values[headerMap.audioOrVideo]),
    saleType: cellText(values[headerMap.saleType]),
    saleUnits: cellNumber(values[headerMap.saleUnits]),
    grossRevenue: cellNumber(values[headerMap.grossRevenue]),
    revDsp,
    period: cellText(values[headerMap.period]),
    postedPeriodCode: cellText(values[headerMap.postedPeriodCode]),
    dspBreak,
    customerRevenueType: cellText(values[headerMap.customerRevenueType]),
    transactionMonthForSummary,
    globalCustomerName,
    summaryMonthKey: summaryMonth?.key ?? null,
    summaryMonthLabel: summaryMonth?.label ?? null,
  }
}

/** Rough BSON/JS-object size so batches flush around IMPORT_BATCH_TARGET_BYTES. */
export function estimateRowBytes(row: ParsedRoyaltyRow): number {
  let bytes = 256
  for (const value of Object.values(row)) {
    if (typeof value === "string") bytes += value.length * 2 + 24
    else if (value instanceof Date) bytes += 32
    else if (typeof value === "number") bytes += 16
    else bytes += 8
  }
  return bytes
}

export type StreamResult = { rowCount: number; skippedRowCount: number }
export type StreamProgress = { processedRowCount: number; skippedRowCount: number }

export type StreamRoyaltyOptions = {
  targetBatchBytes?: number
  maxBatchRows?: number
  onProgress?: (progress: StreamProgress) => void
  onFileBytes?: (bytesRead: number, totalBytes: number | null) => void
}

function swallowStreamError(error: unknown) {
  const name = error instanceof Error ? error.name : ""
  if (name === "AbortError" || name === "ERR_STREAM_PREMATURE_CLOSE") return
}

function countBytes(source: Readable, onBytes?: (bytesRead: number) => void): Readable {
  source.on("error", swallowStreamError)

  let bytesRead = 0
  const counted = source.pipe(
    new Transform({
      highWaterMark: 64 * 1024,
      transform(chunk, _encoding, callback) {
        bytesRead += chunk.length
        onBytes?.(bytesRead)
        callback(null, chunk)
      },
    })
  )
  counted.on("error", swallowStreamError)
  // pipe() doesn't forward errors from the source to the piped stream.
  source.on("error", (error) => counted.destroy(error))
  return counted
}

/**
 * Streams an .xlsx stored as ordered byte slices (e.g. Vercel Blob parts)
 * without buffering the whole file: each slice is downloaded in turn and
 * concatenated into one stream. .xlsx is a zip, so the slices aren't
 * independently parseable — rows are parsed incrementally and flushed in
 * ~25MB batches instead.
 */
export async function streamRoyaltyRowsFromUrls(
  fileUrls: string[],
  totalBytes: number | null,
  onBatch: (rows: ParsedRoyaltyRow[]) => Promise<void>,
  options: StreamRoyaltyOptions = {}
): Promise<StreamResult> {
  const abort = new AbortController()
  try {
    const source = await urlSlicesSource(fileUrls, abort.signal)
    return await streamRoyaltyRowsFromSource(source, onBatch, {
      ...options,
      onFileBytes: (bytesRead) => options.onFileBytes?.(bytesRead, totalBytes ?? source.size),
    })
  } finally {
    abort.abort()
  }
}

/**
 * Streams rows from an .xlsx exposed as a ByteSource. The archive is read with
 * its worksheets last (see reorderedXlsx) so ExcelJS parses rows straight from
 * the download instead of unpacking the worksheet to disk first.
 */
export async function streamRoyaltyRowsFromSource(
  source: ByteSource,
  onBatch: (rows: ParsedRoyaltyRow[]) => Promise<void>,
  options: StreamRoyaltyOptions = {}
): Promise<StreamResult> {
  const stream = countBytes(Readable.from(reorderedXlsx(source), { objectMode: false }), (bytesRead) => {
    options.onFileBytes?.(bytesRead, source.size)
  })

  // ExcelJS doesn't surface errors from its input stream, so a failed slice
  // download would leave the parser waiting forever — fail the import instead.
  const downloadFailed = new Promise<never>((_, reject) => {
    stream.once("error", reject)
  })

  try {
    return await Promise.race([streamRoyaltyRows(stream, onBatch, options), downloadFailed])
  } finally {
    stream.destroy()
  }
}

/** Pass: streams every row, invoking onBatch with memory-bounded chunks of parsed rows. */
export async function streamRoyaltyRows(
  stream: Readable,
  onBatch: (rows: ParsedRoyaltyRow[]) => Promise<void>,
  options: StreamRoyaltyOptions = {}
): Promise<StreamResult> {
  const targetBatchBytes = options.targetBatchBytes ?? IMPORT_BATCH_TARGET_BYTES
  const maxBatchRows = options.maxBatchRows ?? IMPORT_BATCH_MAX_ROWS
  const reader = createReader(stream)
  let headerMap: HeaderMap | null = null
  let batch: ParsedRoyaltyRow[] = []
  let batchBytes = 0
  let total = 0
  let skipped = 0

  async function flush() {
    if (batch.length === 0) return
    const toWrite = batch
    batch = []
    batchBytes = 0
    await onBatch(toWrite)
    options.onProgress?.({ processedRowCount: total, skippedRowCount: skipped })
  }

  // Only the first worksheet is treated as data; extra sheets (notes, pivots,
  // summaries) are common in real exports and shouldn't be required to match
  // the expected columns.
  for await (const worksheetReader of reader) {
    for await (const row of worksheetReader) {
      const values = row.values as ExcelJS.CellValue[]
      if (row.number === 1) {
        headerMap = buildHeaderMap(values)
        continue
      }
      if (!headerMap) continue

      const parsed = toRow(headerMap, values)
      if (!parsed) {
        skipped += 1
        continue
      }

      batch.push(parsed)
      total += 1
      batchBytes += estimateRowBytes(parsed)

      if (batch.length >= maxBatchRows || batchBytes >= targetBatchBytes) {
        await flush()
      }
    }
    break
  }

  if (!headerMap) {
    throw new Error("The uploaded file has no header row.")
  }

  await flush()
  options.onProgress?.({ processedRowCount: total, skippedRowCount: skipped })

  return { rowCount: total, skippedRowCount: skipped }
}
