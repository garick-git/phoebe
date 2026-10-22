/**
 * Answer verification for Ask Phoebe: before an answer is shown, every clock
 * time, date, duration and number in it is checked against the tool results
 * it came with (brief, week 4). If anything doesn't match, the drawer shows
 * the tool data directly instead of the answer.
 *
 * Pure functions, no React, so Vitest can test them.
 *
 * Decisions (Oct 29, see the decision log):
 * - Scope: times, dates, weekdays, durations, percentages, degrees and bare
 *   numbers. Claims in words ("every pass is before sunrise", "look
 *   northeast", number words like "two") are NOT checked; the pass cards
 *   under every answer show the tool's own directions.
 * - Times: the model copies the tool's "when" text, which drops the seconds
 *   ("4:59 am" for 4:59:36), so a time must equal a tool time truncated to
 *   the minute, or rounded to the nearest minute. "5 am" alone may be up to
 *   30 minutes off a tool time ("around 5 am").
 * - Times are checked on the day the same line names ("Thu Oct 22, 4:59 am",
 *   "Thursday at 6:33 am"), or the day after for times before 3 am (a pass
 *   that crosses midnight). With no day named, any day in the results counts.
 * - Durations: within 1 minute of a tool duration (so floor or round both
 *   pass, "about 4 minutes" for 261 s), and on a line with times, within 1
 *   minute of the pass those times belong to.
 * - A bare number (a count, a NORAD ID) only has to appear somewhere in the
 *   tool data, or be a count of its passes. That's the loosest rule.
 * - The check fails closed: a number it can't place counts as wrong, and a
 *   false alarm only means the user sees the tool data instead of the prose.
 */

import type { ToolCall } from "@/lib/ask";

export type ClaimKind = "time" | "date" | "weekday" | "duration" | "percent" | "degrees" | "number";

export type Problem = { kind: ClaimKind; text: string };

export type Verification = {
  ok: boolean;
  /** How many claims were checked; 0 means the answer had nothing to check. */
  checked: number;
  problems: Problem[];
};

// ---- Calendar helpers (wall-clock time in the place's zone, no Intl) --------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** "10-22": month and day, enough to name a day inside a search of at most a week. */
type DateKey = string;

function dateKey(month: number, day: number): DateKey {
  return `${month}-${day}`;
}

/** The weekday (0 = Sunday) of a calendar date. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1; // 0 if unknown
}

function weekdayIndex(name: string): number {
  return WEEKDAYS.indexOf(name.slice(0, 3).toLowerCase()); // -1 if unknown
}

/** 12-hour clock → minutes after midnight. */
function minuteOfDay(hour12: number, minute: number, ampm: string): number {
  const pm = ampm.toLowerCase().startsWith("p");
  return ((hour12 % 12) + (pm ? 12 : 0)) * 60 + minute;
}

// ---- Facts: what the tool results say -----------------------------------------

type DayFacts = { weekday: number; year: number | null; minutes: Set<number> };

type Facts = {
  days: Map<DateKey, DayFacts>;
  /** Visible passes as wall-clock seconds (Date.UTC of the local time), for pairing durations. */
  passes: { startS: number; endS: number; seconds: number }[];
  durationsS: number[];
  dayCounts: Set<number>;
  percents: Set<number>;
  degrees: number[];
  numbers: Set<number>;
};

// "Thu Oct 22, 4:59 am CDT" (ask/tools.py local_time()).
const WHEN_RE = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{1,2}):(\d{2}) (am|pm)\b/g;
// "2026-10-22T04:59:36-05:00": the place's wall clock plus its offset.
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
// get_cloud_forecast's day keys ("Thu Oct 22") and hour keys ("05:00").
const DAY_LABEL_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})$/;
const HOUR_KEY_RE = /^(\d{2}):(\d{2})$/;
const NUMBER_RE = /\d+(?:\.\d+)?/g;

function emptyFacts(): Facts {
  return {
    days: new Map(),
    passes: [],
    durationsS: [],
    dayCounts: new Set(),
    percents: new Set(),
    degrees: [],
    numbers: new Set(),
  };
}

function day(facts: Facts, month: number, dayOfMonth: number, weekday: number, year: number | null): DayFacts {
  const key = dateKey(month, dayOfMonth);
  let entry = facts.days.get(key);
  if (!entry) {
    entry = { weekday, year, minutes: new Set() };
    facts.days.set(key, entry);
  }
  if (entry.year === null) entry.year = year;
  return entry;
}

/** Adds a wall-clock instant; with seconds, both the truncated and the rounded minute. */
function addInstant(facts: Facts, y: number, mo: number, d: number, h: number, mi: number, s: number) {
  day(facts, mo, d, weekdayOf(y, mo, d), y).minutes.add(h * 60 + mi);
  if (s >= 30) {
    const next = new Date(Date.UTC(y, mo - 1, d, h, mi + 1));
    const [ny, nmo, nd] = [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
    day(facts, nmo, nd, next.getUTCDay(), ny).minutes.add(next.getUTCHours() * 60 + next.getUTCMinutes());
  }
}

/** Wall-clock seconds of an ISO time with offset (its local date and time read as if UTC). */
function wallSeconds(iso: string): number | null {
  const m = ISO_RE.exec(iso);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
}

function addString(facts: Facts, text: string) {
  const iso = ISO_RE.exec(text);
  if (iso) {
    const [y, mo, d, h, mi, s] = iso.slice(1, 7).map(Number);
    addInstant(facts, y, mo, d, h, mi, s);
    facts.numbers.add(y);
    return;
  }
  let found = false;
  for (const m of text.matchAll(WHEN_RE)) {
    found = true;
    const entry = day(facts, monthIndex(m[2]), Number(m[3]), weekdayIndex(m[1]), null);
    entry.minutes.add(minuteOfDay(Number(m[4]), Number(m[5]), m[6]));
  }
  if (found) return; // a time label's digits are times, not numbers to quote
  for (const m of text.matchAll(NUMBER_RE)) {
    const n = Number(m[0]);
    facts.numbers.add(n);
    if (text.includes("%")) facts.percents.add(n); // "good <= 25%, fair <= 50%, ..."
  }
}

function addNumber(facts: Facts, key: string, n: number) {
  facts.numbers.add(n);
  if (key.endsWith("_deg")) facts.degrees.push(n);
  if (key.endsWith("_s")) facts.durationsS.push(n);
  if (key === "days") facts.dayCounts.add(n);
}

function walk(facts: Facts, value: unknown, key: string) {
  if (typeof value === "number") addNumber(facts, key, value);
  else if (typeof value === "string") addString(facts, value);
  else if (Array.isArray(value)) value.forEach((v) => walk(facts, v, key));
  else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      const label = DAY_LABEL_RE.exec(k);
      if (label && typeof v === "object" && v !== null) {
        // get_cloud_forecast: {"Thu Oct 22": {"05:00": 40, ...}}
        const entry = day(facts, monthIndex(label[2]), Number(label[3]), weekdayIndex(label[1]), null);
        for (const [hourKey, percent] of Object.entries(v)) {
          const hm = HOUR_KEY_RE.exec(hourKey);
          if (hm) entry.minutes.add(Number(hm[1]) * 60 + Number(hm[2]));
          if (typeof percent === "number") {
            facts.percents.add(percent);
            facts.numbers.add(percent);
          }
        }
        continue;
      }
      walk(facts, v, k);
    }
  }
}

/** Counts the model may quote that no single field holds ("14 in Earth's shadow"). */
function addPassCounts(facts: Facts, result: unknown) {
  if (typeof result !== "object" || result === null) return;
  const passes = (result as { passes?: unknown }).passes;
  if (!Array.isArray(passes)) return;
  facts.numbers.add(passes.length);
  const counts = new Map<string, number>();
  for (const p of passes) {
    if (typeof p !== "object" || p === null) continue;
    const pass = p as Record<string, unknown>;
    const kind = pass.visible === true ? "visible" : String(pass.reason);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (pass.visible === true) {
      const start = wallSeconds(String((pass.appears as { time?: unknown })?.time));
      const end = wallSeconds(String((pass.disappears as { time?: unknown })?.time));
      const seconds = pass.visible_for_s;
      if (start !== null && end !== null && typeof seconds === "number") {
        facts.passes.push({ startS: start, endS: end, seconds });
      }
    }
  }
  counts.forEach((n) => facts.numbers.add(n));
  facts.numbers.add(passes.length - (counts.get("visible") ?? 0)); // "21 can't be seen"
}

export function collectFacts(tools: readonly ToolCall[]): Facts {
  const facts = emptyFacts();
  for (const call of tools) {
    if (call.is_error) continue; // an error result backs nothing
    walk(facts, call.input, "");
    walk(facts, call.result, "");
    addPassCounts(facts, call.result);
  }
  return facts;
}

// ---- Claims: what the answer says ----------------------------------------------

const WEEKDAY_WORD = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";
const WEEKDAY_ANY = `${WEEKDAY_WORD}|Tues|Thurs|Thur|Mon|Tue|Wed|Thu|Fri|Sat|Sun`;
const MONTH_ANY =
  "January|February|March|April|June|July|August|September|October|November|December|Sept|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

// One left-to-right scan; the first alternative that matches at a position wins.
const TOKEN_RE = new RegExp(
  [
    // "Thu Oct 22", "Thursday, October 22nd", "Oct 22"
    `(?<date>(?:\\b(?<dwk>${WEEKDAY_ANY})\\.?,?\\s+)?\\b(?<mon>${MONTH_ANY})\\.?\\s+(?<day>\\d{1,2})(?:st|nd|rd|th)?\\b)`,
    // "Thursday" on its own (abbreviations only count next to a month: "Sun" is also the Sun)
    `(?<weekday>\\b(?:${WEEKDAY_WORD})s?\\b)`,
    // Words that move the day without naming it: stop pairing times with the last day named.
    `(?<rel>\\b(?:[Tt]oday|[Tt]onight|[Tt]omorrow|[Yy]esterday)\\b)`,
    // "4:59 am", "5 a.m.", "12:03pm"
    `(?<clock>\\b(?<ch>\\d{1,2})(?::(?<cm>\\d{2}))?\\s*(?<ap>[aApP])\\.?\\s?[mM]\\b\\.?)`,
    // "05:00" (24-hour)
    `(?<clock24>\\b(?<h24>[01]?\\d|2[0-3]):(?<m24>[0-5]\\d)\\b)`,
    // "about 4 minutes", "76 seconds", "3-day", "7 days"
    `(?<dur>\\b(?<dn>\\d+(?:\\.\\d+)?)\\s*-?\\s*(?<du>seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\\b)`,
    // "40%", "40 percent"
    `(?<pct>\\b(?<pn>\\d+(?:\\.\\d+)?)\\s*(?:%|percent\\b))`,
    // "62°", "62 degrees"
    `(?<deg>\\b(?<gn>\\d+(?:\\.\\d+)?)\\s*(?:°|degrees?\\b))`,
    // Anything else with digits: "5 times", "NORAD 25544", "1,200"
    `(?<num>\\b\\d+(?:,\\d{3})*(?:\\.\\d+)?\\b)`,
  ].join("|"),
  "g",
);

/** Is a time (minutes after midnight) on one of these days, or just after midnight following one? */
function timeOnDays(facts: Facts, days: readonly DateKey[] | null, minutes: number, slack: number): boolean {
  const candidates: [DayFacts, number][] = [];
  for (const [key, entry] of facts.days) {
    if (days === null || days.includes(key)) candidates.push([entry, minutes]);
  }
  if (days !== null && minutes < 3 * 60) {
    // A pass that starts late at night can end after midnight, on the next date.
    for (const key of days) {
      const named = facts.days.get(key);
      if (!named || named.year === null) continue;
      const [mo, d] = key.split("-").map(Number);
      const next = new Date(Date.UTC(named.year, mo - 1, d + 1));
      const entry = facts.days.get(dateKey(next.getUTCMonth() + 1, next.getUTCDate()));
      if (entry) candidates.push([entry, minutes]);
    }
  }
  return candidates.some(([entry, m]) => [...entry.minutes].some((t) => Math.abs(t - m) <= slack));
}

/** Wall-clock seconds of a checked time, when the day (and its year) is known. */
function wallSecondsOf(facts: Facts, key: DateKey, minutes: number): number | null {
  const entry = facts.days.get(key);
  if (!entry || entry.year === null) return null;
  const [mo, d] = key.split("-").map(Number);
  return Date.UTC(entry.year, mo - 1, d, 0, minutes) / 1000;
}

function near(values: Iterable<number>, n: number, tolerance: number): boolean {
  for (const v of values) if (Math.abs(v - n) <= tolerance) return true;
  return false;
}

/** A number at the start of a line followed by "." or ")" is a list marker, not a claim. */
function isListMarker(line: string, index: number, length: number): boolean {
  return line.slice(0, index).trim() === "" && /^[.)]\s/.test(line.slice(index + length, index + length + 2));
}

function checkLine(line: string, facts: Facts, problems: Problem[]): number {
  let checked = 0;
  let context: DateKey[] | null = null; // the day(s) the line has named so far
  const lineSeconds: number[] = []; // wall-clock seconds of the line's checked times
  const durations: { n: number; unit: string; text: string }[] = [];

  for (const m of line.matchAll(TOKEN_RE)) {
    const g = m.groups ?? {};
    const text = m[0].trim();
    if (g.date) {
      checked += 1;
      const key = dateKey(monthIndex(g.mon), Number(g.day));
      const entry = facts.days.get(key);
      if (!entry) problems.push({ kind: "date", text });
      else if (g.dwk && weekdayIndex(g.dwk) !== entry.weekday) problems.push({ kind: "weekday", text });
      context = [key];
    } else if (g.weekday) {
      checked += 1;
      const wanted = weekdayIndex(g.weekday);
      const keys = [...facts.days].filter(([, e]) => e.weekday === wanted).map(([k]) => k);
      if (keys.length === 0) problems.push({ kind: "weekday", text });
      context = keys;
    } else if (g.rel) {
      context = null;
    } else if (g.clock || g.clock24) {
      checked += 1;
      const hourOnly = Boolean(g.clock) && g.cm === undefined;
      const minutes = g.clock
        ? minuteOfDay(Number(g.ch), Number(g.cm ?? 0), g.ap)
        : Number(g.h24) * 60 + Number(g.m24);
      const validClock = g.clock24 || (Number(g.ch) >= 1 && Number(g.ch) <= 12);
      if (!validClock || !timeOnDays(facts, context, minutes, hourOnly ? 30 : 0)) {
        problems.push({ kind: "time", text });
      } else if (context && context.length === 1 && !hourOnly) {
        const s = wallSecondsOf(facts, context[0], minutes);
        if (s !== null) lineSeconds.push(s);
      }
    } else if (g.dur) {
      checked += 1;
      durations.push({ n: Number(g.dn), unit: g.du.toLowerCase(), text });
    } else if (g.pct) {
      checked += 1;
      if (!facts.percents.has(Number(g.pn))) problems.push({ kind: "percent", text });
    } else if (g.deg) {
      checked += 1;
      if (!near(facts.degrees, Number(g.gn), 1)) problems.push({ kind: "degrees", text });
    } else if (g.num) {
      if (isListMarker(line, m.index ?? 0, m[0].length)) continue;
      checked += 1;
      const n = Number(m[0].replace(/,/g, ""));
      const known = facts.numbers.has(n) || [...facts.numbers].some((v) => Math.round(v) === n);
      if (!known) problems.push({ kind: "number", text });
    }
  }

  // Durations last, so they can be paired with the pass the line's times belong to.
  const linePasses = facts.passes.filter((p) =>
    lineSeconds.some((s) => s >= p.startS - 60 && s <= p.endS + 60),
  );
  const passSeconds = linePasses.length > 0 ? linePasses.map((p) => p.seconds) : facts.durationsS;
  for (const { n, unit, text } of durations) {
    let ok: boolean;
    if (unit.startsWith("sec")) ok = near(passSeconds, n, 5);
    else if (unit.startsWith("min")) ok = passSeconds.some((s) => Math.abs(s / 60 - n) < 1);
    else if (unit.startsWith("day")) ok = facts.dayCounts.has(n);
    else ok = near([...facts.dayCounts].map((d) => d * 24), n, 0) || near(facts.numbers, n, 0.5);
    if (!ok) problems.push({ kind: "duration", text });
  }
  return checked;
}

/** Checks every time, date, duration and number in `answer` against `tools`. */
export function verifyAnswer(answer: string, tools: readonly ToolCall[]): Verification {
  const facts = collectFacts(tools);
  const problems: Problem[] = [];
  let checked = 0;
  for (const line of answer.split("\n")) checked += checkLine(line, facts, problems);
  return { ok: problems.length === 0, checked, problems };
}
