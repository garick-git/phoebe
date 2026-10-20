import { describe, expect, it } from "vitest";

import type { Pass, PassPoint } from "@/lib/passes";
import {
  buildPassCards,
  cautionTag,
  compass16,
  compass8,
  dayLabel,
  durationText,
  formatClock,
  heightBand,
  isTonight,
  joinWords,
  pathSentence,
  skyPhrase,
  zoneName,
} from "@/lib/plainPass";

// Every function takes the time zone explicitly; the suite runs in
// Pacific/Chatham (vitest.config.mts), so nothing here can lean on the
// machine's own zone.
const CHICAGO = "America/Chicago";
const TOKYO = "Asia/Tokyo";

const ms = (iso: string) => Date.parse(iso);

function point(time: string, azimuth_deg: number, elevation_deg: number): PassPoint {
  return { time, azimuth_deg, elevation_deg };
}

/**
 * A pass from rise/peak/set plus its visible part. With no `visible` part
 * given, the whole pass is visible (start = rise, highest = peak, end = set).
 */
function makePass(
  rise: PassPoint,
  peak: PassPoint,
  set: PassPoint,
  visible?: { start: PassPoint; highest: PassPoint; end: PassPoint } | null,
): Pass {
  const part = visible === undefined ? { start: rise, highest: peak, end: set } : visible;
  return {
    rise,
    peak,
    set,
    max_elevation_deg: peak.elevation_deg,
    duration_s: (ms(set.time) - ms(rise.time)) / 1000,
    visibility: part
      ? { visible: true, reason: null, ...part }
      : { visible: false, reason: "earth_shadow", start: null, highest: null, end: null },
  };
}

describe("compass words", () => {
  it.each([
    [0, "north", "N"],
    [22.4, "north", "NNE"],
    [22.5, "northeast", "NNE"], // exact boundaries round up
    [315, "northwest", "NW"],
    [359.9, "north", "N"],
    [-10, "north", "N"],
    [360, "north", "N"],
  ])("%d° → %s / %s", (azimuth, eight, sixteen) => {
    expect(compass8(azimuth)).toBe(eight);
    expect(compass16(azimuth)).toBe(sixteen);
  });
});

describe("height bands", () => {
  it.each([
    [19.9, "low", "low in the sky"],
    [20, "partway up", "partway up the sky"],
    [44.9, "partway up", "partway up the sky"],
    [45, "high", "high in the sky"],
    [69.9, "high", "high in the sky"],
    [70, "almost overhead", "almost overhead"],
  ])("%d° → %s", (elevation, band, phrase) => {
    expect(heightBand(elevation)).toBe(band);
    expect(skyPhrase(elevation)).toBe(phrase);
  });
});

describe("small words", () => {
  it("durationText switches to minutes at 60 s", () => {
    expect(durationText(59)).toBe("under 1 min");
    expect(durationText(60)).toBe("1 min");
    expect(durationText(330)).toBe("6 min");
  });

  it("joinWords lists like a person would", () => {
    expect(joinWords([])).toBe("");
    expect(joinWords(["a"])).toBe("a");
    expect(joinWords(["a", "b"])).toBe("a and b");
    expect(joinWords(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("tonight = from now until noon tomorrow, in the place's time", () => {
  // Tue Oct 20, 1:05 pm CDT
  const tuesdayAfternoon = ms("2026-10-20T18:05:00Z");

  it("includes Wed 11:59 am and excludes Wed 12:00 pm", () => {
    expect(isTonight("2026-10-21T16:59:00Z", tuesdayAfternoon, CHICAGO)).toBe(true);
    expect(isTonight("2026-10-21T17:00:00Z", tuesdayAfternoon, CHICAGO)).toBe(false);
  });

  describe("seen at 3 am", () => {
    // Wed Oct 21, 3:00 am CDT
    const threeAm = ms("2026-10-21T08:00:00Z");
    it.each([
      ["2026-10-21T10:45:00Z", "This morning", true], // Wed 5:45 am
      ["2026-10-22T01:00:00Z", "Tonight", true], // Wed 8:00 pm
      ["2026-10-22T10:00:00Z", "Tomorrow morning", true], // Thu 5:00 am
      ["2026-10-23T01:00:00Z", "Tomorrow night", false], // Thu 8:00 pm
      ["2026-10-23T10:00:00Z", "Fri morning", false],
    ])("%s → %s (tonight: %s)", (start, label, tonight) => {
      expect(dayLabel(start, threeAm, CHICAGO)).toBe(label);
      expect(isTonight(start, threeAm, CHICAGO)).toBe(tonight);
    });
  });

  it("stays at noon across the Nov 1 change from daylight time", () => {
    // Sat Oct 31, 8:00 pm CDT; clocks fall back at 2 am, so Sun noon is 18:00 UTC, not 17:00.
    const saturdayNight = ms("2026-11-01T01:00:00Z");
    expect(isTonight("2026-11-01T17:30:00Z", saturdayNight, CHICAGO)).toBe(true); // 11:30 am CST
    expect(isTonight("2026-11-01T18:30:00Z", saturdayNight, CHICAGO)).toBe(false); // 12:30 pm CST
    expect(formatClock("2026-11-01T17:30:00Z", CHICAGO)).toBe("11:30 am");
  });

  it("uses the place's zone, not the viewer's: a Tokyo place", () => {
    // Tue Oct 20, 18:05 UTC is already Wed 3:05 am in Tokyo.
    const now = ms("2026-10-20T18:05:00Z");
    const pass = "2026-10-21T10:30:00Z"; // Wed 7:30 pm in Tokyo
    expect(dayLabel(pass, now, TOKYO)).toBe("Tonight");
    expect(isTonight(pass, now, TOKYO)).toBe(true);
    expect(formatClock(pass, TOKYO)).toBe("7:30 pm");
    // The same instant from Chicago is Wed 5:30 am, "Tomorrow morning".
    expect(dayLabel(pass, now, CHICAGO)).toBe("Tomorrow morning");
  });
});

describe("clock and zone names", () => {
  it("formats times with or without seconds", () => {
    expect(formatClock("2026-10-21T10:45:07Z", CHICAGO)).toBe("5:45 am");
    expect(formatClock("2026-10-21T10:45:07Z", CHICAGO, true)).toBe("5:45:07 am");
    expect(formatClock("2026-10-21T17:00:00Z", CHICAGO)).toBe("12:00 pm");
  });

  it("names the zone in words", () => {
    expect(zoneName(CHICAGO, ms("2026-10-21T00:00:00Z"))).toBe("Central Time");
  });
});

// Passes for the path and caution tests (Chicago, Oct 21; times in UTC).
const RISE = point("2026-10-21T10:44:00Z", 315, 10);
const PEAK = point("2026-10-21T10:47:00Z", 30, 62);
const SET = point("2026-10-21T10:50:00Z", 100, 10);

describe("pathSentence", () => {
  it("rises and sets when the whole pass is visible", () => {
    expect(pathSentence(makePass(RISE, PEAK, SET))).toBe(
      "Rises in the northwest, climbs high in the northeast and sets in the east.",
    );
  });

  it('says "appears" when it comes out of Earth\'s shadow mid-sky', () => {
    const start = point("2026-10-21T10:46:00Z", 340, 40);
    expect(pathSentence(makePass(RISE, PEAK, SET, { start, highest: PEAK, end: SET }))).toBe(
      "Appears partway up in the north, climbs high in the northeast and sets in the east.",
    );
  });

  it('says "fades out" when it goes into shadow before setting', () => {
    const end = point("2026-10-21T10:48:30Z", 80, 35);
    expect(pathSentence(makePass(RISE, PEAK, SET, { start: RISE, highest: PEAK, end }))).toBe(
      "Rises in the northwest, climbs high in the northeast and fades out partway up in the east.",
    );
  });

  it("skips the highest point when it is an edge of the visible part", () => {
    // Appears just after the peak: the highest visible point is where it appears.
    const start = point("2026-10-21T10:47:30Z", 50, 58);
    expect(pathSentence(makePass(RISE, PEAK, SET, { start, highest: start, end: SET }))).toBe(
      "Appears high in the northeast and sets in the east.",
    );
  });

  it('describes a grazing pass as "stays low"', () => {
    const rise = point("2026-10-21T10:44:00Z", 170, 10);
    const peak = point("2026-10-21T10:45:00Z", 180, 12);
    const set = point("2026-10-21T10:46:00Z", 190, 10);
    expect(pathSentence(makePass(rise, peak, set))).toBe("Rises in the south, stays low and sets in the south.");
  });

  it("says climbs almost overhead, without a direction", () => {
    const peak = point("2026-10-21T10:47:00Z", 30, 85);
    expect(pathSentence(makePass(RISE, peak, SET))).toBe(
      "Rises in the northwest, climbs almost overhead and sets in the east.",
    );
  });

  it("has no sentence for a pass that isn't visible", () => {
    expect(pathSentence(makePass(RISE, PEAK, SET, null))).toBeNull();
  });
});

describe("cautionTag", () => {
  const lowPeak = point("2026-10-21T10:47:00Z", 30, 15);
  const briefEnd = point("2026-10-21T10:44:40Z", 320, 12);

  it.each([
    ["low and brief", makePass(RISE, lowPeak, SET, { start: RISE, highest: RISE, end: briefEnd }), "Low and brief, easy to miss"],
    ["low", makePass(RISE, lowPeak, SET), "Stays low, easy to miss"],
    ["brief", makePass(RISE, PEAK, SET, { start: point("2026-10-21T10:46:40Z", 20, 55), highest: PEAK, end: point("2026-10-21T10:47:30Z", 50, 58) }), "Brief, easy to miss"],
    ["an easy pass", makePass(RISE, PEAK, SET), null],
  ])("%s", (_why, pass, tag) => {
    expect(cautionTag(pass)).toBe(tag);
  });
});

describe("buildPassCards", () => {
  // Tue Oct 20, 1:05 pm CDT
  const now = ms("2026-10-20T18:05:00Z");
  const at = (iso: string, az: number, el: number) => point(iso, az, el);

  // A whole visible pass starting at `startIso`, 6 minutes long.
  function passAt(startIso: string): Pass {
    const start = ms(startIso);
    const iso = (offsetS: number) => new Date(start + offsetS * 1000).toISOString();
    return makePass(at(iso(0), 315, 10), at(iso(180), 30, 62), at(iso(360), 100, 10));
  }

  const issTomorrow = passAt("2026-10-21T10:45:00Z"); // Wed 5:45 am: tonight
  const tiangongTonight = passAt("2026-10-21T00:50:00Z"); // Tue 7:50 pm: tonight
  const issEnded = passAt("2026-10-20T17:00:00Z"); // ended before now
  const hubbleLater = passAt("2026-10-22T10:30:00Z"); // Thu 5:30 am: later
  const issHidden = makePass(at("2026-10-21T09:00:00Z", 0, 10), at("2026-10-21T09:03:00Z", 90, 50), at("2026-10-21T09:06:00Z", 180, 10), null);

  const satellites = [
    { noradId: 25544, nickname: "ISS", passes: [issEnded, issHidden, issTomorrow] },
    { noradId: 48274, nickname: "Tiangong", passes: [tiangongTonight] },
    { noradId: 20580, nickname: "Hubble", passes: [hubbleLater] },
  ];

  it("sorts across satellites, skips hidden and ended passes, and splits tonight from later", () => {
    const { tonight, later } = buildPassCards(satellites, now, CHICAGO, { status: "loading" });
    expect(tonight.map((c) => `${c.satellite} ${c.dayLabel} ${c.time}`)).toEqual([
      "Tiangong Tonight 7:50 pm",
      "ISS Tomorrow morning 5:45 am",
    ]);
    expect(later.map((c) => `${c.satellite} ${c.dayLabel} ${c.time}`)).toEqual(["Hubble Thu morning 5:30 am"]);
  });

  it("builds a card's words, details and viewing line", () => {
    const t = ms("2026-10-21T10:00:00Z");
    const forecast = new Map([
      [t, 10],
      [t + 3_600_000, 20],
    ]);
    const { tonight } = buildPassCards(satellites, now, CHICAGO, { status: "ok", forecast });
    const iss = tonight.find((c) => c.noradId === 25544)!;
    expect(iss).toMatchObject({
      headline: "5:45 am, look northwest, high in the sky",
      path: "Rises in the northwest, climbs high in the northeast and sets in the east.",
      duration: "6 min",
      caution: null,
      viewing: "Good viewing · mostly clear",
      cloudDetail: "20% (6:00 am forecast)",
    });
    expect(iss.details).toEqual([
      { label: "Rises", time: "5:45:00 am", elevation: "10° up", direction: "NW (315°)" },
      { label: "Highest", time: "5:48:00 am", elevation: "62° up", direction: "NNE (30°)" },
      { label: "Sets", time: "5:51:00 am", elevation: "10° up", direction: "E (100°)" },
    ]);
  });

  it("never reorders or drops cards because of the forecast", () => {
    const loading = buildPassCards(satellites, now, CHICAGO, { status: "loading" });
    const failed = buildPassCards(satellites, now, CHICAGO, { status: "error" });
    expect(failed.tonight.map((c) => c.key)).toEqual(loading.tonight.map((c) => c.key));
    expect(failed.tonight[0].viewing).toBe("Cloud forecast unavailable");
    expect(loading.tonight[0].viewing).toBe("Checking clouds…");
  });
});
