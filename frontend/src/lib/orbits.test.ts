import { describe, expect, it } from "vitest";

import {
  PACKED_STRIDE,
  PATH_STRIDE,
  orbitPath,
  orbitPeriodMinutes,
  packedPositionAt,
  packedPositionsAt,
  positionsAt,
  trackSatellites,
  type ElementSetRow,
} from "@/lib/orbits";

// Real element sets from CelesTrak's Oct 6 download, in the shape
// /api/satellites/elements/ sends. (Agreement with the server's positions is
// checked separately in orbits.agreement.test.ts.)
const ISS: ElementSetRow = {
  norad_cat_id: 25544,
  name: "ISS (ZARYA)",
  epoch: "2026-10-06T00:20:47.860512Z",
  mean_motion: 15.48747543,
  eccentricity: 0.00068585,
  inclination: 51.6314,
  ra_of_asc_node: 111.6262,
  arg_of_pericenter: 227.8987,
  mean_anomaly: 132.1419,
  bstar: 0.00010208237,
  mean_motion_dot: 5.131e-5,
  mean_motion_ddot: 0,
};

const GOES_16: ElementSetRow = {
  norad_cat_id: 41866,
  name: "GOES 16",
  epoch: "2026-10-06T05:24:12.720672Z",
  mean_motion: 1.00271073,
  eccentricity: 0.00022302,
  inclination: 0.6106,
  ra_of_asc_node: 83.981,
  arg_of_pericenter: 149.2955,
  mean_anomaly: 117.9822,
  bstar: 0,
  mean_motion_dot: -1.08e-6,
  mean_motion_ddot: 0,
};

// Eccentricity 1.5 is not an orbit: SGP4 refuses it.
const BROKEN: ElementSetRow = { ...ISS, norad_cat_id: 99999, name: "BROKEN", eccentricity: 1.5 };

const WHEN = new Date("2026-10-08T00:00:00Z");

describe("positionsAt", () => {
  it("puts the ISS where physics allows: within its inclination, at ISS height and speed", () => {
    const tracked = trackSatellites([ISS]);
    for (let minutes = 0; minutes < 24 * 60; minutes += 30) {
      const [p] = positionsAt(tracked, new Date(WHEN.getTime() + minutes * 60_000));
      // A little over 51.63° is allowed because Earth is slightly flattened.
      expect(Math.abs(p.lat)).toBeLessThanOrEqual(51.63 + 0.25);
      expect(p.lng).toBeGreaterThanOrEqual(-180);
      expect(p.lng).toBeLessThanOrEqual(180);
      expect(p.altitudeKm).toBeGreaterThan(400);
      expect(p.altitudeKm).toBeLessThan(440);
    }
  });

  it("keeps a geostationary satellite over the equator at about 35,786 km", () => {
    const [p] = positionsAt(trackSatellites([GOES_16]), WHEN);
    expect(Math.abs(p.lat)).toBeLessThan(1);
    expect(p.altitudeKm).toBeGreaterThan(35_700);
    expect(p.altitudeKm).toBeLessThan(35_900);
  });

  it("leaves out a satellite SGP4 can't propagate, without hiding the others", () => {
    const tracked = trackSatellites([ISS, BROKEN, GOES_16]);
    expect(tracked).toHaveLength(3); // satellite.js parses it; SGP4 is what fails
    expect(positionsAt(tracked, WHEN).map((p) => p.noradId)).toEqual([25544, 41866]);
  });
});

describe("packedPositionsAt and packedPositionAt", () => {
  const tracked = trackSatellites([ISS, BROKEN, GOES_16]);
  const packed = packedPositionsAt(tracked, WHEN);

  it("packs latitude, longitude, altitude and speed per satellite, in input order", () => {
    expect(packed).toHaveLength(3 * PACKED_STRIDE);
    const [iss, goes] = positionsAt(tracked, WHEN);
    // Float32 keeps about 7 significant digits: about 1 m of latitude/longitude.
    expect(packedPositionAt(packed, 0)).toMatchObject({
      lat: expect.closeTo(iss.lat, 4),
      lng: expect.closeTo(iss.lng, 4),
      altitudeKm: expect.closeTo(iss.altitudeKm, 2),
    });
    expect(packedPositionAt(packed, 2)?.lat).toBeCloseTo(goes.lat, 4);
  });

  it("includes speed relative to Earth's center (about 7.66 km/s for the ISS, 3.07 for GOES)", () => {
    expect(packedPositionAt(packed, 0)?.speedKmS).toBeCloseTo(7.66, 1);
    expect(packedPositionAt(packed, 2)?.speedKmS).toBeCloseTo(3.07, 1);
  });

  it("returns null for a satellite with no position and for an index past the end", () => {
    expect(Number.isNaN(packed[1 * PACKED_STRIDE])).toBe(true);
    expect(packedPositionAt(packed, 1)).toBeNull();
    expect(packedPositionAt(packed, 3)).toBeNull();
  });
});

describe("orbitPath", () => {
  const [iss] = trackSatellites([ISS]);

  it("computes the ISS's period from its mean motion: about 93 minutes", () => {
    expect(orbitPeriodMinutes(ISS.mean_motion)).toBeCloseTo(92.98, 2);
  });

  it("samples one ISS orbit every 30 s (187 points)", () => {
    expect(orbitPath(iss, WHEN)).toHaveLength(187 * PATH_STRIDE);
  });

  it("starts on the satellite and ends about 23° west, because Earth turns under it", () => {
    const path = orbitPath(iss, WHEN);
    const [now] = positionsAt([iss], WHEN);
    expect(path[0]).toBeCloseTo(now.lat, 4);
    expect(path[1]).toBeCloseTo(now.lng, 4);

    const last = path.length - PATH_STRIDE;
    // One orbit later it's back at the same latitude...
    expect(path[last]).toBeCloseTo(now.lat, 0);
    // ...but the ground has moved east under it (360° per sidereal day).
    const westward = ((now.lng - path[last + 1] + 540) % 360) - 180;
    expect(westward).toBeGreaterThan(22);
    expect(westward).toBeLessThan(24.5);
  });

  it("caps high orbits at 500 steps (501 points)", () => {
    const [goes] = trackSatellites([GOES_16]);
    expect(orbitPath(goes, WHEN)).toHaveLength(501 * PATH_STRIDE);
  });

  it("returns an empty path when there's no mean motion to work with", () => {
    expect(orbitPath({ ...iss, meanMotion: 0 }, WHEN)).toHaveLength(0);
  });
});
