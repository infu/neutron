import { describe, expect, test } from "bun:test";
import {
  FEED_UNAVAILABLE_RETRY_DELAYS_MS,
  FeedUnavailableRetryController,
  type FeedRetryClock,
} from "../src/app/feed_retry.ts";
import type { VerificationState } from "../src/app/model.ts";

describe("automatic feed availability recovery", () => {
  test("backs off three times over fifty seconds and then stops", async () => {
    const clock = new FakeClock();
    const calls: string[] = [];
    const controller = new FeedUnavailableRetryController(
      FEED_UNAVAILABLE_RETRY_DELAYS_MS,
      clock,
    );

    controller.observe([observation("post", "unavailable")], (id) => {
      calls.push(id);
      return true;
    });

    expect(clock.delays()).toEqual([5_000]);
    clock.fireNext();
    await settle();
    expect(calls).toEqual(["post"]);
    expect(clock.delays()).toEqual([15_000]);

    clock.fireNext();
    await settle();
    expect(calls).toEqual(["post", "post"]);
    expect(clock.delays()).toEqual([30_000]);

    clock.fireNext();
    await settle();
    expect(calls).toEqual(["post", "post", "post"]);
    expect(clock.delays()).toEqual([]);
  });

  test("stops immediately when a retry is no longer unavailable", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const controller = new FeedUnavailableRetryController(
      [5, 15, 30],
      clock,
    );
    controller.observe([observation("post", "unavailable")], () => {
      calls += 1;
      return calls === 1;
    });

    clock.fireNext();
    await settle();
    expect(clock.delays()).toEqual([15]);

    clock.fireNext();
    await settle();
    expect(calls).toBe(2);
    expect(clock.delays()).toEqual([]);
  });

  test("never schedules a new candidate or a terminal proof failure", () => {
    const clock = new FakeClock();
    let calls = 0;
    const controller = new FeedUnavailableRetryController([5], clock);
    const retry = () => {
      calls += 1;
      return true;
    };

    controller.observe([observation("new", "candidate")], retry);
    controller.observe([observation("invalid", "invalid")], retry);
    expect(clock.delays()).toEqual([]);

    controller.observe([observation("post", "unavailable")], retry);
    expect(clock.delays()).toEqual([5]);
    controller.observe([observation("post", "invalid")], retry);
    expect(clock.delays()).toEqual([]);
    clock.fireAll();
    expect(calls).toBe(0);
  });

  test("cancels sleeping and in-flight work when its row disappears", async () => {
    const clock = new FakeClock();
    const controller = new FeedUnavailableRetryController([5, 15], clock);
    let calls = 0;
    const active: {
      signal?: AbortSignal;
      finish?: (retryable: boolean) => void;
    } = {};
    controller.observe(
      [observation("sleeping", "unavailable")],
      () => {
        calls += 1;
        return true;
      },
    );
    controller.observe([], () => true);
    expect(clock.delays()).toEqual([]);

    controller.observe(
      [observation("active", "unavailable")],
      (_id, signal) => {
        calls += 1;
        active.signal = signal;
        return new Promise<boolean>((resolve) => {
          active.finish = resolve;
        });
      },
    );
    clock.fireNext();
    expect(calls).toBe(1);
    expect(active.signal?.aborted).toBeFalse();

    controller.observe([], () => true);
    expect(active.signal?.aborted).toBeTrue();
    active.finish?.(true);
    await settle();
    expect(clock.delays()).toEqual([]);
  });

  test("manual verification supersedes a timer without resetting backoff", async () => {
    const clock = new FakeClock();
    const controller = new FeedUnavailableRetryController(
      [5, 15, 30],
      clock,
    );
    controller.observe(
      [observation("post", "unavailable")],
      () => true,
    );
    clock.fireNext();
    await settle();
    expect(clock.delays()).toEqual([15]);

    controller.beginNow("post");
    expect(clock.delays()).toEqual([]);
    controller.observe(
      [observation("post", "fetching")],
      () => true,
    );
    controller.observe(
      [observation("post", "unavailable")],
      () => true,
    );
    expect(clock.delays()).toEqual([15]);
  });

  test("limits matured retries without counting sleeping rows as active", async () => {
    const clock = new FakeClock();
    const controller = new FeedUnavailableRetryController(
      [5],
      clock,
      6,
    );
    const finishes: Array<(retryable: boolean) => void> = [];
    let calls = 0;
    controller.observe(
      Array.from({ length: 8 }, (_, index) =>
        observation(`post-${index}`, "unavailable")
      ),
      () => {
        calls += 1;
        return new Promise<boolean>((resolve) => {
          finishes.push(resolve);
        });
      },
    );

    expect(clock.delays()).toHaveLength(8);
    clock.fireAll();
    expect(calls).toBe(6);

    finishes[0]!(false);
    await settle();
    expect(calls).toBe(7);
    controller.dispose();
  });
});

function observation(id: string, verification: VerificationState) {
  return { id, verification } as const;
}

class FakeClock implements FeedRetryClock {
  readonly #tasks = new Map<
    number,
    { readonly callback: () => void; readonly delayMs: number }
  >();
  #nextHandle = 1;

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#tasks.set(handle, { callback, delayMs });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#tasks.delete(handle);
  }

  delays(): number[] {
    return [...this.#tasks.values()].map(({ delayMs }) => delayMs);
  }

  fireNext(): void {
    const next = this.#tasks.entries().next().value as
      | [number, { readonly callback: () => void }]
      | undefined;
    if (!next) throw new Error("No scheduled retry");
    this.#tasks.delete(next[0]);
    next[1].callback();
  }

  fireAll(): void {
    for (const [handle, task] of [...this.#tasks]) {
      this.#tasks.delete(handle);
      task.callback();
    }
  }
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
