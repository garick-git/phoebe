/**
 * What leaves the browser for analytics, checked on the real pages: every
 * event body PostHog would receive is recorded and searched for the place,
 * its coordinates and the question. Sentry's requests stay blocked
 * (blockOutside), so these flows also prove the app works when it fails.
 *
 * Needs a build made with NEXT_PUBLIC_POSTHOG_KEY and NEXT_PUBLIC_SENTRY_DSN
 * set (CI sets dummy values for the frontend job); skipped otherwise:
 *
 *   export NEXT_PUBLIC_POSTHOG_KEY=phc_e2e NEXT_PUBLIC_SENTRY_DSN=https://e2e@o0.ingest.us.sentry.io/0
 *   npm run build && npm run test:e2e
 */

import { expect, test } from "@playwright/test";

import chicago from "../src/lib/__fixtures__/ask-chicago.json";
import sydney from "./fixtures/passes-iss-sydney.json";
import { blockOutside, fulfillApi, openDialog, recordAnalytics, stubCloudForecast, type SentEvent } from "./stubs";

test.skip(!process.env.NEXT_PUBLIC_POSTHOG_KEY, "build without analytics (NEXT_PUBLIC_POSTHOG_KEY unset)");

const SYDNEY = { id: 2147714, name: "Sydney", latitude: -33.86785, longitude: 151.20732, timezone: "Australia/Sydney", admin1: "New South Wales", country: "Australia" };

function expectNothingAbout(sent: SentEvent[], secrets: string[]) {
  const text = JSON.stringify(sent);
  for (const secret of secrets) expect(text, `${secret} was sent to PostHog`).not.toContain(secret);
}

test("Tonight: page views and pass predictions are counted, the place never sent", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-06T01:00:00Z"));
  await blockOutside(page);
  await stubCloudForecast(page, 10);
  const sent = await recordAnalytics(page);
  await page.route("https://geocoding-api.open-meteo.com/v1/search**", (route) =>
    route.fulfill({ json: { results: [SYDNEY] }, headers: { "Access-Control-Allow-Origin": "*" } }),
  );
  await page.route("**/api/satellites/*/passes/**", async (route) => {
    const noradId = Number(new URL(route.request().url()).pathname.split("/")[3]);
    await fulfillApi(route, 200, noradId === 25544 ? sydney : { ...sydney, norad_cat_id: noradId, passes: [] });
  });

  await page.goto("/tonight/");
  const search = page.getByRole("combobox", { name: "Find a city" });
  await search.fill("Syd");
  await expect(page.getByRole("option", { name: "Sydney New South Wales, Australia" })).toBeVisible();
  await search.press("Enter");
  await expect(page.getByRole("article")).toHaveCount(10);

  await expect.poll(() => sent.map((e) => e.event)).toEqual(
    expect.arrayContaining(["$pageview", "tonight_place_chosen", "tonight_passes_shown"]),
  );
  const shown = sent.find((e) => e.event === "tonight_passes_shown");
  expect(shown?.properties).toMatchObject({ visible_tonight: 2, visible_later: 8, failed_satellites: 0 });
  expect(sent.find((e) => e.event === "tonight_place_chosen")?.properties.source).toBe("search");
  for (const event of sent) expect(event.properties.$current_url).toBe("http://127.0.0.1:4173/tonight/");
  expectNothingAbout(sent, ["Sydney", "Syd", "-33.8", "151.2", "lat=", "place=", "Australia"]);
});

test("Ask Phoebe: questions and verified answers are counted, the question never sent", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-21T20:45:00Z"));
  await blockOutside(page);
  await stubCloudForecast(page, 10);
  const sent = await recordAnalytics(page);
  await page.route("**/api/ask/", (route) => fulfillApi(route, 200, chicago));

  await page.goto("/tonight/");
  const dialog = page.getByRole("dialog", { name: "Ask Phoebe" });
  await openDialog(dialog, () => page.getByRole("button", { name: "Ask Phoebe" }).click());
  await dialog.getByLabel("Your question").fill("When can I see the ISS from Chicago in the next 3 days?");
  await dialog.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(dialog.getByRole("article")).toHaveCount(5);

  await expect.poll(() => sent.map((e) => e.event)).toEqual(
    expect.arrayContaining(["ask_question_asked", "ask_answer_shown"]),
  );
  expect(sent.find((e) => e.event === "ask_answer_shown")?.properties).toMatchObject({
    outcome: "verified",
    error_code: null,
    visible_passes: 5,
  });
  expectNothingAbout(sent, ["Chicago", "ISS from", "next 3 days", "41.8", "-87.6", "Illinois"]);
});
