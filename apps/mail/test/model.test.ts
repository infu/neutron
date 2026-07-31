import { expect, test } from "bun:test";
import {
  MAIL_LIMITS,
  MailValidationError,
  unicodeScalarCount,
  validateBodyMarkdown,
  validateClaimedSenderName,
  validateSubject,
  validateUnsignedDecimal,
} from "../src/model.ts";

test("validates sender names and subjects by Unicode scalars and UTF-8 bytes", () => {
  expect(validateClaimedSenderName("Ada Lovelace")).toBe("Ada Lovelace");
  expect(validateSubject("Status ✅")).toBe("Status ✅");
  expect(unicodeScalarCount("A😀")).toBe(2);
  expect(validateClaimedSenderName("a".repeat(MAIL_LIMITS.claimedSenderNameScalars))).toHaveLength(80);
  expect(() => validateClaimedSenderName("a".repeat(81))).toThrow(MailValidationError);
  expect(() => validateClaimedSenderName("😀".repeat(65))).toThrow("byte limit");
  expect(() => validateSubject("😀".repeat(129))).toThrow("byte limit");
});

test("rejects ambiguous formatting, controls, blank fields, and invalid scalars", () => {
  for (const value of ["", "   ", "line\nbreak", "abc\u202edef", "zero\u200bwidth", "tab\there"]) {
    expect(() => validateSubject(value)).toThrow(MailValidationError);
  }
  expect(() => validateClaimedSenderName("broken\ud800")).toThrow("Unicode scalar");
});

test("body permits ordinary Markdown newlines and tabs but rejects non-text controls", () => {
  expect(validateBodyMarkdown("# Hello\n\n- one\n\tcode")).toContain("Hello");
  expect(validateBodyMarkdown("")).toBe("");
  expect(() => validateBodyMarkdown("bad\0body")).toThrow("control");
  expect(() => validateBodyMarkdown(`bad${String.fromCharCode(0x1f)}body`)).toThrow("control");
  expect(() => validateBodyMarkdown("x".repeat(MAIL_LIMITS.bodyBytes + 1))).toThrow("32 KiB");
});

test("unsigned decimals are canonical and bounded", () => {
  expect(validateUnsignedDecimal("0", "value")).toBe("0");
  expect(validateUnsignedDecimal("18446744073709551615", "value")).toBe(
    "18446744073709551615",
  );
  for (const value of ["", "01", "-1", "+1", "1.0", " 1"] as const) {
    expect(() => validateUnsignedDecimal(value, "value")).toThrow("unsigned decimal");
  }
  expect(() => validateUnsignedDecimal("18446744073709551616", "value")).toThrow("range");
});
