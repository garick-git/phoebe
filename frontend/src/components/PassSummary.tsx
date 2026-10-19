"use client";

import { useEffect, useState } from "react";

import {
  fetchPasses,
  PassesError,
  visiblePasses,
  type PassesResponse,
} from "@/lib/passes";
import type { Place } from "@/lib/place";
import { POPULAR_SATELLITES } from "@/lib/popular";

type Row = { status: "ok"; response: PassesResponse } | { status: "error"; httpStatus: number | null };

/** Rows for one request key (place + attempt), so old answers never mix with new ones. */
type Loaded = { key: string; rows: Partial<Record<number, Row>> };

function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

function describe(row: Row | undefined, timeZone: string): string {
  if (!row) return "checking…";
  if (row.status === "error") {
    if (row.httpStatus === 429) return "too many requests right now. Wait a minute, then try again.";
    if (row.httpStatus === null) return "couldn't reach Phoebe's server.";
    return "couldn't load passes.";
  }
  const { days } = row.response;
  const visible = visiblePasses(row.response);
  if (visible.length === 0) return `no visible passes in the next ${days} days.`;
  const next = visible[0].visibility.start;
  const count = `${visible.length} visible ${visible.length === 1 ? "pass" : "passes"} in the next ${days} days`;
  return next ? `${count}; next ${formatTime(next.time, timeZone)}.` : `${count}.`;
}

/**
 * Today's stand-in for Thursday's pass cards: one line per popular satellite.
 * All three requests start together; each line fills in as its answer arrives.
 */
export default function PassSummary({ place }: { place: Place }) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ key: "", rows: {} });
  const key = `${place.lat},${place.lon},${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    for (const sat of POPULAR_SATELLITES) {
      const record = (row: Row) =>
        setLoaded((prev) => ({
          key,
          rows: { ...(prev.key === key ? prev.rows : {}), [sat.noradId]: row },
        }));
      fetchPasses(sat.noradId, place.lat, place.lon, controller.signal).then(
        (response) => record({ status: "ok", response }),
        (error: unknown) => {
          if (controller.signal.aborted) return;
          record({ status: "error", httpStatus: error instanceof PassesError ? error.status : null });
        },
      );
    }
    // A new place (or leaving the page) cancels requests for the old one.
    return () => controller.abort();
  }, [key, place.lat, place.lon]);

  const rows = loaded.key === key ? loaded.rows : {};
  const done = POPULAR_SATELLITES.filter((sat) => rows[sat.noradId]).length;
  const allDone = done === POPULAR_SATELLITES.length;
  const anyError = POPULAR_SATELLITES.some((sat) => rows[sat.noradId]?.status === "error");
  const withVisible = POPULAR_SATELLITES.filter((sat) => {
    const row = rows[sat.noradId];
    return row?.status === "ok" && visiblePasses(row.response).length > 0;
  }).length;

  return (
    <div className="mt-3">
      <p className="text-sm text-muted">Times in {place.timeZone.replace(/_/g, " ")}.</p>
      <ul className="mt-3 space-y-2" aria-busy={!allDone}>
        {POPULAR_SATELLITES.map((sat) => (
          <li
            key={sat.noradId}
            className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted"
          >
            <span className="font-semibold text-ink">{sat.nickname}</span>:{" "}
            {describe(rows[sat.noradId], place.timeZone)}
          </li>
        ))}
      </ul>
      {allDone && anyError && (
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          className="mt-3 min-h-11 rounded-full border border-line px-4 text-sm text-ink hover:bg-raised"
        >
          Try again
        </button>
      )}
      <p role="status" className="sr-only">
        {allDone
          ? `${withVisible} of ${POPULAR_SATELLITES.length} satellites have visible passes in the next week.`
          : "Loading passes…"}
      </p>
    </div>
  );
}
