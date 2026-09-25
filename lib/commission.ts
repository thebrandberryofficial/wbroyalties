import { Admin } from "@/models/Admin"

/** Used when a row has no vendor account (or the account has no rate set). */
const FALLBACK_COMMISSION_PERCENT = 25

/**
 * Builds an aggregation expression for each row's commission percent.
 *
 * The vendor list is tiny compared to the royalty rows, so the rates are
 * loaded once and embedded in the pipeline instead of `$lookup`-ing the
 * vendor for every row — the per-row lookup dominated dashboard load time.
 */
export async function commissionPercentExpression() {
  const vendors = await Admin.find({})
    .select({ ottCommissionPercent: 1, ytCommissionPercent: 1 })
    .lean()

  const vendorIds = vendors.map((vendor) => vendor._id)
  const rates = vendors.map((vendor) => ({
    ott: vendor.ottCommissionPercent ?? null,
    yt: vendor.ytCommissionPercent ?? null,
  }))

  return {
    $let: {
      vars: { index: { $indexOfArray: [{ $literal: vendorIds }, "$vendorId"] } },
      in: {
        $ifNull: [
          {
            // $arrayElemAt treats -1 as "last element", so a row whose vendor
            // isn't found has to be caught before indexing.
            $cond: [
              { $lt: ["$$index", 0] },
              null,
              {
                $let: {
                  vars: { rate: { $arrayElemAt: [{ $literal: rates }, "$$index"] } },
                  in: { $cond: [{ $eq: ["$dspBreak", "Youtube"] }, "$$rate.yt", "$$rate.ott"] },
                },
              },
            ],
          },
          FALLBACK_COMMISSION_PERCENT,
        ],
      },
    },
  }
}
