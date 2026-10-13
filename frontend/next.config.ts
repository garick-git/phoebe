import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export: `next build` writes plain HTML/CSS/JS to out/, which Amplify
  // serves from its CDN. No Next.js server runs in production (Django is the API).
  // cacheComponents and partialPrefetching (template defaults) were removed:
  // they need a Next.js server and fail the build in export mode.
  output: "export",
  // Emit /about/index.html instead of /about.html so a static host can serve
  // a deep link or a refresh on /about without a rewrite rule.
  trailingSlash: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
