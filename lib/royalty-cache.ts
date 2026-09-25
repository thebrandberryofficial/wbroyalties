import { revalidateTag } from "next/cache"

/**
 * Tag for cached dashboard/analytics results. Anything that changes royalty
 * rows or vendor accounts (uploads, batch deletes, commission edits) must call
 * `invalidateRoyaltyData()` so the next page load recomputes them.
 */
export const ROYALTY_DATA_TAG = "royalty-data"

export function invalidateRoyaltyData() {
  // Expire immediately rather than serving stale numbers after a change.
  revalidateTag(ROYALTY_DATA_TAG, { expire: 0 })
}
