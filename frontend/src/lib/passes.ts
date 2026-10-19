/**
 * Client for Phoebe's passes endpoint:
 * GET /api/satellites/<norad_cat_id>/passes/?lat=&lon=&days=
 * Field names match the API's JSON (satellites/views.py).
 */

import { API_BASE_URL } from "@/lib/api";
import { roundCoord } from "@/lib/place";

export type PassPoint = { time: string; azimuth_deg: number; elevation_deg: number };

export type Visibility = {
  visible: boolean;
  reason: "daylight" | "earth_shadow" | null;
  start: PassPoint | null;
  highest: PassPoint | null;
  end: PassPoint | null;
};

export type Pass = {
  rise: PassPoint;
  peak: PassPoint;
  set: PassPoint;
  max_elevation_deg: number;
  duration_s: number;
  visibility: Visibility;
};

export type PassesResponse = {
  norad_cat_id: number;
  name: string;
  location: { latitude: number; longitude: number };
  start: string;
  end: string;
  days: number;
  element_set_age_hours: number;
  passes: Pass[];
};

/** Tonight asks for a week, so an empty night can still say when the next pass is. */
export const PASS_DAYS = 7;

/** `status` is the HTTP status, or null when the server couldn't be reached. */
export class PassesError extends Error {
  readonly status: number | null;
  constructor(status: number | null) {
    super(status === null ? "Passes request failed" : `Passes request failed: HTTP ${status}`);
    this.status = status;
  }
}

export async function fetchPasses(
  noradId: number,
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<PassesResponse> {
  // Rounded again here, so no caller can ever send more than about 1 km of precision.
  const params = new URLSearchParams({
    lat: String(roundCoord(lat)),
    lon: String(roundCoord(lon)),
    days: String(PASS_DAYS),
  });
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/satellites/${noradId}/passes/?${params}`, {
      signal,
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    if (signal?.aborted) throw error; // cancelled on purpose: not a failure
    throw new PassesError(null);
  }
  if (!response.ok) throw new PassesError(response.status);
  return (await response.json()) as PassesResponse;
}

export function visiblePasses(response: PassesResponse): Pass[] {
  return response.passes.filter((p) => p.visibility.visible);
}
