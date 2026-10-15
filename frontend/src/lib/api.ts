/**
 * Where Phoebe's API lives. `npm run dev` talks to the local Django server
 * (its CORS allowlist has http://localhost:3000); production builds talk to
 * https://phoebe-api.garickm.com (its allowlist has https://phoebe.garickm.com).
 * NEXT_PUBLIC_API_BASE_URL overrides both. It's baked in at build time and is
 * public, so it must never hold a secret.
 */
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  (process.env.NODE_ENV === "development"
    ? "http://127.0.0.1:8000"
    : "https://phoebe-api.garickm.com");
