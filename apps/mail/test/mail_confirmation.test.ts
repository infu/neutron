import { describe, expect, test } from "bun:test";
import { composerLeaveConfirmationKind } from "../src/mail_confirmation.ts";

describe("Mail in-app confirmation reconciliation", () => {
  test("a completed send or route change invalidates a pending leave action", () => {
    expect(composerLeaveConfirmationKind("compose", true, true)).toBe("sending");
    expect(composerLeaveConfirmationKind("compose", true, false)).toBe("discard");
    expect(composerLeaveConfirmationKind("compose", false, false)).toBeNull();
    expect(composerLeaveConfirmationKind("reader", true, true)).toBeNull();
  });
});
