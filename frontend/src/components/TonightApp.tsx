"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import CitySearch from "@/components/CitySearch";
import PassSummary from "@/components/PassSummary";
import type { GeocodedPlace } from "@/lib/geocoding";
import {
  cleanLabel,
  formatCoords,
  isValidTimeZone,
  parsePlace,
  placeSearchParams,
  roundCoord,
  viewerTimeZone,
  type Place,
} from "@/lib/place";

/** Geolocation error codes from the spec: 1 denied, 2 unavailable, 3 timeout. */
const LOCATION_ERRORS: Record<number, string> = {
  1: "Location access is off for this site. Search for your city instead.",
  2: "Your location isn't available right now. Search for your city instead.",
  3: "Finding your location took too long. Try again, or search for your city.",
};

/**
 * Tonight's interactive part. The URL is the state: picking a city or using
 * your location writes `?lat=&lon=&place=&tz=` (see lib/place.ts), and the
 * passes load from whatever the URL says, so links and Back work. Read with
 * useSearchParams in the browser, because a static export has no server to
 * read the query string (the page wraps this in <Suspense> for the build).
 */
export default function TonightApp() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");

  const parsed = useMemo(() => parsePlace(searchParams, viewerTimeZone()), [searchParams]);

  // A hand-edited or old link (precise coordinates, a bad time zone, a long
  // label) is rewritten to the rounded, canonical form without a new history entry.
  const canonical = parsed.kind === "ok" ? placeSearchParams(parsed.place).toString() : null;
  useEffect(() => {
    if (canonical !== null && canonical !== searchParams.toString()) {
      router.replace(`${pathname}?${canonical}`, { scroll: false });
    }
  }, [canonical, searchParams, router, pathname]);

  function go(place: Place) {
    // push, not replace: Back returns to the previous city.
    router.push(`${pathname}?${placeSearchParams(place)}`, { scroll: false });
  }

  function pickCity(city: GeocodedPlace) {
    setLocationError("");
    go({
      lat: roundCoord(city.lat),
      lon: roundCoord(city.lon),
      label: cleanLabel(city.label),
      timeZone: city.timeZone && isValidTimeZone(city.timeZone) ? city.timeZone : viewerTimeZone(),
    });
  }

  function locateMe() {
    if (!("geolocation" in navigator)) {
      setLocationError("This browser can't share your location. Search for your city instead.");
      return;
    }
    setLocating(true);
    setLocationError("");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        // Rounded here, in the browser, before it goes into the URL or any request.
        go({
          lat: roundCoord(position.coords.latitude),
          lon: roundCoord(position.coords.longitude),
          label: null,
          timeZone: viewerTimeZone(),
        });
      },
      (error) => {
        setLocating(false);
        setLocationError(LOCATION_ERRORS[error.code] ?? LOCATION_ERRORS[2]);
      },
      // City-level accuracy is plenty, and a position up to 10 minutes old is fine.
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
    );
  }

  return (
    <>
      <div className="mt-6 space-y-3">
        <CitySearch onPick={pickCity} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            onClick={locateMe}
            disabled={locating}
            className="min-h-11 rounded-full border border-line px-4 text-sm text-ink hover:bg-raised disabled:text-muted"
          >
            {locating ? "Finding your location…" : "Use my location"}
          </button>
          <p className="text-xs text-muted">Rounded to about 1 km before it leaves your device.</p>
        </div>
        <p role="status" className={locationError ? "text-sm text-ink" : "sr-only"}>
          {locationError}
        </p>
      </div>

      {parsed.kind === "invalid" && (
        <p className="mt-6 rounded-lg border border-line bg-surface p-4 text-sm text-ink">
          This link&apos;s location isn&apos;t valid. Search for a city instead.
        </p>
      )}

      {parsed.kind === "ok" && (
        <section aria-labelledby="tonight-place" className="mt-8">
          <h2 id="tonight-place" className="text-lg font-semibold">
            {parsed.place.label ?? `Near ${formatCoords(parsed.place.lat, parsed.place.lon)}`}
          </h2>
          <PassSummary place={parsed.place} />
        </section>
      )}
    </>
  );
}
