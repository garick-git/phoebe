"use client";

import { CheckIcon } from "@/components/icons";
import { CATEGORIES } from "@/lib/categories";

type Props = {
  /** How many satellites each category holds (same order as CATEGORIES). */
  counts: number[];
  /** The selected category's index, or -1 for all. */
  value: number;
  onChange: (value: number) => void;
};

/**
 * Category chips: one is always selected ("All" by default). They are toggle
 * buttons (aria-pressed), so a screen reader says "Space stations, 9,
 * toggle button, pressed". The selected chip is also marked with a check and
 * bold text, never by color alone. On phones the row scrolls sideways instead
 * of wrapping, so it doesn't cover the globe.
 */
export default function CategoryFilter({ counts, value, onChange }: Props) {
  const total = counts.reduce((sum, n) => sum + n, 0);
  const options = [
    { key: "all", label: "All", count: total, value: -1 },
    ...CATEGORIES.map((c, i) => ({ key: c.id, label: c.label, count: counts[i], value: i })),
  ];

  return (
    <div
      role="group"
      aria-label="Filter satellites by category"
      className="mt-2 flex gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs ${
              active
                ? "border-accent bg-accent font-semibold text-accent-ink"
                : "border-line bg-surface/90 text-ink hover:border-accent"
            }`}
          >
            {active && <CheckIcon className="size-3.5" />}
            {option.label}
            <span className={`font-mono ${active ? "" : "text-muted"}`}>
              {option.count.toLocaleString()}
            </span>
          </button>
        );
      })}
    </div>
  );
}
