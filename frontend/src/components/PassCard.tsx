import type { PassCardModel } from "@/lib/plainPass";

/**
 * One visible pass in plain language. The headline answers "when and where
 * do I look"; the cloud rating right under it says whether it's worth going
 * out, in words (never color alone); exact times, degrees and the cloud
 * percentage sit behind a native <details>, so the numbers are there on
 * request (brief 6c) with no JavaScript.
 */
export default function PassCard({ card }: { card: PassCardModel }) {
  return (
    <article className="rounded-xl border border-line bg-surface p-4">
      {/* Screen readers get this row from the heading and the line after it. */}
      <div aria-hidden="true" className="flex items-baseline justify-between gap-3 text-sm">
        <p className="font-semibold uppercase tracking-wide text-accent">
          {card.dayLabel} · {card.satellite}
        </p>
        <p className="shrink-0 text-muted">{card.duration}</p>
      </div>
      {/* A heading, so VoiceOver users can jump pass to pass (VO+Cmd+H or the
          rotor's headings list); h4 under "Tonight" / "Later this week" (h3)
          and under Ask Phoebe's group headings (h3). */}
      <h4 className="mt-1 text-xl font-semibold leading-snug text-ink">
        <span className="sr-only">
          {card.dayLabel}, {card.satellite}:{" "}
        </span>
        {card.headline}
      </h4>
      <p className="sr-only">Visible for {card.duration}.</p>
      <p className="mt-2 text-base font-medium text-ink">{card.viewing}</p>
      <p className="mt-2 text-base leading-relaxed text-muted">{card.path}</p>
      {card.caution && (
        <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-sm text-ink">
          <span aria-hidden="true" className="font-bold text-accent">
            !
          </span>
          {card.caution}
        </p>
      )}
      <details className="mt-2">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm text-muted hover:text-ink">
          <span>
            Exact times and directions
            {/* Five toggles named alike are hard to tell apart when tabbing. */}
            <span className="sr-only">
              {" "}
              for {card.satellite} at {card.time}
            </span>
          </span>
        </summary>
        <dl className="space-y-1 pb-1 text-sm">
          {card.details.map((row) => (
            <div key={row.label} className="flex flex-wrap gap-x-3">
              <dt className="w-20 shrink-0 text-muted">{row.label}</dt>
              <dd className="text-ink">
                {row.time} · {row.elevation} · {row.direction}
              </dd>
            </div>
          ))}
          {card.cloudDetail && (
            <div className="flex flex-wrap gap-x-3">
              <dt className="w-20 shrink-0 text-muted">Clouds</dt>
              <dd className="text-ink">{card.cloudDetail}</dd>
            </div>
          )}
        </dl>
      </details>
    </article>
  );
}
