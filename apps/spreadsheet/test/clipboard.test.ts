import { expect, test } from "bun:test";
import { parseClipboardTable, stringifyClipboardTable } from "../src/clipboard.ts";

test("spreadsheet clipboard TSV preserves quoted tabs, newlines, and quotes", () => {
  const rows = [
    ["alpha", "two\nlines"],
    ["tab\tinside", 'say "hi"'],
  ];
  const text = stringifyClipboardTable(rows);
  expect(text).toBe('alpha\t"two\nlines"\n"tab\tinside"\t"say ""hi"""');
  expect(parseClipboardTable(text)).toEqual(rows);
  expect(parseClipboardTable(text.replaceAll("\n", "\r\n"))).toEqual(rows);
});

test("spreadsheet clipboard TSV keeps trailing empty fields and rejects broken quotes", () => {
  expect(parseClipboardTable("a\t\n1\t2")).toEqual([["a", ""], ["1", "2"]]);
  expect(() => parseClipboardTable('"never closed')).toThrow("unterminated quoted field");
});
