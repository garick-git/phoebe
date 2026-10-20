import { describe, expect, it } from "vitest";

import type { CloudForecast } from "@/lib/forecast";
import {
  hoursSpanned,
  ratingFor,
  viewingFor,
  viewingText,
  worstCloud,
  type ForecastState,
} from "@/lib/viewing";

const HOUR = 3_600_000;
/** Oct 21, 2026 at hh:mm UTC, in ms. */
const at = (hh: number, mm = 0) => Date.UTC(2026, 9, 21, hh, mm);
const iso = (ms: number) => new Date(ms).toISOString();

function forecast(entries: [number, number | null][]): CloudForecast {
  return new Map(entries);
}

describe("ratingFor", () => {
  it.each([
    [0, "good"],
    [25, "good"],
    [25.5, "fair"],
    [50, "fair"],
    [51, "poor"],
    [100, "poor"],
  ] as const)("%d%% → %s", (percent, rating) => {
    expect(ratingFor(percent)).toBe(rating);
  });
});

describe("hoursSpanned", () => {
  it("covers the hour before and after a pass inside one hour (2 hours)", () => {
    expect(hoursSpanned(at(10, 45), at(10, 50))).toEqual([at(10), at(11)]);
  });

  it("covers 3 hours when the pass crosses the top of an hour", () => {
    expect(hoursSpanned(at(10, 55), at(11, 5))).toEqual([at(10), at(11), at(12)]);
  });

  it("starts at that hour when the pass starts exactly on the hour", () => {
    expect(hoursSpanned(at(11), at(11, 4))).toEqual([at(11), at(12)]);
  });
});

describe("worstCloud", () => {
  it("takes the cloudier hour", () => {
    const f = forecast([[at(10), 10], [at(11), 60]]);
    expect(worstCloud(f, at(10, 45), at(10, 50))).toEqual({ percent: 60, hourMs: at(11) });
  });

  it("takes the earlier hour on a tie", () => {
    const f = forecast([[at(10), 40], [at(11), 40]]);
    expect(worstCloud(f, at(10, 45), at(10, 50))).toEqual({ percent: 40, hourMs: at(10) });
  });

  it("returns null when an hour has no value, rather than rating from part of the window", () => {
    expect(worstCloud(forecast([[at(10), 10], [at(11), null]]), at(10, 45), at(10, 50))).toBeNull();
  });

  it("returns null past the end of the forecast", () => {
    expect(worstCloud(forecast([[at(10), 10]]), at(10, 45), at(10, 50))).toBeNull();
  });
});

describe("viewingFor", () => {
  const now = at(0);
  const ok: ForecastState = {
    status: "ok",
    forecast: forecast([
      [at(10), 20],
      [at(11), 30],
      [at(0) + 72 * HOUR, 5],
      [at(1) + 72 * HOUR, 5],
    ]),
  };

  it("is loading while the forecast is loading, and unavailable after an error", () => {
    expect(viewingFor({ status: "loading" }, iso(at(10, 45)), iso(at(10, 50)), now)).toEqual({ status: "loading" });
    expect(viewingFor({ status: "error" }, iso(at(10, 45)), iso(at(10, 50)), now)).toEqual({ status: "unavailable" });
  });

  it("rates the pass from its cloudiest hour", () => {
    expect(viewingFor(ok, iso(at(10, 45)), iso(at(10, 50)), now)).toEqual({
      status: "rated",
      rating: "fair",
      percent: 30,
      hourMs: at(11),
      early: false,
    });
  });

  it("is unavailable when the forecast doesn't cover the pass", () => {
    expect(viewingFor(ok, iso(at(14)), iso(at(14, 5)), now)).toEqual({ status: "unavailable" });
  });

  it('says "early forecast" past 72 hours, but not at exactly 72 hours', () => {
    const exactly72 = at(0) + 72 * HOUR;
    expect(viewingFor(ok, iso(exactly72), iso(exactly72 + 60_000), now)).toMatchObject({ early: false });
    expect(viewingFor(ok, iso(exactly72 + 1000), iso(exactly72 + 60_000), now)).toMatchObject({ early: true });
  });
});

describe("viewingText", () => {
  it.each([
    [{ status: "loading" }, "Checking clouds…"],
    [{ status: "unavailable" }, "Cloud forecast unavailable"],
    [{ status: "rated", rating: "good", percent: 10, hourMs: 0, early: false }, "Good viewing · mostly clear"],
    [{ status: "rated", rating: "fair", percent: 40, hourMs: 0, early: false }, "Fair viewing · partly cloudy"],
    [{ status: "rated", rating: "poor", percent: 90, hourMs: 0, early: false }, "Poor viewing · cloudy"],
    [{ status: "rated", rating: "poor", percent: 90, hourMs: 0, early: true }, "Poor viewing · cloudy · early forecast"],
  ] as const)("%o → %s", (viewing, text) => {
    expect(viewingText(viewing)).toBe(text);
  });
});
