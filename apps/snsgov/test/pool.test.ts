/**
 * The concurrency pool.
 *
 * It replaced chunked `Promise.all` batches, where every chunk waited for its
 * slowest member — with 54 SNSes and a handful of dead canisters timing out,
 * that left most lanes idle.
 */

import { expect, test } from "bun:test";
import { pool } from "../src/data/pool";

test("results keep the order of their inputs, not of completion", async () => {
  const out = await pool([30, 5, 20, 1], 4, async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return ms;
  });
  expect(out).toEqual([30, 5, 20, 1]);
});

// The whole point: a slow task must not stop the lanes beside it.
test("a lane takes the next task the instant it frees up", async () => {
  let inFlight = 0;
  let peak = 0;
  const started: number[] = [];
  await pool(Array.from({ length: 12 }, (_x, i) => i), 4, async (i) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    started.push(i);
    // The first task is slow; the rest are instant.
    await new Promise((resolve) => setTimeout(resolve, i === 0 ? 40 : 1));
    inFlight -= 1;
  });
  expect(peak).toBeLessThanOrEqual(4);
  // With chunking, tasks 4-11 could not start until task 0 finished. Here the
  // other lanes run right through it.
  expect(started.length).toBe(12);
  expect(started.indexOf(11)).toBeLessThan(12);
});

test("degenerate inputs are handled", async () => {
  expect(await pool([], 4, async () => 1)).toEqual([]);
  expect(await pool([1, 2, 3], 0, async (x) => x * 2)).toEqual([2, 4, 6]);
  expect(await pool([1], 99, async (x) => x)).toEqual([1]);
});
