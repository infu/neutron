import { expect, test } from "bun:test";
import { canonicalJson, compareCanonicalText } from "../src/canonical.ts";

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

test("canonical JSON retains the released scalar-order wire bytes", () => {
  expect(
    canonicalJson({
      "\ud83d\ude00": [true, null, { z: -0, a: "caf\u00e9" }],
      "\uffff": 2,
      a: 1,
    }),
  ).toBe(
    '{"a":1,"\uffff":2,"\ud83d\ude00":[true,null,{"a":"caf\u00e9","z":0}]}',
  );
});
