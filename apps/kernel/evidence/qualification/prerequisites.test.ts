import { expect, test } from "bun:test";
import {
  awaitQualificationPrerequisites,
  runBoundedQualificationWorkset,
} from "./prerequisites.ts";

test("qualification prerequisites await every branch and preserve input order", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  let completed = false;
  const result = awaitQualificationPrerequisites([
    first.promise,
    second.promise,
  ] as const).then((value) => {
    completed = true;
    return value;
  });

  second.resolve("second");
  await Promise.resolve();
  expect(completed).toBe(false);
  first.resolve("first");
  expect(await result).toEqual(["first", "second"]);
});

test("qualification prerequisites retain one failure after all branches settle", async () => {
  const failure = new Error("fixed gate failed");
  const late = deferred<void>();
  let completed = false;
  const result = awaitQualificationPrerequisites([
    Promise.reject(failure),
    late.promise.then(() => {
      completed = true;
    }),
  ] as const).catch((error: unknown) => error);

  await Promise.resolve();
  expect(completed).toBe(false);
  late.resolve();
  expect(await result).toBe(failure);
  expect(completed).toBe(true);
});

test("qualification prerequisites aggregate failures in fixed input order", async () => {
  const first = new Error("first fixed gate failed");
  const second = new Error("second fixed gate failed");
  const result = awaitQualificationPrerequisites([
    Promise.reject(first),
    Promise.resolve("passed"),
    Promise.reject(second),
  ] as const).catch((error: unknown) => error);

  const failure = await result;
  expect(failure).toBeInstanceOf(AggregateError);
  expect([...((failure as AggregateError).errors)]).toEqual([
    first,
    second,
  ]);
});

test("bounded qualification work attempts every item and preserves input order", async () => {
  const gates = Array.from({ length: 7 }, () => deferred<number>());
  const started: number[] = [];
  let active = 0;
  let maximumActive = 0;
  const result = runBoundedQualificationWorkset(
    gates.map((_, index) => index),
    3,
    async (index) => {
      started.push(index);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const value = await gates[index]!.promise;
      active -= 1;
      return value;
    },
  );

  await waitFor(() => started.length === 3);
  expect(started).toEqual([0, 1, 2]);
  gates[1]!.resolve(101);
  await waitFor(() => started.length === 4);
  expect(started).toEqual([0, 1, 2, 3]);
  gates[3]!.resolve(103);
  await waitFor(() => started.length === 5);
  gates[2]!.resolve(102);
  await waitFor(() => started.length === 6);
  gates[0]!.resolve(100);
  await waitFor(() => started.length === 7);
  gates[6]!.resolve(106);
  gates[5]!.resolve(105);
  gates[4]!.resolve(104);

  expect(await result).toEqual([100, 101, 102, 103, 104, 105, 106]);
  expect(maximumActive).toBe(3);
  expect(active).toBe(0);
});

test("bounded qualification work settles the full workset and orders failures", async () => {
  const first = new Error("first canonical failure");
  const fourth = new Error("fourth canonical failure");
  const fourthGate = deferred<void>();
  const started: number[] = [];
  const result = runBoundedQualificationWorkset(
    [0, 1, 2, 3, 4, 5],
    3,
    async (index) => {
      started.push(index);
      if (index === 0) throw first;
      if (index === 3) {
        await fourthGate.promise;
        throw fourth;
      }
      return index;
    },
  ).catch((error: unknown) => error);

  await waitFor(() => started.length === 6);
  fourthGate.resolve();
  const failure = await result;
  expect(failure).toBeInstanceOf(AggregateError);
  expect([...(failure as AggregateError).errors]).toEqual([first, fourth]);
  expect(started).toEqual([0, 1, 2, 3, 4, 5]);
});

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Test condition did not become true");
}
