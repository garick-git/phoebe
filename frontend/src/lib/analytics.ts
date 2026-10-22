/**
 * Product analytics: a handful of events sent straight to PostHog's capture
 * API, with no SDK (decision log, Oct 22). Only the events and fields typed
 * below can leave the browser: no autocapture, no session replay, no text
 * from the page, no place names, coordinates or questions.
 *
 * Off unless NEXT_PUBLIC_POSTHOG_KEY was set at build time (Amplify only), so
 * local development and CI send nothing. The key is PostHog's public,
 * write-only project key, so it's safe in the browser.
 *
 * Analytics must never break the app: track() never throws and never waits;
 * a blocked or failed request is simply lost.
 */

import { stripQuery } from "./privacy";

export const POSTHOG_HOST = "https://us.i.posthog.com";
const CAPTURE_URL = `${POSTHOG_HOST}/i/v0/e/`;
const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "";
const VISITOR_KEY = "phoebe-visitor";

/** Every event Phoebe sends, and the only fields each may carry. */
export type AnalyticsEvents = {
  $pageview: Record<string, never>;
  /** A place was picked on Tonight (not which place). */
  tonight_place_chosen: { source: "search" | "location" };
  /** Tonight's cards appeared: the pass predictions were used. */
  tonight_passes_shown: { visible_tonight: number; visible_later: number; failed_satellites: number };
  /** A question was sent to Ask Phoebe (never its text). */
  ask_question_asked: Record<string, never>;
  /** How the answer ended: verified prose, the tool-data fallback, or an error. */
  ask_answer_shown: {
    outcome: "verified" | "fallback" | "error";
    error_code: string | null;
    visible_passes: number;
  };
};
export type AnalyticsEventName = keyof AnalyticsEvents;

type CaptureBody = {
  api_key: string;
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, string | number | boolean | null>;
};

/**
 * The exact JSON sent to PostHog for one event (pure, for tests).
 * `href` is the page's address; only its origin and path are kept.
 */
export function captureBody<E extends AnalyticsEventName>(
  event: E,
  props: AnalyticsEvents[E],
  context: { apiKey: string; distinctId: string; href: string; now: Date },
): CaptureBody {
  const page = new URL(stripQuery(context.href));
  return {
    api_key: context.apiKey,
    event,
    distinct_id: context.distinctId,
    timestamp: context.now.toISOString(),
    properties: {
      ...props,
      $current_url: page.origin + page.pathname,
      $host: page.host,
      $pathname: page.pathname,
      $lib: "phoebe-web",
      // Anonymous events: no person profile is created for the visitor ID.
      $process_person_profile: false,
      // No city or country looked up from the IP address (which the project
      // also discards).
      $geoip_disable: true,
    },
  };
}

let memoryVisitorId: string | null = null;

/**
 * A random ID for this browser, so visitors can be counted (monthly active
 * users) without knowing who anyone is. Kept in localStorage; if that's
 * unavailable (private mode, blocked storage), one per page load.
 */
function visitorId(): string {
  try {
    const stored = window.localStorage.getItem(VISITOR_KEY);
    if (stored) return stored;
    const id = crypto.randomUUID();
    window.localStorage.setItem(VISITOR_KEY, id);
    return id;
  } catch {
    memoryVisitorId ??= crypto.randomUUID();
    return memoryVisitorId;
  }
}

/** Whether the visitor's browser asks sites not to share or sell their data. */
function globalPrivacyControl(): boolean {
  return (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
}

/** Send one event. Fire and forget: never throws, never blocks. */
export function track<E extends AnalyticsEventName>(event: E, props: AnalyticsEvents[E]): void {
  if (!POSTHOG_KEY || typeof window === "undefined") return;
  try {
    if (globalPrivacyControl()) return;
    const body = captureBody(event, props, {
      apiKey: POSTHOG_KEY,
      distinctId: visitorId(),
      href: window.location.href,
      now: new Date(),
    });
    fetch(CAPTURE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }).catch(() => {});
  } catch {
    // Analytics is never worth an error for the visitor.
  }
}
