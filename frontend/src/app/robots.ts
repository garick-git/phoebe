import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Static export: written to out/robots.txt at build time.
export const dynamic = "force-static";

/** Everything may be crawled; the sitemap lists the pages that matter. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
