/**
 * Orbital elements in, map positions out. The API sends each satellite's
 * newest element set once; satellite.js runs SGP4 in the browser to turn
 * those elements plus a moment in time into a position, so the server never
 * streams positions (brief section 4).
 */
import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
  type SatRec,
} from "satellite.js";

/** One row of GET /api/satellites/elements/ (names match the Django model). */
export type ElementSetRow = {
  norad_cat_id: number;
  name: string;
  epoch: string; // ISO 8601, UTC ("…Z")
  mean_motion: number; // revolutions per day
  eccentricity: number;
  inclination: number; // degrees
  ra_of_asc_node: number; // degrees
  arg_of_pericenter: number; // degrees
  mean_anomaly: number; // degrees
  bstar: number;
  mean_motion_dot: number;
  mean_motion_ddot: number;
};

export type TrackedSatellite = {
  noradId: number;
  name: string;
  satrec: SatRec;
  meanMotion: number; // revolutions per day (from the elements, for the orbit period)
  inclinationDeg: number;
};

export type SatellitePosition = {
  noradId: number;
  name: string;
  lat: number; // degrees
  lng: number; // degrees
  altitudeKm: number; // above the WGS84 ellipsoid
};

/** Mean Earth radius; the globe measures altitude in Earth radii. */
export const EARTH_RADIUS_KM = 6371;

/** Our API's field names → the CelesTrak OMM names json2satrec reads. */
export function toSatrec(row: ElementSetRow): SatRec {
  return json2satrec({
    OBJECT_NAME: row.name,
    OBJECT_ID: "", // required by the type, not used by SGP4
    NORAD_CAT_ID: row.norad_cat_id,
    ELEMENT_SET_NO: 0, // required by the type, not used by SGP4
    EPOCH: row.epoch,
    MEAN_MOTION: row.mean_motion,
    ECCENTRICITY: row.eccentricity,
    INCLINATION: row.inclination,
    RA_OF_ASC_NODE: row.ra_of_asc_node,
    ARG_OF_PERICENTER: row.arg_of_pericenter,
    MEAN_ANOMALY: row.mean_anomaly,
    BSTAR: row.bstar,
    MEAN_MOTION_DOT: row.mean_motion_dot,
    MEAN_MOTION_DDOT: row.mean_motion_ddot,
  });
}

/** Build satellite.js records once; rows it can't parse are skipped. */
export function trackSatellites(rows: ElementSetRow[]): TrackedSatellite[] {
  const tracked: TrackedSatellite[] = [];
  for (const row of rows) {
    try {
      tracked.push({
        noradId: row.norad_cat_id,
        name: row.name,
        satrec: toSatrec(row),
        meanMotion: row.mean_motion,
        inclinationDeg: row.inclination,
      });
    } catch {
      // Malformed elements for one satellite shouldn't hide the other 16,000.
    }
  }
  return tracked;
}

/** One satellite's position at `date`, or null if SGP4 can't propagate it. */
function geodeticAt(satrec: SatRec, date: Date, gmst: number) {
  // No result (or, in older satellite.js versions, `false`) means SGP4
  // couldn't propagate this satellite to this time.
  const state = propagate(satrec, date);
  const position = state?.position;
  if (!position || typeof position !== "object") return null;
  const geo = eciToGeodetic(position, gmst);
  if (!Number.isFinite(geo.height) || geo.height < 0) return null;
  // SGP4 returns the velocity too (km/s). Its length is the speed relative to
  // Earth's center, the same definition the API's position endpoint uses.
  const velocity = state?.velocity;
  const speedKmS =
    velocity && typeof velocity === "object" ? Math.hypot(velocity.x, velocity.y, velocity.z) : NaN;
  return {
    lat: degreesLat(geo.latitude),
    lng: degreesLong(geo.longitude),
    altitudeKm: geo.height,
    speedKmS,
  };
}

/**
 * Where every satellite is at `date`. Satellites SGP4 can't propagate (for
 * example ones that have decayed since their element set) are left out.
 */
export function positionsAt(satellites: TrackedSatellite[], date: Date): SatellitePosition[] {
  // Earth's rotation angle at this moment: the same for every satellite, so
  // compute it once. It turns the inertial (TEME) frame into Earth-fixed.
  const gmst = gstime(date);
  const positions: SatellitePosition[] = [];
  for (const { noradId, name, satrec } of satellites) {
    const geo = geodeticAt(satrec, date, gmst);
    if (geo) positions.push({ noradId, name, ...geo });
  }
  return positions;
}

/** Numbers per satellite in a packed buffer: latitude, longitude, altitude (km), speed (km/s). */
export const PACKED_STRIDE = 4;

/**
 * The same positions packed into one Float32Array, in `satellites` order
 * (satellite i is at index i * PACKED_STRIDE). A Web Worker can hand this to
 * the page without copying it. Satellites SGP4 can't propagate get NaN.
 * Float32 keeps about 7 significant digits: about 1 m of latitude/longitude.
 */
export function packedPositionsAt(satellites: TrackedSatellite[], date: Date): Float32Array {
  const gmst = gstime(date);
  const packed = new Float32Array(satellites.length * PACKED_STRIDE);
  for (let i = 0; i < satellites.length; i++) {
    const geo = geodeticAt(satellites[i].satrec, date, gmst);
    const at = i * PACKED_STRIDE;
    packed[at] = geo ? geo.lat : NaN;
    packed[at + 1] = geo ? geo.lng : NaN;
    packed[at + 2] = geo ? geo.altitudeKm : NaN;
    packed[at + 3] = geo ? geo.speedKmS : NaN;
  }
  return packed;
}

/** Satellite `index`'s position in a packed buffer, or null if it has none. */
export function packedPositionAt(
  packed: Float32Array,
  index: number,
): { lat: number; lng: number; altitudeKm: number; speedKmS: number } | null {
  const at = index * PACKED_STRIDE;
  if (at + PACKED_STRIDE > packed.length || Number.isNaN(packed[at])) return null;
  return {
    lat: packed[at],
    lng: packed[at + 1],
    altitudeKm: packed[at + 2],
    speedKmS: packed[at + 3],
  };
}

/** One sample every 30 s (about 185 for the ISS), but never more than 500 per orbit. */
const PATH_STEP_MS = 30_000;
const PATH_MAX_SAMPLES = 500;

/** Numbers per sample in an orbit path: latitude, longitude, altitude (km). */
export const PATH_STRIDE = 3;

/** How long one orbit takes, from the mean motion (revolutions per day). */
export function orbitPeriodMinutes(meanMotion: number): number {
  return 1440 / meanMotion;
}

/**
 * Where the satellite will be over the next orbit, starting at `start`: packed
 * latitude, longitude and altitude per sample (NaN where SGP4 fails). Earth's
 * rotation angle is recomputed for every sample, so this is the real path over
 * the ground (drawn at the satellite's altitude), which doesn't close into a
 * loop: Earth turns about 23 degrees under the ISS during one orbit.
 * High orbits are capped at 500 samples (a geostationary one: every 2.9 min).
 */
export function orbitPath(satellite: TrackedSatellite, start: Date): Float32Array {
  if (!(satellite.meanMotion > 0)) return new Float32Array(0);
  const periodMs = orbitPeriodMinutes(satellite.meanMotion) * 60_000;
  const steps = Math.min(PATH_MAX_SAMPLES, Math.ceil(periodMs / PATH_STEP_MS));
  const path = new Float32Array((steps + 1) * PATH_STRIDE);
  for (let k = 0; k <= steps; k++) {
    const date = new Date(start.getTime() + (periodMs * k) / steps);
    const geo = geodeticAt(satellite.satrec, date, gstime(date));
    const at = k * PATH_STRIDE;
    path[at] = geo ? geo.lat : NaN;
    path[at + 1] = geo ? geo.lng : NaN;
    path[at + 2] = geo ? geo.altitudeKm : NaN;
  }
  return path;
}
