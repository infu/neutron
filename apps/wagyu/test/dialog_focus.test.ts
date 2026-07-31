import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  focusDialog,
  handleDialogKeyboard,
  restoreDialogFocus,
} from "../src/app/components/dialog_focus.ts";

interface FakeDocument {
  activeElement: unknown;
}

function focusTarget(document: FakeDocument, connected = true): HTMLElement {
  const target = {
    isConnected: connected,
    tabIndex: 0,
    hasAttribute: () => false,
    getAttribute: () => null,
    focus: () => {
      document.activeElement = target;
    },
  };
  return target as unknown as HTMLElement;
}

function dialogHarness() {
  const document: FakeDocument = { activeElement: null };
  const first = focusTarget(document);
  const middle = focusTarget(document);
  const last = focusTarget(document);
  const elements = [first, middle, last];
  const container = {
    ownerDocument: document,
    tabIndex: -1,
    isConnected: true,
    hasAttribute: () => false,
    getAttribute: () => null,
    querySelectorAll: () => elements,
    contains: (candidate: unknown) =>
      candidate === container || elements.includes(candidate as HTMLElement),
    focus: () => {
      document.activeElement = container;
    },
  } as unknown as HTMLElement;
  return { container, document, first, middle, last };
}

function keyboard(key: string, shiftKey = false) {
  let prevented = false;
  let stopped = false;
  return {
    event: {
      key,
      shiftKey,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
    },
    prevented: () => prevented,
    stopped: () => stopped,
  };
}

describe("modal dialog keyboard boundary", () => {
  test("sets the requested initial focus and wraps Tab in both directions", () => {
    const { container, document, first, last } = dialogHarness();
    expect(focusDialog(container, last)).toBe(last);
    expect(document.activeElement).toBe(last);

    const forward = keyboard("Tab");
    handleDialogKeyboard(forward.event, container, () => undefined);
    expect(forward.prevented()).toBeTrue();
    expect(document.activeElement).toBe(first);

    const backward = keyboard("Tab", true);
    handleDialogKeyboard(backward.event, container, () => undefined);
    expect(backward.prevented()).toBeTrue();
    expect(document.activeElement).toBe(last);
  });

  test("pulls focus back inside and closes once on Escape", () => {
    const { container, document, first } = dialogHarness();
    document.activeElement = focusTarget(document);
    const tab = keyboard("Tab");
    handleDialogKeyboard(tab.event, container, () => undefined);
    expect(tab.prevented()).toBeTrue();
    expect(document.activeElement).toBe(first);

    let closes = 0;
    const escape = keyboard("Escape");
    handleDialogKeyboard(escape.event, container, () => {
      closes += 1;
    });
    expect(closes).toBe(1);
    expect(escape.prevented()).toBeTrue();
    expect(escape.stopped()).toBeTrue();
  });

  test("returns focus only to an opener that is still connected", () => {
    const document: FakeDocument = { activeElement: null };
    const connected = focusTarget(document);
    restoreDialogFocus(connected);
    expect(document.activeElement).toBe(connected);

    const removed = focusTarget(document, false);
    const fallback = focusTarget(document);
    restoreDialogFocus(removed, fallback);
    expect(document.activeElement).toBe(fallback);
  });

  test("is wired into every modal surface", async () => {
    const [app, composer, likes] = await Promise.all([
      readFile(new URL("../src/app/App.tsx", import.meta.url), "utf8"),
      readFile(
        new URL("../src/app/components/Composer.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../src/app/components/LikesDrawer.tsx", import.meta.url),
        "utf8",
      ),
    ]);
    expect(app).toContain("useDialogFocus(dialog, cancelButton, onClose)");
    expect(composer).toContain("useDialogFocus(dialog, textarea, close)");
    expect(likes).toContain("useDialogFocus(drawer, closeButton, onClose)");
  });
});
