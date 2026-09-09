import { expect, test } from "bun:test";
import { needsTradeReconciliation } from "../src/trade_progress";

test("tracking distinguishes acknowledged configuration from unresolved orders and never dispatches drafts", () => {
  for (const kind of ["order", "modify", "cancel", "cancelAll", "leverage", "margin"]) {
    for (const state of ["prepared", "signed"]) expect(needsTradeReconciliation({ state, intent: { kind } })).toBe(false);
    expect(needsTradeReconciliation({ state: "uncertain", intent: { kind } })).toBe(true);
    expect(needsTradeReconciliation({ state: "accepted", intent: { kind } })).toBe(!["leverage", "margin"].includes(kind));
  }
});

test("observed resting and partially open orders need no acknowledgement polling", () => {
  expect(needsTradeReconciliation({ state: "accepted", intent: { kind: "cancelAll" }, orders: [] })).toBe(false);
  expect(needsTradeReconciliation({ state: "accepted", intent: { kind: "cancelAll" } })).toBe(true);
  for (const state of ["resting", "filled", "canceled", "rejected"]) expect(needsTradeReconciliation({ state, intent: { kind: "order" }, orders: [{ state }] })).toBe(false);
  expect(needsTradeReconciliation({ state: "partial", orders: [{ state: "partial", venueStatus: "open" }] })).toBe(false);
  expect(needsTradeReconciliation({ state: "partial", orders: [{ state: "partial", venueStatus: "filled" }] })).toBe(false);
  expect(needsTradeReconciliation({ state: "partial", orders: [{ state: "partial" }] })).toBe(true);
});
