import mongoose from "mongoose"
import { unstable_cache } from "next/cache"

import { RoyaltyRecord } from "@/models/RoyaltyRecord"
import { commissionPercentExpression } from "@/lib/commission"
import { ROYALTY_DATA_TAG } from "@/lib/royalty-cache"
import { Admin } from "@/models/Admin"
import { UploadBatch } from "@/models/UploadBatch"

export type AnalyticsFilters = {
  vendorId?: string
  dateFrom?: string
  dateTo?: string
  dspBreak?: "Youtube" | "Others"
  revDsp?: string
  country?: string
  revenueType?: string
  label?: string
  isrc?: string
  q?: string
  postedPeriodCode?: string
}

export type MonthlyPoint = {
  key: string
  label: string
  grossRevenue: number
  payout: number
  units: number
}
export type DspSplitPoint = {
  dspBreak: "Youtube" | "Others"
  grossRevenue: number
  payout: number
  units: number
}
export type PlatformPoint = {
  platform: string
  grossRevenue: number
  payout: number
  units: number
}
export type RankedRow = { label: string; grossRevenue: number; payout?: number; units: number }
export type RevenueTypeRow = {
  revenueType: string
  grossRevenue: number
  payout: number
  units: number
  revenuePerStream: number
}
export type CountryRow = {
  label: string
  grossRevenue: number
  units: number
  share: number
}

export type AnalyticsResult = {
  summary: {
    totalGrossRevenue: number
    totalPayout: number
    totalUnits: number
    totalRows: number
    vendorCount: number
    trackCount: number
    revenuePerStream: number
  }
  monthlyTrend: MonthlyPoint[]
  dspSplit: DspSplitPoint[]
  platformSplit: PlatformPoint[]
  topVendors: RankedRow[]
  topTracks: RankedRow[]
  topArtists: RankedRow[]
  topLabels: RankedRow[]
  topCountries: CountryRow[]
  revenueTypeMix: RevenueTypeRow[]
  concentration: {
    top10TracksRevenue: number
    top10SharePercent: number
    trackCount: number
  }
  highlights: {
    topPlatform: (RankedRow & { share: number }) | null
    topCountry: (RankedRow & { share: number }) | null
    topTrack: (RankedRow & { share: number }) | null
    topLabel: (RankedRow & { share: number }) | null
  }
}

const PLATFORM_FOLD_LIMIT = 5

/**
 * "admin" sees gross revenue alongside vendor payouts. "vendor" must never see
 * gross revenue: every amount, ranking and percentage is based on the vendor's
 * own commission-adjusted amount (YouTube rows at their YouTube rate, all other
 * platforms at their OTT rate).
 */
export type AnalyticsView = "admin" | "vendor"

/** Excludes docs missing `field` so they don't collapse into one misleading "Unknown" bucket. */
function notNullOrEmpty(field: string) {
  return { [field]: { $nin: [null, ""] } }
}

function buildMatchStage(filters: AnalyticsFilters) {
  const match: Record<string, unknown> = {}

  if (filters.vendorId && mongoose.isValidObjectId(filters.vendorId)) {
    match.vendorId = new mongoose.Types.ObjectId(filters.vendorId)
  }
  if (filters.dspBreak) {
    match.dspBreak = filters.dspBreak
  }
  if (filters.revDsp) {
    match.revDsp = filters.revDsp
  }
  if (filters.country) {
    match.country = filters.country
  }
  if (filters.revenueType) {
    match.customerRevenueType = filters.revenueType
  }
  if (filters.label) {
    match.labelName = filters.label
  }
  if (filters.isrc) {
    match.isrc = filters.isrc
  }
  if (filters.postedPeriodCode) {
    match.postedPeriodCode = filters.postedPeriodCode
  }
  if (filters.dateFrom || filters.dateTo) {
    const range: Record<string, Date> = {}
    if (filters.dateFrom) range.$gte = new Date(filters.dateFrom)
    if (filters.dateTo) range.$lte = new Date(filters.dateTo)
    match.transactionDate = range
  }
  if (filters.q && filters.q.trim().length > 0) {
    match.$text = { $search: filters.q.trim() }
  }

  return match
}

type RawGroupRow = { _id: string | null; grossRevenue: number; payout?: number; units: number }

function toRankedRows(rows: RawGroupRow[]): RankedRow[] {
  return rows.map((row) => ({
    label: row._id ?? "Unknown",
    grossRevenue: row.grossRevenue,
    payout: row.payout,
    units: row.units,
  }))
}

async function computeAnalytics(
  filters: AnalyticsFilters,
  view: AnalyticsView
): Promise<AnalyticsResult> {
  const match = buildMatchStage(filters)
  const commissionPercent = await commissionPercentExpression()

  const [result] = await RoyaltyRecord.aggregate([
    { $match: match },
    {
      $addFields: {
        commissionPercent,
        summaryKey: {
          $ifNull: [
            "$summaryMonthKey",
            { $dateToString: { format: "%Y-%m", date: "$transactionDate" } },
          ],
        },
        summaryLabel: { $ifNull: ["$summaryMonthLabel", "$summaryMonthKey"] },
      },
    },
    {
      $addFields: {
        payout: { $multiply: ["$grossRevenue", { $divide: ["$commissionPercent", 100] }] },
      },
    },
    // For vendors, swap each row's gross for their own amount before anything
    // is summed, so every total, ranking, share and per-stream figure below is
    // computed from what the vendor earns — and gross never leaves the query.
    ...(view === "vendor" ? [{ $set: { grossRevenue: "$payout" } }] : []),
    {
      $facet: {
        summary: [
          {
            $group: {
              _id: null,
              totalGrossRevenue: { $sum: "$grossRevenue" },
              totalPayout: { $sum: "$payout" },
              totalUnits: { $sum: "$saleUnits" },
              totalRows: { $sum: 1 },
              vendorIds: { $addToSet: "$vendorId" },
              trackTitles: { $addToSet: "$productTitle" },
            },
          },
          {
            $project: {
              _id: 0,
              totalGrossRevenue: 1,
              totalPayout: 1,
              totalUnits: 1,
              totalRows: 1,
              vendorCount: {
                $size: { $filter: { input: "$vendorIds", cond: { $ne: ["$$this", null] } } },
              },
              trackCount: {
                $size: {
                  $filter: {
                    input: "$trackTitles",
                    cond: { $and: [{ $ne: ["$$this", null] }, { $ne: ["$$this", ""] }] },
                  },
                },
              },
            },
          },
        ],
        monthlyTrend: [
          {
            $group: {
              _id: "$summaryKey",
              label: { $first: "$summaryLabel" },
              grossRevenue: { $sum: "$grossRevenue" },
              payout: { $sum: "$payout" },
              units: { $sum: "$saleUnits" },
            },
          },
          { $sort: { _id: 1 } },
        ],
        dspSplit: [
          {
            $group: {
              _id: "$dspBreak",
              grossRevenue: { $sum: "$grossRevenue" },
              payout: { $sum: "$payout" },
              units: { $sum: "$saleUnits" },
            },
          },
        ],
        platformSplit: [
          { $match: notNullOrEmpty("revDsp") },
          {
            $group: {
              _id: "$revDsp",
              grossRevenue: { $sum: "$grossRevenue" },
              payout: { $sum: "$payout" },
              units: { $sum: "$saleUnits" },
            },
          },
          { $sort: { grossRevenue: -1 } },
        ],
        topVendors: [
          { $match: notNullOrEmpty("vendorName") },
          {
            $group: {
              _id: "$vendorName",
              grossRevenue: { $sum: "$grossRevenue" },
              payout: { $sum: "$payout" },
              units: { $sum: "$saleUnits" },
            },
          },
          { $sort: { grossRevenue: -1 } },
          { $limit: 10 },
        ],
        topTracks: [
          { $match: notNullOrEmpty("productTitle") },
          {
            $group: {
              _id: "$productTitle",
              grossRevenue: { $sum: "$grossRevenue" },
              units: { $sum: "$saleUnits" },
            },
          },
          { $sort: { grossRevenue: -1 } },
          { $limit: 10 },
        ],
        topArtists: [
          { $match: notNullOrEmpty("productArtistName") },
          {
            $group: {
              _id: "$productArtistName",
              grossRevenue: { $sum: "$grossRevenue" },
              units: { $sum: "$saleUnits" },
            },
          },
          { $sort: { grossRevenue: -1 } },
          { $limit: 10 },
        ],
        topLabels: [
          { $match: notNullOrEmpty("labelName") },
          {
            $group: {
              _id: "$labelName",
              grossRevenue: { $sum: "$grossRevenue" },
              units: { $sum: "$saleUnits" },
            },
          },
          { $sort: { grossRevenue: -1 } },
          { $limit: 10 },
        ],
        topCountries: [
          { $match: notNullOrEmpty("country") },
          {
            $group: {
              _id: "$country",
              grossRevenue: { $sum: "$grossRevenue" },
              units: { $sum: "$saleUnits" },
            },
          },
          { $sort: { grossRevenue: -1 } },
          { $limit: 10 },
        ],
        revenueTypeMix: [
          { $match: notNullOrEmpty("customerRevenueType") },
          {
            $group: {
              _id: "$customerRevenueType",
              grossRevenue: { $sum: "$grossRevenue" },
              payout: { $sum: "$payout" },
              units: { $sum: "$saleUnits" },
            },
          },
          { $sort: { grossRevenue: -1 } },
        ],
      },
    },
  ])

  const summaryRow = result?.summary?.[0] ?? {
    totalGrossRevenue: 0,
    totalPayout: 0,
    totalUnits: 0,
    totalRows: 0,
    vendorCount: 0,
    trackCount: 0,
  }

  const summary = {
    ...summaryRow,
    revenuePerStream:
      summaryRow.totalUnits > 0 ? summaryRow.totalGrossRevenue / summaryRow.totalUnits : 0,
  }
  const totalRevenueOrOne = summary.totalGrossRevenue || 1

  const rawPlatformSplit: RawGroupRow[] = result?.platformSplit ?? []
  const topPlatforms = rawPlatformSplit.slice(0, PLATFORM_FOLD_LIMIT)
  const restPlatforms = rawPlatformSplit.slice(PLATFORM_FOLD_LIMIT)
  const platformSplit: PlatformPoint[] = topPlatforms.map((row) => ({
    platform: row._id ?? "Unknown",
    grossRevenue: row.grossRevenue,
    payout: row.payout ?? 0,
    units: row.units,
  }))
  if (restPlatforms.length > 0) {
    platformSplit.push({
      platform: "Other",
      grossRevenue: restPlatforms.reduce((sum, row) => sum + row.grossRevenue, 0),
      payout: restPlatforms.reduce((sum, row) => sum + (row.payout ?? 0), 0),
      units: restPlatforms.reduce((sum, row) => sum + row.units, 0),
    })
  }

  const rawTopCountries: RawGroupRow[] = result?.topCountries ?? []
  const topCountries: CountryRow[] = rawTopCountries.map((row) => ({
    label: row._id ?? "Unknown",
    grossRevenue: row.grossRevenue,
    units: row.units,
    share: (row.grossRevenue / totalRevenueOrOne) * 100,
  }))

  const rawRevenueTypeMix: RawGroupRow[] = result?.revenueTypeMix ?? []
  const revenueTypeMix: RevenueTypeRow[] = rawRevenueTypeMix.map((row) => ({
    revenueType: row._id ?? "Unknown",
    grossRevenue: row.grossRevenue,
    payout: row.payout ?? 0,
    units: row.units,
    revenuePerStream: row.units > 0 ? row.grossRevenue / row.units : 0,
  }))

  const topTracks = toRankedRows(result?.topTracks ?? [])
  const top10TracksRevenue = topTracks.reduce((sum, row) => sum + row.grossRevenue, 0)

  const topPlatformRaw = rawPlatformSplit[0]
  const topCountryRaw = rawTopCountries[0]
  const topTrackRaw: RawGroupRow | undefined = result?.topTracks?.[0]
  const topLabelRaw: RawGroupRow | undefined = result?.topLabels?.[0]

  return {
    summary,
    monthlyTrend: (result?.monthlyTrend ?? []).map(
      (row: { _id: string; label: string; grossRevenue: number; payout: number; units: number }) => ({
        key: row._id ?? "Unknown",
        label: row.label ?? row._id ?? "Unknown",
        grossRevenue: row.grossRevenue,
        payout: row.payout,
        units: row.units,
      })
    ),
    dspSplit: (result?.dspSplit ?? []).map(
      (row: { _id: "Youtube" | "Others" | null; grossRevenue: number; payout: number; units: number }) => ({
        dspBreak: row._id ?? "Others",
        grossRevenue: row.grossRevenue,
        payout: row.payout,
        units: row.units,
      })
    ),
    platformSplit,
    topVendors: toRankedRows(result?.topVendors ?? []),
    topTracks,
    topArtists: toRankedRows(result?.topArtists ?? []),
    topLabels: toRankedRows(result?.topLabels ?? []),
    topCountries,
    revenueTypeMix,
    concentration: {
      top10TracksRevenue,
      top10SharePercent:
        summary.totalGrossRevenue > 0 ? (top10TracksRevenue / summary.totalGrossRevenue) * 100 : 0,
      trackCount: summary.trackCount,
    },
    highlights: {
      topPlatform: topPlatformRaw
        ? {
            label: topPlatformRaw._id ?? "Unknown",
            grossRevenue: topPlatformRaw.grossRevenue,
            units: topPlatformRaw.units,
            share: (topPlatformRaw.grossRevenue / totalRevenueOrOne) * 100,
          }
        : null,
      topCountry: topCountryRaw
        ? {
            label: topCountryRaw._id ?? "Unknown",
            grossRevenue: topCountryRaw.grossRevenue,
            units: topCountryRaw.units,
            share: (topCountryRaw.grossRevenue / totalRevenueOrOne) * 100,
          }
        : null,
      topTrack: topTrackRaw
        ? {
            label: topTrackRaw._id ?? "Unknown",
            grossRevenue: topTrackRaw.grossRevenue,
            units: topTrackRaw.units,
            share: (topTrackRaw.grossRevenue / totalRevenueOrOne) * 100,
          }
        : null,
      topLabel: topLabelRaw
        ? {
            label: topLabelRaw._id ?? "Unknown",
            grossRevenue: topLabelRaw.grossRevenue,
            units: topLabelRaw.units,
            share: (topLabelRaw.grossRevenue / totalRevenueOrOne) * 100,
          }
        : null,
    },
  }
}

export type FilterOptions = {
  vendors: { id: string; vendorName: string }[]
  revDspOptions: string[]
  countryOptions: string[]
  revenueTypeOptions: string[]
  labelOptions: string[]
  postedPeriodCodeOptions: string[]
}

async function computeFilterOptions(): Promise<FilterOptions> {
  const [vendors, revDspOptions, countryOptions, revenueTypeOptions, labelOptions, postedPeriodCodeOptions] =
    await Promise.all([
      Admin.find({ role: "vendor" }).sort({ vendorName: 1 }).select({ vendorName: 1 }).lean(),
      RoyaltyRecord.distinct("revDsp"),
      RoyaltyRecord.distinct("country"),
      RoyaltyRecord.distinct("customerRevenueType"),
      RoyaltyRecord.distinct("labelName"),
      RoyaltyRecord.distinct("postedPeriodCode"),
    ])

  return {
    vendors: vendors.map((v) => ({ id: v._id.toString(), vendorName: v.vendorName ?? v._id.toString() })),
    revDspOptions: (revDspOptions as (string | null)[]).filter((v): v is string => Boolean(v)).sort(),
    countryOptions: (countryOptions as (string | null)[]).filter((v): v is string => Boolean(v)).sort(),
    revenueTypeOptions: (revenueTypeOptions as (string | null)[])
      .filter((v): v is string => Boolean(v))
      .sort(),
    labelOptions: (labelOptions as (string | null)[]).filter((v): v is string => Boolean(v)).sort(),
    postedPeriodCodeOptions: (postedPeriodCodeOptions as (string | null)[])
      .filter((v): v is string => Boolean(v))
      .sort(),
  }
}

// Results only change when data is uploaded/deleted or a vendor is edited.
// Uploads bump the data version below (so a new import shows up even if the
// uploader closed the tab mid-import); batch deletes and vendor edits
// invalidate ROYALTY_DATA_TAG. Repeat page loads skip the full-collection
// aggregation; the daily revalidate is just a safety net.
const CACHE_OPTIONS = { tags: [ROYALTY_DATA_TAG], revalidate: 24 * 60 * 60 }

/** Cheap fingerprint of the imported data, used as part of the cache key. */
async function royaltyDataVersion(): Promise<string> {
  const [latest, batchCount] = await Promise.all([
    UploadBatch.findOne().sort({ updatedAt: -1 }).select({ updatedAt: 1 }).lean(),
    UploadBatch.estimatedDocumentCount(),
  ])
  return `${batchCount}:${latest?.updatedAt?.getTime() ?? 0}`
}

const cachedAnalytics = unstable_cache(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- only part of the cache key
  (filters: AnalyticsFilters, view: AnalyticsView, _dataVersion: string) =>
    computeAnalytics(filters, view),
  ["royalty-analytics"],
  CACHE_OPTIONS
)

const cachedFilterOptions = unstable_cache(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- only part of the cache key
  (_dataVersion: string) => computeFilterOptions(),
  ["royalty-filter-options"],
  CACHE_OPTIONS
)

export async function getAnalytics(
  filters: AnalyticsFilters,
  view: AnalyticsView
): Promise<AnalyticsResult> {
  return cachedAnalytics(filters, view, await royaltyDataVersion())
}

export async function getFilterOptions(): Promise<FilterOptions> {
  return cachedFilterOptions(await royaltyDataVersion())
}
