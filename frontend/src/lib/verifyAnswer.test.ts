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

  it.each([
    // Oct 22's real answer said "At about 4½ minutes" for a 277 s pass (4.6 min);
    // before the fix only the bare "4" was checked.
    ["4½ minutes", true],
    ["4 and a half minutes", true],
    ["4.5 minutes", true],
    ["9½ minutes", false],
    ["2½ minutes", false],
    ["½ minute", false],
  ])("reads fractions in durations: %s → ok %s", (duration, ok) => {
    const answer = `- Sat Oct 24, 6:35 am CDT: highest at 6:37 am, gone at 6:40 am. At about ${duration}, this is the longest pass.`;
    const result = verifyAnswer(answer, CHICAGO_TOOLS);
    expect(result.ok).toBe(ok);
    if (!ok) expect(result.problems.map((p) => p.kind)).toEqual(["duration"]);
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

// Wording from the evaluation's real answers (ask/eval/recordings, Oct 22),
// with a look_up_satellite result shaped like ask/tools.py's.
const ISS_LOOKUP: ToolCall[] = [
  {
    name: "look_up_satellite",
    input: { query: "ISS" },
    is_error: false,
    result: {
      best_match: {
        norad_cat_id: 25544,
        name: "ISS (ZARYA)",
        orbit: { period_minutes: 92.9, inclination_deg: 51.6, element_set_age_hours: 172.9 },
        now: { latitude: -44.1, longitude: -25.8, altitude_km: 432, speed_km_s: 7.65 },
      },
      other_matches: [],
    },
  },
];

describe("verifyAnswer: facts kept under other names (evaluation, Oct 22)", () => {
  it("passes Opus's real ISS answer: position, period and the data's age", () => {
    const answer =
      "The International Space Station (ISS) is about **432 km** above Earth right now. It's over the South " +
      "Atlantic Ocean, at about 44.1°S, 25.8°W, and moving at about 7.65 km per second. It goes around Earth " +
      "once every 93 minutes.\n\nThese numbers come from tracking data that's about 7 days old.";
    expect(verifyAnswer(answer, ISS_LOOKUP).problems).toEqual([]);
  });

  it.each([
    ["a latitude that isn't the satellite's", "It's at about 45.3°S.", "degrees"],
    ["a period more than a minute off", "It goes around Earth once every 95 minutes.", "duration"],
    ["a data age more than half a day off", "The tracking data is about 5 days old.", "duration"],
  ])("still catches %s", (_label, answer, kind) => {
    const result = verifyAnswer(answer, ISS_LOOKUP);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.kind)).toEqual([kind]);
  });

  it("accepts the length of the answer's own list ('here are the next 5' above 5 list lines)", () => {
    const list = "- Low in the north.\n- Low in the northeast.\n- Partway up in the north.\n- Low in the north.";
    // Chicago's tool data has no 4 anywhere, so only the list's length can back it.
    expect(verifyAnswer(`Here are the next 4:\n${list}`, CHICAGO_TOOLS).ok).toBe(true);
    expect(verifyAnswer(`Here are the next 6:\n${list}`, CHICAGO_TOOLS).problems).toEqual([
      { kind: "number", text: "6" },
    ]);
  });
});
