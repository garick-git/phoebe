"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Globe, { type GlobeMethods } from "react-globe.gl";

import { PauseIcon, PlayIcon } from "@/components/icons";
import { API_BASE_URL } from "@/lib/api";
import { EARTH_RADIUS_KM, PACKED_STRIDE, type SatellitePosition } from "@/lib/orbits";
import type { FromWorker, ToWorker } from "@/workers/positions-messages";

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; particleSets: SatellitePosition[][]; count: number; at: Date };

type Catalog = { noradIds: number[]; names: string[] };

// A low-orbit satellite moves about 0.2 px a second at the starting view, so
// one update a second looks smooth and leaves the CPU almost idle.
const UPDATE_INTERVAL_MS = 1000;

// Accessors live outside the component so their identity never changes:
// react-globe.gl redraws a layer whenever an accessor prop is a new function.
const particleAltitude = (p: object) => (p as SatellitePosition).altitudeKm / EARTH_RADIUS_KM;
const particleColor = () => "#f5b84a"; // theme accent (amber)

// Start over North America at a height where the low-orbit cloud is visible.
const START_VIEW = { lat: 30, lng: -97, altitude: 3 };

const NO_PARTICLES: SatellitePosition[][] = [];

const timeFormat: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** Refill `positions` from the worker's packed buffer (the objects the layer reads). */
function unpackInto(positions: SatellitePosition[], catalog: Catalog, packed: Float32Array) {
  positions.length = 0;
  for (let i = 0; i < catalog.noradIds.length; i++) {
    const at = i * PACKED_STRIDE;
    if (Number.isNaN(packed[at])) continue; // SGP4 couldn't propagate it
    positions.push({
      noradId: catalog.noradIds[i],
      name: catalog.names[i],
      lat: packed[at],
      lng: packed[at + 1],
      altitudeKm: packed[at + 2],
    });
  }
}

/** The live globe. Loaded only in the browser (WebGL), after the page's text. */
export default function SatelliteGlobe() {
  const containerRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const workerRef = useRef<Worker | null>(null);
  const catalogRef = useRef<Catalog | null>(null);
  const inFlightRef = useRef(false);
  // The one particle set, kept as the same array for the page's lifetime (see
  // the "positions" handler for why).
  const particleSetRef = useRef<SatellitePosition[]>([]);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [catalogReady, setCatalogReady] = useState(false);
  // WCAG 2.2.2 (Pause, Stop, Hide): moving content needs a pause control.
  // People who ask their system for reduced motion start paused.
  const [playing, setPlaying] = useState(
    () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");

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

  /** Ask the worker for positions now. Skips (never queues) if it's still busy. */
  const requestPositions = useCallback(() => {
    const worker = workerRef.current;
    if (!worker || !catalogRef.current || inFlightRef.current) return;
    inFlightRef.current = true;
    worker.postMessage({ type: "compute", time: Date.now() } satisfies ToWorker);
  }, []);

  // Start the worker. It downloads the elements and runs SGP4 off the main
  // thread; this side only turns its buffer into layer data.
  useEffect(() => {
    // Written exactly this way so Turbopack bundles the worker. No
    // `type: "module"`: Turbopack's worker loader uses importScripts, which
    // only works in a classic worker.
    const worker = new Worker(new URL("../workers/positions.worker.ts", import.meta.url));
    workerRef.current = worker;
    catalogRef.current = null;
    inFlightRef.current = false;

    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if (message.type === "error") {
        setState({ kind: "error" });
      } else if (message.type === "loaded") {
        catalogRef.current = { noradIds: message.noradIds, names: message.names };
        setCatalogReady(true);
        requestPositions(); // first positions, even when starting paused
      } else if (message.type === "positions") {
        inFlightRef.current = false;
        const catalog = catalogRef.current;
        if (!catalog) return;
        const set = particleSetRef.current;
        unpackInto(set, catalog, message.positions);
        // A new outer array tells react-globe.gl the layer changed. Keeping the
        // same inner set makes three-globe update its existing point cloud
        // instead of replacing it: replacing it disposed the material, so
        // three.js deleted and recompiled the shader program on every update
        // (measured in a profile: long tasks up to 365 ms; none after this).
        setState({ kind: "ready", particleSets: [set], count: set.length, at: new Date(message.time) });
      }
    };
    // The worker script itself failed (for example it couldn't be downloaded).
    worker.onerror = () => setState({ kind: "error" });

    worker.postMessage({
      type: "load",
      url: `${API_BASE_URL}/api/satellites/elements/`,
    } satisfies ToWorker);

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [requestPositions]);

  // Stop updating while the tab is hidden: nobody can see it, and it saves battery.
  useEffect(() => {
    const onChange = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  // The update loop. Runs only while playing, visible, and loaded; catches up
  // straight away when any of those becomes true again.
  const live = playing && pageVisible && catalogReady;
  useEffect(() => {
    if (!live) return;
    requestPositions();
    const id = window.setInterval(requestPositions, UPDATE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [live, requestPositions]);

  // Point the camera once the globe exists. (onGlobeReady can fire before the
  // ref is attached, so do it in an effect that runs after the globe mounts.)
  const hasSize = size.width > 0;
  useEffect(() => {
    if (hasSize) globeRef.current?.pointOfView(START_VIEW);
  }, [hasSize]);

  const count = state.kind === "ready" ? state.count : 0;

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
            // One particle set holding every satellite: drawn as a single
            // point cloud (one WebGL draw call), not 16,000 objects.
            particlesData={state.kind === "ready" ? state.particleSets : NO_PARTICLES}
            particleLat="lat"
            particleLng="lng"
            particleAltitude={particleAltitude}
            particlesSize={2}
            particlesSizeAttenuation={false}
            particlesColor={particleColor}
          />
        </div>
      )}

      <div className="absolute inset-x-0 bottom-4 flex items-center justify-center gap-2 px-4">
        {/* A live region: its text changes only when the state does (never
            every second), so screen readers aren't flooded. */}
        <p
          role="status"
          className="whitespace-nowrap rounded-full border border-line bg-bg/80 px-4 py-1.5 text-xs text-muted"
        >
          {state.kind === "loading" && "Loading satellites…"}
          {state.kind === "error" && "Couldn't load satellites. Please try again later."}
          {state.kind === "ready" &&
            (playing
              ? `${count.toLocaleString()} satellites · live`
              : `${count.toLocaleString()} satellites · paused at ${state.at.toLocaleTimeString([], timeFormat)}`)}
        </p>

        {state.kind === "ready" && (
          <button
            type="button"
            onClick={() => setPlaying((value) => !value)}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-raised px-4 text-xs font-medium text-ink hover:border-accent"
          >
            {playing ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
            {playing ? "Pause motion" : "Play motion"}
          </button>
        )}
      </div>
    </div>
  );
}
