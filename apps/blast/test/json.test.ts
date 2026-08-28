import { describe, expect, test } from "bun:test";
import {
  assertBoundedBlastJson,
  assertBoundedBlastJsonEnvelope,
  assertBoundedBlastStoredV1Json,
  boundedError,
  isUnicodeScalarText,
  naturalNumber,
  requiredBlastMethodName,
  unicodeScalarLength,
} from "../src/json.ts";
import {
  BLAST_LIMITS,
  BLAST_STORED_V1_JSON_LIMITS,
} from "../src/limits.ts";

describe("Blast JSON boundaries", () => {
  test("accept nested JSON and reject non-JSON values", () => {
    expect(() =>
      assertBoundedBlastJson({ pages: [{ nested: [1, true, null] }] }, "value", 1_024),
    ).not.toThrow();
    expect(() =>
      assertBoundedBlastJson({ bad: 1n }, "value", 1_024),
    ).toThrow("JSON-compatible");
  });

  test("rejects shapes that JSON serialization would omit or rewrite", () => {
    const sparse = new Array<unknown>(1);
    const namedArray: unknown[] = [];
    Object.defineProperty(namedArray, "extra", { enumerable: true, value: 1 });
    const hidden = {};
    Object.defineProperty(hidden, "value", { value: 1 });

    expect(() => assertBoundedBlastJson([], "value", 1_024)).not.toThrow();
    class CustomArray extends Array<unknown> {}
    for (const invalid of [
      sparse,
      namedArray,
      hidden,
      new Date(),
      new CustomArray(1),
      { bad: undefined },
    ]) {
      expect(() => assertBoundedBlastJson(invalid, "value", 1_024)).toThrow(
        "JSON-compatible",
      );
    }
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertBoundedBlastJson(invalid, "value", 1_024)).toThrow(
        "JSON-compatible",
      );
    }
  });

  test("rejects accessors and toJSON without invoking them", () => {
    let accessorReads = 0;
    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 1;
      },
    });
    let toJsonCalls = 0;
    const customized = {
      value: 1,
      toJSON() {
        toJsonCalls += 1;
        return {};
      },
    };

    expect(() => assertBoundedBlastJson(accessor, "value", 1_024)).toThrow(
      "JSON-compatible",
    );
    expect(() => assertBoundedBlastJson(customized, "value", 1_024)).toThrow(
      "JSON-compatible",
    );
    expect(accessorReads).toBe(0);
    expect(toJsonCalls).toBe(0);
  });

  test("rejects cycles, remains stack-safe, and permits shared JSON values", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => assertBoundedBlastJson(cycle, "value", 1_024)).toThrow(
      "JSON-compatible",
    );

    let deeplyNested: unknown = null;
    for (let index = 0; index < 20_000; index += 1) {
      deeplyNested = [deeplyNested];
    }
    expect(() =>
      assertBoundedBlastJson(deeplyNested, "value", 1_000_000),
    ).toThrow("nested too deeply");

    const shared = { nested: [1, true, null] };
    const nullPrototype = Object.assign(Object.create(null), { shared });
    expect(() =>
      assertBoundedBlastJson(
        { first: shared, second: shared, nullPrototype },
        "value",
        1_024,
      ),
    ).not.toThrow();
  });

  test("enforces depth, nodes, and bytes", () => {
    let nested: unknown = null;
    for (let index = 0; index <= BLAST_LIMITS.jsonDepth + 1; index += 1) {
      nested = [nested];
    }
    expect(() => assertBoundedBlastJson(nested, "value", 1_000_000)).toThrow(
      "nested too deeply",
    );
    expect(() => assertBoundedBlastJson("large", "value", 2)).toThrow(
      "too large",
    );
  });

  test("reserves structure for protocol wrappers around a maximum-shape value", () => {
    let maximumDepth: unknown = null;
    for (let index = 0; index < BLAST_LIMITS.jsonDepth; index += 1) {
      maximumDepth = [maximumDepth];
    }
    expect(() =>
      assertBoundedBlastJson(maximumDepth, "value", 1_000_000),
    ).not.toThrow();

    const envelope = { values: [maximumDepth], nextCursor: null };
    expect(() =>
      assertBoundedBlastJson(envelope, "envelope", 1_000_000),
    ).toThrow("nested too deeply");
    expect(() =>
      assertBoundedBlastJsonEnvelope(envelope, "envelope", 1_000_000),
    ).not.toThrow();

    const maximumNodes = Array.from(
      { length: BLAST_LIMITS.jsonNodes - 1 },
      () => null,
    );
    expect(() =>
      assertBoundedBlastJson(maximumNodes, "value", 1_000_000),
    ).not.toThrow();
    expect(() =>
      assertBoundedBlastJson(
        { values: [maximumNodes], nextCursor: null },
        "envelope",
        1_000_000,
      ),
    ).toThrow("too many values");
    expect(() =>
      assertBoundedBlastJsonEnvelope(
        { values: [maximumNodes], nextCursor: null },
        "envelope",
        1_000_000,
      ),
    ).not.toThrow();
  });

  test("retains the exact wider JSON shape accepted by browser schema v1", () => {
    let retainedDepth: unknown = null;
    for (
      let index = 0;
      index < BLAST_STORED_V1_JSON_LIMITS.depth;
      index += 1
    ) {
      retainedDepth = [retainedDepth];
    }
    expect(() =>
      assertBoundedBlastStoredV1Json(
        retainedDepth,
        "retained value",
        1_000_000,
      )
    ).not.toThrow();
    expect(() =>
      assertBoundedBlastJson(retainedDepth, "new value", 1_000_000)
    ).toThrow("nested too deeply");

    const retainedNodes = Array.from(
      { length: BLAST_STORED_V1_JSON_LIMITS.nodes - 1 },
      () => null,
    );
    expect(() =>
      assertBoundedBlastStoredV1Json(
        retainedNodes,
        "retained value",
        1_000_000,
      )
    ).not.toThrow();
    expect(() =>
      assertBoundedBlastJson(retainedNodes, "new value", 1_000_000)
    ).toThrow("too many values");
  });

  test("normalizes errors and natural numbers", () => {
    expect(boundedError(new Error("bad\u0000input"))).toBe("bad�input");
    expect(boundedError(`\ud800low\udfff`)).toBe("�low�");
    const boundary = boundedError(
      new Error(`${"x".repeat(996)}😀${"y".repeat(4)}`),
    );
    expect(boundary).toBe(`${"x".repeat(996)}😀...`);
    expect(isUnicodeScalarText(boundary)).toBe(true);
    expect(unicodeScalarLength(boundary)).toBe(1_000);
    expect(naturalNumber(4, "limit", 4)).toBe(4);
    expect(() => naturalNumber(-1, "limit", 4)).toThrow();
  });

  test("validates exact scalar-safe canister method names", () => {
    const maximum = "😀".repeat(BLAST_LIMITS.canisterMethodCharacters);
    expect(requiredBlastMethodName(maximum, "method")).toBe(maximum);
    for (const invalid of [
      "",
      `${maximum}😀`,
      "bad\u0000method",
      "bad\nmethod",
      "bad\u001fmethod",
      "bad\u007fmethod",
      "bad\ud800method",
    ]) {
      expect(() => requiredBlastMethodName(invalid, "method")).toThrow(
        "method is invalid",
      );
    }
  });
});
