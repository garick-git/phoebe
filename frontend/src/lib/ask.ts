/**
 * Client for Ask Phoebe: POST /api/ask/ with {"question"} returns
 * {answer, complete, tools, usage}; errors come back as {detail, code}.
 * Field names match the back end (ask/views.py, ask/service.py, ask/tools.py).
 *
 * Also turns get_passes tool results into pass cards. Decision (Oct 29): map
 * the tool's own result in the browser instead of changing the tool or
 * refetching the passes endpoint, so the cards show exactly the data the
 * answer was checked against, with no extra request and no back-end change.
 */

import { API_BASE_URL } from "@/lib/api";
import type { PassPoint } from "@/lib/passes";
import type { VisiblePass } from "@/lib/plainPass";

/** Same bounds as ask/serializers.py, checked here first so a bad question costs nothing. */
export const MIN_QUESTION_LENGTH = 3;
export const MAX_QUESTION_LENGTH = 500;

export type ToolCall = {
  name: string;
  input: unknown;
  result: unknown;
  is_error: boolean;
};

export type AskResponse = {
  answer: string;
  /** False when the server stopped the loop early (round, tool or time limit). */
  complete: boolean;
  tools: ToolCall[];
};

// ---- Calling the API ------------------------------------------------------

/** `status` is the HTTP status, or null when the server couldn't be reached. */
export class AskError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly detail: string | null;
  /** Seconds, from the Retry-After header (429s and some 503s). */
  readonly retryAfterS: number | null;
  constructor(status: number | null, code: string | null = null, detail: string | null = null, retryAfterS: number | null = null) {
    super(status === null ? "Ask request failed" : `Ask request failed: HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfterS = retryAfterS;
  }
}

/** The server's {detail, code} messages that are written for visitors (ask/views.py UNAVAILABLE). */
const SERVER_MESSAGE_CODES = new Set(["not_configured", "daily_budget", "spend_limit", "busy", "timeout", "config"]);

/** One line for the visitor, never a technical reason. */
export function askErrorMessage(error: AskError): string {
  if (error.status === null) return "Couldn't reach Phoebe. Check your connection and try again.";
  if (error.status === 429) {
    // ask_day (20 a day) asks to wait hours; ask_burst (5 a minute) about a minute.
    return error.retryAfterS !== null && error.retryAfterS > 120
      ? "That's all the questions Phoebe can take from you today. Try again tomorrow."
      : "That's a lot of questions at once. Wait a minute, then try again.";
  }
  if (error.status === 400) {
    return `Ask a question between ${MIN_QUESTION_LENGTH} and ${MAX_QUESTION_LENGTH} characters long.`;
  }
  if (error.code && error.detail && SERVER_MESSAGE_CODES.has(error.code)) return error.detail;
  return "Ask Phoebe isn't working right now. Try again later.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Outside data: check the shape before anything renders it. */
export function parseAskResponse(body: unknown): AskResponse {
  if (!isRecord(body) || typeof body.answer !== "string" || !Array.isArray(body.tools)) {
    throw new AskError(200, "bad_response");
  }
  const tools: ToolCall[] = body.tools.filter(isRecord).map((t) => ({
    name: typeof t.name === "string" ? t.name : "",
    input: t.input,
    result: t.result,
    is_error: t.is_error === true,
  }));
  return { answer: body.answer, complete: body.complete !== false, tools };
}

export async function postAsk(question: string, signal?: AbortSignal): Promise<AskResponse> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/ask/`, {
      method: "POST",
      // JSON only: the server refuses form posts, so a cross-site POST always
      // needs a CORS preflight, which only Phoebe's own origin passes.
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
      signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    if (signal?.aborted) throw error; // cancelled on purpose: not a failure
    throw new AskError(null);
  }
  if (!response.ok) {
    let code: string | null = null;
    let detail: string | null = null;
    try {
      const body: unknown = await response.json();
      if (isRecord(body)) {
        if (typeof body.code === "string") code = body.code;
        if (typeof body.detail === "string") detail = body.detail;
      }
    } catch {
      // Not JSON (a proxy error page, say): the status alone decides the message.
    }
    const retry = Number(response.headers.get("Retry-After"));
    throw new AskError(response.status, code, detail, Number.isFinite(retry) && retry > 0 ? retry : null);
  }
  return parseAskResponse(await response.json());
}

// ---- get_passes results → pass cards --------------------------------------

/** One point of a visible pass in the tool's result (ask/tools.py `_point`). */
export type ToolPoint = {
  when: string;
  time: string;
  direction: string;
  height: string;
  azimuth_deg: number;
  elevation_deg: number;
};

export type ToolPass =
  | { visible: true; appears: ToolPoint; highest: ToolPoint; disappears: ToolPoint; visible_for_s: number }
  | { visible: false; reason: "daylight" | "earth_shadow"; peak: string; max_elevation_deg: number };

export type ToolPlace = { label: string; latitude: number; longitude: number; timezone: string };

export type PassesResult = {
  satellite: { norad_cat_id: number; name: string; nickname?: string };
  place: ToolPlace;
  days: number;
  min_elevation_deg: number;
  passes: ToolPass[];
};

function isPoint(value: unknown): value is ToolPoint {
  return (
    isRecord(value) &&
    typeof value.time === "string" &&
    !Number.isNaN(Date.parse(value.time)) &&
    typeof value.azimuth_deg === "number" &&
    typeof value.elevation_deg === "number"
  );
}

function isPass(value: unknown): value is ToolPass {
  if (!isRecord(value)) return false;
  if (value.visible === true) {
    return isPoint(value.appears) && isPoint(value.highest) && isPoint(value.disappears);
  }
  return value.visible === false && (value.reason === "daylight" || value.reason === "earth_shadow");
}

/** A successful get_passes result with the fields the cards need, or null. */
export function passesResult(call: ToolCall): PassesResult | null {
  if (call.name !== "get_passes" || call.is_error || !isRecord(call.result)) return null;
  const r = call.result;
  const sat = r.satellite;
  const place = r.place;
  if (
    !isRecord(sat) ||
    typeof sat.norad_cat_id !== "number" ||
    typeof sat.name !== "string" ||
    !isRecord(place) ||
    typeof place.label !== "string" ||
    typeof place.latitude !== "number" ||
    typeof place.longitude !== "number" ||
    typeof place.timezone !== "string" ||
    typeof r.min_elevation_deg !== "number" ||
    !Array.isArray(r.passes) ||
    !r.passes.every(isPass)
  ) {
    return null;
  }
  return r as PassesResult;
}

/**
 * The tool rounds elevations to 0.1° and every pass rises and sets at exactly
 * the 10° line (`min_elevation_deg`). So a visible part that starts higher
 * than that line plus a little slack appeared mid-sky (it came out of Earth's
 * shadow, or the sky got dark enough), and one that ends higher faded out.
 * Tonight decides the same thing from rise/set times (5 s of slack); this is
 * the equivalent for a result with no rise or set.
 */
export const EDGE_SLACK_DEG = 0.5;

function passPoint(p: ToolPoint): PassPoint {
  return { time: p.time, azimuth_deg: p.azimuth_deg, elevation_deg: p.elevation_deg };
}

export function visiblePassFromTool(
  pass: Extract<ToolPass, { visible: true }>,
  minElevationDeg: number,
): VisiblePass {
  return {
    start: passPoint(pass.appears),
    highest: passPoint(pass.highest),
    end: passPoint(pass.disappears),
    appearsMidSky: pass.appears.elevation_deg - minElevationDeg > EDGE_SLACK_DEG,
    fadesMidSky: pass.disappears.elevation_deg - minElevationDeg > EDGE_SLACK_DEG,
  };
}

/** Everything one get_passes call found, ready for cards (or the empty message). */
export type PassGroup = {
  key: string;
  noradId: number;
  /** "ISS" for the popular satellites (the tool's nickname), otherwise the catalog name. */
  satellite: string;
  place: ToolPlace;
  days: number;
  visible: VisiblePass[];
  notVisible: { daylight: number; earth_shadow: number };
};

/**
 * One group per satellite and place, in the order the model asked. If it
 * asked twice for the same pair (3 days, then 7), the later call wins.
 */
export function passGroups(tools: readonly ToolCall[]): PassGroup[] {
  const groups = new Map<string, PassGroup>();
  for (const call of tools) {
    const result = passesResult(call);
    if (!result) continue;
    const { satellite, place } = result;
    const key = `${satellite.norad_cat_id}|${place.latitude}|${place.longitude}`;
    const visible: VisiblePass[] = [];
    const notVisible = { daylight: 0, earth_shadow: 0 };
    for (const pass of result.passes) {
      if (pass.visible) visible.push(visiblePassFromTool(pass, result.min_elevation_deg));
      else notVisible[pass.reason] += 1;
    }
    groups.delete(key); // re-insert, so the latest call also takes the latest position
    groups.set(key, {
      key,
      noradId: satellite.norad_cat_id,
      satellite: satellite.nickname ?? satellite.name,
      place,
      days: result.days,
      visible,
      notVisible,
    });
  }
  return [...groups.values()];
}

/**
 * Why a group has no visible passes, in plain words, for when the tool's data
 * is shown instead of the answer: "In the next 7 days it passes 26 times, but
 * never where you could see it: 14 in Earth's shadow, 12 in daylight."
 */
export function noVisibleText(group: PassGroup): string {
  const { daylight, earth_shadow: shadow } = group.notVisible;
  const total = daylight + shadow;
  const span = group.days === 1 ? "In the next day" : `In the next ${group.days} days`;
  if (total === 0) return `${span} it doesn't pass over at all.`;
  const parts = [
    shadow ? `${shadow} in Earth's shadow` : null,
    daylight ? `${daylight} in daylight` : null,
  ].filter((p): p is string => p !== null);
  const times = total === 1 ? "once" : `${total} times`;
  return `${span} it passes ${times}, but never where you could see it: ${parts.join(", ")}.`;
}
