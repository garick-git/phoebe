"use client";

import { useEffect, useId, useState, type KeyboardEvent } from "react";

import { MIN_QUERY_LENGTH, searchPlaces, type GeocodedPlace } from "@/lib/geocoding";

/** Wait this long after the last keystroke before asking Open-Meteo. */
const DEBOUNCE_MS = 300;

/** The answer for one query; `places: null` means the request failed. */
type Answer = { query: string; places: GeocodedPlace[] | null };

/**
 * City search box: the same WAI-ARIA 1.2 combobox pattern as the globe's
 * satellite search, but the results come from Open-Meteo, so typing is
 * debounced and a newer query cancels the older request (AbortController).
 * Results are kept with the query they answer, so a late answer for an old
 * query can never be shown for a newer one.
 */
export default function CitySearch({ onPick }: { onPick: (place: GeocodedPlace) => void }) {
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [answer, setAnswer] = useState<Answer | null>(null);

  const q = query.trim();
  const searchable = q.length >= MIN_QUERY_LENGTH;

  useEffect(() => {
    if (!searchable) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchPlaces(q, controller.signal).then(
        (places) => setAnswer({ query: q, places }),
        () => {
          if (!controller.signal.aborted) setAnswer({ query: q, places: null });
        },
      );
    }, DEBOUNCE_MS);
    // Runs on the next keystroke (and on unmount): cancels the pending timer,
    // or the request already in flight.
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, searchable]);

  // Everything below is derived from the query and the latest answer.
  const current = searchable && answer?.query === q ? answer : null;
  const places = current?.places ?? [];
  const searching = searchable && current === null;
  const failed = current !== null && current.places === null;
  const noMatch = current !== null && current.places?.length === 0;
  const showList = open && places.length > 0;

  let message = "";
  if (searching) message = "Searching…";
  else if (failed) message = "City search isn't available right now. Try again, or use your location.";
  else if (noMatch) message = `No places match “${q}”. Check the spelling, or try “City, State”.`;

  function choose(place: GeocodedPlace) {
    setQuery("");
    setOpen(false);
    onPick(place);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, places.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      if (showList) {
        event.preventDefault();
        choose(places[active] ?? places[0]);
      }
    } else if (event.key === "Escape") {
      if (open) setOpen(false);
      else setQuery("");
    }
  }

  return (
    <div className="relative">
      <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-ink">
        Find a city
      </label>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        placeholder="e.g. Austin, or Austin, TX"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="min-h-12 w-full rounded-full border border-line bg-surface px-4 text-base text-ink placeholder:text-muted"
      />

      <ul
        id={listId}
        role="listbox"
        aria-label="Matching places"
        hidden={!showList}
        className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-lg"
      >
        {places.map((place, i) => (
          <li
            key={place.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            // mousedown would blur the input (closing the list) before the click lands
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(place)}
            onMouseMove={() => setActive(i)}
            className={`flex min-h-12 cursor-pointer flex-col justify-center px-4 py-1 ${
              i === active ? "bg-raised" : ""
            }`}
          >
            <span className="text-sm text-ink">{place.name}</span>
            {place.detail && <span className="text-xs text-muted">{place.detail}</span>}
          </li>
        ))}
      </ul>

      {/* Announced politely: searching, how many results, no match, or an error. */}
      <p role="status" className="sr-only">
        {showList ? `${places.length} places found` : open ? message : ""}
      </p>
      {open && !showList && message && (
        <p className="absolute inset-x-0 top-full z-20 mt-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted">
          {message}
        </p>
      )}
    </div>
  );
}
