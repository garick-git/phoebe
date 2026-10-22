/**
 * What may leave the browser for Sentry (errors) and PostHog (analytics).
 * Pure functions, so Vitest can pin every rule.
 *
 * Location privacy (brief section 2): page URLs hold a city name and rounded
 * coordinates (Tonight: ?lat=&lon=&place=), API URLs hold coordinates
 * (passes: ?lat=&lon=), Open-Meteo URLs hold a typed city name or coordinates,
 * and Ask Phoebe's question can name a place. None of these may reach a third
 * party. The rule is simple on purpose: no query string, anywhere, ever.
 */

import type { Breadcrumb, ErrorEvent } from "@sentry/browser";

/** The URL without its query string and fragment (works for relative URLs too). */
export function stripQuery(url: string): string;
export function stripQuery(url: string | undefined): string | undefined;
export function stripQuery(url: string | undefined): string | undefined {
  if (typeof url !== "string") return url;
  return url.split(/[?#]/, 1)[0];
}

// An http(s) URL's query string or fragment, inside any text.
const URL_TAIL = /(https?:\/\/[^\s?#'"]+)[?#][^\s'"]*/g;

/** Drop the query string and fragment of every URL quoted in `text`. */
export function stripUrlsInText(text: string): string;
export function stripUrlsInText(text: string | undefined): string | undefined;
export function stripUrlsInText(text: string | undefined): string | undefined {
  if (typeof text !== "string") return text;
  return text.replace(URL_TAIL, "$1");
}

// Breadcrumb categories that are never sent: clicks and key presses (an
// element's description can carry text from the page, such as a place name)
// and console output (anything can be logged).
const DROPPED_CATEGORIES = /^(ui\.|console$)/;

/** Sentry's beforeBreadcrumb hook. Returning null drops the breadcrumb. */
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  if (crumb.category && DROPPED_CATEGORIES.test(crumb.category)) return null;
  const data = crumb.data ? { ...crumb.data } : undefined;
  if (data) {
    // fetch/xhr breadcrumbs carry `url`; navigation breadcrumbs `from` and `to`.
    for (const key of ["url", "from", "to"]) {
      if (typeof data[key] === "string") data[key] = stripQuery(data[key]);
    }
  }
  return { ...crumb, data, message: stripUrlsInText(crumb.message) };
}

/** Sentry's beforeSend hook: runs on every error event before it's sent. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const scrubbed: ErrorEvent = { ...event, message: stripUrlsInText(event.message) };
  delete scrubbed.user;

  if (event.request) {
    // Only the page's address without its query, and the browser's name.
    // Referer can hold a Tonight URL; cookies and bodies have no use here.
    const userAgent = event.request.headers?.["User-Agent"];
    scrubbed.request = {
      url: stripQuery(event.request.url),
      ...(userAgent ? { headers: { "User-Agent": userAgent } } : {}),
    };
  }

  if (event.exception?.values) {
    scrubbed.exception = {
      ...event.exception,
      values: event.exception.values.map((value) => ({
        ...value,
        value: stripUrlsInText(value.value),
      })),
    };
  }

  if (event.breadcrumbs) {
    scrubbed.breadcrumbs = event.breadcrumbs.flatMap((crumb) => {
      const kept = scrubBreadcrumb(crumb);
      return kept ? [kept] : [];
    });
  }
  return scrubbed;
}
