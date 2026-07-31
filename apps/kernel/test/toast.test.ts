import { afterEach, expect, test } from "bun:test";
import {
  clearToasts,
  dismissToast,
  showToast,
  useToastStore,
} from "../src/toast/store.ts";

afterEach(clearToasts);

test("toast store bounds the visible stack and dismisses entries", () => {
  const ids = Array.from({ length: 5 }, (_, index) =>
    showToast({ message: `Notice ${index}`, tone: "info" }),
  );
  expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
    "Notice 1",
    "Notice 2",
    "Notice 3",
    "Notice 4",
  ]);

  dismissToast(ids[3]!);
  expect(useToastStore.getState().toasts).toHaveLength(3);
});

test("toast store deduplicates a repeated notification", () => {
  const first = showToast({ message: "Copied to clipboard", tone: "success" });
  const second = showToast({ message: "Copied to clipboard", tone: "success" });
  expect(second).toBe(first);
  expect(useToastStore.getState().toasts).toHaveLength(1);
});
