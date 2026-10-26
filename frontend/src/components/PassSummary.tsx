"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import PassCard from "@/components/PassCard";
import { track } from "@/lib/analytics";
import { fetchCloudForecast } from "@/lib/forecast";
import { fetchPasses, PASS_DAYS, PassesError, type PassesResponse } from "@/lib/passes";
import type { Place } from "@/lib/place";
import { buildPassCards, joinWords, zoneName, type PassCardModel } from "@/lib/plainPass";
import { POPULAR_SATELLITES } from "@/lib/popular";
import type { ForecastState } from "@/lib/viewing";

type Row = { status: "ok"; response: PassesResponse } | { status: "error"; httpStatus: number | null };

/**
 * Rows for one request key (place + attempt), so old answers never mix with
 * new ones. `at` is when the requests started, captured in the effect so
 * rendering stays pure; it's "now" until the minute clock below ticks.
 */
type Loaded = { key: string; at: number; rows: Partial<Record<number, Row>> };

/** The cloud forecast for one request key, like `Loaded`. */
type ForecastLoaded = { key: string; state: ForecastState };

// One shared object, so the cards' useMemo doesn't rerun while still loading.
const FORECAST_LOADING: ForecastState = { status: "loading" };

/** The same failure for every satellite gets one line instead of three. */
function allFailedText(httpStatus: number | null): string {
  if (httpStatus === 429) return "Too many requests right now. Wait a minute, then try again.";
  if (httpStatus === null) return "Couldn't reach Phoebe's server. Check your connection, then try again.";
  return "Couldn't load passes. Try again in a moment.";
}

function errorText(httpStatus: number | null): string {
  if (httpStatus === 429) return "too many requests right now. Wait a minute, then try again.";
  if (httpStatus === null) return "couldn't reach Phoebe's server.";
  return "couldn't load passes.";
}

/** "Next: ISS, tomorrow morning at 5:45 am." */
function nextText(card: PassCardModel): string {
  const day = card.dayLabel.charAt(0).toLowerCase() + card.dayLabel.slice(1);
  return `Next: ${card.satellite}, ${day} at ${card.time}.`;
}

function CardList({ cards }: { cards: PassCardModel[] }) {
  return (
    <ol className="mt-3 space-y-3">
      {cards.map((card) => (
        <li key={card.key}>
          <PassCard card={card} />
        </li>
      ))}
    </ol>
  );
}

/**
 * Tonight's pass cards for the popular satellites. All three requests start
 * together; cards appear once all three have answered, so they don't jump
 * around as each satellite's passes are sorted in.
 */
export default function PassSummary({ place }: { place: Place }) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ key: "", at: 0, rows: {} });
  const [forecastLoaded, setForecastLoaded] = useState<ForecastLoaded>({ key: "", state: FORECAST_LOADING });
  const key = `${place.lat},${place.lon},${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    const startedAt = Date.now();
    for (const sat of POPULAR_SATELLITES) {
      const record = (row: Row) =>
        setLoaded((prev) => ({
          key,
          at: startedAt,
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
    // The cloud forecast: one request per place, started with the passes. Cards
    // don't wait for it; each card's rating line fills in when it arrives.
    fetchCloudForecast(place.lat, place.lon, controller.signal).then(
      (forecast) => setForecastLoaded({ key, state: { status: "ok", forecast } }),
      () => {
        if (!controller.signal.aborted) setForecastLoaded({ key, state: { status: "error" } });
      },
    );
    // A new place (or leaving the page) cancels requests for the old one.
    return () => controller.abort();
  }, [key, place.lat, place.lon]);

  // A page left open (afternoon to evening, or past midnight) moves on: ended
  // passes drop off and "Tonight" / "Tomorrow morning" stay right. Ticks once a
  // minute and when the tab becomes visible again; 0 until the first tick.
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const tick = () => setClock(Date.now());
    const id = window.setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  const current = loaded.key === key ? loaded : null;
  const nowMs = Math.max(current?.at ?? 0, clock);
  const rows = current?.rows ?? {};
  const forecast = forecastLoaded.key === key ? forecastLoaded.state : FORECAST_LOADING;
  const allDone = POPULAR_SATELLITES.every((sat) => rows[sat.noradId]);
  const okSats = POPULAR_SATELLITES.filter((sat) => rows[sat.noradId]?.status === "ok");
  const failedSats = POPULAR_SATELLITES.filter((sat) => rows[sat.noradId]?.status === "error");

  const cards = useMemo(() => {
    if (!current || !allDone) return null;
    const satellites = POPULAR_SATELLITES.flatMap((sat) => {
      const row = current.rows[sat.noradId];
      return row?.status === "ok"
        ? [{ noradId: sat.noradId, nickname: sat.nickname, passes: row.response.passes }]
        : [];
    });
    return buildPassCards(satellites, nowMs, place.timeZone, forecast);
  }, [current, allDone, nowMs, place.timeZone, forecast]);

  // Count each place's predictions once, when its cards first appear (not on
  // every minute tick or forecast update). Only counts, never the place.
  const trackedKey = useRef("");
  useEffect(() => {
    if (!cards || trackedKey.current === key) return;
    trackedKey.current = key;
    track("tonight_passes_shown", {
      visible_tonight: cards.tonight.length,
      visible_later: cards.later.length,
      failed_satellites: failedSats.length,
    });
  }, [cards, key, failedSats.length]);

  if (!cards || !current) {
    return (
      <div className="mt-3" aria-busy="true">
        <p className="text-sm text-muted">
          Checking {joinWords(POPULAR_SATELLITES.map((sat) => sat.inSentence))}…
        </p>
        <div aria-hidden="true" className="mt-3 space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-36 rounded-xl border border-line bg-surface motion-safe:animate-pulse" />
          ))}
        </div>
        <p role="status" className="sr-only">
          Loading passes…
        </p>
      </div>
    );
  }

  const { tonight, later } = cards;
  const checked = joinWords(okSats.map((sat) => sat.inSentence), "or");
  const statusOf = (sat: (typeof POPULAR_SATELLITES)[number]) => {
    const row = rows[sat.noradId];
    return row?.status === "error" ? row.httpStatus : null;
  };
  // Every satellite failed for the same reason: say it once.
  const sameFailure =
    okSats.length === 0 && new Set(failedSats.map(statusOf)).size === 1
      ? allFailedText(statusOf(failedSats[0]))
      : null;
  // Never "No visible passes" when nothing loaded: we don't know.
  const statusText =
    okSats.length === 0
      ? (sameFailure ?? "Couldn't load passes.")
      : tonight.length
        ? `${tonight.length} visible ${tonight.length === 1 ? "pass" : "passes"} tonight. ${nextText(tonight[0])}`
        : `No visible passes tonight. ${later.length ? nextText(later[0]) : ""}`;

  return (
    <div className="mt-3">
      <p className="text-sm text-muted">Times are {zoneName(place.timeZone, nowMs)}.</p>

      {failedSats.length > 0 && (
        <div className="mt-3 rounded-lg border border-line bg-surface p-4 text-sm text-ink">
          {sameFailure ? (
            <p>{sameFailure}</p>
          ) : (
            <ul className="space-y-1">
              {failedSats.map((sat) => (
                <li key={sat.noradId}>
                  {sat.nickname}: {errorText(statusOf(sat))}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="mt-3 min-h-11 rounded-full border border-line px-4 text-ink hover:bg-raised"
          >
            Try again
          </button>
        </div>
      )}

      {okSats.length > 0 && (
        <>
          <h3 className="mt-6 text-base font-semibold">
            Tonight <span className="font-normal text-muted">(until noon tomorrow)</span>
          </h3>
          {tonight.length > 0 ? (
            <CardList cards={tonight} />
          ) : (
            <div className="mt-3 rounded-xl border border-line bg-surface p-4">
              <p className="text-base text-ink">
                No visible passes from {checked} tonight.{" "}
                {later.length > 0
                  ? nextText(later[0])
                  : `None in the next ${PASS_DAYS} days either.`}
              </p>
              {later.length === 0 && (
                // So an empty week doesn't look like a broken page (Nov 2 copy pass).
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  Satellites only show up when your sky is dark but they&apos;re still in sunlight, so
                  visible passes come and go in stretches. Check back in a few days.
                </p>
              )}
            </div>
          )}

          {later.length > 0 && (
            <>
              <h3 className="mt-8 text-base font-semibold">Later this week</h3>
              <CardList cards={later} />
            </>
          )}
        </>
      )}

      <p role="status" className="sr-only">
        {statusText}
      </p>
    </div>
  );
}
