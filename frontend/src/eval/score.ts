/**
 * Scores Ask Phoebe's recorded evaluation replies (ask/eval/recordings/*.json,
 * made on the Mac by `manage.py run_ask_eval`; CI never calls Claude).
 *
 * Pass times change every day, so there is no fixed answer key. A reply is
 * correct when it passes every check for its question:
 * - Behavior: the right tool, satellite, place and number of days; no tools
 *   for an off-topic question or one with no city.
 * - Place: the tool was asked about the city named in the question, and the
 *   place it found is the expected one ("Paris" → France). verifyAnswer()
 *   can't see this: a right answer for the wrong city passes verification.
 * - Faithfulness: verifyAnswer() (the drawer's own check) finds every time,
 *   date, duration and number in the answer in that reply's tool results.
 * - Visibility: with no visible passes, the answer says so in words; with
 *   some, it gives at least one time. With clouds asked, it gives a rating.
 *
 * Not part of the app: nothing under src/ imports this file.
 */

import type { ToolCall } from "@/lib/ask";
import { verifyAnswer, type Verification } from "@/lib/verifyAnswer";

export type Expect =
  | {
      type: "passes";
      satellite: number;
      /** `asked`: the city as named in the question; `label`: parts the found place's label must contain. */
      place: { asked: string; label: string[] };
      /** Acceptable search lengths ("tonight" → 1 or 2); omitted means any. */
      days?: number[];
      clouds?: boolean;
    }
  | { type: "satellite"; satellite: number }
  | { type: "ask_city" }
  | { type: "decline" };

export type EvalQuestion = { id: string; question: string; expect: Expect };

export type QuestionSet = {
  gate_model: string;
  min_score: number | null;
  questions: EvalQuestion[];
};

export type RecordedReply = {
  id: string;
  question: string;
  answer: string;
  complete: boolean;
  tools: ToolCall[];
  error: string | null;
  cost_usd?: string;
};

export type Recording = {
  model: string;
  fingerprint: string;
  recorded_at?: string;
  cost_usd?: string;
  replies: RecordedReply[];
};

export type Check = { name: string; ok: boolean; detail?: string };

export type QuestionScore = {
  id: string;
  ok: boolean;
  checks: Check[];
  verification: Verification | null;
};

export type RecordingScore = {
  model: string;
  correct: number;
  total: number;
  /** Claims verifyAnswer() checked across all answers, and answers it rejected. */
  claimsChecked: number;
  verificationFailures: number;
  questions: QuestionScore[];
};

/** "No visible passes", "won't be visible", "you can't see it", "none of them are visible". */
const NONE_VISIBLE_RE =
  /\b(?:no|not|none|cannot|can't|won't|isn't|aren't|never)\b[^.\n]{0,60}\b(?:visible|see|seen|spot|catch)\b/i;
/** A clock time: "4:59 am", "5 a.m.", "21:05". */
const CLOCK_RE = /\b\d{1,2}(?::\d{2})?\s*[ap]\.?\s?m\b|\b(?:[01]?\d|2[0-3]):[0-5]\d\b/i;
const RATING_RE = /\b(?:good|fair|poor)\b/i;
const ASKS_PLACE_RE = /\b(?:city|town|where|location|place)\b/i;

/** Lowercase without accents, so "Reykjavík" contains "reykjavik". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function okCalls(tools: readonly ToolCall[], name: string): ToolCall[] {
  return tools.filter((t) => t.name === name && !t.is_error);
}

function placeLabel(call: ToolCall | undefined): string {
  return String(obj(obj(call?.result).place).label ?? "");
}

function check(name: string, ok: boolean, detail?: string): Check {
  return ok ? { name, ok } : { name, ok, detail };
}

function passesChecks(expect: Extract<Expect, { type: "passes" }>, reply: RecordedReply): Check[] {
  const checks: Check[] = [];
  const call = okCalls(reply.tools, "get_passes")[0];
  checks.push(check("get_passes", call !== undefined, "no successful get_passes call"));
  if (!call) return checks;

  const result = obj(call.result);
  const norad = obj(result.satellite).norad_cat_id;
  checks.push(check("satellite", norad === expect.satellite, `got NORAD ${String(norad)}`));

  const asked = String(obj(call.input).place ?? "");
  checks.push(
    check("place asked", fold(asked).includes(fold(expect.place.asked)), `tool asked about "${asked}"`),
  );
  const label = placeLabel(call);
  const missing = expect.place.label.filter((part) => !fold(label).includes(fold(part)));
  checks.push(check("place found", missing.length === 0, `found "${label}"`));

  if (expect.days) {
    checks.push(check("days", expect.days.includes(Number(result.days)), `searched ${String(result.days)} days`));
  }

  const visibleCount = Number(result.visible_pass_count);
  if (visibleCount === 0) {
    checks.push(check("says none visible", NONE_VISIBLE_RE.test(reply.answer), "doesn't say none are visible"));
  } else {
    checks.push(check("gives a time", CLOCK_RE.test(reply.answer), `${visibleCount} visible, but no time given`));
  }

  if (expect.clouds) {
    const clouds = okCalls(reply.tools, "get_cloud_forecast")[0];
    checks.push(check("get_cloud_forecast", clouds !== undefined, "no successful get_cloud_forecast call"));
    if (clouds) {
      checks.push(
        check("same place for clouds", placeLabel(clouds) === label, `clouds for "${placeLabel(clouds)}"`),
      );
    }
    if (visibleCount > 0) {
      checks.push(check("cloud rating", RATING_RE.test(reply.answer), "no good/fair/poor rating"));
    }
  }
  return checks;
}

function satelliteChecks(expect: Extract<Expect, { type: "satellite" }>, reply: RecordedReply): Check[] {
  const call = okCalls(reply.tools, "look_up_satellite")[0];
  const norad = obj(obj(call?.result).best_match).norad_cat_id;
  return [
    check("look_up_satellite", call !== undefined, "no successful look_up_satellite call"),
    check("satellite", norad === expect.satellite, `got NORAD ${String(norad)}`),
  ];
}

/** Scores one question's recorded reply (undefined: never recorded). */
export function scoreQuestion(question: EvalQuestion, reply: RecordedReply | undefined): QuestionScore {
  if (!reply) {
    return { id: question.id, ok: false, checks: [check("recorded", false, "no reply")], verification: null };
  }
  const checks: Check[] = [
    check("answered", reply.error === null && reply.complete, reply.error ?? "incomplete answer"),
  ];
  const expect = question.expect;
  if (expect.type === "passes") checks.push(...passesChecks(expect, reply));
  else if (expect.type === "satellite") checks.push(...satelliteChecks(expect, reply));
  else {
    checks.push(check("no tools", reply.tools.length === 0, `called ${reply.tools.map((t) => t.name).join(", ")}`));
    if (expect.type === "ask_city") {
      checks.push(check("asks for a place", ASKS_PLACE_RE.test(reply.answer), "doesn't ask where"));
    }
  }

  const verification = verifyAnswer(reply.answer, reply.tools);
  const problems = verification.problems.map((p) => `${p.kind} "${p.text}"`).join(", ");
  checks.push(check("verified", verification.ok, problems));

  return { id: question.id, ok: checks.every((c) => c.ok), checks, verification };
}

/** Scores a whole recording against the question set, in the set's order. */
export function scoreRecording(set: QuestionSet, recording: Recording): RecordingScore {
  const replies = new Map(recording.replies.map((r) => [r.id, r]));
  const questions = set.questions.map((q) => scoreQuestion(q, replies.get(q.id)));
  return {
    model: recording.model,
    correct: questions.filter((q) => q.ok).length,
    total: questions.length,
    claimsChecked: questions.reduce((n, q) => n + (q.verification?.checked ?? 0), 0),
    verificationFailures: questions.filter((q) => q.verification && !q.verification.ok).length,
    questions,
  };
}

/** One line per question, for the test output: "✓ iss-chicago-3d" or "✗ … (place found: …)". */
export function report(score: RecordingScore): string {
  const lines = score.questions.map((q) => {
    if (q.ok) return `  ✓ ${q.id}`;
    const failed = q.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail ?? ""}`);
    return `  ✗ ${q.id} (${failed.join("; ")})`;
  });
  const pct = Math.round((100 * score.correct) / score.total);
  return [
    `${score.model}: ${score.correct}/${score.total} correct (${pct}%), ` +
      `${score.claimsChecked} claims checked, ${score.verificationFailures} answers failed verification`,
    ...lines,
  ].join("\n");
}
