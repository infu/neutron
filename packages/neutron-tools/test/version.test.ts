import { describe, expect, test } from "bun:test";
import {
  APP_VERSION_MIN,
  assertAppVersion,
  formatAppVersion,
  formatAppVersionLabel,
  isAppVersion,
  normalizeAppVersion,
  packAppVersion,
  parseAppVersion,
  unpackAppVersion,
} from "../src/version.ts";

describe("packed app release versions", () => {
  test("renders packed versions exactly at the 0 and 99 component boundaries", () => {
    const boundaries = [
      {
        parts: { major: 0, minor: 1, patch: 0 },
        packed: 100,
        text: "0.1.0",
      },
      {
        parts: { major: 0, minor: 1, patch: 99 },
        packed: 199,
        text: "0.1.99",
      },
      {
        parts: { major: 0, minor: 99, patch: 0 },
        packed: 9_900,
        text: "0.99.0",
      },
      {
        parts: { major: 0, minor: 99, patch: 99 },
        packed: 9_999,
        text: "0.99.99",
      },
      {
        parts: { major: 1, minor: 0, patch: 0 },
        packed: 10_000,
        text: "1.0.0",
      },
      {
        parts: { major: 1, minor: 0, patch: 99 },
        packed: 10_099,
        text: "1.0.99",
      },
      {
        parts: { major: 1, minor: 99, patch: 0 },
        packed: 19_900,
        text: "1.99.0",
      },
      {
        parts: { major: 1, minor: 99, patch: 99 },
        packed: 19_999,
        text: "1.99.99",
      },
    ] as const;

    for (const { parts, packed, text } of boundaries) {
      expect(packAppVersion(parts)).toBe(packed);
      expect(unpackAppVersion(packed)).toEqual(parts);
      expect(formatAppVersion(packed)).toBe(text);
      expect(parseAppVersion(text)).toBe(packed);
    }
  });

  test("packs and formats the supported SemVer subset", () => {
    expect(APP_VERSION_MIN).toBe(100);
    expect(packAppVersion({ major: 0, minor: 1, patch: 0 })).toBe(100);
    expect(packAppVersion({ major: 0, minor: 1, patch: 1 })).toBe(101);
    expect(packAppVersion({ major: 1, minor: 0, patch: 0 })).toBe(10_000);
    expect(formatAppVersion(100)).toBe("0.1.0");
    expect(formatAppVersion(101)).toBe("0.1.1");
    expect(formatAppVersion(9_999)).toBe("0.99.99");
    expect(formatAppVersion(10_000)).toBe("1.0.0");
    expect(formatAppVersion(101n)).toBe("0.1.1");
    expect(normalizeAppVersion(10_000n)).toBe(10_000);
    expect(formatAppVersionLabel(101)).toBe("v0.1.1");
    expect(parseAppVersion("0.1.0")).toBe(100);
    expect(parseAppVersion("1.2.3")).toBe(10_203);
    expect(unpackAppVersion(10_203)).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
    });
  });

  test("rejects pre-baseline, malformed, and overflowing versions", () => {
    for (const value of [0, 1, 99, -1, 100.5, Number.NaN, Infinity]) {
      expect(isAppVersion(value)).toBe(false);
      expect(() => assertAppVersion(value)).toThrow(/0\.1\.0/);
    }
    expect(() =>
      packAppVersion({ major: 0, minor: 100, patch: 0 }),
    ).toThrow(/minor/);
    expect(() =>
      packAppVersion({ major: 0, minor: 1, patch: 100 }),
    ).toThrow(/patch/);
    expect(() =>
      packAppVersion({
        major: Number.MAX_SAFE_INTEGER,
        minor: 0,
        patch: 0,
      }),
    ).toThrow(/0\.1\.0/);
    for (const value of ["1", "v0.1.0", "0.01.0", "0.100.0", "0.0.1"]) {
      expect(() => parseAppVersion(value)).toThrow();
    }
  });
});
