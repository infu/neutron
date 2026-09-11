import { expect, test } from "bun:test";
import type { OperationResult } from "../src/view-types.ts";
import { canDismissNotification, canRecoverEthereumPayment, isCanceledBeforeSubmission, isCanceledCheckout, notificationAttentionCount, notificationFingerprint, notificationTitle, readDismissedNotifications, visibleNotifications } from "../src/notification-state.ts";

const canceled: OperationResult = { operationId: "1234567890abcdef1234567890abcdef", state: "failed", nextAction: "review", message: "The browser wallet declined this transaction before submission.", ethereumWallet: "browser", canceledBeforeSubmission: true };
const hash = `0x${"a".repeat(64)}`;

test("known browser cancellation drops the notification without changing its saved record", () => {
  const original = structuredClone(canceled);
  expect(isCanceledBeforeSubmission(canceled)).toBe(true);
  expect(visibleNotifications([canceled])).toEqual([]);
  expect(notificationAttentionCount([canceled])).toBe(0);
  expect(canceled).toEqual(original);
});

test("canceled protocol checkout clears the card and badge on repeated history reads without a browser journal", () => {
  const operation: OperationResult = { operationId: "f".repeat(32), paymentRail: "ethereum", state: "failed", nextAction: "none", checkoutCanceled: true, message: "Checkout canceled." };
  for (const read of [operation, structuredClone(operation)]) {
    expect(isCanceledCheckout(read)).toBe(true);
    expect(visibleNotifications([read])).toEqual([]);
    expect(notificationAttentionCount([read])).toBe(0);
    expect(canRecoverEthereumPayment(read)).toBe(false);
  }
});

test("new payment evidence overrides a canceled checkout marker without hiding recovery", () => {
  const operation: OperationResult = { operationId: "f".repeat(32), paymentRail: "ethereum", state: "failed", nextAction: "none", checkoutCanceled: true, message: "Checkout canceled." };
  for (const patch of [
    { checkoutCanceled: undefined }, { nextAction: "review" as const }, { state: "pending" as const },
    { ethereumTransactionHash: hash }, { ledgerBlock: "7" }, { entitled: true },
    { settlement: { state: "pending" as const, message: "Buyer credit still needs settlement." } },
  ]) {
    const updated = { ...operation, ...patch };
    expect(isCanceledCheckout(updated)).toBe(false);
    expect(visibleNotifications([updated, operation])).toEqual([updated]);
  }
});

test("approval-only reminder can be dismissed and restored as a preference without erasing its intent", () => {
  const approval: OperationResult = { operationId: "a".repeat(32), state: "approval_required", nextAction: "resume", canDismiss: true, message: "No protocol payment is recorded." };
  const original = structuredClone(approval);
  const stored = JSON.stringify({ [approval.operationId]: notificationFingerprint(approval) });
  const dismissed = readDismissedNotifications({ getItem: () => stored }, "this-neutron");
  expect(canDismissNotification(approval)).toBe(true);
  expect(visibleNotifications([approval], dismissed)).toEqual([]);
  expect(notificationAttentionCount([approval], dismissed)).toBe(0);
  expect(approval).toEqual(original);
  const dispatch = { ...approval, state: "pending" as const, canDismiss: false };
  expect(visibleNotifications([dispatch], dismissed)).toEqual([dispatch]);
  const paid = { ...approval, ledgerBlock: "999" };
  expect(canDismissNotification(paid)).toBe(false);
  expect(visibleNotifications([paid], dismissed)).toEqual([paid]);
});

test("completed activity is clearable only after required settlement finishes", () => {
  const complete: OperationResult = { operationId: "a".repeat(32), state: "complete", nextAction: "none", message: "Complete", ledgerBlock: "999" };
  expect(canDismissNotification(complete)).toBe(true);
  expect(canDismissNotification({ ...complete, canDismiss: true, settlement: { state: "pending", message: "Wrapping remains pending" } })).toBe(false);
  expect(readDismissedNotifications({ getItem: () => "invalid" }, "this-neutron")).toEqual({});
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
