/**
 * Sentry's browser SDK setup, loaded on demand by ./sentry.ts. Named imports
 * (not `import * as Sentry`) so the bundler keeps only what's listed here:
 * a namespace import pulled Session Replay and the feedback widget into the
 * chunk too (411 KB; now 86 KB, 30 KB compressed).
 */

import {
  breadcrumbsIntegration,
  browserApiErrorsIntegration,
  dedupeIntegration,
  eventFiltersIntegration,
  functionToStringIntegration,
  globalHandlersIntegration,
  httpContextIntegration,
  init,
  linkedErrorsIntegration,
} from "@sentry/browser";
import { scrubBreadcrumb, scrubEvent } from "./privacy";

export function initSentry(dsn: string): void {
  init({
    dsn,
    environment: "production",
    // Listed one by one instead of the defaults: no console capture, no
    // locale/time zone context, no session pings.
    defaultIntegrations: false,
    integrations: [
      eventFiltersIntegration(),
      functionToStringIntegration(),
      browserApiErrorsIntegration(),
      globalHandlersIntegration(),
      linkedErrorsIntegration(),
      dedupeIntegration(),
      httpContextIntegration(),
      // Requests and page changes only (URLs scrubbed); no clicks or key presses.
      breadcrumbsIntegration({ dom: false, fetch: true, xhr: true, history: true, sentry: false }),
    ],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: ["User-Agent"] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    },
    // No sentry-trace/baggage headers on our API or Open-Meteo requests
    // (they'd also turn simple requests into CORS preflights).
    tracePropagationTargets: [],
    // Don't rewrite the app's own fetch error messages ("Failed to fetch").
    enhanceFetchErrorMessages: "report-only",
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}
