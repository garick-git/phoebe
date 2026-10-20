import { defineConfig } from "vitest/config";

/**
 * Vitest for the front end's pure logic (src/lib): no React, no DOM, so the
 * plain Node environment is enough (no jsdom). Run with `npm test`.
 */
export default defineConfig({
  resolve: {
    // Vite 8 reads the `@/*` alias from tsconfig.json itself, so imports like
    // "@/lib/place" work in tests exactly as they do in Next.js (no plugin).
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Every time-zone function takes the zone as an argument. Running the
    // suite in an unusual zone (UTC+13:45, with daylight time) makes any test
    // that quietly depends on the machine's zone fail here, instead of passing
    // on a Mac in Central Time and failing in CI, which runs in UTC.
    env: { TZ: "Pacific/Chatham" },
  },
});
