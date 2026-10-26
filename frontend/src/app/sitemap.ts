import type { MetadataRoute } from "next";
import { NAV_ITEMS, SITE_URL } from "@/lib/site";

// Static export: written to out/sitemap.xml at build time.
export const dynamic = "force-static";

/**
 * The pages worth indexing: the same list as the navigation, as absolute URLs
 * on the final domain with the trailing slash (trailingSlash is on), so they
 * match each page's canonical link. No lastModified: these pages don't change
 * on a schedule, and a made-up date would only mislead crawlers.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return NAV_ITEMS.map((item) => ({ url: new URL(item.href, SITE_URL).toString() }));
}
