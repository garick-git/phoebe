import { describe, expect, it } from "vitest";

import {
  AskError,
  askErrorMessage,
  EDGE_SLACK_DEG,
  noVisibleText,
  parseAskResponse,
  passGroups,
  type ToolCall,
} from "@/lib/ask";
import { buildPassCards } from "@/lib/plainPass";

import austin from "./__fixtures__/ask-austin.json";
import chicago from "./__fixtures__/ask-chicago.json";

const CHICAGO_TOOLS = chicago.tools as ToolCall[];
const CHICAGO = "America/Chicago";

describe("passGroups", () => {
  it("turns Chicago's get_passes result into one ISS group with its 5 visible passes", () => {
    const [group, ...rest] = passGroups(CHICAGO_TOOLS);
    expect(rest).toEqual([]);
    expect(group.satellite).toBe("ISS");
    expect(group.place.timezone).toBe(CHICAGO);
    expect(group.visible).toHaveLength(5);
    expect(group.notVisible).toEqual({ daylight: 7, earth_shadow: 5 });
  });

  it("uses the 10° line to tell 'appears' from 'rises'", () => {
    const [group] = passGroups(CHICAGO_TOOLS);
    // 4:59 am appears at 18.4°; 6:33 am starts at exactly 10.0°; all end at 10.0°.
    expect(group.visible.map((v) => v.appearsMidSky)).toEqual([true, false, true, true, false]);
    expect(group.visible.every((v) => !v.fadesMidSky)).toBe(true);
    expect(EDGE_SLACK_DEG).toBeLessThan(1);
  });

  it("keeps the later call when the model asks twice for the same satellite and place", () => {
    const first = { ...CHICAGO_TOOLS[0], result: { ...(CHICAGO_TOOLS[0].result as object), days: 1 } };
    const groups = passGroups([first, CHICAGO_TOOLS[0]]);
    expect(groups).toHaveLength(1);
    expect(groups[0].days).toBe(3);
  });

  it("skips errors, other tools and malformed results", () => {
    const bad: ToolCall[] = [
      { ...CHICAGO_TOOLS[0], is_error: true },
      { name: "look_up_satellite", input: {}, result: { name: "ISS (ZARYA)" }, is_error: false },
      { name: "get_passes", input: {}, result: { passes: [{ visible: true }] }, is_error: false },
    ];
    expect(passGroups(bad)).toEqual([]);
  });
});

describe("Ask's pass cards", () => {
  it("are the same cards as Tonight's: headline, path and details", () => {
    const [group] = passGroups(CHICAGO_TOOLS);
    const now = Date.parse("2026-10-21T20:00:00-05:00");
    const { tonight, later } = buildPassCards(
      [{ noradId: group.noradId, nickname: group.satellite, passes: group.visible }],
      now,
      CHICAGO,
      { status: "error" },
    );
    const cards = [...tonight, ...later];
    expect(cards).toHaveLength(5);
    expect(cards[0]).toMatchObject({
      satellite: "ISS",
      dayLabel: "Tomorrow morning",
      headline: "4:59 am, look northeast, low in the sky",
      duration: "1 min",
      caution: "Stays low, easy to miss",
    });
    expect(cards[0].path).toMatch(/^Appears low in the northeast/);
    expect(cards[0].details[0]).toMatchObject({ label: "Appears", time: "4:59:36 am" });
    expect(cards[1].path).toMatch(/^Rises in the northwest/);
    expect(cards[1].details.map((d) => d.label)).toEqual(["Rises", "Highest", "Sets"]);
  });
});

describe("noVisibleText", () => {
  it("explains an empty week with the tool's own counts", () => {
    const [group] = passGroups(austin.tools as ToolCall[]);
    expect(noVisibleText(group)).toBe(
      "In the next 7 days it passes 26 times, but never where you could see it: 14 in Earth's shadow, 12 in daylight.",
    );
  });
});

describe("parseAskResponse", () => {
  it("accepts the real response", () => {
    const parsed = parseAskResponse(chicago);
    expect(parsed.answer).toBe(chicago.answer);
    expect(parsed.tools).toHaveLength(1);
  });

  it("rejects a body without an answer", () => {
    expect(() => parseAskResponse({ tools: [] })).toThrow(AskError);
  });
});

describe("askErrorMessage", () => {
  it.each([
    [new AskError(null), "Couldn't reach Phoebe. Check your connection and try again."],
    [new AskError(429, null, null, 45), "That's a lot of questions at once. Wait a minute, then try again."],
    [new AskError(429, null, null, 50_000), "That's all the questions Phoebe can take from you today. Try again tomorrow."],
    [new AskError(400), "Ask a question between 3 and 500 characters long."],
    [
      new AskError(503, "daily_budget", "Ask Phoebe has answered all it can for today. Back tomorrow!"),
      "Ask Phoebe has answered all it can for today. Back tomorrow!",
    ],
    [new AskError(504, "timeout", "Ask Phoebe took too long to answer. Try again in a minute."), "Ask Phoebe took too long to answer. Try again in a minute."],
    // An unknown code's detail is never shown (it wasn't written for visitors).
    [new AskError(500, "boom", "Traceback ..."), "Ask Phoebe isn't working right now. Try again later."],
  ])("%#", (error, message) => {
    expect(askErrorMessage(error)).toBe(message);
  });
});
