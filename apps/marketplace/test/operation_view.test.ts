import { expect, test } from "bun:test";
import { operationView } from "../src/client.ts";
import type { WireResult } from "../src/protocol.ts";

test("confirmed ledger blocks survive the app's compact operation view", () => {
  const result: WireResult = {
    order: { requestId: "0123456789abcdef0123456789abcdef", state: { complete: null }, lastError: [], items: [] },
    attempt: [{ state: { succeeded: null }, hadUnknown: false, block: [780011n] }],
    active: false, nextAction: { none: null },
  };
  expect(operationView(result)).toMatchObject({ state: "complete", ledgerBlock: "780011", nextAction: "none" });
  result.order!.state = { dispatched: null };
  result.nextAction = { retry_same_attempt: null };
  expect(operationView(result)).toMatchObject({ state: "pending", ledgerBlock: "780011", nextAction: "resume" });
});

test("unresolved outcomes have no invented ledger block or external-receipt action", () => {
  const result: WireResult = {
    withdrawal: { requestId: "0123456789abcdef0123456789abcdef", state: { outcome_unknown: null }, lastError: [] },
    attempt: [{ state: { outcome_unknown: null }, hadUnknown: true, block: [] }],
    active: false, nextAction: { review_required: null },
  };
  expect(operationView(result)).toMatchObject({ state: "pending", nextAction: "none" });
  expect(operationView(result).ledgerBlock).toBeUndefined();
});
