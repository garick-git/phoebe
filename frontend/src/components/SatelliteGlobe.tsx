"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Globe, { type GlobeMethods } from "react-globe.gl";

import CategoryFilter from "@/components/CategoryFilter";
import SatelliteDetails from "@/components/SatelliteDetails";
import SatelliteSearch from "@/components/SatelliteSearch";
import { PauseIcon, PlayIcon } from "@/components/icons";
import { API_BASE_URL } from "@/lib/api";
import { CATEGORIES, categorizeAll } from "@/lib/categories";
import {
  EARTH_RADIUS_KM,
  PACKED_STRIDE,
  PATH_STRIDE,
  packedPositionAt,
  type SatellitePosition,
} from "@/lib/orbits";
import { buildSearchIndex, type SearchIndex, type SearchResult } from "@/lib/search";
import { GLOBE_DETAIL_SLOT_ID, GLOBE_SEARCH_SLOT_ID } from "@/lib/site";
import type { FromWorker, ToWorker } from "@/workers/positions-messages";

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | {
      kind: "ready";
      particleSets: GlobePoint[][];
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

/** A dot on the globe: a position plus where the satellite sits in the catalog. */
type GlobePoint = SatellitePosition & { index: number };

/** [latitude, longitude, altitude in Earth radii] */
type PathPoint = [number, number, number];

/** The selected satellite's next orbit (from the worker), with its period and inclination. */
type OrbitInfo = {
  index: number;
  time: number; // ms since 1970: where the path starts
  periodMinutes: number;
  inclinationDeg: number;
  paths: { points: PathPoint[] }[];
};

// A low-orbit satellite moves about 0.2 px a second at the starting view, so
// one update a second looks smooth and leaves the CPU almost idle.
const UPDATE_INTERVAL_MS = 1000;

// Accessors live outside the component so their identity never changes:
// react-globe.gl redraws a layer whenever an accessor prop is a new function.
const particleAltitude = (p: object) => (p as SatellitePosition).altitudeKm / EARTH_RADIUS_KM;
const particleColor = () => "#f5b84a"; // theme accent (amber)

// Start over North America at a height where the low-orbit cloud is visible.
const START_VIEW = { lat: 30, lng: -97, altitude: 3 };

// Clicking a dot. globe.gl's click tolerance (lineHoverPrecision, used for
// points too) is in world units, where Earth's radius is 100, and defaults to
// 0.2: under one screen pixel at the starting view, so dots were very hard to
// hit. Convert a tolerance in screen pixels to world units for the current
// zoom: at distance d, one pixel spans 2·d·tan(fov/2) / canvas height.
const PICK_RADIUS_PX = 10;
const GLOBE_RADIUS_UNITS = 100; // three-globe's Earth radius in world units
const CAMERA_FOV_DEG = 50; // three.js's default PerspectiveCamera, which globe.gl keeps

/** Click tolerance (world units) for `altitude` (Earth radii above the surface). */
function pickPrecisionFor(altitude: number, canvasHeight: number) {
  const distance = altitude * GLOBE_RADIUS_UNITS;
  const unitsPerPixel =
    (2 * distance * Math.tan(((CAMERA_FOV_DEG / 2) * Math.PI) / 180)) / canvasHeight;
  return PICK_RADIUS_PX * unitsPerPixel;
}

// Only dots (and Earth itself, so a satellite behind Earth can't be clicked)
// take clicks: the orbit line passes through the selected dot and would
// otherwise catch clicks meant for it.
const pointerEventsFilter = (object: object) =>
  (object as { __globeObjType?: string }).__globeObjType !== "path";

const NO_PARTICLES: GlobePoint[][] = [];
const NO_PATHS: OrbitInfo["paths"] = [];

// The orbit path: a thin, light line, so it stands apart from the amber dots.
const pathPointLat = (p: object) => (p as PathPoint)[0];
const pathPointLng = (p: object) => (p as PathPoint)[1];
const pathPointAlt = (p: object) => (p as PathPoint)[2];
const pathColor = () => "rgba(230, 233, 240, 0.7)"; // theme ink at 70%
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
  positions: GlobePoint[],
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
      index: i,
      noradId: catalog.noradIds[i],
      name: catalog.names[i],
      lat: packed[at],
      lng: packed[at + 1],
      altitudeKm: packed[at + 2],
    });
  }
}

/** The worker's packed path → points for the paths layer (samples SGP4 couldn't compute are skipped). */
function toPathPoints(path: Float32Array): PathPoint[] {
  const points: PathPoint[] = [];
  for (let at = 0; at + PATH_STRIDE <= path.length; at += PATH_STRIDE) {
    if (Number.isNaN(path[at])) continue;
    points.push([path[at], path[at + 1], path[at + 2] / EARTH_RADIUS_KM]);
  }
  return points;
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
  const particleSetRef = useRef<GlobePoint[]>([]);
  // The selected satellite's catalog index, for the worker's message handler:
  // an orbit that arrives after the selection changed is ignored.
  const selectedIndexRef = useRef<number | null>(null);
  // Which satellite's orbit the worker is computing right now (if any).
  const orbitPendingRef = useRef<number | null>(null);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [searchIndex, setSearchIndex] = useState<SearchIndex | null>(null);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  // Category filter: an index into CATEGORIES, or ALL. The ref lets the worker's
  // message handler (created once) read the current value.
  const [filter, setFilter] = useState(ALL);
  const filterRef = useRef(ALL);
  const [counts, setCounts] = useState<number[] | null>(null);
  const [categoryOf, setCategoryOf] = useState<Uint8Array | null>(null);
  const [orbit, setOrbit] = useState<OrbitInfo | null>(null);
  // The last positions received, so a filter change can redraw while paused.
  const latestRef = useRef<{ packed: Float32Array; time: number } | null>(null);
  // The slot is in the page's pre-rendered HTML, so it exists before this
  // client-only component first renders.
  const [searchSlot] = useState(() => document.getElementById(GLOBE_SEARCH_SLOT_ID));
  const [detailSlot] = useState(() => document.getElementById(GLOBE_DETAIL_SLOT_ID));
  // WCAG 2.2.2 (Pause, Stop, Hide): moving content needs a pause control.
  // People who ask their system for reduced motion start paused.
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");
  // The camera's height, for the click tolerance. Updated only when it changes
  // by more than 5%, so rotating or small zooms don't re-render.
  const [cameraAltitude, setCameraAltitude] = useState(START_VIEW.altitude);
  const handleZoom = useCallback(({ altitude }: { altitude: number }) => {
    setCameraAltitude((previous) =>
      Math.abs(altitude - previous) > previous * 0.05 ? altitude : previous,
    );
  }, []);

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

  /** Ask the worker for one orbit's path, starting at the time of the dots on screen. */
  const requestOrbit = useCallback((index: number) => {
    const worker = workerRef.current;
    if (!worker || orbitPendingRef.current === index) return;
    orbitPendingRef.current = index;
    const time = latestRef.current?.time ?? Date.now();
    worker.postMessage({ type: "orbit", index, time } satisfies ToWorker);
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
        setCategoryOf(byIndex);
        setSearchIndex(buildSearchIndex(message.noradIds, message.names));
        requestPositions(); // first positions, even when starting paused
      } else if (message.type === "positions") {
        inFlightRef.current = false;
        publish(message.positions, message.time);
      } else if (message.type === "orbit") {
        if (orbitPendingRef.current === message.index) orbitPendingRef.current = null;
        if (message.index !== selectedIndexRef.current) return; // selection changed meanwhile
        setOrbit({
          index: message.index,
          time: message.time,
          periodMinutes: message.periodMinutes,
          inclinationDeg: message.inclinationDeg,
          paths: [{ points: toPathPoints(message.path) }],
        });
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

  /**
   * Select a satellite, from search or a click on the globe: highlight it, fill
   * the details panel and draw its next orbit. Search also turns the camera to
   * it; a click doesn't, because the satellite is already in view.
   */
  const select = useCallback(
    (result: SearchResult, moveCamera: boolean) => {
      setSelected(result);
      selectedIndexRef.current = result.index;
      setOrbit(null);
      requestOrbit(result.index);
      const latestPacked = latestRef.current?.packed;
      const position = latestPacked && packedPositionAt(latestPacked, result.index);
      const globe = globeRef.current;
      if (!moveCamera || !position || !globe) return;
      // Stay at least 1 Earth radius above the satellite (a geostationary one is
      // 5.6 radii up), and no farther out than 2 radii for low orbits.
      const satelliteAltitude = position.altitudeKm / EARTH_RADIUS_KM;
      const altitude = Math.max(Math.min(globe.pointOfView().altitude, 2), satelliteAltitude + 1);
      globe.pointOfView(
        { lat: position.lat, lng: position.lng, altitude },
        prefersReducedMotion() ? 0 : 1000,
      );
    },
    [requestOrbit],
  );

  const clearSelection = useCallback(() => {
    setSelected(null);
    selectedIndexRef.current = null;
    setOrbit(null);
  }, []);

  // A click on a dot: the particle layer hands back that dot's own object.
  const handleParticleClick = useCallback(
    (point: object) => {
      const { index, noradId, name } = point as GlobePoint;
      select({ index, noradId, name }, false);
    },
    [select],
  );

  // Keep the path ahead of the satellite: once it is a quarter of an orbit old,
  // ask for a fresh one starting from where the satellite is now.
  const atMs = state.kind === "ready" ? state.at.getTime() : 0;
  useEffect(() => {
    if (orbit && atMs - orbit.time > (orbit.periodMinutes * 60_000) / 4) {
      requestOrbit(orbit.index);
    }
  }, [atMs, orbit, requestOrbit]);

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
            onParticleClick={handleParticleClick}
            onZoom={handleZoom}
            lineHoverPrecision={pickPrecisionFor(cameraAltitude, size.height)}
            pointerEventsFilter={pointerEventsFilter}
            htmlElementsData={markerData}
            htmlLat={markerLat}
            htmlLng={markerLng}
            htmlAltitude={markerAltitude}
            htmlElement={markerElement}
            // No glide between updates: the marker stays on its dot.
            htmlTransitionDuration={0}
            // The selected satellite's next orbit over the ground.
            pathsData={orbit ? orbit.paths : NO_PATHS}
            pathPoints="points"
            pathPointLat={pathPointLat}
            pathPointLng={pathPointLng}
            pathPointAlt={pathPointAlt}
            pathColor={pathColor}
            pathTransitionDuration={0}
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
              onSelect={(result) => select(result, true)}
              onClear={clearSelection}
            />
            {counts && <CategoryFilter counts={counts} value={filter} onChange={changeFilter} />}
          </>,
          searchSlot,
        )}

      {detailSlot &&
        selected &&
        createPortal(
          <SatelliteDetails
            name={selected.name}
            noradId={selected.noradId}
            categoryLabel={categoryOf ? CATEGORIES[categoryOf[selected.index]].label : "—"}
            position={markerPosition}
            orbit={orbit && orbit.index === selected.index ? orbit : null}
          />,
          detailSlot,
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
