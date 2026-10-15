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

export type TrackedSatellite = { noradId: number; name: string; satrec: SatRec };

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
      tracked.push({ noradId: row.norad_cat_id, name: row.name, satrec: toSatrec(row) });
    } catch {
      // Malformed elements for one satellite shouldn't hide the other 16,000.
    }
  }
  return tracked;
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
    // No result (or, in older satellite.js versions, `false`) means SGP4
    // couldn't propagate this satellite to this time.
    const position = propagate(satrec, date)?.position;
    if (!position || typeof position !== "object") continue;
    const geo = eciToGeodetic(position, gmst);
    if (!Number.isFinite(geo.height) || geo.height < 0) continue;
    positions.push({
      noradId,
      name,
      lat: degreesLat(geo.latitude),
      lng: degreesLong(geo.longitude),
      altitudeKm: geo.height,
    });
  }
  return positions;
}
