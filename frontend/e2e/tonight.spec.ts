/**
 * Tonight's main flow, end to end: search a city → the URL holds the rounded
 * place → the passes load as plain-language cards with a cloud rating.
 *
 * The ISS passes are real responses from Phoebe's passes endpoint, made with
 * the Oct 6 ISS element set (ISS_RECORD in satellites/tests/test_positions.py)
 * at 2026-10-06 01:00 UTC, which is also where the clock is fixed:
 * Sydney has 10 visible passes that week (2 before noon tomorrow), London none.
 * Tiangong and Hubble answer with no passes, to keep the cards about the ISS.
 */

import { expect, test, type Page } from "@playwright/test";

import london from "./fixtures/passes-iss-london.json";
import sydney from "./fixtures/passes-iss-sydney.json";
import { blockOutside, fulfillApi, stubCloudForecast } from "./stubs";

const NOW = new Date("2026-10-06T01:00:00Z"); // noon in Sydney, 2 am in London

const PLACES = {
  sydney: { id: 2147714, name: "Sydney", latitude: -33.86785, longitude: 151.20732, timezone: "Australia/Sydney", admin1: "New South Wales", country: "Australia" },
  london: { id: 2643743, name: "London", latitude: 51.50853, longitude: -0.12574, timezone: "Europe/London", admin1: "England", country: "United Kingdom" },
};

const SYDNEY_URL = "/tonight/?lat=-33.87&lon=151.21&place=Sydney%2C+New+South+Wales%2C+Australia&tz=Australia%2FSydney";

/** Stubs the geocoder and the passes endpoint; returns every passes URL requested. */
async function stubApis(page: Page) {
  await page.route("https://geocoding-api.open-meteo.com/v1/search**", async (route) => {
    const name = new URL(route.request().url()).searchParams.get("name")?.toLowerCase() ?? "";
    const results = Object.values(PLACES).filter((p) => p.name.toLowerCase().startsWith(name));
    await route.fulfill({ json: results.length ? { results } : {}, headers: { "Access-Control-Allow-Origin": "*" } });
  });

  const requested: URL[] = [];
  await page.route("**/api/satellites/*/passes/**", async (route) => {
    const url = new URL(route.request().url());
    requested.push(url);
    const noradId = Number(url.pathname.split("/")[3]);
    const iss = url.searchParams.get("lat") === "51.51" ? london : sydney;
    const body = noradId === 25544 ? iss : { ...iss, norad_cat_id: noradId, name: `NORAD ${noradId}`, passes: [] };
    await fulfillApi(route, 200, body);
  });
  return requested;
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await blockOutside(page);
  await stubCloudForecast(page, 10); // "Good viewing" everywhere
});

async function pickCity(page: Page, typed: string, option: string) {
  const search = page.getByRole("combobox", { name: "Find a city" });
  await search.fill(typed);
  await expect(page.getByRole("option", { name: option })).toBeVisible();
  await search.press("Enter"); // the keyboard path: the first option is active
}

test("pick a city: the URL holds the rounded place and the passes load as cards", async ({ page }) => {
  const requested = await stubApis(page);
  await page.goto("/tonight/");
  await pickCity(page, "Syd", "Sydney New South Wales, Australia");

  await expect(page).toHaveURL(SYDNEY_URL);
  await expect(page.getByRole("heading", { level: 2, name: "Sydney, New South Wales, Australia" })).toBeVisible();

  const tonight = page.getByRole("list").filter({ has: page.getByRole("article") }).first();
  await expect(tonight.getByRole("article")).toHaveCount(2);
  const first = tonight.getByRole("article").first();
  await expect(first).toContainText(/TOMORROW MORNING · ISS/i);
  await expect(first).toContainText(/4:10 am, look/);
  await expect(first).toContainText("Good viewing · mostly clear");
  await expect(page.getByRole("heading", { name: "Later this week" })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(10);

  // Location privacy: every request carried coordinates rounded to 2 decimals.
  expect(requested).toHaveLength(3);
  for (const url of requested) {
    expect(url.searchParams.get("lat")).toBe("-33.87");
    expect(url.searchParams.get("lon")).toBe("151.21");
  }
});

test("a precise link is rewritten to the rounded one", async ({ page }) => {
  await stubApis(page);
  await page.goto("/tonight/?lat=-33.86785&lon=151.20732&place=Sydney%2C+New+South+Wales%2C+Australia&tz=Australia%2FSydney");
  await expect(page).toHaveURL(SYDNEY_URL);
  await expect(page.getByRole("article")).toHaveCount(10);
});

test("Back returns to the previous city", async ({ page }) => {
  await stubApis(page);
  await page.goto(SYDNEY_URL);
  await expect(page.getByRole("heading", { level: 2, name: /^Sydney/ })).toBeVisible();

  await pickCity(page, "Lon", "London England, United Kingdom");
  await expect(page.getByRole("heading", { level: 2, name: /^London/ })).toBeVisible();
  await expect(page).toHaveURL(/lat=51\.51&lon=-0\.13/);

  await page.goBack();
  await expect(page.getByRole("heading", { level: 2, name: /^Sydney/ })).toBeVisible();
  await expect(page).toHaveURL(SYDNEY_URL);
});

test("a week with no visible passes says so", async ({ page }) => {
  await stubApis(page);
  await page.goto("/tonight/");
  await pickCity(page, "Lon", "London England, United Kingdom");

  await expect(page.getByText(/^No visible passes from .+ tonight\. None in the next 7 days either\.$/)).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
});

test("the details toggle shows exact times and the cloud forecast", async ({ page }) => {
  await stubApis(page);
  await page.goto(SYDNEY_URL);
  const card = page.getByRole("article").first();
  const details = card.getByText("Exact times and directions");
  await expect(card.getByText("Clouds", { exact: true })).toBeHidden();

  await details.click();
  await expect(card.getByText("Appears", { exact: true })).toBeVisible();
  await expect(card.getByText("Clouds", { exact: true })).toBeVisible();
  await expect(card).toContainText("10%");
});

test("a failed cloud forecast still shows every card", async ({ page }) => {
  await stubApis(page);
  await stubCloudForecast(page, "fail"); // registered later, so it wins
  await page.goto(SYDNEY_URL);

  await expect(page.getByRole("article")).toHaveCount(10);
  await expect(page.getByRole("article").first()).toContainText("Cloud forecast unavailable");
});
