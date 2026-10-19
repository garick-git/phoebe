import type { Metadata } from "next";
import { Suspense } from "react";

import TonightApp from "@/components/TonightApp";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Tonight",
  description:
    "Find out when the ISS, Tiangong, Hubble and other bright satellites will pass over your city tonight, where to look, and whether clouds will get in the way.",
  path: "/tonight/",
});

/** Pre-rendered stand-in while the interactive part loads (and what the static HTML holds). */
function TonightSkeleton() {
  return (
    <div aria-hidden="true" className="mt-6 space-y-3">
      <div className="h-4 w-24 rounded bg-raised" />
      <div className="h-12 rounded-full border border-line bg-surface" />
      <div className="h-11 w-40 rounded-full border border-line" />
    </div>
  );
}

/**
 * Tonight (visible passes). Mobile-first because people check it outside.
 * The heading and intro are static HTML; the search and passes read the URL
 * in the browser. useSearchParams needs this <Suspense> boundary in a static
 * export: at build time there is no URL, so the build renders the fallback.
 */
export default function TonightPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Tonight</h1>
      <p className="mt-2 text-muted">
        Pick a city to see when the ISS, Tiangong and Hubble pass over and whether you can see
        them.
      </p>
      <Suspense fallback={<TonightSkeleton />}>
        <TonightApp />
      </Suspense>
    </div>
  );
}
