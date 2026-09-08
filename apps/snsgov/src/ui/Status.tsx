import type { ReactNode } from "react";

/**
 * Busy and empty states.
 *
 * There is one way to say "working": a small spinner in the place a control
 * already occupies — normally the section's own refresh button, which spins
 * instead of showing its arrow. Nothing is added to the layout, so nothing
 * moves when the work finishes, and there is no text to read, no panel to
 * paint, and no row to reflow.
 *
 * Deliberately not used: the design system's `.nt-state` block, which paints a
 * large tinted panel; and a full-width "Reading…" line, which is small but
 * still a row that appears and disappears under the content.
 */

/** A 14px spinner. Sized by its container so it can sit inside a button. */
export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span aria-label={label} className="snsgov-spinner" role="status" />;
}

/**
 * The spinner in the position a refresh button occupies.
 *
 * Use as the child of the existing `IconButton`, swapped for its icon while
 * busy: the button keeps its size and place, so the header does not move.
 */
export function BusyOr({ busy, children }: { busy: boolean; children: ReactNode }) {
  return busy ? <Spinner /> : <>{children}</>;
}

/**
 * A view with no content yet.
 *
 * Absolutely positioned, so the content that replaces it does not get pushed
 * down and snapped back. One spinner, no text.
 */
export function Pending({ label = "Loading" }: { label?: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="snsgov-pending" role="status">
      <span className="snsgov-spinner" />
    </div>
  );
}

export function Empty({ label }: { label: string }) {
  return <p className="snsgov-empty">{label}</p>;
}
