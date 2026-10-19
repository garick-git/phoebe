/**
 * A place to predict passes for, and how it lives in Tonight's URL:
 *
 *   /tonight/?lat=30.27&lon=-97.74&place=Austin%2C+Texas%2C+United+States&tz=America%2FChicago
 *
 * The coordinates decide the passes; `place` is only a label, and `tz` is the
 * time zone the times are shown in (the place's, not the viewer's, so a shared
 * link reads the same for everyone). Coordinates never carry more than
 * 2 decimals (about 1 km), in the URL or in any request (brief, location
 * privacy). No React here, so Vitest can test it directly.
 */

export type Place = {
  lat: number;
  lon: number;
  /** Untrusted text from the URL; always rendered as text, never as HTML. */
  label: string | null;
  timeZone: string;
};

export const MAX_LABEL_LENGTH = 80;

/** Round to 2 decimals. `+ 0` turns -0 into 0, like the API's round_location(). */
export function roundCoord(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

// Plain decimal numbers only. Number() alone would accept "", " ", "1e1",
// "0x1E" and "Infinity", and "" even becomes 0, which is a real latitude.
const DECIMAL = /^-?\d{1,3}(\.\d+)?$/;

function parseCoord(raw: string | null, limit: number): number | null {
  if (raw === null || !DECIMAL.test(raw)) return null;
  const value = Number(raw);
  return Math.abs(value) <= limit ? value : null;
}

export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false; // RangeError: Invalid time zone
  }
}

/** Control characters out, whitespace collapsed, at most 80 characters; null if empty. */
export function cleanLabel(raw: string | null): string | null {
  if (raw === null) return null;
  const text = raw
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH)
    .trim();
  return text || null;
}

export type ParsedPlace = { kind: "none" } | { kind: "invalid" } | { kind: "ok"; place: Place };

/**
 * Read a place from the URL. No `lat`/`lon` at all → "none" (show the search);
 * anything malformed or out of range → "invalid". Precise coordinates are
 * rounded; a missing or unknown time zone falls back to `fallbackTimeZone`.
 */
export function parsePlace(
  params: { get(name: string): string | null },
  fallbackTimeZone: string,
): ParsedPlace {
  const rawLat = params.get("lat");
  const rawLon = params.get("lon");
  if (rawLat === null && rawLon === null) return { kind: "none" };

  const lat = parseCoord(rawLat, 90);
  const lon = parseCoord(rawLon, 180);
  if (lat === null || lon === null) return { kind: "invalid" };

  const tz = params.get("tz");
  return {
    kind: "ok",
    place: {
      lat: roundCoord(lat),
      lon: roundCoord(lon),
      label: cleanLabel(params.get("place")),
      timeZone: tz && isValidTimeZone(tz) ? tz : fallbackTimeZone,
    },
  };
}

/** The canonical query string for a place (always rounded, fixed order). */
export function placeSearchParams(place: Place): URLSearchParams {
  const params = new URLSearchParams();
  params.set("lat", String(roundCoord(place.lat)));
  params.set("lon", String(roundCoord(place.lon)));
  if (place.label) params.set("place", place.label);
  params.set("tz", place.timeZone);
  return params;
}

/** "30.27°N, 97.74°W" */
export function formatCoords(lat: number, lon: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}°${ns}, ${Math.abs(lon).toFixed(2)}°${ew}`;
}
