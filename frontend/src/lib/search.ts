/**
 * Satellite search in the browser, over the names the globe already has.
 * Ranking matches the API's `/api/satellites/?search=` (satellites/views.py):
 * exact name first, then names that start with the query, then names that
 * contain it; ties go to the lower NORAD ID (the older object). So "ISS"
 * puts ISS (ZARYA), NORAD 25544, first. Keep the two in step.
 */

export type SearchIndex = {
  noradIds: number[];
  names: string[];
  lowerNames: string[]; // lowercased once, not on every keystroke
};

export type SearchResult = {
  index: number; // position in the catalog (and in the worker's buffers)
  noradId: number;
  name: string;
};

export function buildSearchIndex(noradIds: number[], names: string[]): SearchIndex {
  return { noradIds, names, lowerNames: names.map((name) => name.toLowerCase()) };
}

const EXACT = 0;
const STARTS_WITH = 1;
const CONTAINS = 2;

/** Up to `limit` matches for `query`, best first. Blank queries match nothing. */
export function searchSatellites(index: SearchIndex, query: string, limit = 8): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: { index: number; rank: number }[] = [];
  for (let i = 0; i < index.lowerNames.length; i++) {
    const name = index.lowerNames[i];
    const at = name.indexOf(q);
    if (at === -1) continue;
    hits.push({ index: i, rank: name === q ? EXACT : at === 0 ? STARTS_WITH : CONTAINS });
  }

  hits.sort((a, b) => a.rank - b.rank || index.noradIds[a.index] - index.noradIds[b.index]);
  return hits.slice(0, limit).map(({ index: i }) => ({
    index: i,
    noradId: index.noradIds[i],
    name: index.names[i],
  }));
}
