import type { ErrorEvent } from "@sentry/browser";
import { describe, expect, it } from "vitest";
import { scrubBreadcrumb, scrubEvent, stripQuery, stripUrlsInText } from "./privacy";

const TONIGHT = "https://phoebe.garickm.com/tonight/?lat=30.27&lon=-97.74&place=Austin%2C+Texas&tz=America%2FChicago";
const PASSES = "https://phoebe-api.garickm.com/api/satellites/25544/passes/?lat=30.27&lon=-97.74&days=7";
const GEOCODING = "https://geocoding-api.open-meteo.com/v1/search?name=Austin&count=5";

/** Nothing that places or identifies the visitor may appear anywhere. */
function expectClean(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of ["30.27", "-97.74", "Austin", "lat=", "place=", "Evergreen", "203.0.113.7", "session"]) {
    expect(text, `${secret} would be sent`).not.toContain(secret);
  }
}

describe("stripQuery", () => {
  it("keeps the address up to the path", () => {
    expect(stripQuery(TONIGHT)).toBe("https://phoebe.garickm.com/tonight/");
    expect(stripQuery("/tonight/?lat=1#x")).toBe("/tonight/");
    expect(stripQuery("https://phoebe.garickm.com/about/")).toBe("https://phoebe.garickm.com/about/");
    expect(stripQuery(undefined)).toBeUndefined();
  });

  it("strips URLs inside text, leaving the rest", () => {
    expect(stripUrlsInText(`Failed to load ${GEOCODING} (500)`)).toBe(
      "Failed to load https://geocoding-api.open-meteo.com/v1/search (500)",
    );
    expect(stripUrlsInText("Where? Nowhere.")).toBe("Where? Nowhere.");
  });
});

describe("scrubBreadcrumb", () => {
  it("drops clicks, key presses and console output", () => {
    expect(scrubBreadcrumb({ category: "ui.click", message: "li.card > h3" })).toBeNull();
    expect(scrubBreadcrumb({ category: "ui.input", message: "input#ask" })).toBeNull();
    expect(scrubBreadcrumb({ category: "console", message: "Austin" })).toBeNull();
  });

  it("keeps requests and page changes without their queries", () => {
    const fetchCrumb = scrubBreadcrumb({
      category: "fetch",
      data: { method: "GET", url: PASSES, status_code: 200 },
    });
    expect(fetchCrumb?.data).toEqual({
      method: "GET",
      url: "https://phoebe-api.garickm.com/api/satellites/25544/passes/",
      status_code: 200,
    });
    const navigation = scrubBreadcrumb({ category: "navigation", data: { from: "/tonight/", to: "/tonight/?lat=30.27&lon=-97.74" } });
    expect(navigation?.data).toEqual({ from: "/tonight/", to: "/tonight/" });
    expectClean([fetchCrumb, navigation]);
  });
});

describe("scrubEvent", () => {
  const event: ErrorEvent = {
    type: undefined,
    message: `Request to ${GEOCODING} failed`,
    user: { ip_address: "203.0.113.7" },
    request: {
      url: TONIGHT,
      headers: { "User-Agent": "Mozilla/5.0", Referer: TONIGHT },
      cookies: { session: "abc" },
      data: { question: "Can I see the ISS from 742 Evergreen Terrace?" },
      query_string: "lat=30.27&lon=-97.74",
    },
    exception: { values: [{ type: "TypeError", value: `Failed to fetch ${PASSES}` }] },
    breadcrumbs: [
      { category: "ui.click", message: "button Austin, Texas" },
      { category: "fetch", data: { url: GEOCODING } },
    ],
  };

  it("keeps the page path, the browser and the error, nothing else", () => {
    const scrubbed = scrubEvent(event);
    expect(scrubbed.request).toEqual({
      url: "https://phoebe.garickm.com/tonight/",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    expect(scrubbed.exception?.values?.[0]).toEqual({
      type: "TypeError",
      value: "Failed to fetch https://phoebe-api.garickm.com/api/satellites/25544/passes/",
    });
    expect(scrubbed.breadcrumbs).toEqual([
      { category: "fetch", data: { url: "https://geocoding-api.open-meteo.com/v1/search" }, message: undefined },
    ]);
    expect(scrubbed.user).toBeUndefined();
    expectClean(scrubbed);
  });

  it("leaves the original event untouched", () => {
    scrubEvent(event);
    expect(event.request?.url).toBe(TONIGHT);
  });
});
