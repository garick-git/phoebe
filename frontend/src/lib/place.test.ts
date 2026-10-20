import { describe, expect, it } from "vitest";

import {
  MAX_LABEL_LENGTH,
  cleanLabel,
  formatCoords,
  parsePlace,
  placeSearchParams,
  roundCoord,
} from "@/lib/place";

const FALLBACK_TZ = "America/New_York";

function parse(query: string) {
  return parsePlace(new URLSearchParams(query), FALLBACK_TZ);
}

describe("parsePlace", () => {
  it("returns none when the URL has no coordinates at all", () => {
    expect(parse("")).toEqual({ kind: "none" });
    expect(parse("place=Austin")).toEqual({ kind: "none" });
  });

  it("rounds precise coordinates to 2 decimals (about 1 km)", () => {
    const result = parse(
      "lat=30.26715&lon=-97.74306&place=Austin%2C+Texas%2C+United+States&tz=America%2FChicago",
    );
    expect(result).toEqual({
      kind: "ok",
      place: {
        lat: 30.27,
        lon: -97.74,
        label: "Austin, Texas, United States",
        timeZone: "America/Chicago",
      },
    });
  });

  it.each([
    ["an empty latitude (Number('') would be 0, a real latitude)", "lat=&lon=-97.74"],
    ["exponent notation", "lat=1e1&lon=-97.74"],
    ["hexadecimal", "lat=0x1E&lon=-97.74"],
    ["Infinity", "lat=Infinity&lon=-97.74"],
    ["a latitude past the pole", "lat=91&lon=-97.74"],
    ["a longitude past the date line", "lat=30.27&lon=180.5"],
    ["a missing longitude", "lat=30.27"],
    ["words", "lat=north&lon=west"],
  ])("rejects %s", (_why, query) => {
    expect(parse(query)).toEqual({ kind: "invalid" });
  });

  it("accepts the exact limits", () => {
    expect(parse("lat=-90&lon=180")).toMatchObject({ kind: "ok", place: { lat: -90, lon: 180 } });
  });

  it("turns -0.001 into a plain 0, not -0", () => {
    const result = parse("lat=-0.001&lon=-0.001");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(Object.is(result.place.lat, 0)).toBe(true);
    expect(Object.is(result.place.lon, 0)).toBe(true);
    // ...so the canonical URL never says "-0".
    expect(placeSearchParams(result.place).get("lat")).toBe("0");
  });

  it("falls back to the given time zone when tz is unknown or missing", () => {
    expect(parse("lat=30.27&lon=-97.74&tz=Mars%2FOlympus_Mons")).toMatchObject({
      place: { timeZone: FALLBACK_TZ },
    });
    expect(parse("lat=30.27&lon=-97.74")).toMatchObject({ place: { timeZone: FALLBACK_TZ } });
  });

  it("treats a blank label as no label", () => {
    expect(parse("lat=30.27&lon=-97.74&place=%20%20")).toMatchObject({ place: { label: null } });
  });
});

describe("placeSearchParams", () => {
  it("writes the canonical, rounded query string in a fixed order", () => {
    const params = placeSearchParams({
      lat: 30.26715,
      lon: -97.74306,
      label: "Austin, Texas, United States",
      timeZone: "America/Chicago",
    });
    expect(params.toString()).toBe(
      "lat=30.27&lon=-97.74&place=Austin%2C+Texas%2C+United+States&tz=America%2FChicago",
    );
  });

  it("leaves out place when there is no label", () => {
    const params = placeSearchParams({ lat: 1, lon: 2, label: null, timeZone: "UTC" });
    expect(params.toString()).toBe("lat=1&lon=2&tz=UTC");
  });

  it("round-trips through parsePlace unchanged", () => {
    const place = { lat: 41.88, lon: -87.63, label: "Chicago, Illinois, United States", timeZone: "America/Chicago" };
    expect(parsePlace(placeSearchParams(place), FALLBACK_TZ)).toEqual({ kind: "ok", place });
  });
});

describe("cleanLabel", () => {
  it("removes control characters and collapses spaces", () => {
    expect(cleanLabel("  Austin\u0000,\u0007   Texas,\u001b United States ")).toBe(
      "Austin, Texas, United States",
    );
  });

  it("removes tabs and newlines too (they are control characters), without adding a space", () => {
    expect(cleanLabel("Austin,\nTexas")).toBe("Austin,Texas");
  });

  it("caps the label at 80 characters", () => {
    const long = "A".repeat(200);
    expect(cleanLabel(long)).toHaveLength(MAX_LABEL_LENGTH);
  });

  it("trims a space left at the cut", () => {
    const label = `${"A".repeat(MAX_LABEL_LENGTH - 1)} BBBB`;
    expect(cleanLabel(label)).toBe("A".repeat(MAX_LABEL_LENGTH - 1));
  });

  it("returns null for nothing or only control characters", () => {
    expect(cleanLabel(null)).toBeNull();
    expect(cleanLabel("\u0000\u001f")).toBeNull();
  });
});

describe("roundCoord and formatCoords", () => {
  it("rounds to 2 decimals", () => {
    expect(roundCoord(30.26715)).toBe(30.27);
    expect(roundCoord(-97.74306)).toBe(-97.74);
  });

  it("formats with hemispheres instead of signs", () => {
    expect(formatCoords(30.27, -97.74)).toBe("30.27°N, 97.74°W");
    expect(formatCoords(-33.87, 151.21)).toBe("33.87°S, 151.21°E");
  });
});
