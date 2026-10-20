/**
 * Well-known satellites bright enough to see with the naked eye, with the
 * names people actually use. One list for both screens: Tonight checks these
 * for visible passes, and the globe's search finds them by nickname ("Hubble"
 * finds HST, "Tiangong" finds CSS (TIANHE)). No React, so Vitest can test it.
 *
 * Starlink trains are left out on purpose (Oct 19 decision): a "train" is a
 * fresh launch batch whose NORAD IDs change with every launch.
 */

export type PopularSatellite = {
  noradId: number;
  /** Short name shown on Tonight and next to CelesTrak's name in search. */
  nickname: string;
  /** The nickname as it reads mid-sentence: "the ISS", "Tiangong", "Hubble". */
  inSentence: string;
  fullName: string;
  /** Lowercase; a query that matches the start of any alias finds it. */
  aliases: readonly string[];
};

export const POPULAR_SATELLITES: readonly PopularSatellite[] = [
  {
    noradId: 25544,
    nickname: "ISS",
    inSentence: "the ISS",
    fullName: "International Space Station",
    aliases: ["iss", "space station", "international space station", "zarya"],
  },
  {
    noradId: 48274,
    nickname: "Tiangong",
    inSentence: "Tiangong",
    fullName: "Tiangong space station",
    aliases: ["tiangong", "chinese space station", "css", "tianhe"],
  },
  {
    noradId: 20580,
    nickname: "Hubble",
    inSentence: "Hubble",
    fullName: "Hubble Space Telescope",
    aliases: ["hubble", "hst", "hubble space telescope"],
  },
];

// One letter would pull these to the top of almost every search ("c" → css).
const MIN_ALIAS_QUERY = 2;

const BY_NORAD_ID = new Map(POPULAR_SATELLITES.map((sat) => [sat.noradId, sat]));

export function popularSatellite(noradId: number): PopularSatellite | undefined {
  return BY_NORAD_ID.get(noradId);
}

/** NORAD IDs of popular satellites with an alias that starts with `query`. */
export function nicknameMatches(query: string): Set<number> {
  const q = query.trim().toLowerCase();
  const ids = new Set<number>();
  if (q.length < MIN_ALIAS_QUERY) return ids;
  for (const sat of POPULAR_SATELLITES) {
    if (sat.aliases.some((alias) => alias.startsWith(q))) ids.add(sat.noradId);
  }
  return ids;
}
