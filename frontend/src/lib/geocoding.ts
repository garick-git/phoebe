/**
 * City search through Open-Meteo's free geocoding API (no key; data based on
 * GeoNames, CC BY 4.0; credited on the About page). Called from the browser
 * on purpose: Open-Meteo's free limits count per IP address, so each visitor
 * uses their own allowance instead of every visitor sharing the server's.
 * What someone types goes to Open-Meteo; no Referer is sent with it.
 */

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";

/** Open-Meteo returns nothing for 1 character; 2 must match a name exactly; 3+ match its start. */
export const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 8;

export type GeocodedPlace = {
  id: number;
  name: string;
  /** "Texas, United States" */
  detail: string;
  /** "Austin, Texas, United States" */
  label: string;
  lat: number;
  lon: number;
  /** IANA time zone, e.g. "America/Chicago"; null if Open-Meteo omits it. */
  timeZone: string | null;
};

// Answers kept for this page visit, so retyping a query costs no request.
const cache = new Map<string, GeocodedPlace[]>();
const CACHE_LIMIT = 50;

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<GeocodedPlace[]> {
  const q = query.trim();
  const key = q.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    name: q,
    count: String(MAX_RESULTS),
    language: "en",
    format: "json",
  });
  const response = await fetch(`${GEOCODING_URL}?${params}`, {
    signal,
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error(`City search failed: HTTP ${response.status}`);

  // No matches → no `results` key at all (Open-Meteo omits empty fields).
  const body = (await response.json()) as { results?: unknown[] };
  const places = (body.results ?? []).flatMap(toPlace);

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, places);
  return places;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}

/** One API result → zero or one place (outside data: check every field we use). */
function toPlace(raw: unknown): GeocodedPlace[] {
  if (typeof raw !== "object" || raw === null) return [];
  const r = raw as Record<string, unknown>;
  const name = text(r.name);
  if (!name || typeof r.id !== "number" || !finite(r.latitude, 90) || !finite(r.longitude, 180)) {
    return [];
  }
  // Drop repeats, e.g. Singapore, Singapore, Singapore.
  const parts = [name, text(r.admin1), text(r.country)].filter(
    (part, i, all): part is string => part !== null && all.indexOf(part) === i,
  );
  return [
    {
      id: r.id,
      name,
      detail: parts.slice(1).join(", "),
      label: parts.join(", "),
      lat: r.latitude,
      lon: r.longitude,
      timeZone: text(r.timezone),
    },
  ];
}
