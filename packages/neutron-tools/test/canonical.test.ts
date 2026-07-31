import { expect, test } from "bun:test";
import { compareCanonicalText } from "../src/canonical.ts";

test("canonical text order is lexical and independent of locale collation", () => {
  expect(["z", "aa", "a", "ab"].sort(compareCanonicalText)).toEqual([
    "a",
    "aa",
    "ab",
    "z",
  ]);
  expect(compareCanonicalText("aa", "z")).toBeLessThan(0);
  expect(compareCanonicalText("😀", "\uffff")).toBeGreaterThan(0);
});
