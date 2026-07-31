import { describe, expect, test } from "bun:test";
import {
  canonicalizeFilesPath,
  unicodeScalarCount,
  validateFilesName,
} from "../src/vault/paths.ts";

describe("Files V2 canonical private paths", () => {
  test("whole-input whitespace, root aliases, slashes, and dot segments are exact", () => {
    expect(canonicalizeFilesPath("\u2003 //notes///./report.txt\u00a0"))
      .toEqual({
        path: "/notes/report.txt",
        segments: ["notes", "report.txt"],
        scalars: 17,
      });
    for (const alias of ["", "/", "///", " \t/\n", "/././"]) {
      expect(canonicalizeFilesPath(alias)).toEqual({
        path: "/",
        segments: [],
        scalars: 1,
      });
    }
  });

  test("normalization is NFC and names remain case-sensitive", () => {
    expect(canonicalizeFilesPath("/e\u0301/Readme").segments)
      .toEqual(["é", "Readme"]);
    expect(canonicalizeFilesPath("/README").path).toBe("/README");
    expect(canonicalizeFilesPath("/readme").path).toBe("/readme");
    expect(canonicalizeFilesPath("/README").path)
      .not.toBe(canonicalizeFilesPath("/readme").path);
  });

  test("stored segments preserve interior whitespace and reject edge whitespace", () => {
    expect(validateFilesName("quarterly report")).toBe("quarterly report");
    expect(canonicalizeFilesPath("/quarterly report/final").segments)
      .toEqual(["quarterly report", "final"]);
    for (const input of [
      "/ leading/child",
      "/trailing /child",
      "/\u00a0leading/child",
      "/trailing\u2003/child",
    ]) {
      expect(() => canonicalizeFilesPath(input)).toThrow(
        "Files name is invalid",
      );
    }
    expect(() => validateFilesName(" direct ")).toThrow(
      "Files name is invalid",
    );
  });

  test("traversal, separators, controls, and malformed Unicode fail closed", () => {
    for (const input of [
      "/notes/../secret",
      "/notes\\secret",
      "/notes/\0secret",
      "/notes/\u001fsecret",
      "/notes/\u0085secret",
      "/notes/\ud800",
      "/notes/\udc00",
    ]) {
      expect(() => canonicalizeFilesPath(input)).toThrow();
    }
    for (const name of [
      "",
      ".",
      "..",
      "a/b",
      "a\\b",
      "a\0b",
      "a\u001fb",
      "\ud800",
    ]) {
      expect(() => validateFilesName(name)).toThrow();
    }
  });

  test("name scalar, UTF-8, complete-path, and depth boundaries are exact", () => {
    const fourByteName = "🧪".repeat(100);
    expect(unicodeScalarCount(fourByteName)).toBe(100);
    expect(new TextEncoder().encode(fourByteName)).toHaveLength(400);
    expect(validateFilesName(fourByteName)).toBe(fourByteName);
    expect(() => validateFilesName(`${fourByteName}a`)).toThrow(
      "Files name exceeds its bound",
    );

    const path240 = `/${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(37)}`;
    expect(unicodeScalarCount(path240)).toBe(240);
    expect(canonicalizeFilesPath(path240).scalars).toBe(240);
    expect(() => canonicalizeFilesPath(`${path240}c`)).toThrow(
      "Files path exceeds its bound",
    );

    const depth64 = `/${Array.from({ length: 64 }, () => "a").join("/")}`;
    const depth65 = `${depth64}/a`;
    expect(canonicalizeFilesPath(depth64).segments).toHaveLength(64);
    expect(() => canonicalizeFilesPath(depth65)).toThrow(
      "Files path exceeds the tree-depth bound",
    );
  });
});
