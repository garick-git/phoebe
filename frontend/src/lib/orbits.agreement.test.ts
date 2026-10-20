/**
 * JavaScript half of the Python vs JavaScript position agreement test.
 *
 * SGP4 runs in two places (brief, section 4): satellite.js here for the globe,
 * skyfield on the server for passes. The reference answers come from
 * compute_position() in a fixture that the back end's pytest
 * (satellites/tests/test_agreement.py) keeps current; this file checks that
 * the browser's code lands on the same spots. Same element sets, in the shape
 * /api/satellites/elements/ sends them, through the real trackSatellites() →
 * positionsAt() / packedPositionsAt() path.
 *
 * Tolerances (decided Oct 20; Oct 15's one-off check measured 27–44 m):
 * 100 m on the ground, 10 m of altitude, 1 m/s of speed. A real bug is far
 * bigger: a one-second timing slip moves the ISS about 7.6 km, and a wrong
 * frame or unit is off by kilometres.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  packedPositionAt,
  packedPositionsAt,
  positionsAt,
  trackSatellites,
  type ElementSetRow,
} from "@/lib/orbits";

type ReferencePosition = {
  time: string;
  latitude: number;
  longitude: number;
  altitude_km: number;
  speed_km_s: number;
};

type Fixture = {
  satellites: { element_set: ElementSetRow; positions: ReferencePosition[] }[];
};

// Lives with the back-end tests (so it is inside the Django image too) and
// is read from here by path; no network needed.
const fixture: Fixture = JSON.parse(
  readFileSync(
    new URL("../../../satellites/tests/fixtures/position_agreement.json", import.meta.url),
    "utf8",
  ),
);

const MAX_GROUND_KM = 0.1;
const MAX_ALTITUDE_KM = 0.01;
const MAX_SPEED_KM_S = 0.001;

/** Great-circle distance on a sphere of Earth's mean radius, in km. */
function groundDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad; // the sine below makes ±180° wraparound harmless
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const rows = fixture.satellites.map((s) => s.element_set);
const tracked = trackSatellites(rows);

const cases = fixture.satellites.flatMap((sat, satIndex) =>
  sat.positions.map((ref) => ({ name: sat.element_set.name, satIndex, ref })),
);

describe("browser (satellite.js) vs server (skyfield) positions", () => {
  it("covers all five reference satellites and parses every element set", () => {
    expect(fixture.satellites).toHaveLength(5);
    expect(tracked.map((t) => t.noradId)).toEqual(rows.map((r) => r.norad_cat_id));
  });

  it.each(cases)("$name at $ref.time: positionsAt()", ({ satIndex, ref }) => {
    const [got] = positionsAt([tracked[satIndex]], new Date(ref.time));
    expect(got).toBeDefined();
    expect(groundDistanceKm(got.lat, got.lng, ref.latitude, ref.longitude)).toBeLessThan(MAX_GROUND_KM);
    expect(Math.abs(got.altitudeKm - ref.altitude_km)).toBeLessThan(MAX_ALTITUDE_KM);
  });

  it.each(cases)("$name at $ref.time: packedPositionsAt() with speed", ({ satIndex, ref }) => {
    // The globe's worker path: all satellites in one Float32Array.
    const packed = packedPositionsAt(tracked, new Date(ref.time));
    const got = packedPositionAt(packed, satIndex);
    expect(got).not.toBeNull();
    expect(groundDistanceKm(got!.lat, got!.lng, ref.latitude, ref.longitude)).toBeLessThan(MAX_GROUND_KM);
    expect(Math.abs(got!.altitudeKm - ref.altitude_km)).toBeLessThan(MAX_ALTITUDE_KM);
    expect(Math.abs(got!.speedKmS - ref.speed_km_s)).toBeLessThan(MAX_SPEED_KM_S);
  });
});
