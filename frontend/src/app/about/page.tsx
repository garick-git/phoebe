import type { Metadata } from "next";
import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "About",
  description:
    "How Phoebe predicts visible satellite passes, how its predictions are checked, where its data comes from, and what it does with your location.",
  path: "/about/",
});

const linkClass = "text-accent underline underline-offset-2 hover:no-underline";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-10">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      <div className="mt-2 space-y-3 text-muted">{children}</div>
    </section>
  );
}

/**
 * About: how it works, how a pass is judged visible and how that was checked,
 * credits (attribution required by Open-Meteo and GeoNames, CC BY 4.0), and
 * the privacy note. Every claim here must stay true: numbers come from the
 * project's measured results, not estimates.
 */
export default function AboutPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 leading-relaxed">
      <h1 className="text-2xl font-semibold tracking-tight">About Phoebe</h1>
      <p className="mt-3 text-muted">
        Phoebe answers one question: when should I go outside, and will I actually see it?
        Satellites are only visible when they are sunlit against a dark sky, so Phoebe combines
        orbital data, the Sun’s position and the cloud forecast for your city. Sky apps are best for
        spotting a satellite once you’re outside; Phoebe tells you when to go out and where to look.
      </p>

      <Section id="how" title="How it works">
        <p>
          Once a day Phoebe downloads the latest orbital data for every active satellite. The dots on
          the globe are calculated in your browser every second; pass predictions are calculated on
          Phoebe’s server. Both use SGP4, the standard model for this kind of orbital data.
        </p>
        <p>
          The viewing rating comes from the hourly cloud forecast for the time of the pass:{" "}
          <strong className="font-medium text-ink">good</strong> up to 25% cloud cover,{" "}
          <strong className="font-medium text-ink">fair</strong> up to 50%, and{" "}
          <strong className="font-medium text-ink">poor</strong> above that.
        </p>
        <p>
          Ask Phoebe answers questions in plain English using Claude, an AI model by Anthropic, which
          looks up passes, satellites and forecasts with Phoebe’s own data. Before an answer is shown,
          every time and number in it is checked against that data; if anything doesn’t match, you
          see the pass data instead of the answer.
        </p>
      </Section>

      <Section id="visible" title="When a pass counts as visible">
        <p>A pass is shown only when all three are true at the same moment:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>the satellite is at least 10° above your horizon,</li>
          <li>the satellite is in sunlight, not in Earth’s shadow, and</li>
          <li>your sky is dark enough: the Sun is at least 6° below the horizon.</li>
        </ul>
        <p>
          That’s why visible passes come in stretches: for days at a time the satellite only crosses
          your sky in daylight, or in Earth’s shadow in the middle of the night.
        </p>
      </Section>

      <Section id="checked" title="How the predictions were checked">
        <p>
          Phoebe’s ISS predictions were compared with{" "}
          <a href="https://www.heavens-above.com" className={linkClass}>
            Heavens-Above
          </a>
          , a long-running satellite prediction site. For Chicago in October 2026, all 11 visible
          passes matched, and every appear, highest and disappear time (33 in all) was within
          2 seconds. Both agreed that Austin had no visible ISS passes that week.
        </p>
        <p>
          Predictions get less accurate as orbital data ages, so they’re best within a few days.
          Phoebe is for planning when to look up, not for navigation or safety decisions.
        </p>
      </Section>

      <Section id="privacy" title="Your location and privacy">
        <p>Phoebe has no accounts and doesn’t store where you are.</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            “Use my location” is rounded to about 1 km in your browser before it’s used anywhere, and
            the page’s address only ever holds a city or those rounded coordinates.
          </li>
          <li>
            City search sends what you type to Open-Meteo (along with your IP address, like any web
            request).
          </li>
          <li>
            The cloud forecast sends the place’s rounded coordinates to Open-Meteo, which keeps
            server logs, possibly including them, for up to 90 days.
          </li>
          <li>
            Ask Phoebe sends your question to Phoebe’s server and to Anthropic to answer it, and the
            place you name to Open-Meteo to find it, so don’t include personal details.
          </li>
          <li>
            Phoebe counts anonymous events (for example, that a pass list was shown) and reports
            errors, never with your place, coordinates, IP address or anything you typed.
          </li>
        </ul>
      </Section>

      <Section id="credits" title="Data and credits">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Orbital data from{" "}
            <a href="https://celestrak.org" className={linkClass}>
              CelesTrak
            </a>
            .
          </li>
          <li>
            Weather data and city search by{" "}
            <a href="https://open-meteo.com" className={linkClass}>
              Open-Meteo.com
            </a>{" "}
            (CC BY 4.0).
          </li>
          <li>
            City locations based on{" "}
            <a href="https://www.geonames.org" className={linkClass}>
              GeoNames
            </a>{" "}
            (CC BY 4.0).
          </li>
          <li>
            Earth image from the{" "}
            <a href="https://github.com/vasturiano/three-globe" className={linkClass}>
              three-globe
            </a>{" "}
            project by Vasco Asturiano (MIT License).
          </li>
          <li>Predictions checked against Heavens-Above.</li>
        </ul>
      </Section>
    </div>
  );
}
