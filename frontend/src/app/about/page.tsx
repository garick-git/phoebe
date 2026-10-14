import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "About",
  description:
    "How Phoebe predicts visible satellite passes, where its orbital and weather data come from, and how accurate it is.",
  path: "/about/",
});

const linkClass = "text-accent underline underline-offset-2 hover:no-underline";

/** About. A first draft; the full version with attribution is reviewed in Week 5. */
export default function AboutPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 leading-relaxed">
      <h1 className="text-2xl font-semibold tracking-tight">About Phoebe</h1>
      <p className="mt-3 text-muted">
        Phoebe answers one question: when should I go outside, and will I actually see it? Satellites
        are only visible when they are sunlit against a dark sky, so Phoebe combines orbital data,
        the Sun’s position and the cloud forecast for your city.
      </p>

      <h2 className="mt-8 text-lg font-semibold">How it works</h2>
      <p className="mt-2 text-muted">
        Each day Phoebe downloads the latest orbital data for active satellites. Positions on the
        globe are calculated in your browser; pass predictions are calculated on Phoebe’s server
        using the standard SGP4 orbit model.
      </p>

      <h2 className="mt-8 text-lg font-semibold">Data sources</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
        <li>
          Orbital data from{" "}
          <a href="https://celestrak.org" className={linkClass}>
            CelesTrak
          </a>
          .
        </li>
        <li>
          Weather and city search by{" "}
          <a href="https://open-meteo.com" className={linkClass}>
            Open-Meteo.com
          </a>
          .
        </li>
      </ul>

      <h2 className="mt-8 text-lg font-semibold">Accuracy</h2>
      <p className="mt-2 text-muted">
        Predictions get less accurate as orbital data ages and are best within a few days. Phoebe is
        for planning when to look up, not for navigation or safety decisions.
      </p>
    </div>
  );
}
