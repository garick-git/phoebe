"use client";

import dynamic from "next/dynamic";

/** Shown while the globe's code (three.js and friends, about 540 KB gzipped) loads. */
function GlobePlaceholder() {
  return (
    <div className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
      <div className="size-[min(70vw,26rem)] rounded-full bg-[radial-gradient(circle_at_35%_30%,#1d2c4f,#0b1222_60%,#070b14)] shadow-[0_0_80px_-10px_rgba(245,184,74,0.25)] ring-1 ring-line" />
    </div>
  );
}

// ssr: false keeps the globe out of the pre-rendered HTML (WebGL only exists in
// the browser) and splits it into its own chunk, fetched after the page's text
// is on screen (brief 6c: the globe never blocks the key content).
const SatelliteGlobe = dynamic(() => import("./SatelliteGlobe"), {
  ssr: false,
  loading: GlobePlaceholder,
});

export default function GlobeLoader() {
  return <SatelliteGlobe />;
}
