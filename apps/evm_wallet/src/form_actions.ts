import type { KeyboardEvent } from "react";

/** Tile sandboxes prohibit native form submission, including submit events. */
export function runFormAction(
  form: HTMLFormElement | null,
  disabled: boolean,
  action: () => void,
): void {
  if (disabled || !form?.reportValidity()) return;
  action();
}

/** Enter in a single-line field uses the button's validated action. */
export function onFormActionKeyDown(
  event: KeyboardEvent<HTMLFormElement>,
  disabled: boolean,
  action: () => void,
): void {
  if (
    event.key !== "Enter" ||
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    !(event.target instanceof HTMLInputElement)
  ) return;
  // Prevent a native submission even for a disabled action. Textareas retain
  // their newline behavior, selects keep their keyboard navigation, and
  // buttons generate their own click event on Enter or Space.
  event.preventDefault();
  if (
    event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
    !["text", "search", "email", "url", "tel", "password", "number"].includes(event.target.type)
  ) return;
  runFormAction(event.currentTarget, disabled, action);
}
