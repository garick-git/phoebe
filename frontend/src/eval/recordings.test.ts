/**
 * Ask Phoebe's evaluation gate: scores every recording in ask/eval/recordings/
 * (real replies, recorded on the Mac by `manage.py run_ask_eval`) and fails
 * if the gate model scores below `min_score` in ask/eval/questions.json.
 *
 * Runs in CI on every PR with no API calls: a change to verifyAnswer() or the
 * scorer is re-checked against real wording here, and a change to the prompt
 * or tools fails pytest (test_evaluation.py) until it has been re-recorded.
 * `npx vitest run src/eval` prints the per-question report.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { report, scoreRecording, type QuestionSet, type Recording } from "./score";

const EVAL_DIR = new URL("../../../ask/eval/", import.meta.url);

const set: QuestionSet = JSON.parse(readFileSync(new URL("questions.json", EVAL_DIR), "utf8"));

const RECORDINGS_DIR = new URL("recordings/", EVAL_DIR);
const recordings: Recording[] = (existsSync(RECORDINGS_DIR) ? readdirSync(RECORDINGS_DIR) : [])
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, RECORDINGS_DIR), "utf8")));

const gate = recordings.find((r) => r.model === set.gate_model);

describe("Ask Phoebe evaluation", () => {
  it("has a recording for the gate model", () => {
    expect(gate, `no recording for ${set.gate_model}`).toBeDefined();
  });

  it.each(recordings.map((r) => [r.model, r] as const))("%s: report", (_model, recording) => {
    const score = scoreRecording(set, recording);
    console.log(report(score));
    expect(score.total).toBe(set.questions.length);
  });

  it(`${set.gate_model} scores at least min_score`, () => {
    expect(set.min_score, "set min_score in ask/eval/questions.json").not.toBeNull();
    const score = scoreRecording(set, gate!);
    expect(score.correct, report(score)).toBeGreaterThanOrEqual(set.min_score!);
  });
});
