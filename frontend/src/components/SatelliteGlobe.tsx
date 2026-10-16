"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Globe, { type GlobeMethods } from "react-globe.gl";

import CategoryFilter from "@/components/CategoryFilter";
import SatelliteSearch from "@/components/SatelliteSearch";
import { PauseIcon, PlayIcon } from "@/components/icons";
import { API_BASE_URL } from "@/lib/api";
import { CATEGORIES, categorizeAll } from "@/lib/categories";
import {
  EARTH_RADIUS_KM,
  PACKED_STRIDE,
  packedPositionAt,
  type SatellitePosition,
} from "@/lib/orbits";
import { buildSearchIndex, type SearchIndex, type SearchResult } from "@/lib/search";
import { GLOBE_SEARCH_SLOT_ID } from "@/lib/site";
import type { FromWorker, ToWorker } from "@/workers/positions-messages";

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | {
      kind: "ready";
      particleSets: SatellitePosition[][];
      packed: Float32Array; // the same positions, by catalog index (for the marker)
      count: number;
      at: Date;
    };

type Catalog = {
  noradIds: number[];
  names: string[];
  categories: Uint8Array; // category (an index into CATEGORIES) per catalog index
};

/** The filter value that shows every satellite. */
const ALL = -1;

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
const NO_MARKERS: SearchResult[] = [];

/**
 * The highlight marker: a ring on the satellite plus its name. Built with DOM
 * calls because globe.gl positions a real element; the name goes in with
 * textContent (never innerHTML), because it comes from an outside data feed.
 * Hidden from screen readers: the search box announces the selection.
 */
function markerElement(d: object) {
  const root = document.createElement("div");
  root.setAttribute("aria-hidden", "true");
  root.className = "pointer-events-none relative size-7";
  const ring = document.createElement("span");
  ring.className =
    "absolute inset-0 rounded-full border-2 border-ink shadow-[0_0_0_2px_rgba(7,11,20,0.85)]";
  const label = document.createElement("span");
  label.className =
    "absolute left-full top-1/2 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-line bg-bg/90 px-2 py-0.5 text-xs font-medium text-ink";
  label.textContent = (d as SearchResult).name;
  root.append(ring, label);
  return root;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const timeFormat: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** Refill `positions` from the worker's packed buffer (the objects the layer reads). */
function unpackInto(
  positions: SatellitePosition[],
  catalog: Catalog,
  packed: Float32Array,
  filter: number,
) {
  positions.length = 0;
  for (let i = 0; i < catalog.noradIds.length; i++) {
    if (filter !== ALL && catalog.categories[i] !== filter) continue;
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
  const [searchIndex, setSearchIndex] = useState<SearchIndex | null>(null);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  // Category filter: an index into CATEGORIES, or ALL. The ref lets the worker's
  // message handler (created once) read the current value.
  const [filter, setFilter] = useState(ALL);
  const filterRef = useRef(ALL);
  const [counts, setCounts] = useState<number[] | null>(null);
  // The last positions received, so a filter change can redraw while paused.
  const latestRef = useRef<{ packed: Float32Array; time: number } | null>(null);
  // The slot is in the page's pre-rendered HTML, so it exists before this
  // client-only component first renders.
  const [searchSlot] = useState(() => document.getElementById(GLOBE_SEARCH_SLOT_ID));
  // WCAG 2.2.2 (Pause, Stop, Hide): moving content needs a pause control.
  // People who ask their system for reduced motion start paused.
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
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

  /** Turn a packed buffer into the layer's data, keeping only the current filter's satellites. */
  const publish = useCallback((packed: Float32Array, time: number) => {
    const catalog = catalogRef.current;
    if (!catalog) return;
    latestRef.current = { packed, time };
    const set = particleSetRef.current;
    unpackInto(set, catalog, packed, filterRef.current);
    // A new outer array tells react-globe.gl the layer changed. Keeping the
    // same inner set makes three-globe update its existing point cloud
    // instead of replacing it: replacing it disposed the material, so
    // three.js deleted and recompiled the shader program on every update
    // (measured in a profile: long tasks up to 365 ms; none after this).
    // A filter change only changes how many entries the set holds.
    setState({
      kind: "ready",
      particleSets: [set],
      packed,
      count: set.length,
      at: new Date(time),
    });
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
        const { byIndex, counts: categoryCounts } = categorizeAll(message.noradIds, message.names);
        catalogRef.current = {
          noradIds: message.noradIds,
          names: message.names,
          categories: byIndex,
        };
        setCounts(categoryCounts);
        setSearchIndex(buildSearchIndex(message.noradIds, message.names));
        requestPositions(); // first positions, even when starting paused
      } else if (message.type === "positions") {
        inFlightRef.current = false;
        publish(message.positions, message.time);
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
  }, [requestPositions, publish]);

  // Stop updating while the tab is hidden: nobody can see it, and it saves battery.
  useEffect(() => {
    const onChange = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  // The update loop. Runs only while playing, visible, and loaded; catches up
  // straight away when any of those becomes true again.
  const live = playing && pageVisible && searchIndex !== null;
  useEffect(() => {
    if (!live) return;
    requestPositions();
    const id = window.setInterval(requestPositions, UPDATE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [live, requestPositions]);

  // The highlighted satellite's current position (null if SGP4 has none).
  const packed = state.kind === "ready" ? state.packed : null;
  const markerPosition = useMemo(
    () => (selected && packed ? packedPositionAt(packed, selected.index) : null),
    [selected, packed],
  );
  // The marker's data object changes only when the selection does: the HTML
  // layer keeps one DOM element per object, so a new object every second
  // would rebuild the element. New positions arrive through the accessors.
  const hasMarker = markerPosition !== null;
  const markerData = useMemo(
    () => (selected && hasMarker ? [selected] : NO_MARKERS),
    [selected, hasMarker],
  );
  const markerLat = useCallback(() => markerPosition?.lat ?? 0, [markerPosition]);
  const markerLng = useCallback(() => markerPosition?.lng ?? 0, [markerPosition]);
  const markerAltitude = useCallback(
    () => (markerPosition?.altitudeKm ?? 0) / EARTH_RADIUS_KM,
    [markerPosition],
  );

  /** Show one category (or ALL). Re-filters the last positions, so it works while paused too. */
  function changeFilter(next: number) {
    filterRef.current = next;
    setFilter(next);
    const latest = latestRef.current;
    if (latest) publish(latest.packed, latest.time);
  }

  /** Highlight a search result and turn the camera to it. */
  function select(result: SearchResult) {
    setSelected(result);
    const position = packed && packedPositionAt(packed, result.index);
    const globe = globeRef.current;
    if (!position || !globe) return;
    // Stay at least 1 Earth radius above the satellite (a geostationary one is
    // 5.6 radii up), and no farther out than 2 radii for low orbits.
    const satelliteAltitude = position.altitudeKm / EARTH_RADIUS_KM;
    const altitude = Math.max(Math.min(globe.pointOfView().altitude, 2), satelliteAltitude + 1);
    globe.pointOfView(
      { lat: position.lat, lng: position.lng, altitude },
      prefersReducedMotion() ? 0 : 1000,
    );
  }

  // Point the camera once the globe exists. (onGlobeReady can fire before the
  // ref is attached, so do it in an effect that runs after the globe mounts.)
  const hasSize = size.width > 0;
  useEffect(() => {
    if (hasSize) globeRef.current?.pointOfView(START_VIEW);
  }, [hasSize]);

  const count = state.kind === "ready" ? state.count : 0;
  const total = counts ? counts.reduce((sum, n) => sum + n, 0) : 0;
  const categoryLabel = filter === ALL ? null : CATEGORIES[filter].label;

  return (
    <div ref={containerRef} className="absolute inset-0">
      {size.width > 0 && (
        <div
          role="img"
          aria-label={
            state.kind === "ready"
              ? `3D globe showing ${count.toLocaleString()} active satellites at their current positions` +
                (categoryLabel ? ` in the ${categoryLabel} category` : "") +
                (selected && hasMarker ? `, with ${selected.name} highlighted` : "")
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
            // A short list (for example 9 stations) is easier to see and
            // click with bigger dots; 16,000 dots need to stay small.
            particlesSize={count <= 500 ? 5 : 2}
            particlesSizeAttenuation={false}
            particlesColor={particleColor}
            htmlElementsData={markerData}
            htmlLat={markerLat}
            htmlLng={markerLng}
            htmlAltitude={markerAltitude}
            htmlElement={markerElement}
            // No glide between updates: the marker stays on its dot.
            htmlTransitionDuration={0}
          />
        </div>
      )}

      {searchSlot &&
        searchIndex &&
        createPortal(
          <>
            <SatelliteSearch
              index={searchIndex}
              selection={selected && { name: selected.name, onGlobe: hasMarker }}
              onSelect={select}
              onClear={() => setSelected(null)}
            />
            {counts && <CategoryFilter counts={counts} value={filter} onChange={changeFilter} />}
          </>,
          searchSlot,
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
            (categoryLabel
              ? `${count.toLocaleString()} of ${total.toLocaleString()} satellites · ${categoryLabel}`
              : `${count.toLocaleString()} satellites`) +
              ` · ${playing ? "live" : `paused at ${state.at.toLocaleTimeString([], timeFormat)}`}`}
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
