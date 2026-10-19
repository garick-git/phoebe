/**
 * Satellite search in the browser, over the names the globe already has.
 * Ranking matches the API's `/api/satellites/?search=` (satellites/views.py):
 * exact name first, then names that start with the query, then names that
 * contain it; ties go to the lower NORAD ID (the older object). So "ISS"
 * puts ISS (ZARYA), NORAD 25544, first. Keep the two in step.
 *
 * One addition the API doesn't have: a nickname match from the popular list
 * (lib/popular.ts) ranks above everything, so "hub" puts HST (Hubble) first
 * and "tiangong" finds CSS (TIANHE), whose CelesTrak names don't contain them.
 */

import { nicknameMatches, popularSatellite } from "@/lib/popular";

export type SearchIndex = {
  noradIds: number[];
  names: string[];
  lowerNames: string[]; // lowercased once, not on every keystroke
};

export type SearchResult = {
  index: number; // position in the catalog (and in the worker's buffers)
  noradId: number;
  name: string;
  /** Friendly name from the popular list, when CelesTrak's name doesn't already contain it. */
  nickname?: string;
};

export function buildSearchIndex(noradIds: number[], names: string[]): SearchIndex {
  return { noradIds, names, lowerNames: names.map((name) => name.toLowerCase()) };
}

const NICKNAME = -1;
const EXACT = 0;
const STARTS_WITH = 1;
const CONTAINS = 2;

/** Up to `limit` matches for `query`, best first. Blank queries match nothing. */
export function searchSatellites(index: SearchIndex, query: string, limit = 8): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const byNickname = nicknameMatches(q);
  const hits: { index: number; rank: number }[] = [];
  for (let i = 0; i < index.lowerNames.length; i++) {
    const name = index.lowerNames[i];
    const at = name.indexOf(q);
    const nicknameHit = byNickname.size > 0 && byNickname.has(index.noradIds[i]);
    if (at === -1 && !nicknameHit) continue;
    const rank = nicknameHit ? NICKNAME : name === q ? EXACT : at === 0 ? STARTS_WITH : CONTAINS;
    hits.push({ index: i, rank });
  }

  hits.sort((a, b) => a.rank - b.rank || index.noradIds[a.index] - index.noradIds[b.index]);
  return hits.slice(0, limit).map(({ index: i }) => {
    const nickname = popularSatellite(index.noradIds[i])?.nickname;
    const showNickname = nickname && !index.lowerNames[i].includes(nickname.toLowerCase());
    return {
      index: i,
      noradId: index.noradIds[i],
      name: index.names[i],
      ...(showNickname ? { nickname } : {}),
    };
  });
}
