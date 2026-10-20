import { describe, expect, it } from "vitest";

import { CATEGORIES, categorizeAll, categoryIndex, type CategoryId } from "@/lib/categories";

function category(noradId: number, name: string): CategoryId {
  return CATEGORIES[categoryIndex(noradId, name)].id;
}

// Cases from the Oct 16 audit against CelesTrak's own group files. Real
// NORAD IDs where it matters (stations are matched by ID, not by name).
describe("categoryIndex", () => {
  it.each([
    [25544, "ISS (ZARYA)", "stations"],
    [48274, "CSS (TIANHE)", "stations"],
    // Other ISS modules and objects stay out, so one dot means one station.
    [25575, "ISS (UNITY)", "other"],
    [69796, "ISS OBJECT YM", "other"],
  ] as const)("%i %s → %s", (id, name, expected) => {
    expect(category(id, name)).toBe(expected);
  });

  it.each([
    ["STARLINK-1008", "starlink"],
    ["ONEWEB-0012", "constellations"],
    ["KUIPER-00001", "constellations"],
    ["IRIDIUM 106", "constellations"],
    ["NAVSTAR 81 (USA 319)", "navigation"],
    ["GSAT0101 (GALILEO-PFM)", "navigation"],
    ["COSMOS 2433 [GLONASS-M]", "navigation"],
    ["BEIDOU-3 M1", "navigation"],
    // India's GSAT-7 is a communications satellite, not Galileo's GSAT0xxx.
    ["GSAT-7", "other"],
    ["NOAA 19", "weather"],
    ["GOES 16", "weather"],
    // A GOES satellite the US military renamed: matched inside the parentheses.
    ["EWS-G2 (GOES 15)", "weather"],
    ["MTG-I2", "weather"],
    ["SENTINEL-3A", "weather"],
    ["SENTINEL-2A", "other"],
    ["HST", "other"],
  ] as const)("%s → %s", (name, expected) => {
    expect(category(99999, name)).toBe(expected);
  });

  it("anchors name rules to the start of the name", () => {
    expect(category(99999, "NOT STARLINK")).toBe("other");
    expect(category(99999, "XNOAA 19")).toBe("other");
  });
});

describe("categorizeAll", () => {
  it("returns each satellite's category and the count per category", () => {
    const { byIndex, counts } = categorizeAll(
      [25544, 44714, 41866, 20580, 99999],
      ["ISS (ZARYA)", "STARLINK-1008", "GOES 16", "HST", "STARLINK-9999"],
    );
    expect(Array.from(byIndex, (c) => CATEGORIES[c].id)).toEqual([
      "stations",
      "starlink",
      "weather",
      "other",
      "starlink",
    ]);
    expect(counts).toEqual([1, 2, 0, 0, 1, 1]);
    expect(counts).toHaveLength(CATEGORIES.length);
  });
});
