/**
 * Error tracking with Sentry in the browser.
 *
 * Off unless NEXT_PUBLIC_SENTRY_DSN was set at build time (Amplify only), so
 * local development and CI send nothing. A browser DSN is public by design:
 * it can only send events to the phoebe-web project, never read them.
 *
 * The SDK is loaded with a dynamic import of ./sentryInit after the page is
 * interactive, in its own chunk (about 30 KB compressed), so it never delays
 * the first paint or the answer on Tonight (brief 6c). The trade-off: an error in the first moments of a page load,
 * before Sentry starts, isn't reported.
 *
 * Privacy: integrations are listed one by one instead of taking the defaults
 * (no console capture, no locale/time zone context, no session pings), click
 * and key breadcrumbs are dropped, and every URL loses its query string
 * (lib/privacy.ts). Sentry's server-side scrubbing is a second net.
 */

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN ?? "";

let started = false;

export async function startSentry(): Promise<void> {
  if (!SENTRY_DSN || started) return;
  started = true;
  const { initSentry } = await import("./sentryInit");
  initSentry(SENTRY_DSN);
}
