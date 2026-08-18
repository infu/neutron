import { describe, expect, test } from "bun:test";
import {
  QUALIFICATION_FAILURE_MAX_DIAGNOSTIC_BYTES,
  formatQualificationFailure,
} from "./failure.ts";

describe("Certified Assets qualification failure diagnostics", () => {
  test("prints names and messages independently of a bare stack", () => {
    const inner = new Error();
    Object.defineProperty(inner, "stack", { value: "Error" });
    const outer = new Error("receipt operational-sample failure", {
      cause: inner,
    });
    Object.defineProperty(outer, "stack", { value: "Error" });

    expect(JSON.parse(formatQualificationFailure(outer))).toEqual({
      schema: "neutron.kernel.certified-assets-qualification-failure.v1",
      cause_chain: "complete",
      errors: [
        {
          depth: 0,
          name: "Error",
          message: "receipt operational-sample failure",
          stack: "Error",
        },
        {
          depth: 1,
          name: "Error",
          message: "",
          stack: "Error",
        },
      ],
    });
  });

  test("handles cause cycles and hostile property getters", () => {
    const cycle = new Error("cycle");
    Object.defineProperty(cycle, "cause", { value: cycle });
    expect(JSON.parse(formatQualificationFailure(cycle)).cause_chain).toBe(
      "cycle",
    );

    const hostile = new Proxy({}, {
      get() {
        throw new Error("hostile getter must not escape");
      },
    });
    expect(JSON.parse(formatQualificationFailure(hostile))).toEqual({
      schema: "neutron.kernel.certified-assets-qualification-failure.v1",
      cause_chain: "unreadable",
      errors: [{
        depth: 0,
        name: "unreadable",
        message: "unreadable",
        stack: "unreadable",
      }],
    });
  });

  test("bounds long Unicode diagnostics and non-Error thrown values", () => {
    const long = new Error("\ud83e\udd84\u0000\\\"".repeat(
      QUALIFICATION_FAILURE_MAX_DIAGNOSTIC_BYTES * 2,
    ));
    const formatted = formatQualificationFailure(long);
    expect(Buffer.byteLength(formatted, "utf8")).toBeLessThanOrEqual(
      QUALIFICATION_FAILURE_MAX_DIAGNOSTIC_BYTES,
    );
    expect(formatted).toContain("...[truncated]");
    expect(JSON.parse(formatted).errors[0].message).toContain(
      "...[truncated]",
    );
    expect(
      JSON.parse(formatQualificationFailure("plain failure")).errors[0]
        .message,
    ).toBe(
      "plain failure",
    );
  });

  test("traverses bounded AggregateError members and their causes", () => {
    const nestedCause = new Error("nested cleanup cause");
    const cleanup = new Error("cleanup failed", { cause: nestedCause });
    const primary = new Error("primary qualification failure");
    const formatted = JSON.parse(formatQualificationFailure(
      new AggregateError([primary, cleanup], "qualification and cleanup failed"),
    ));

    expect(formatted.cause_chain).toBe("complete");
    expect(formatted.errors.map(
      ({ message }: { message: string }) => message,
    )).toEqual([
      "qualification and cleanup failed",
      "primary qualification failure",
      "cleanup failed",
      "nested cleanup cause",
    ]);
    expect(formatted.errors.every(
      ({ stack }: { stack: string }) => stack.length > 0,
    )).toBe(true);
  });

  test("bounds oversized AggregateError member lists", () => {
    const formatted = formatQualificationFailure(new AggregateError(
      Array.from({ length: 32 }, (_, index) => new Error(`failure ${index}`)),
      "many failures",
    ));
    const parsed = JSON.parse(formatted);
    expect(parsed.cause_chain).toBe("truncated");
    expect(parsed.errors.length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(formatted, "utf8")).toBeLessThanOrEqual(
      QUALIFICATION_FAILURE_MAX_DIAGNOSTIC_BYTES,
    );
  });
});
