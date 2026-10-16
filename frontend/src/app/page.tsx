import type { Metadata } from "next";
import GlobeLoader from "@/components/GlobeLoader";
import {
  GLOBE_DETAIL_SLOT_ID,
  GLOBE_SEARCH_SLOT_ID,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TAGLINE,
  pageMetadata,
} from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: `${SITE_NAME} · ${SITE_TAGLINE}`,
  description: SITE_DESCRIPTION,
  path: "/",
  isHome: true,
});

const DETAIL_FIELDS = ["NORAD ID", "Category", "Altitude", "Speed", "Orbit period", "Inclination"];

/** Globe (home). The heading and panel are pre-rendered HTML; the 3D globe loads after them. */
export default function GlobePage() {
  return (
    <div className="flex flex-1 flex-col lg:flex-row">
      <section
        aria-labelledby="globe-heading"
        className="relative flex min-h-[60dvh] flex-1 items-center justify-center overflow-hidden"
      >
        <GlobeLoader />

        <div className="pointer-events-none absolute inset-x-4 top-4 z-10 flex flex-col gap-3 sm:right-auto sm:w-96">
          <div>
            <h1 id="globe-heading" className="text-2xl font-semibold tracking-tight">
              Every active satellite, live
            </h1>
            <p className="mt-1 text-sm text-muted">
              Search, filter, and pick a satellite to see where it is and when you can see it.
            </p>
          </div>
          {/* The globe renders its search box here once its data has loaded. */}
          <div id={GLOBE_SEARCH_SLOT_ID} className="pointer-events-auto empty:hidden" />
        </div>
      </section>

      <aside
        aria-labelledby="detail-heading"
        className="border-t border-line bg-surface p-5 lg:w-80 lg:border-l lg:border-t-0"
      >
        <h2
          id="detail-heading"
          className="text-sm font-semibold uppercase tracking-wider text-muted"
        >
          Satellite details
        </h2>
        <div data-detail-placeholder>
          <p className="mt-2 text-sm text-muted">
            Click a satellite on the globe, or search for one, to see its details and path.
          </p>
          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            {DETAIL_FIELDS.map((field) => (
              <div key={field}>
                <dt className="text-muted">{field}</dt>
                <dd className="font-mono text-ink">—</dd>
              </div>
            ))}
          </dl>
        </div>
        {/* The globe renders the selected satellite here (see globals.css). */}
        <div id={GLOBE_DETAIL_SLOT_ID} data-detail-slot />
      </aside>
    </div>
  );
}
