import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // proxyClientMaxBodySize: "2mb",
    // Keep visited pages in the browser's in-memory cache so switching between
    // Dashboard/Analytics/Reports doesn't re-request the server each time.
    // Royalty data only changes on upload, batch delete, or vendor edits, and
    // those paths call revalidatePath/router.refresh, which clear this cache;
    // a full page reload also clears it.
    staleTimes: {
      dynamic: 30 * 60,
      static: 30 * 60,
    },
  },
};

export default nextConfig;
