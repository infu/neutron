/**
 * Whole-row activation for tables whose rows open something.
 *
 * The name cell keeps its real `<button>`, so keyboard and screen-reader users
 * get a proper control with an accessible name; this adds the mouse target that
 * a table row visually promises. Hitting a 14px-tall run of text to open a row
 * is a needless miss-target.
 */

import type { MouseEvent } from "react";

/** Anything a user could have meant to click *instead of* the row. */
const CONTROLS = "button, a, input, select, textarea, label, [role='button']";

export function rowProps(open: () => void): {
  className: string;
  onClick: (event: MouseEvent<HTMLTableRowElement>) => void;
} {
  return {
    className: "snsgov-row",
    onClick: (event) => {
      // A click that landed on a control belongs to that control. The name
      // button opens the row anyway through its own handler, and the row's
      // copy button must not navigate.
      if ((event.target as HTMLElement | null)?.closest(CONTROLS)) return;
      open();
    },
  };
}
