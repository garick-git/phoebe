"use client";

import { useId, useMemo, useState, type KeyboardEvent } from "react";

import { searchSatellites, type SearchIndex, type SearchResult } from "@/lib/search";

type Props = {
  index: SearchIndex;
  /** What the globe is showing for the current selection, or null if none. */
  selection: { name: string; onGlobe: boolean } | null;
  onSelect: (result: SearchResult) => void;
  onClear: () => void;
};

/**
 * A combobox (WAI-ARIA 1.2 pattern, list autocomplete): type to filter, arrow
 * keys move through the results, Enter picks the highlighted one (the first by
 * default), Escape closes the list, then clears the text.
 */
export default function SatelliteSearch({ index, selection, onSelect, onClear }: Props) {
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const results = useMemo(() => searchSatellites(index, query), [index, query]);
  const showList = open && results.length > 0;
  const showNoMatch = open && query.trim() !== "" && results.length === 0;

  function choose(result: SearchResult) {
    setQuery(result.name);
    setOpen(false);
    onSelect(result);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      if (showList) {
        event.preventDefault();
        choose(results[active] ?? results[0]);
      }
    } else if (event.key === "Escape") {
      if (open) setOpen(false);
      else setQuery("");
    }
  }

  return (
    <div className="relative">
      <label htmlFor={inputId} className="sr-only">
        Search satellites
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
        placeholder="Search satellites, e.g. ISS"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="min-h-11 w-full rounded-full border border-line bg-surface/90 px-4 text-sm text-ink placeholder:text-muted"
      />

      <ul
        id={listId}
        role="listbox"
        aria-label="Matching satellites"
        hidden={!showList}
        className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-lg"
      >
        {results.map((result, i) => (
          <li
            key={result.noradId}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            // mousedown would blur the input (closing the list) before the click lands
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(result)}
            onMouseMove={() => setActive(i)}
            className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 text-sm ${
              i === active ? "bg-raised text-ink" : "text-muted"
            }`}
          >
            <span className="truncate">{result.name}</span>
            <span className="shrink-0 font-mono text-xs text-muted">{result.noradId}</span>
          </li>
        ))}
      </ul>

      {/* Announced politely: how many matches, and what the globe now shows. */}
      <p role="status" className="sr-only">
        {showList ? `${results.length} matching satellites` : ""}
        {showNoMatch ? "No satellites match" : ""}
      </p>
      {showNoMatch && (
        <p className="absolute inset-x-0 top-full mt-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted">
          No satellites match “{query.trim()}”.
        </p>
      )}

      {selection && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <p role="status" className="rounded-full border border-line bg-bg/80 px-3 py-1 text-ink">
            {selection.onGlobe
              ? `Showing ${selection.name}`
              : `No current position for ${selection.name}`}
          </p>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              onClear();
            }}
            className="min-h-11 rounded-full px-3 text-muted underline underline-offset-4 hover:text-ink"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
