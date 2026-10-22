/**
 * Tests for the evaluation's scorer itself, on Oct 21's two real production
 * answers (src/lib/__fixtures__): a grader that passes everything would make
 * the score meaningless, so each check is shown failing on a broken reply.
 */

import { describe, expect, it } from "vitest";

import austin from "@/lib/__fixtures__/ask-austin.json";
import chicago from "@/lib/__fixtures__/ask-chicago.json";
import type { ToolCall } from "@/lib/ask";
import { report, scoreQuestion, scoreRecording, type EvalQuestion, type RecordedReply } from "./score";

const CHICAGO_Q: EvalQuestion = {
  id: "iss-chicago-3d",
  question: "When can I see the ISS from Chicago in the next 3 days?",
  expect: { type: "passes", satellite: 25544, place: { asked: "Chicago", label: ["Chicago", "Illinois"] }, days: [3] },
};

const AUSTIN_Q: EvalQuestion = {
  id: "iss-austin-week",
  question: "When can I see the ISS from Austin this week?",
  expect: { type: "passes", satellite: 25544, place: { asked: "Austin", label: ["Austin", "Texas"] }, days: [7] },
};

function reply(id: string, body: { answer: string; complete: boolean; tools: unknown[] }): RecordedReply {
  return {
    id,
    question: "",
    answer: body.answer,
    complete: body.complete,
    tools: structuredClone(body.tools) as ToolCall[],
    error: null,
  };
}

/** A copy of the reply with its first tool call's result changed. */
function withResult(r: RecordedReply, change: (result: Record<string, unknown>) => void): RecordedReply {
  const copy = structuredClone(r);
  change(copy.tools[0].result as Record<string, unknown>);
  return copy;
}

function failed(score: ReturnType<typeof scoreQuestion>): string[] {
  return score.checks.filter((c) => !c.ok).map((c) => c.name);
}

describe("scoreQuestion on real answers", () => {
  it("passes Oct 21's Chicago answer", () => {
    const score = scoreQuestion(CHICAGO_Q, reply(CHICAGO_Q.id, chicago));
    expect(failed(score)).toEqual([]);
    expect(score.ok).toBe(true);
    expect(score.verification?.checked).toBeGreaterThan(20);
  });

  it("passes Oct 21's Austin answer (none visible, said in words)", () => {
    const score = scoreQuestion(AUSTIN_Q, reply(AUSTIN_Q.id, austin));
    expect(failed(score)).toEqual([]);
  });
});

describe("each check catches its own failure", () => {
  const good = reply(CHICAGO_Q.id, chicago);

  it("wrong satellite", () => {
    const r = withResult(good, (res) => ((res.satellite as Record<string, unknown>).norad_cat_id = 48274));
    expect(failed(scoreQuestion(CHICAGO_Q, r))).toEqual(["satellite"]);
  });

  it("right answer for the wrong city (verification alone can't see this)", () => {
    const r = withResult(good, (res) => ((res.place as Record<string, unknown>).label = "Chicago Heights, Illinois, United States"));
    const score = scoreQuestion(CHICAGO_Q, r);
    expect(score.verification?.ok).toBe(true);
    expect(failed(score)).toEqual([]); // the label still contains Chicago and Illinois…
    const paris: EvalQuestion = {
      ...CHICAGO_Q,
      expect: { type: "passes", satellite: 25544, place: { asked: "Paris", label: ["Paris", "France"] }, days: [3] },
    };
    // …but a question about Paris answered for Chicago fails both place checks.
    expect(failed(scoreQuestion(paris, good))).toEqual(["place asked", "place found"]);
  });

  it("the tool asked about another city", () => {
    const r = structuredClone(good);
    (r.tools[0].input as Record<string, unknown>).place = "Springfield";
    expect(failed(scoreQuestion(CHICAGO_Q, r))).toEqual(["place asked"]);
  });

  it("wrong number of days", () => {
    const r = withResult(good, (res) => (res.days = 7));
    expect(failed(scoreQuestion(CHICAGO_Q, r))).toContain("days");
  });

  it("a wrong time fails verification", () => {
    const r = { ...good, answer: good.answer.replace("4:59 am", "4:58 am") };
    expect(failed(scoreQuestion(CHICAGO_Q, r))).toEqual(["verified"]);
  });

  it("an incomplete answer or an error", () => {
    expect(failed(scoreQuestion(CHICAGO_Q, { ...good, complete: false }))).toContain("answered");
    expect(failed(scoreQuestion(CHICAGO_Q, { ...good, error: "busy", tools: [] }))).toContain("answered");
  });

  it("no visible passes, but the answer doesn't say so", () => {
    const r = reply(AUSTIN_Q.id, { ...austin, answer: "Here are the ISS passes for Austin, Texas, United States." });
    expect(failed(scoreQuestion(AUSTIN_Q, r))).toEqual(["says none visible"]);
  });

  it("visible passes, but no time given", () => {
    const r = { ...good, answer: "The ISS is visible from Chicago, Illinois, United States." };
    expect(failed(scoreQuestion(CHICAGO_Q, r))).toEqual(["gives a time"]);
  });

  it("clouds asked, but no forecast call or rating", () => {
    const q: EvalQuestion = { ...CHICAGO_Q, expect: { ...CHICAGO_Q.expect, clouds: true } as EvalQuestion["expect"] };
    expect(failed(scoreQuestion(q, good))).toEqual(["get_cloud_forecast", "cloud rating"]);
  });

  it("a missing reply", () => {
    expect(failed(scoreQuestion(CHICAGO_Q, undefined))).toEqual(["recorded"]);
  });
});

describe("questions that need no tool", () => {
  const empty = { complete: true, tools: [] };

  it("asks which city", () => {
    const q: EvalQuestion = { id: "no-city", question: "", expect: { type: "ask_city" } };
    expect(scoreQuestion(q, reply("no-city", { ...empty, answer: "Which city are you in?" })).ok).toBe(true);
    expect(failed(scoreQuestion(q, reply("no-city", { ...empty, answer: "Sure, let me check." })))).toEqual([
      "asks for a place",
    ]);
    expect(failed(scoreQuestion(q, reply("no-city", chicago)))).toContain("no tools");
  });

  it("declines off-topic questions without inventing numbers", () => {
    const q: EvalQuestion = { id: "off-topic", question: "", expect: { type: "decline" } };
    expect(scoreQuestion(q, reply("off-topic", { ...empty, answer: "I can only help with satellite viewing." })).ok).toBe(
      true,
    );
    expect(failed(scoreQuestion(q, reply("off-topic", { ...empty, answer: "Try Lou's, open until 11 pm." })))).toEqual(
      ["verified"],
    );
  });
});

describe("scoreRecording", () => {
  it("counts correct answers and missing replies, in the set's order", () => {
    const score = scoreRecording(
      { gate_model: "m", min_score: null, questions: [CHICAGO_Q, AUSTIN_Q] },
      { model: "m", fingerprint: "f", replies: [reply(CHICAGO_Q.id, chicago)] },
    );
    expect(score.correct).toBe(1);
    expect(score.total).toBe(2);
    expect(score.questions.map((q) => q.id)).toEqual(["iss-chicago-3d", "iss-austin-week"]);
    expect(report(score)).toContain("1/2 correct (50%)");
    expect(report(score)).toContain("✗ iss-austin-week (recorded: no reply)");
  });
});
