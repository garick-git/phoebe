/**
 * Ask Phoebe's drawer, end to end, with POST /api/ask/ stubbed by Oct 21's
 * real Chicago answer (src/lib/__fixtures__/ask-chicago.json). The clock is
 * fixed just after that answer was made, so its passes (Oct 22–24) are still
 * ahead and show as cards. No test here calls Claude.
 */

import { expect, test, type Page } from "@playwright/test";

import chicago from "../src/lib/__fixtures__/ask-chicago.json";
import { blockOutside, fulfillApi, stubCloudForecast } from "./stubs";

// "searched_from": "Wed Oct 21, 3:44 pm CDT" in the fixture.
const ASKED_AT = new Date("2026-10-21T20:45:00Z");
const QUESTION = "When can I see the ISS from Chicago in the next 3 days?";

async function stubAsk(page: Page, status: number, body: unknown, headers: Record<string, string> = {}) {
  const asked: string[] = [];
  await page.route("**/api/ask/", async (route) => {
    if (route.request().method() === "POST") asked.push(route.request().postDataJSON().question);
    await fulfillApi(route, status, body, headers);
  });
  return asked;
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(ASKED_AT);
  await blockOutside(page);
  await stubCloudForecast(page, 10); // 10% everywhere: "Good viewing"
});

async function openFromHeader(page: Page) {
  await page.goto("/tonight/");
  await page.getByRole("button", { name: "Ask Phoebe" }).click();
  const dialog = page.getByRole("dialog", { name: "Ask Phoebe" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The visible message (each one is also in a screen-reader status line, which this skips). */
function message(page: Page, text: string) {
  return page.getByRole("dialog", { name: "Ask Phoebe" }).getByRole("paragraph").filter({ hasText: text });
}

async function ask(page: Page, text = QUESTION) {
  const dialog = page.getByRole("dialog", { name: "Ask Phoebe" });
  await dialog.getByLabel("Your question").fill(text);
  await dialog.getByRole("button", { name: "Ask", exact: true }).click();
}

test("a verified answer shows with the ✓ line and the same pass cards as Tonight", async ({ page }) => {
  const asked = await stubAsk(page, 200, chicago);
  const dialog = await openFromHeader(page);
  await ask(page);

  expect(asked).toEqual([QUESTION]);
  await expect(dialog.getByText("You asked")).toBeVisible();
  await expect(dialog.getByText(/you can see the ISS 5 times in the next 3 days/)).toBeVisible();
  await expect(dialog.getByText("Times and numbers checked against Phoebe’s pass data.")).toBeVisible();

  const group = dialog.getByRole("region", { name: "ISS from Chicago, Illinois, United States" });
  await expect(group.getByRole("article")).toHaveCount(5);
  await expect(group.getByRole("article").first()).toContainText("Good viewing");
  await expect(dialog.getByRole("status").last()).toHaveText("Answer ready. 5 visible passes shown as cards.");
});

test("an answer with one wrong time is hidden, and the passes come straight from the tool data", async ({ page }) => {
  // The stub's --wrong case: the first time a minute early (4:59 am → 4:58 am).
  const wrong = { ...chicago, answer: chicago.answer.replace("4:59 am", "4:58 am") };
  expect(wrong.answer).not.toEqual(chicago.answer);
  await stubAsk(page, 200, wrong);
  const dialog = await openFromHeader(page);
  await ask(page);

  await expect(dialog.getByText(/couldn’t double-check that answer/)).toBeVisible();
  await expect(dialog.getByRole("article")).toHaveCount(5);
  await expect(dialog).not.toContainText("4:58");
  await expect(dialog.getByText("Times and numbers checked against Phoebe’s pass data.")).toHaveCount(0);
});

test("a spent daily budget (503) shows the server's message", async ({ page }) => {
  const detail = "Ask Phoebe has answered all it can for today. Back tomorrow!";
  await stubAsk(page, 503, { detail, code: "daily_budget" }, { "Retry-After": "3600" });
  const dialog = await openFromHeader(page);
  await ask(page);

  await expect(message(page, detail)).toBeVisible();
  await expect(dialog.getByRole("article")).toHaveCount(0);
  // The question stays in the box, so trying again is one tap.
  await expect(dialog.getByLabel("Your question")).toHaveValue(QUESTION);
});

test("too many questions at once (429) asks to wait a minute", async ({ page }) => {
  await stubAsk(page, 429, { detail: "Request was throttled. Expected available in 42 seconds." }, { "Retry-After": "42" });
  await openFromHeader(page);
  await ask(page);

  await expect(message(page, "That's a lot of questions at once. Wait a minute, then try again.")).toBeVisible();
});

test("the daily question limit (429 with a long Retry-After) says to come back tomorrow", async ({ page }) => {
  await stubAsk(
    page,
    429,
    { detail: "Request was throttled. Expected available in 30000 seconds." },
    { "Retry-After": "30000" },
  );
  await openFromHeader(page);
  await ask(page);

  await expect(message(page, "That's all the questions Phoebe can take from you today. Try again tomorrow.")).toBeVisible();
});

test("keyboard only: open, pick an example, close with Escape, focus returns", async ({ page }) => {
  await stubAsk(page, 200, chicago);
  await page.goto("/tonight/");
  const open = page.getByRole("button", { name: "Ask Phoebe" });
  await open.focus();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Ask Phoebe" });
  await expect(dialog).toBeVisible();
  // Focus moved into the dialog (the native default: its first focusable, Close).
  await expect(dialog.getByRole("button", { name: "Close Ask Phoebe" })).toBeFocused();

  // An example fills the input and focuses it.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  const input = dialog.getByLabel("Your question");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("When can I see the ISS from Austin this week?");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the tab bar's Ask button opens the drawer", async ({ page }) => {
    await page.goto("/tonight/");
    await expect(page.getByRole("button", { name: "Ask Phoebe" })).toBeHidden(); // header button is desktop-only
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Ask Phoebe" })).toBeVisible();
  });
});
