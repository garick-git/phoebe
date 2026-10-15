"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Globe, { type GlobeMethods } from "react-globe.gl";

import { API_BASE_URL } from "@/lib/api";
import {
  EARTH_RADIUS_KM,
  positionsAt,
  trackSatellites,
  type ElementSetRow,
  type SatellitePosition,
} from "@/lib/orbits";

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; positions: SatellitePosition[]; at: Date };

// Accessors live outside the component so their identity never changes:
// react-globe.gl redraws a layer whenever an accessor prop is a new function.
const particleAltitude = (p: object) => (p as SatellitePosition).altitudeKm / EARTH_RADIUS_KM;
const particleColor = () => "#f5b84a"; // theme accent (amber)

// Start over North America at a height where the low-orbit cloud is visible.
const START_VIEW = { lat: 30, lng: -97, altitude: 3 };

/** The live globe. Loaded only in the browser (WebGL), after the page's text. */
export default function SatelliteGlobe() {
  const containerRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  // The globe draws a canvas of a fixed pixel size; keep it matched to its box.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.round(width), height: Math.round(height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // One request for every current satellite's elements, then SGP4 locally.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/satellites/elements/`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const rows: ElementSetRow[] = await response.json();
        const at = new Date();
        setState({ kind: "ready", positions: positionsAt(trackSatellites(rows), at), at });
      } catch {
        if (!controller.signal.aborted) setState({ kind: "error" });
      }
    })();
    return () => controller.abort();
  }, []);

  // One particle set holding every satellite: drawn as a single point cloud
  // (one WebGL draw call) instead of 16,000 separate objects.
  const particleSets = useMemo(
    () => (state.kind === "ready" ? [state.positions] : []),
    [state],
  );

  // Point the camera once the globe exists. (onGlobeReady can fire before the
  // ref is attached, so do it in an effect that runs after the globe mounts.)
  const hasSize = size.width > 0;
  useEffect(() => {
    if (hasSize) globeRef.current?.pointOfView(START_VIEW);
  }, [hasSize]);

  const count = state.kind === "ready" ? state.positions.length : 0;

  return (
    <div ref={containerRef} className="absolute inset-0">
      {size.width > 0 && (
        <div
          role="img"
          aria-label={
            state.kind === "ready"
              ? `3D globe showing ${count.toLocaleString()} active satellites at their current positions`
              : "3D globe"
          }
        >
          <Globe
            ref={globeRef}
            width={size.width}
            height={size.height}
            backgroundColor="rgba(0,0,0,0)"
            globeImageUrl="/textures/earth-dark.jpg"
            atmosphereColor="#f5b84a"
            atmosphereAltitude={0.12}
            particlesData={particleSets}
            particleLat="lat"
            particleLng="lng"
            particleAltitude={particleAltitude}
            particlesSize={2}
            particlesSizeAttenuation={false}
            particlesColor={particleColor}
          />
        </div>
      )}

      <p
        role="status"
        className="absolute bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-line bg-bg/80 px-4 py-1.5 text-xs text-muted"
      >
        {state.kind === "loading" && "Loading satellites…"}
        {state.kind === "error" && "Couldn't load satellites. Please try again later."}
        {state.kind === "ready" &&
          `${count.toLocaleString()} satellites · positions at ${state.at.toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}`}
      </p>
    </div>
  );
}
