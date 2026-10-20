import { describe, expect, it } from "vitest";

import { buildSearchIndex, searchSatellites } from "@/lib/search";

// Real NORAD IDs and CelesTrak names.
const CATALOG: [number, string][] = [
  [69796, "ISS OBJECT YM"],
  [49044, "ISS (NAUKA)"],
  [25544, "ISS (ZARYA)"],
  [37772, "ARISSAT-1"],
  [20580, "HST"],
  [48274, "CSS (TIANHE)"],
  [22675, "COSMOS 2251"],
  [44714, "STARLINK-1008"],
];

const index = buildSearchIndex(
  CATALOG.map(([id]) => id),
  CATALOG.map(([, name]) => name),
);

function names(query: string, limit?: number) {
  return searchSatellites(index, query, limit).map((r) => r.name);
}

describe("searchSatellites", () => {
  it('ranks "ISS" exactly like the API (satellites/tests/test_api.py)', () => {
    // Same catalog and expected order as test_search_ranks_best_matches_first,
    // so the browser's ranking and the API's can't drift apart silently.
    expect(names("iss")).toEqual(["ISS (ZARYA)", "ISS (NAUKA)", "ISS OBJECT YM", "ARISSAT-1"]);
    expect(names("ISS")).toEqual(names("iss"));
  });

  it("ranks exact, then starts with, then contains, even against NORAD order", () => {
    // Made-up IDs: the lowest ID has the weakest match.
    const small = buildSearchIndex([50, 900, 100], ["MY TEST SAT", "TEST SAT 2", "TEST SAT"]);
    expect(searchSatellites(small, "test sat").map((r) => r.name)).toEqual([
      "TEST SAT",
      "TEST SAT 2",
      "MY TEST SAT",
    ]);
  });

  it("breaks ties by NORAD ID, oldest object first", () => {
    // "s": only STARLINK starts with it; the rest contain it.
    expect(names("s")).toEqual([
      "STARLINK-1008",
      "HST", // 20580
      "COSMOS 2251", // 22675
      "ISS (ZARYA)", // 25544
      "ARISSAT-1", // 37772
      "CSS (TIANHE)", // 48274
      "ISS (NAUKA)", // 49044
      "ISS OBJECT YM", // 69796
    ]);
  });

  it('ranks a nickname match first: "hub" finds HST and labels it Hubble', () => {
    const [first] = searchSatellites(index, "hub");
    expect(first).toMatchObject({ noradId: 20580, name: "HST", nickname: "Hubble" });
  });

  it('finds Tiangong by a name CelesTrak doesn\'t use: "tiangong" → CSS (TIANHE)', () => {
    expect(searchSatellites(index, "tiangong")).toEqual([
      { index: 5, noradId: 48274, name: "CSS (TIANHE)", nickname: "Tiangong" },
    ]);
  });

  it("doesn't repeat a nickname the name already contains", () => {
    const [iss] = searchSatellites(index, "iss");
    expect(iss.noradId).toBe(25544);
    expect(iss.nickname).toBeUndefined();
  });

  it('gives no nickname boost to a single letter: "c" ranks COSMOS before CSS by NORAD ID', () => {
    expect(names("c")[0]).toBe("COSMOS 2251");
    expect(names("c")[1]).toBe("CSS (TIANHE)");
  });

  it("matches nothing for a blank query and respects the limit", () => {
    expect(names("   ")).toEqual([]);
    expect(names("s", 2)).toHaveLength(2);
  });
});
