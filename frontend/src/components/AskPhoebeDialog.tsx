"use client";

import type { MouseEvent, Ref } from "react";
import { CloseIcon } from "./icons";

/**
 * Ask Phoebe drawer (placeholder until the assistant exists).
 *
 * Built on the native <dialog> element opened with showModal(), which gives the
 * accessibility behavior for free: the rest of the page becomes inert (focus
 * can't leave the dialog), Escape closes it, focus moves into it on open and
 * returns to the button that opened it on close, and screen readers announce it
 * as a dialog. A bottom sheet on phones, a right-hand drawer on wider screens.
 */
export default function AskPhoebeDialog({ ref }: { ref: Ref<HTMLDialogElement> }) {
  // A click on the backdrop lands on the <dialog> element itself (the panel's
  // content is a child that fills it), so close only in that case.
  function closeOnBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) event.currentTarget.close();
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="ask-phoebe-title"
      onClick={closeOnBackdrop}
      className="m-0 mt-auto h-[85dvh] max-h-none w-full max-w-none rounded-t-2xl border-t border-line bg-surface p-0 text-ink sm:my-0 sm:ml-auto sm:mr-0 sm:h-dvh sm:w-[28rem] sm:rounded-none sm:border-l sm:border-t-0"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 id="ask-phoebe-title" className="text-lg font-semibold">
            Ask Phoebe
          </h2>
          {/* method="dialog" closes the dialog natively, no JavaScript needed. */}
          <form method="dialog">
            <button
              type="submit"
              aria-label="Close Ask Phoebe"
              className="rounded-md p-2 text-muted transition-colors hover:text-ink"
            >
              <CloseIcon className="size-5" />
            </button>
          </form>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-6 text-sm leading-relaxed text-muted">
          <p>Ask questions about satellites in plain English, for example:</p>
          <ul className="space-y-2">
            <li className="rounded-lg bg-raised px-4 py-3 text-ink">
              “When can I see the ISS from Austin this week?”
            </li>
            <li className="rounded-lg bg-raised px-4 py-3 text-ink">
              “Will it be clear enough to see anything tonight?”
            </li>
          </ul>
          <p className="rounded-lg border border-dashed border-line p-4">
            The assistant isn’t available yet. This panel is a placeholder.
          </p>
        </div>
      </div>
    </dialog>
  );
}
