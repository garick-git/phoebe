/**
 * Satellite categories, worked out in the browser from each satellite's name
 * and NORAD ID. The database has no category column (decided Oct 17: names
 * cost $0 and need no back-end change; CelesTrak's group files would be more
 * accurate but mean more daily downloads, a migration and ingest changes).
 *
 * This is an inference, so it is deliberately conservative: a satellite only
 * gets a named category when a rule matches it exactly, and everything else
 * lands in "Other satellites" instead of being guessed. Rules are anchored to
 * the start of the name; a loose match is how GSAT (India's communications
 * satellites) once got mistaken for GSAT0xxx (Galileo navigation).
 *
 * Measured against CelesTrak's own group lists on Oct 16 (a one-off download):
 * weather 73/73, navigation 156/169 (13 left out on purpose, see below),
 * OneWeb + Kuiper + Iridium NEXT 1,122/1,122.
 *
 * No imports, so it can be tested on its own (Vitest, Oct 24).
 */

export const CATEGORIES = [
  { id: "stations", label: "Space stations" },
  { id: "starlink", label: "Starlink" },
  { id: "constellations", label: "Communications constellations" },
  { id: "navigation", label: "Navigation" },
  { id: "weather", label: "Weather" },
  { id: "other", label: "Other satellites" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];

/** Position of a category in CATEGORIES (small numbers fit in a Uint8Array). */
const INDEX: Record<CategoryId, number> = {
  stations: 0,
  starlink: 1,
  constellations: 2,
  navigation: 3,
  weather: 4,
  other: 5,
};

// One dot per station: the core module that represents each one. CelesTrak
// also tracks the other modules (ISS (UNITY), ISS (ZVEZDA), CSS (WENTIAN)…)
// as separate objects, but they are bolted together, so they would stack on the
// same spot and a click could open "ISS (UNITY)" instead of the ISS. They (and
// visiting ships such as Soyuz or Dragon) stay under All / Other satellites.
// Decided Oct 16 after comparing with CelesTrak's "stations" group (21 objects:
// modules, visiting ships, small satellites just released from the ISS, debris).
const STATION_IDS = new Set([
  25544, // ISS (ZARYA)
  48274, // CSS (TIANHE), the Tiangong space station
]);

const STARLINK = /^STARLINK/;

const CONSTELLATIONS =
  /^(ONEWEB|IRIDIUM|GLOBALSTAR|ORBCOMM|KUIPER|QIANFAN|GUOWANG|HULIANWANG|O3B)\b/;

// GPS is listed as NAVSTAR; Galileo as GSAT0xxx (not India's GSAT-7, GSAT-10…);
// GLONASS as "COSMOS 24xx [GLONASS-M]"; plus Japan's and India's regional systems.
// Checked against CelesTrak's "gnss" group on Oct 16: 156 of 169 caught. The 13
// left out on purpose are communications satellites that also carry a GPS
// correction payload (WAAS, EGNOS, GAGAN, SDCM), such as Inmarsat 4-F2 or Luch-5A.
const NAVIGATION = /^(NAVSTAR|BEIDOU|GSAT0\d{3}|QZS-|IRNSS-|NVS-)|\[GLONASS/;

// Checked against CelesTrak's own "weather" group on Oct 16 (73 of 73 caught).
// "EWS-G2 (GOES 15)" is a GOES satellite the US military renamed, so the name
// has to be matched inside the parentheses too. MTG = Meteosat Third Generation,
// CYGFM = NASA's CYGNSS hurricane-wind satellites, SENTINEL-3 (not 1, 2 or 6).
const WEATHER =
  /^(NOAA |GOES|METEOSAT|METOP|FENGYUN|HIMAWARI|METEOR-M|DMSP|SUOMI NPP|MTG-|INSAT-3D|ELEKTRO-L|ARKTIKA-M|GEO-KOMPSAT-2A|SENTINEL-3|TIANMU-1|CYGFM)|\(GOES \d+\)/;

/** Which category a satellite belongs to (an index into CATEGORIES). */
export function categoryIndex(noradId: number, name: string): number {
  if (STATION_IDS.has(noradId)) return INDEX.stations;
  if (STARLINK.test(name)) return INDEX.starlink;
  if (CONSTELLATIONS.test(name)) return INDEX.constellations;
  if (NAVIGATION.test(name)) return INDEX.navigation;
  if (WEATHER.test(name)) return INDEX.weather;
  return INDEX.other;
}

/**
 * Categorize the whole catalog once, when it loads. `byIndex[i]` is satellite
 * i's category (same order as the worker's buffers); `counts[c]` is how many
 * satellites each category holds.
 */
export function categorizeAll(noradIds: number[], names: string[]) {
  const byIndex = new Uint8Array(noradIds.length);
  const counts: number[] = CATEGORIES.map(() => 0);
  for (let i = 0; i < noradIds.length; i++) {
    const c = categoryIndex(noradIds[i], names[i]);
    byIndex[i] = c;
    counts[c]++;
  }
  return { byIndex, counts };
}
