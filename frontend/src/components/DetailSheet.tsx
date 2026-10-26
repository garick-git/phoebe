"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronUpIcon } from "@/components/icons";
import { GLOBE_PEEK_SLOT_ID } from "@/lib/site";

/**
 * The satellite details panel. Desktop (lg and up): a side panel, always open.
 * Phones and tablets: a bottom sheet over the globe, collapsed by default to a
 * one-line bar, so the globe keeps the whole screen. The bar is a real button
 * (inside the heading, the accordion pattern) with aria-expanded; the globe
 * portals the selected satellite's name into it, so a tap on a dot shows up
 * on screen straight away.
 *
 * `children` is the pre-rendered placeholder and the globe's details slot,
 * passed from the server-rendered page, so they stay static HTML.
 * Phones: fixed just above the bottom tab bar (SiteChrome: 3.5rem of links plus a
 * 1px border plus the home-bar inset); keep the two in step. Tablets have no tab bar.
 * Open and closed are CSS (globals.css, [data-sheet]): the body animates its
 * grid row from 0fr to 1fr and is visibility: hidden when closed, which also
 * takes it out of the tab order and the accessibility tree. Reduced motion is
 * handled by the global rule that removes transitions.
 */
export default function DetailSheet({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Escape closes the open sheet from anywhere inside it, and puts focus back
  // on the bar so keyboard users don't lose their place.
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !open) return;
    setOpen(false);
    buttonRef.current?.focus();
  }

  return (
    <aside
      aria-label="Satellite details"
      data-sheet
      data-open={open}
      onKeyDown={handleKeyDown}
      className="fixed inset-x-0 bottom-[calc(3.5rem+1px+env(safe-area-inset-bottom))] z-20 rounded-t-2xl sm:bottom-0 border-t border-line bg-surface/95 backdrop-blur lg:static lg:w-80 lg:rounded-none lg:border-l lg:border-t-0 lg:bg-surface lg:p-5 lg:backdrop-blur-none"
    >
      {/* Phones and tablets: the bar that opens and closes the sheet. */}
      <h2 className="lg:hidden">
        <button
          ref={buttonRef}
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
          className="flex min-h-14 w-full items-center gap-3 px-5 text-left"
        >
          <span className="min-w-0 flex-1">
            {/* A grab handle, drawn only: the whole bar is the control. */}
            <span aria-hidden="true" className="mx-auto mb-1.5 block h-1 w-9 rounded-full bg-line" />
            <span className="flex items-baseline gap-2">
              {/* The globe renders the selected satellite's name here. */}
              <span
                id={GLOBE_PEEK_SLOT_ID}
                data-peek-slot
                className="truncate text-base font-semibold text-ink empty:hidden"
              />
              <span data-peek-placeholder className="truncate text-sm">
                <span className="font-semibold text-ink">Satellite details</span>
                <span className="text-muted"> · tap a dot or search</span>
              </span>
            </span>
          </span>
          <ChevronUpIcon
            className={`size-5 shrink-0 text-muted motion-safe:transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </h2>

      {/* Desktop: a plain heading over the always-open panel. */}
      <h2 className="hidden text-sm font-semibold uppercase tracking-wider text-muted lg:block">
        Satellite details
      </h2>

      <div id={bodyId} data-sheet-body>
        <div data-sheet-content>{children}</div>
      </div>
    </aside>
  );
}
