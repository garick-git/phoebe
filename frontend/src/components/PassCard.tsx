import type { PassCardModel } from "@/lib/plainPass";

/**
 * One visible pass in plain language. The headline answers "when and where
 * do I look"; exact times and degrees sit behind a native <details>, so the
 * numbers are there on request (brief 6c) with no JavaScript.
 */
export default function PassCard({ card }: { card: PassCardModel }) {
  return (
    <article className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <p className="font-semibold uppercase tracking-wide text-accent">
          {card.dayLabel} · {card.satellite}
        </p>
        <p className="shrink-0 text-muted">
          <span className="sr-only">Visible for </span>
          {card.duration}
        </p>
      </div>
      <p className="mt-1 text-xl font-semibold leading-snug text-ink">{card.headline}</p>
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
          Exact times and directions
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
        </dl>
      </details>
    </article>
  );
}
