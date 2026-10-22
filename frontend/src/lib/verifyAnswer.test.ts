import { describe, expect, it } from "vitest";

import type { ToolCall } from "@/lib/ask";
import { verifyAnswer } from "@/lib/verifyAnswer";

// Real production answers from Oct 21 (usage removed): Chicago has 5 visible
// ISS passes in 3 days; Austin has none in 7 days.
import austin from "./__fixtures__/ask-austin.json";
import chicago from "./__fixtures__/ask-chicago.json";

const CHICAGO_TOOLS = chicago.tools as ToolCall[];
const AUSTIN_TOOLS = austin.tools as ToolCall[];

/** Chicago's answer with one piece replaced; fails loudly if the piece isn't there. */
function chicagoWith(from: string, to: string): string {
  expect(chicago.answer).toContain(from);
  return chicago.answer.replace(from, to);
}

describe("verifyAnswer on real answers", () => {
  it("passes Chicago's answer: every time, day and duration matches the tool", () => {
    const result = verifyAnswer(chicago.answer, CHICAGO_TOOLS);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThan(20);
  });

  it("passes Austin's answer (only '7 days' to check)", () => {
    const result = verifyAnswer(austin.answer, AUSTIN_TOOLS);
    expect(result).toEqual({ ok: true, checked: 1, problems: [] });
  });

  it("passes an answer with nothing to check", () => {
    expect(verifyAnswer("Which city should I check?", [])).toEqual({ ok: true, checked: 0, problems: [] });
  });
});

describe("verifyAnswer catches a deliberately wrong", () => {
  it.each([
    // [what changed, from, to, kind]
    ["clock time (one minute off)", "4:59 am", "4:58 am", "time"],
    ["end time", "disappears there at 5:00 am", "disappears there at 5:09 am", "time"],
    ["duration", "about 4 minutes", "about 9 minutes", "duration"],
    ["duration taken from another pass", "(about 3 minutes)", "(about 5 minutes)", "duration"],
    ["date", "Sat Oct 24, 5:01", "Sat Oct 27, 5:01", "date"],
    ["weekday for a real date", "Thu Oct 22, 4:59", "Fri Oct 22, 4:59", "weekday"],
    ["real time on the wrong day", "Fri Oct 23, 5:47", "Fri Oct 23, 4:59", "time"],
    ["real time on the wrong weekday", "Thursday at 6:33", "Friday at 6:33", "time"],
    ["count", "5 times", "6 times", "number"],
    ["search length", "next 3 days", "next 4 days", "duration"],
  ])("%s", (_label, from, to, kind) => {
    const result = verifyAnswer(chicagoWith(from, to), CHICAGO_TOOLS);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.kind)).toContain(kind);
  });

  it("number when the tool behind it failed (an error result backs nothing)", () => {
    const failed = CHICAGO_TOOLS.map((t) => ({ ...t, is_error: true }));
    expect(verifyAnswer(chicago.answer, failed).ok).toBe(false);
  });

  it("time when no tool was called at all", () => {
    expect(verifyAnswer("The ISS passes at 7:14 pm tonight.", []).problems).toEqual([
      { kind: "time", text: "7:14 pm" },
    ]);
  });
});

describe("verifyAnswer rules", () => {
  it("accepts a time rounded to the nearest minute (6:37:52 → 6:38)", () => {
    expect(verifyAnswer(chicagoWith("Sat Oct 24, 6:35 am CDT: It rises in the northwest, is highest in the north at 6:37 am", "Sat Oct 24, 6:35 am CDT: It rises in the northwest, is highest in the north at 6:38 am"), CHICAGO_TOOLS).ok).toBe(true);
  });

  it("accepts an hour on its own within 30 minutes ('around 5 am' for 4:59)", () => {
    expect(verifyAnswer("On Thursday, look around 5 am.", CHICAGO_TOOLS).ok).toBe(true);
    // Thursday's nearest tool time to 11 am is a daylight pass peaking at 9:50 am.
    expect(verifyAnswer("On Thursday, look around 11 am.", CHICAGO_TOOLS).ok).toBe(false);
  });

  it("accepts a.m. spellings and a 24-hour time", () => {
    expect(verifyAnswer("Thu Oct 22 at 4:59 a.m. (04:59).", CHICAGO_TOOLS).ok).toBe(true);
  });

  it("checks times without a day against every day in the results", () => {
    expect(verifyAnswer("The best pass starts at 6:35 am.", CHICAGO_TOOLS).ok).toBe(true);
  });

  it("stops pairing at 'tomorrow' (a relative day is not checked against the last day named)", () => {
    expect(verifyAnswer("Thu Oct 22 at 4:59 am, and tomorrow at 5:47 am.", CHICAGO_TOOLS).ok).toBe(true);
  });

  it("accepts a non-visible pass's peak time and pass counts the tool implies", () => {
    // Austin: 26 passes, 14 in Earth's shadow, 12 in daylight; a shadow pass peaks in the results.
    const peak = (AUSTIN_TOOLS[0].result as { passes: { peak?: string }[] }).passes[0].peak ?? "";
    const time = /\d{1,2}:\d{2} [ap]m/.exec(peak)?.[0];
    expect(time).toBeDefined();
    const answer = `It passes 26 times: 14 in Earth's shadow and 12 in daylight. One peaks at ${time}.`;
    expect(verifyAnswer(answer, AUSTIN_TOOLS)).toMatchObject({ ok: true, problems: [] });
  });

  it("ignores list markers but not other numbers", () => {
    expect(verifyAnswer("1. Thu Oct 22, 4:59 am\n2. Fri Oct 23, 5:47 am", CHICAGO_TOOLS).ok).toBe(true);
    expect(verifyAnswer("Satellite 99999 is up.", CHICAGO_TOOLS).ok).toBe(false);
  });

  it("checks cloud percentages and forecast hours against get_cloud_forecast", () => {
    const cloud: ToolCall = {
      name: "get_cloud_forecast",
      input: { place: "Chicago", days: 2 },
      is_error: false,
      result: {
        time_zone: "America/Chicago",
        cloud_cover_percent: { "Thu Oct 22": { "04:00": 15, "05:00": 40 } },
        scale: "good <= 25%, fair <= 50%, poor > 50%",
      },
    };
    const tools = [...CHICAGO_TOOLS, cloud];
    expect(verifyAnswer("Thu Oct 22 at 5 am: 40% cloud, fair (fair is 50% or less).", tools).ok).toBe(true);
    expect(verifyAnswer("Thu Oct 22 at 5 am: 35% cloud.", tools).problems).toEqual([
      { kind: "percent", text: "35%" },
    ]);
  });

  it("checks degrees within 1°", () => {
    // Chicago's first visible pass appears at 18.4° elevation.
    expect(verifyAnswer("It appears 18° up.", CHICAGO_TOOLS).ok).toBe(true);
    expect(verifyAnswer("It appears 33° up.", CHICAGO_TOOLS).ok).toBe(false);
  });

  it("does not check claims in words (documented limit)", () => {
    expect(verifyAnswer("Every pass is after sunset, high in the south.", CHICAGO_TOOLS).ok).toBe(true);
  });
});
