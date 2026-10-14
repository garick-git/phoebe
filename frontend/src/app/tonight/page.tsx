import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Tonight",
  description:
    "Find out when the ISS, Tiangong, Hubble and other bright satellites will pass over your city tonight, where to look, and whether clouds will get in the way.",
  path: "/tonight/",
});

/** Tonight (visible passes). Placeholder; mobile-first because people check it outside. */
export default function TonightPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Tonight</h1>
      <p className="mt-2 text-muted">
        Pick a city to see which satellites you can spot tonight, when to go outside, and where to
        look.
      </p>

      <p className="mt-6 rounded-lg border border-dashed border-line p-4 text-sm text-muted">
        Placeholder: city search and pass cards go here.
      </p>

      {/* Skeleton pass cards showing the planned layout. */}
      <ul aria-hidden="true" className="mt-6 space-y-3">
        {[0, 1, 2].map((i) => (
          <li key={i} className="rounded-xl border border-line bg-surface p-4">
            <div className="h-4 w-24 rounded bg-raised" />
            <div className="mt-3 h-3 w-48 rounded bg-raised" />
            <div className="mt-2 h-3 w-32 rounded bg-raised" />
          </li>
        ))}
      </ul>
    </div>
  );
}
