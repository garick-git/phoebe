type Props = {
  name: string;
  noradId: number;
  categoryLabel: string;
  /** Live values from the latest positions; null when SGP4 has no position. */
  position: { altitudeKm: number; speedKmS: number } | null;
  /** From the worker's orbit message; null until it arrives. */
  orbit: { periodMinutes: number; inclinationDeg: number } | null;
};

const DASH = "—";

/** 92.9 min for low orbits; 23 h 56 min for high ones. */
function formatPeriod(minutes: number) {
  if (!Number.isFinite(minutes)) return DASH;
  if (minutes < 120) return `${minutes.toFixed(1)} min`;
  const total = Math.round(minutes);
  return `${Math.floor(total / 60)} h ${total % 60} min`;
}

/**
 * The selected satellite's details, rendered by the globe into the
 * pre-rendered panel's slot. Not a live region: altitude and speed change every
 * second, which would flood a screen reader (the search box announces the
 * selection instead).
 */
export default function SatelliteDetails({ name, noradId, categoryLabel, position, orbit }: Props) {
  const rows: [string, string][] = [
    ["NORAD ID", String(noradId)],
    ["Category", categoryLabel],
    ["Altitude", position ? `${Math.round(position.altitudeKm).toLocaleString()} km` : DASH],
    [
      "Speed",
      position && Number.isFinite(position.speedKmS) ? `${position.speedKmS.toFixed(2)} km/s` : DASH,
    ],
    ["Orbit period", orbit ? formatPeriod(orbit.periodMinutes) : DASH],
    ["Inclination", orbit ? `${orbit.inclinationDeg.toFixed(1)}°` : DASH],
  ];

  return (
    <div>
      <h3 className="mt-2 text-lg font-semibold text-ink">{name}</h3>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="font-mono tabular-nums text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-5 text-xs leading-relaxed text-muted">
        {position
          ? "The line on the globe is where it will fly over the next orbit. "
          : "No current position: its orbital data may be too old to calculate. "}
        Speed is measured from Earth’s center. The category is Phoebe’s best guess from the
        satellite’s name.
      </p>
    </div>
  );
}
