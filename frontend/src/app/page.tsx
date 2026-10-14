import type { Metadata } from "next";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: `${SITE_NAME} · ${SITE_TAGLINE}`,
  description: SITE_DESCRIPTION,
  path: "/",
  isHome: true,
});

const DETAIL_FIELDS = ["Name", "NORAD ID", "Category", "Altitude", "Speed", "Orbit period"];

/** Globe (home). Placeholder until the 3D globe lands; the detail panel shows its layout. */
export default function GlobePage() {
  return (
    <div className="flex flex-1 flex-col lg:flex-row">
      <section
        aria-labelledby="globe-heading"
        className="relative flex min-h-[60dvh] flex-1 items-center justify-center overflow-hidden"
      >
        <div className="absolute left-4 top-4 max-w-sm">
          <h1 id="globe-heading" className="text-2xl font-semibold tracking-tight">
            Every active satellite, live
          </h1>
          <p className="mt-1 text-sm text-muted">
            Search, filter, and pick a satellite to see where it is and when you can see it.
          </p>
        </div>

        {/* Placeholder sphere where the 3D globe will render. */}
        <div
          aria-hidden="true"
          className="size-[min(70vw,26rem)] rounded-full bg-[radial-gradient(circle_at_35%_30%,#1d2c4f,#0b1222_60%,#070b14)] shadow-[0_0_80px_-10px_rgba(245,184,74,0.25)] ring-1 ring-line"
        />

        <p className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-dashed border-line px-4 py-1.5 text-xs text-muted">
          Placeholder: the live 3D globe goes here
        </p>
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
        <p className="mt-2 text-sm text-muted">
          Select a satellite on the globe to see its details and next visible passes.
        </p>
        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          {DETAIL_FIELDS.map((field) => (
            <div key={field}>
              <dt className="text-muted">{field}</dt>
              <dd className="font-mono text-ink">—</dd>
            </div>
          ))}
        </dl>
      </aside>
    </div>
  );
}
