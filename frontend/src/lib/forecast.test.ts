import { describe, expect, it } from "vitest";

import { parseCloudForecast } from "@/lib/forecast";

/** Oct 21, 2026 at hh:00 UTC, in ms. */
const at = (hh: number) => Date.UTC(2026, 9, 21, hh);

describe("parseCloudForecast (Open-Meteo's JSON)", () => {
  it("turns unix seconds into ms and keeps valid percentages", () => {
    const t = at(10) / 1000;
    const parsed = parseCloudForecast({ hourly: { time: [t, t + 3600], cloud_cover: [0, 100] } });
    expect([...parsed]).toEqual([
      [at(10), 0],
      [at(11), 100],
    ]);
  });

  it("turns out-of-range, missing or non-numeric values into no data (null), never a guess", () => {
    const t = at(10) / 1000;
    const parsed = parseCloudForecast({
      hourly: { time: [t, t + 3600, t + 7200, t + 10800], cloud_cover: [150, null, "40", -1] },
    });
    expect([...parsed.values()]).toEqual([null, null, null, null]);
  });

  it("skips hours whose time isn't a whole number", () => {
    const parsed = parseCloudForecast({ hourly: { time: ["2026-10-21T10:00", 1.5], cloud_cover: [10, 20] } });
    expect(parsed.size).toBe(0);
  });

  it.each([
    ["null", null],
    ["a string", "oops"],
    ["no hourly block", {}],
    ["missing cloud_cover", { hourly: { time: [1] } }],
    ["arrays of different lengths", { hourly: { time: [1, 2], cloud_cover: [10] } }],
  ])("throws for a malformed body: %s", (_why, body) => {
    expect(() => parseCloudForecast(body)).toThrow("Cloud forecast: unexpected response");
  });
});
