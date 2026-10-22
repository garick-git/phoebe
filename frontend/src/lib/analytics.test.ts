import { afterEach, describe, expect, it, vi } from "vitest";
import { captureBody } from "./analytics";

const CONTEXT = {
  apiKey: "phc_test",
  distinctId: "6f1b5d1e-1111-4222-8333-444455556666",
  href: "https://phoebe.garickm.com/tonight/?lat=30.27&lon=-97.74&place=Austin%2C+Texas&tz=America%2FChicago#top",
  now: new Date("2026-10-22T20:00:00Z"),
};

describe("captureBody", () => {
  it("sends the event, its own fields and the page path, nothing about the place", () => {
    const body = captureBody(
      "tonight_passes_shown",
      { visible_tonight: 2, visible_later: 5, failed_satellites: 0 },
      CONTEXT,
    );

    expect(body).toEqual({
      api_key: "phc_test",
      event: "tonight_passes_shown",
      distinct_id: CONTEXT.distinctId,
      timestamp: "2026-10-22T20:00:00.000Z",
      properties: {
        visible_tonight: 2,
        visible_later: 5,
        failed_satellites: 0,
        $current_url: "https://phoebe.garickm.com/tonight/",
        $host: "phoebe.garickm.com",
        $pathname: "/tonight/",
        $lib: "phoebe-web",
        $process_person_profile: false,
        $geoip_disable: true,
      },
    });
    const text = JSON.stringify(body);
    for (const secret of ["30.27", "-97.74", "Austin", "Chicago", "lat=", "#top"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("only allows each event's own fields (checked by TypeScript)", () => {
    // @ts-expect-error: a place name is not a field of any event
    captureBody("tonight_place_chosen", { source: "search", place: "Austin" }, CONTEXT);
    // @ts-expect-error: questions are never sent
    captureBody("ask_question_asked", { question: "When is the ISS over Austin?" }, CONTEXT);
  });
});

describe("track", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("does nothing without a PostHog key (development and local builds)", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", ""); // CI's frontend job sets a dummy one
    vi.resetModules();
    const { track } = await import("./analytics");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("window", { location: { href: CONTEXT.href } });
    track("$pageview", {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never throws or waits, even with storage blocked and the request failing", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test"); // read when the module loads
    vi.resetModules();
    const { track: trackWithKey } = await import("./analytics");
    const fetchSpy = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", {
      location: { href: CONTEXT.href },
      localStorage: {
        getItem: () => {
          throw new Error("storage blocked");
        },
      },
    });

    expect(() => trackWithKey("ask_question_asked", {})).not.toThrow();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://us.i.posthog.com/i/v0/e/");
    expect(init.credentials).toBe("omit");
    const sent = JSON.parse(init.body as string);
    expect(sent.event).toBe("ask_question_asked");
    expect(sent.properties.$current_url).toBe("https://phoebe.garickm.com/tonight/");
    await Promise.resolve(); // the rejected request is swallowed, not unhandled
  });

  it("respects Global Privacy Control", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.resetModules();
    const { track: trackWithKey } = await import("./analytics");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("navigator", { globalPrivacyControl: true });
    vi.stubGlobal("window", { location: { href: CONTEXT.href } });

    trackWithKey("$pageview", {});

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
