"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { track } from "@/lib/analytics";
import { startSentry } from "@/lib/sentry";

/**
 * Starts error tracking once the page is interactive, and counts a page view
 * on every page change (the path only: Tonight's place stays out of it,
 * because a new place changes the query string, not the path). Renders nothing.
 * Both do nothing unless their keys were set at build time (lib/sentry.ts,
 * lib/analytics.ts).
 */
export default function Monitoring() {
  const pathname = usePathname();

  useEffect(() => {
    startSentry().catch(() => {
      // A blocked SDK download (ad blockers do this) must not break the page.
    });
  }, []);

  useEffect(() => {
    track("$pageview", {});
  }, [pathname]);

  return null;
}
