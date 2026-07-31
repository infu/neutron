import { expect, test } from "bun:test";
import { isValidAppId } from "../src/app_ids.ts";

test("app ids use canonical lowercase alphanumeric segments", () => {
  for (const value of [
    "mail",
    "agent",
    "a1_b2",
    "1234",
    "a".repeat(30),
  ]) {
    expect(isValidAppId(value)).toBe(true);
  }

  for (const value of [
    "abc",
    "a".repeat(31),
    "_mail",
    "mail_",
    "mail__agent",
    "____",
    "Mail",
    "mail-agent",
    null,
  ]) {
    expect(isValidAppId(value)).toBe(false);
  }
});
