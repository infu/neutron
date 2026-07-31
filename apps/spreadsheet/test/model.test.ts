import { expect, test } from "bun:test";
import { rawInputFromText } from "../src/model.ts";

test("raw text parsing preserves identifiers that spreadsheet numbers cannot represent losslessly", () => {
  expect(rawInputFromText("0012345")).toEqual({ kind: "text", value: "0012345" });
  expect(rawInputFromText("-0012345")).toEqual({ kind: "text", value: "-0012345" });
  expect(rawInputFromText("1234567890123456")).toEqual({ kind: "text", value: "1234567890123456" });
  expect(rawInputFromText("0.1234567890123456")).toEqual({ kind: "text", value: "0.1234567890123456" });

  expect(rawInputFromText("0")).toEqual({ kind: "number", value: 0 });
  expect(rawInputFromText("0.00125")).toEqual({ kind: "number", value: 0.00125 });
  expect(rawInputFromText("123456789012345")).toEqual({ kind: "number", value: 123456789012345 });
  expect(rawInputFromText("1.25e4")).toEqual({ kind: "number", value: 12_500 });
});
