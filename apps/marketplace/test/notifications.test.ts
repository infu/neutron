import { expect, test } from "bun:test";
import type { OperationResult } from "../src/view-types.ts";
import { canRecoverEthereumPayment, isCanceledBeforeSubmission, notificationAttentionCount, notificationTitle, visibleNotifications } from "../src/notification-state.ts";

const canceled: OperationResult = { operationId: "1234567890abcdef1234567890abcdef", state: "failed", nextAction: "review", message: "The browser wallet declined this transaction before submission.", ethereumWallet: "browser", canceledBeforeSubmission: true };
const hash = `0x${"a".repeat(64)}`;

test("known browser cancellation drops the notification without changing its saved record", () => {
  const original = structuredClone(canceled);
  expect(isCanceledBeforeSubmission(canceled)).toBe(true);
  expect(visibleNotifications([canceled])).toEqual([]);
  expect(notificationAttentionCount([canceled])).toBe(0);
  expect(canceled).toEqual(original);
});

test("cancellation prose alone never hides uncertain or previously submitted payments", () => {
  for (const patch of [
    { canceledBeforeSubmission: undefined }, { state: "pending" as const }, { ethereumWallet: "evm_wallet" as const },
    { ethereumTransactionHash: hash }, { entitled: true }, { ledgerBlock: "123" },
    { settlement: { state: "pending" as const, message: "An earlier payment still needs settlement." } },
  ]) {
    const observation = { ...canceled, ...patch };
    expect(isCanceledBeforeSubmission(observation)).toBe(false);
    expect(visibleNotifications([observation])).toEqual([observation]);
  }
});

test("latest evidence wins while all other outstanding IDs stay visible", () => {
  const stale: OperationResult = { ...canceled, canceledBeforeSubmission: undefined, state: "pending", message: "Awaiting wallet result" };
  const other: OperationResult = { ...stale, operationId: "b".repeat(32), ethereumTransactionHash: hash };
  expect(visibleNotifications([canceled, stale, other])).toEqual([other]);
  expect(notificationAttentionCount([canceled, stale, other])).toBe(1);
});

test("installation handoffs do not become financial notifications", () => {
  const installation = { ...canceled, canceledBeforeSubmission: undefined, installation: {} as NonNullable<OperationResult["installation"]> };
  expect(visibleNotifications([installation])).toEqual([]);
});

test("approval confirmation and deposit submission keep original-payment recovery", () => {
  for (const message of ["USDC approval confirmed. No payment has been made.", "Deposit submitted; waiting for Ethereum confirmation."]) {
    const pending: OperationResult = { ...canceled, canceledBeforeSubmission: undefined, state: "pending", message, ethereumTransactionHash: hash };
    expect(canRecoverEthereumPayment(pending)).toBe(true);
    expect(notificationTitle(pending)).toBe("In progress");
    expect(notificationAttentionCount([pending])).toBe(1);
  }
});

test("app access is complete while wrapping remains visible without another payment action", () => {
  const complete: OperationResult = { ...canceled, state: "complete", nextAction: "none", entitled: true, ethereumTransactionHash: hash, settlement: { state: "pending", message: "Wrapping is pending; your app is already available." } };
  expect(visibleNotifications([complete])).toEqual([complete]);
  expect(canRecoverEthereumPayment(complete)).toBe(false);
  expect(notificationTitle(complete)).toBe("Purchase complete");
  expect(notificationAttentionCount([complete])).toBe(0);
});
