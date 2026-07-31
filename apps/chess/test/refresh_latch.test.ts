import { expect, test } from "bun:test";
import {
  beginRefresh,
  createRefreshLatch,
  queueRefresh,
  shouldDrainRefresh,
} from "../src/refresh_latch.ts";

test("Chess queues an external refresh until a local mutation finishes", () => {
  const latch = createRefreshLatch();
  queueRefresh(latch);
  expect(shouldDrainRefresh(latch, true, true)).toBe(false);
  expect(shouldDrainRefresh(latch, true, false)).toBe(true);
  expect(beginRefresh(latch, false)).toBe(true);
  expect(latch.pending).toBe(false);
});

test("Chess retains a queued refresh behind an older same-epoch query", () => {
  const latch = createRefreshLatch();
  queueRefresh(latch);
  expect(beginRefresh(latch, true)).toBe(false);
  expect(latch.pending).toBe(true);
  expect(shouldDrainRefresh(latch, true, false)).toBe(true);
  expect(beginRefresh(latch, false)).toBe(true);
  expect(latch.pending).toBe(false);
});

test("Chess coalesces refresh bursts and never drains after unmount", () => {
  const latch = createRefreshLatch();
  queueRefresh(latch);
  queueRefresh(latch);
  expect(latch.pending).toBe(true);
  expect(shouldDrainRefresh(latch, false, false)).toBe(false);
});
