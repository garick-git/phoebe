import { describe, expect, it } from "vitest";

import { POPULAR_SATELLITES, nicknameMatches, popularSatellite } from "@/lib/popular";

describe("popular satellites", () => {
  it("looks satellites up by NORAD ID", () => {
    expect(popularSatellite(25544)).toMatchObject({ nickname: "ISS", inSentence: "the ISS" });
    expect(popularSatellite(48274)?.inSentence).toBe("Tiangong");
    expect(popularSatellite(20580)?.nickname).toBe("Hubble");
    expect(popularSatellite(44714)).toBeUndefined();
  });

  it("matches the start of any alias, from two letters on", () => {
    expect(nicknameMatches("h")).toEqual(new Set());
    expect(nicknameMatches("hu")).toEqual(new Set([20580]));
    expect(nicknameMatches("  CSS ")).toEqual(new Set([48274]));
    expect(nicknameMatches("space station")).toEqual(new Set([25544]));
    expect(nicknameMatches("station")).toEqual(new Set()); // start of an alias only
  });

  it("keeps every alias lowercase (matching lowercases the query, not the aliases)", () => {
    for (const sat of POPULAR_SATELLITES) {
      for (const alias of sat.aliases) expect(alias).toBe(alias.toLowerCase());
    }
  });
});
