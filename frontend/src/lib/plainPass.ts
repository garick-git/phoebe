/**
 * Plain-language pass descriptions for Tonight's cards, for example
 * "5:45 am, look north, partway up the sky". Pure functions with no React,
 * so Vitest can test them. Every time is in the place's time zone, never the
 * viewer's, so a shared link reads the same for everyone.
 *
 * Decisions (Oct 20, see the decision log):
 * - "Tonight" = from now until noon tomorrow, place's time (an observing night
 *   runs noon to noon; a visible pass needs a dark sky, so no sunset math).
 * - 8-point compass on the card, 16-point plus degrees in the details.
 * - Four height bands: low, partway up, high, almost overhead.
 * - "Appears" / "fades out" when the visible part starts or ends mid-sky
 *   (the API doesn't say whether that's Earth's shadow or the sky, so no cause).
 * - Low or brief passes are tagged, never hidden.
 * - Cards are sorted by time across satellites.
 * Built on visibility.start / highest / end, not rise / peak / set.
 * Every card function takes the API's Pass (Tonight) or a VisiblePass (Ask
 * Phoebe's tool results, mapped in lib/ask.ts), so both show identical cards.
 * The cloud rating's logic lives in lib/viewing.ts; this file only words it.
 */

import type { Pass, PassPoint } from "@/lib/passes";
import { viewingFor, viewingText, type ForecastState } from "@/lib/viewing";

/** Height bands, in degrees above the horizon (a fist at arm's length is about 10°). */
export const PARTWAY_FROM_DEG = 20;
export const HIGH_FROM_DEG = 45;
export const OVERHEAD_FROM_DEG = 70;

/** A visible part shorter than this gets the "brief" tag. */
export const BRIEF_BELOW_S = 60;

/**
 * If the visible part starts this long after the rise (or ends this long
 * before the set), it appears (or fades out) mid-sky. Both come from the API
 * rounded to the second, so a few seconds of slack.
 */
const SAME_MOMENT_MS = 5_000;

const COMPASS_8 = [
  "north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest",
] as const;
const COMPASS_16 = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

function normalizeAzimuth(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Azimuth (0 = north, 90 = east) → "northwest". Exact boundaries round up (22.5 → northeast). */
export function compass8(azimuthDeg: number): string {
  return COMPASS_8[Math.round(normalizeAzimuth(azimuthDeg) / 45) % 8];
}

/** Azimuth → "NNW", for the details. */
export function compass16(azimuthDeg: number): string {
  return COMPASS_16[Math.round(normalizeAzimuth(azimuthDeg) / 22.5) % 16];
}

export type Height = "low" | "partway up" | "high" | "almost overhead";

export function heightBand(elevationDeg: number): Height {
  if (elevationDeg >= OVERHEAD_FROM_DEG) return "almost overhead";
  if (elevationDeg >= HIGH_FROM_DEG) return "high";
  if (elevationDeg >= PARTWAY_FROM_DEG) return "partway up";
  return "low";
}

/** How high it gets, for the headline: "high in the sky", "almost overhead". */
export function skyPhrase(elevationDeg: number): string {
  const band = heightBand(elevationDeg);
  if (band === "almost overhead") return band;
  if (band === "partway up") return "partway up the sky";
  return `${band} in the sky`;
}

/** Where one point is: "low in the west", "high in the north", "almost overhead". */
export function positionPhrase(point: PassPoint): string {
  const band = heightBand(point.elevation_deg);
  return band === "almost overhead" ? band : `${band} in the ${compass8(point.azimuth_deg)}`;
}

function ms(iso: string): number {
  return Date.parse(iso);
}

/** "a", "a and b", "a, b and c". */
export function joinWords(parts: readonly string[], last = "and"): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} ${last} ${parts[parts.length - 1]}`;
}

/**
 * The visible part of one pass: everything a card needs. `appearsMidSky` /
 * `fadesMidSky` say whether it starts (or stops) being visible above the 10°
 * line, instead of rising (or setting) there. Tonight works them out from
 * the API's rise and set times (below); Ask Phoebe's tool result has no rise
 * or set, so lib/ask.ts works them out from the edges' elevations.
 */
export type VisiblePass = {
  start: PassPoint;
  highest: PassPoint;
  end: PassPoint;
  appearsMidSky: boolean;
  fadesMidSky: boolean;
};

/** A pass from the passes endpoint, or one already reduced to its visible part. */
export type AnyPass = Pass | VisiblePass;

/** The visible part, or null if the pass can't be seen. */
export function visiblePart(pass: AnyPass): VisiblePass | null {
  if (!("visibility" in pass)) return pass;
  const { visible, start, highest, end } = pass.visibility;
  if (!(visible && start && highest && end)) return null;
  return {
    start,
    highest,
    end,
    appearsMidSky: ms(start.time) - ms(pass.rise.time) > SAME_MOMENT_MS,
    fadesMidSky: ms(pass.set.time) - ms(end.time) > SAME_MOMENT_MS,
  };
}

/** Seconds the satellite can be seen (start to end of the visible part). */
export function visibleSeconds(pass: AnyPass): number {
  const part = visiblePart(pass);
  return part ? Math.round((ms(part.end.time) - ms(part.start.time)) / 1000) : 0;
}

/**
 * The path in one sentence, for example "Appears partway up in the north,
 * climbs high in the northeast and fades out low in the east."
 */
export function pathSentence(pass: AnyPass): string | null {
  const part = visiblePart(pass);
  if (!part) return null;
  const { start, highest, end, appearsMidSky: appears, fadesMidSky: fades } = part;

  const clauses = [
    appears ? `Appears ${positionPhrase(start)}` : `Rises in the ${compass8(start.azimuth_deg)}`,
  ];
  // When it appears past the peak (or fades before it), the highest point is
  // an edge of the visible part, which the other clauses already describe.
  if (highest.time !== start.time && highest.time !== end.time) {
    const band = heightBand(highest.elevation_deg);
    const where = `in the ${compass8(highest.azimuth_deg)}`;
    // A grazing pass: "Rises in the south, stays low and sets in the south."
    const sameAsStart = compass8(highest.azimuth_deg) === compass8(start.azimuth_deg);
    clauses.push(
      band === "low"
        ? sameAsStart ? "stays low" : `stays low ${where}`
        : band === "almost overhead"
          ? "climbs almost overhead"
          : `climbs ${band} ${where}`,
    );
  }
  clauses.push(fades ? `fades out ${positionPhrase(end)}` : `sets in the ${compass8(end.azimuth_deg)}`);
  return `${joinWords(clauses)}.`;
}

/** "Low and brief, easy to miss", or null for an easy pass. */
export function cautionTag(pass: AnyPass): string | null {
  const part = visiblePart(pass);
  if (!part) return null;
  const low = part.highest.elevation_deg < PARTWAY_FROM_DEG;
  const brief = visibleSeconds(pass) < BRIEF_BELOW_S;
  if (low && brief) return "Low and brief, easy to miss";
  if (low) return "Stays low, easy to miss";
  if (brief) return "Brief, easy to miss";
  return null;
}

export function durationText(seconds: number): string {
  return seconds < 60 ? "under 1 min" : `${Math.round(seconds / 60)} min`;
}

// ---- Time in the place's zone -------------------------------------------

type LocalParts = { date: string; hour: number; minute: number; weekday: string };

// One formatter per zone: creating Intl formatters is slow, and there are only a few zones.
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

/** The place's wall-clock date ("YYYY-MM-DD"), hour (0–23), minute and weekday at an instant. */
export function localParts(atMs: number, timeZone: string): LocalParts {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    partsFormatters.set(timeZone, formatter);
  }
  const p: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(atMs))) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: p.weekday,
  };
}

/** Calendar math on "YYYY-MM-DD" (no time zone involved, so no daylight-time surprises). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Tonight = from now until noon tomorrow, in the place's time. Compared as
 * wall-clock strings ("2026-10-21 05:45" < "2026-10-21 12:00"), so it never
 * needs the zone's UTC offset and stays right across a daylight-time change.
 */
export function isTonight(startIso: string, nowMs: number, timeZone: string): boolean {
  const cutoff = `${addDays(localParts(nowMs, timeZone).date, 1)} 12:00`;
  const at = localParts(ms(startIso), timeZone);
  return `${at.date} ${pad2(at.hour)}:${pad2(at.minute)}` < cutoff;
}

/** "Tonight", "This morning", "Tomorrow morning", "Tomorrow night", "Thu morning". */
export function dayLabel(startIso: string, nowMs: number, timeZone: string): string {
  const now = localParts(nowMs, timeZone);
  const at = localParts(ms(startIso), timeZone);
  const morning = at.hour < 12;
  if (at.date === now.date) return morning ? "This morning" : "Tonight";
  if (at.date === addDays(now.date, 1)) return morning ? "Tomorrow morning" : "Tomorrow night";
  return `${at.weekday} ${morning ? "morning" : "night"}`;
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** "5:45 am" (or "5:45:01 am" with seconds), built from parts so it's the same in every browser. */
export function formatClock(iso: string, timeZone: string, withSeconds = false): string {
  const cacheKey = `${timeZone}|${withSeconds}`;
  let formatter = clockFormatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      second: withSeconds ? "2-digit" : undefined,
      hour12: true,
    });
    clockFormatters.set(cacheKey, formatter);
  }
  const p: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(iso))) p[part.type] = part.value;
  const seconds = withSeconds ? `:${p.second}` : "";
  return `${p.hour}:${p.minute}${seconds} ${(p.dayPeriod ?? "").toLowerCase()}`.trim();
}

/** "Central Time" for America/Chicago; the IANA name if the browser can't name it. */
export function zoneName(timeZone: string, atMs: number): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longGeneric" })
      .formatToParts(new Date(atMs))
      .find((p) => p.type === "timeZoneName");
    if (part?.value) return part.value;
  } catch {
    // Older browsers without "longGeneric" fall through.
  }
  return timeZone.replace(/_/g, " ");
}

// ---- Cards ----------------------------------------------------------------

export type DetailRow = { label: string; time: string; elevation: string; direction: string };

export type PassCardModel = {
  key: string;
  noradId: number;
  satellite: string;
  startIso: string;
  dayLabel: string;
  time: string;
  /** "5:45 am, look north, partway up the sky" */
  headline: string;
  path: string;
  duration: string;
  caution: string | null;
  /** "Good viewing · mostly clear", "Checking clouds…" or "Cloud forecast unavailable". */
  viewing: string;
  /** "10% (5:00 am forecast)" for the details, or null with no rating. */
  cloudDetail: string | null;
  details: DetailRow[];
};

export type SatellitePasses = { noradId: number; nickname: string; passes: readonly AnyPass[] };

function detailRow(label: string, point: PassPoint, timeZone: string): DetailRow {
  return {
    label,
    time: formatClock(point.time, timeZone, true),
    elevation: `${Math.round(point.elevation_deg)}° up`,
    direction: `${compass16(point.azimuth_deg)} (${Math.round(normalizeAzimuth(point.azimuth_deg))}°)`,
  };
}

export function passCard(
  noradId: number,
  satellite: string,
  pass: AnyPass,
  nowMs: number,
  timeZone: string,
  forecast: ForecastState,
): PassCardModel | null {
  const part = visiblePart(pass);
  if (!part) return null;
  const { start, highest, end, appearsMidSky: appears, fadesMidSky: fades } = part;
  const time = formatClock(start.time, timeZone);
  const viewing = viewingFor(forecast, start.time, end.time, nowMs);
  return {
    key: `${noradId}-${start.time}`,
    noradId,
    satellite,
    startIso: start.time,
    dayLabel: dayLabel(start.time, nowMs, timeZone),
    time,
    headline: `${time}, look ${compass8(start.azimuth_deg)}, ${skyPhrase(highest.elevation_deg)}`,
    path: pathSentence(pass) ?? "",
    duration: durationText(visibleSeconds(pass)),
    caution: cautionTag(pass),
    viewing: viewingText(viewing),
    cloudDetail:
      viewing.status === "rated"
        ? `${viewing.percent}% (${formatClock(new Date(viewing.hourMs).toISOString(), timeZone)} forecast)`
        : null,
    details: [
      detailRow(appears ? "Appears" : "Rises", start, timeZone),
      detailRow("Highest", highest, timeZone),
      detailRow(fades ? "Fades out" : "Sets", end, timeZone),
    ],
  };
}

/**
 * Every visible pass that hasn't ended yet as a card, sorted by time across
 * satellites, split into tonight and later. (The API only returns upcoming
 * passes, but a page left open overnight would otherwise keep showing old ones.)
 * The cloud forecast only fills in each card's rating; it never filters or
 * reorders cards.
 */
export function buildPassCards(
  satellites: readonly SatellitePasses[],
  nowMs: number,
  timeZone: string,
  forecast: ForecastState,
): { tonight: PassCardModel[]; later: PassCardModel[] } {
  const cards: PassCardModel[] = [];
  for (const sat of satellites) {
    for (const pass of sat.passes) {
      const end = visiblePart(pass)?.end;
      if (end && ms(end.time) <= nowMs) continue;
      const card = passCard(sat.noradId, sat.nickname, pass, nowMs, timeZone, forecast);
      if (card) cards.push(card);
    }
  }
  cards.sort((a, b) => ms(a.startIso) - ms(b.startIso) || a.noradId - b.noradId);
  const tonight = cards.filter((c) => isTonight(c.startIso, nowMs, timeZone));
  const later = cards.filter((c) => !isTonight(c.startIso, nowMs, timeZone));
  return { tonight, later };
}
