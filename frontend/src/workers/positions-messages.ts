/**
 * Messages between the globe (main thread) and the positions worker. Shared
 * types only, so importing this file never pulls worker code into the page.
 */

/** Page → worker. */
export type ToWorker =
  /** Download the elements from `url` and build the SGP4 records. */
  | { type: "load"; url: string }
  /** Compute every satellite's position at `time` (ms since 1970, UTC). */
  | { type: "compute"; time: number }
  /** One orbit's path for the satellite at catalog `index`, starting at `time`. */
  | { type: "orbit"; index: number; time: number };

/** Worker → page. */
export type FromWorker =
  /** The catalog, in the same order as every `positions` buffer. */
  | { type: "loaded"; noradIds: number[]; names: string[] }
  /** Packed lat/lng/altitude per satellite (see PACKED_STRIDE); NaN = no position. */
  | { type: "positions"; time: number; positions: Float32Array; workerMs: number }
  /** Packed lat/lng/altitude per sample (see PATH_STRIDE), plus the orbit's period and inclination. */
  | {
      type: "orbit";
      index: number;
      time: number;
      path: Float32Array;
      periodMinutes: number;
      inclinationDeg: number;
    }
  | { type: "error" };
