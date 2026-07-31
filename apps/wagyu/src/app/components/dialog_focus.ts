import { useEffect, useRef } from "react";
import type { RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface DialogKeyboardEvent {
  key: string;
  shiftKey: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export function dialogFocusableElements(
  container: HTMLElement,
): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.tabIndex >= 0,
  );
}

export function focusDialog(
  container: HTMLElement,
  preferred: HTMLElement | null,
): HTMLElement {
  const focusable = dialogFocusableElements(container);
  const target =
    preferred && container.contains(preferred) && focusable.includes(preferred)
      ? preferred
      : focusable[0] ?? container;
  focusWithoutScroll(target);
  return target;
}

export function handleDialogKeyboard(
  event: DialogKeyboardEvent,
  container: HTMLElement,
  onEscape: () => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    onEscape();
    return;
  }
  if (event.key !== "Tab") return;

  const focusable = dialogFocusableElements(container);
  if (focusable.length === 0) {
    event.preventDefault();
    focusWithoutScroll(container);
    return;
  }

  const active = container.ownerDocument.activeElement;
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (!container.contains(active)) {
    event.preventDefault();
    focusWithoutScroll(event.shiftKey ? last : first);
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    focusWithoutScroll(last);
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    focusWithoutScroll(first);
  }
}

export function restoreDialogFocus(
  target: HTMLElement | null,
  fallback: HTMLElement | null = null,
): void {
  if (
    target?.isConnected &&
    !target.hasAttribute("disabled") &&
    target.getAttribute("aria-disabled") !== "true"
  ) {
    focusWithoutScroll(target);
    return;
  }
  if (fallback?.isConnected) focusWithoutScroll(fallback);
}

export function useDialogFocus(
  containerRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const active = container.ownerDocument.activeElement;
    const HTMLElementClass =
      container.ownerDocument.defaultView?.HTMLElement;
    const returnTarget =
      HTMLElementClass && active instanceof HTMLElementClass
        ? active as HTMLElement
        : null;
    const returnFallback =
      container.ownerDocument.querySelector<HTMLElement>(
        "[data-dialog-focus-fallback]",
      );
    focusDialog(container, initialFocusRef.current);
    const keydown = (event: KeyboardEvent) => {
      handleDialogKeyboard(event, container, () => closeRef.current());
    };
    container.ownerDocument.addEventListener("keydown", keydown, true);
    return () => {
      container.ownerDocument.removeEventListener("keydown", keydown, true);
      restoreDialogFocus(returnTarget, returnFallback);
    };
  }, [containerRef, initialFocusRef]);
}

function focusWithoutScroll(target: HTMLElement): void {
  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }
}
