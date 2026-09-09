import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionCard, actionExplanation, actionPresentation, actionTitle, canContinueSavedAction, newestSavedAction, retainedPool, savedActionInput, unusedPoolGuidance, type SavedAction } from "../src/activity.tsx";
import type { ActionProgress } from "../src/action_client.ts";
import { liquiditySettlementGuidance } from "../src/action_receipt.ts";
const input = { kind: "mint", pool: "mohjv-bqaaa-aaaag-qjyia-cai", amount0: "1000000", amount1: "2500000", tickLower: -60, tickUpper: 60 };
const record = (owner = { appId: "icpswap", rootMode: false }) => ({ input_json: JSON.stringify({ version: 1, kind: "liquidity", owner, input }), state: "funding_requested" });
describe("durable liquidity activity", () => {
  test("finds pool references and action kind inside the saved intent envelope", () => {
    expect(retainedPool(record())).toBe(input.pool);
    expect(actionTitle(record())).toBe("New liquidity position");
    expect(savedActionInput(record())).toEqual(input);
  });
  test("preserves flat historical inputs and does not invent references for unreadable records", () => {
    expect(retainedPool({ input_json: JSON.stringify(input) })).toBe(input.pool);
    expect(retainedPool({ input_json: "{}" })).toBeNull();
    expect(retainedPool({ input_json: "not JSON" })).toBeNull();
  });
  test("shows Continue only for this app's human funding namespace", () => {
    expect(canContinueSavedAction(record())).toBe(true);
    expect(canContinueSavedAction(record({ appId: "agent", rootMode: true }))).toBe(false);
    expect(canContinueSavedAction(record({ appId: "agent", rootMode: false }))).toBe(false);
    expect(canContinueSavedAction(record({ appId: "icpswap", rootMode: true }))).toBe(false);
    expect(canContinueSavedAction({ ...record(), state: "uncertain" })).toBe(false);
    expect(canContinueSavedAction({ ...record(), state: "complete" })).toBe(false);
  });
  test("explains unverified payout without claiming failure or wallet settlement", () => {
    expect(actionExplanation("settlement_pending", "Empty queues")).toBe("The pool completed this action. Payment to your Wallet has not been verified yet. Check status to review the saved result.");
    expect(actionExplanation("uncertain", "Reply lost")).toContain("without sending another payment");
    expect(actionExplanation("complete", "No payout scheduled: zero claim.")).toBe("No payout scheduled: zero claim.");
    expect(actionExplanation("stopped", "Insufficient funds")).toBe("Insufficient funds");
  });
});

test("delayed history or status cannot undo a newer saved receipt", () => {
  const previous: SavedAction = { id: "test", input_json: record().input_json, state: "complete", detail: "Protocol success retained", created_at: "100", updated_at: "200", revision: "4" };
  const stale = { ...previous, state: "execution_requested", detail: "Waiting", updated_at: "199", revision: "3" };
  expect(newestSavedAction(previous, stale)).toBe(previous);
  expect(newestSavedAction(stale, previous)).toBe(previous);
});

function claimProgress(amount1 = "0"): ActionProgress {
  const operation = {
    id: "20260909001100000000000000000003", input_json: JSON.stringify({ kind: "claim", pool: input.pool, positionId: "5097" }),
    plan_json: "", funding_json: "", result_json: "", state: "settlement_pending", detail: "Protocol effect succeeded.",
    created_at: "1788960000000000000", updated_at: "1788960000000000010", revision: "9",
    effects: [{ key: "liquidity", canister: input.pool, method: "claim", state: "succeeded", error: "",
      dispatched_at: "1788960000000000001", completed_at: "1788960000000000010", result_nat: null, result_amount0: "297", result_amount1: amount1 }],
  };
  const plan = { pool: input.pool, owner: "3rurp-vyaaa-aaaay-aacua-cai",
    request: { kind: "claim", pool: input.pool, position_id: "5097" },
    token0: { address: "ryjl3-tyaaa-aaaaa-aaaba-cai", standard: "ICRC2" }, token1: { address: "xevnm-gaaaa-aaaar-qafnq-cai", standard: "ICRC2" },
    fee0: "10000", fee1: "10000", observed_at: "1788960000000000000" };
  return { operationId: operation.id, state: operation.state, message: operation.detail, raw: { operation, plan } };
}

describe("activity guidance for retained pool credit", () => {
  test("successful 297-atom claim explains saved-fee pool credit without claiming Wallet settlement", () => {
    const progress = claimProgress(), action = progress.raw.operation as SavedAction;
    const display = actionPresentation(action, progress);
    expect(display.receipt?.settlement.payoutEstimates?.token0).toMatchObject({ status: "retained_in_pool", grossAtoms: "297", feeAtoms: "10000" });
    progress.message = liquiditySettlementGuidance(display.receipt)!;
    const rendered = renderToStaticMarkup(React.createElement(ActionCard, { action, progress }));
    expect(rendered).toContain("Payout unverified");
    expect(rendered).toContain("expected to remain as pool credit at the saved fees");
    expect(rendered).toContain("Wallet payouts remain unverified");
    expect(rendered).toContain("no Wallet payout or transfer fee debit is expected");
    expect(rendered).toContain("Check status");
    expect(rendered).not.toContain(">Continue</button>");
  });

  test("mixed payout keeps the other token payment unverified", () => {
    const progress = claimProgress("46000"), action = progress.raw.operation as SavedAction;
    const display = actionPresentation(action, progress);
    const explanation = actionExplanation(display.state, display.message, display.receipt);
    expect(explanation).toContain("Wallet payouts remain unverified");
    expect(explanation).not.toContain("no Wallet payout or transfer fee debit is expected");
  });

  test("compact history and untrusted prose cannot manufacture retained-credit evidence", () => {
    const progress = claimProgress(), action = progress.raw.operation as SavedAction;
    const compact = { ...action, effects: [] };
    expect(actionPresentation(compact).receipt).toBeNull();
    const noPlan = { ...progress, raw: { operation: action }, message: "Tokens are definitely paid." };
    const display = actionPresentation(action, noPlan);
    expect(display.receipt).toBeNull();
    expect(actionExplanation(display.state, display.message, display.receipt)).toContain("has not been verified");
  });

  test("newer uncertain journal wins over stale successful progress and old Check status evidence", () => {
    const progress = claimProgress(), action = progress.raw.operation as SavedAction;
    const newer = { ...action, revision: "10", updated_at: "1788960000000000011", state: "uncertain", detail: "Needs another status check" };
    const display = actionPresentation(newer, progress, progress);
    expect(display.state).toBe("uncertain");
    expect(display.receipt).toBeNull();
    expect(actionExplanation(display.state, display.message, display.receipt)).not.toContain("pool balance");
    const sameRevisionConflict = { ...newer, revision: "9" };
    expect(actionPresentation(sameRevisionConflict, progress).receipt).toBeNull();
  });

  test("a newer response with unknown state never receives success guidance from older evidence", () => {
    const older = claimProgress(), action = older.raw.operation as SavedAction;
    const newer: ActionProgress = { ...older, state: "uncertain", message: "Reply interrupted", raw: {
      ...older.raw, operation: { ...action, revision: "10", state: "uncertain" } } };
    const display = actionPresentation(action, newer, older);
    expect(display.state).toBe("uncertain");
    expect(display.receipt).toBeNull();
    expect(actionExplanation("uncertain", "Unknown", actionPresentation(action, older).receipt)).not.toContain("pool balance");
    expect(actionPresentation(action, { ...older, operationId: "another-action" }).receipt).toBeNull();
  });

  test("historical zero claims can normalize to complete without a journal revision change", () => {
    const progress = claimProgress(), operation = progress.raw.operation as SavedAction;
    (operation.effects as { result_amount0: string }[])[0]!.result_amount0 = "0";
    progress.state = "complete"; progress.message = "No payout scheduled: the successful claim returned zero tokens.";
    operation.state = "complete";
    for (const state of ["settlement_pending", "protocol_complete"]) {
      const historical = { ...operation, state };
      const display = actionPresentation(historical, progress);
      expect(display.state).toBe("complete");
      expect(display.receipt?.settlement.status).toBe("not_required");
      expect(actionExplanation(display.state, display.message, display.receipt)).toContain("No payout scheduled");
    }
    expect(actionPresentation({ ...operation, state: "uncertain" }, progress).state).toBe("uncertain");
    (operation.effects as { result_amount0: string }[])[0]!.result_amount0 = "297";
    expect(actionPresentation({ ...operation, state: "settlement_pending" }, progress).state).toBe("settlement_pending");
  });

  test("observed unused credit guidance accounts for reserved balances and available fee evidence", () => {
    const observation = { unused0: "297", unused1: "0", reserved0: "0", reserved1: "0", fee0: "10000", fee1: "10000" };
    expect(unusedPoolGuidance(observation)).toContain("cannot be withdrawn at the observed fee");
    expect(unusedPoolGuidance({ ...observation, unused1: "999999" })).toContain("cannot be withdrawn at the observed fee");
    expect(unusedPoolGuidance({ ...observation, unused0: "10000" })).toContain("cannot be withdrawn at the observed fee");
    expect(unusedPoolGuidance({ ...observation, unused0: "10297", reserved0: "10000" })).toContain("cannot be withdrawn at the observed fee");
    for (const changed of [{ reserved0: "297" }, { reserved0: null }, { fee0: null }, { unused0: "10001" }, { fee0: "-1" }]) {
      expect(unusedPoolGuidance({ ...observation, ...changed })).not.toContain("cannot be withdrawn");
    }
    expect(unusedPoolGuidance({ unused0: "invalid", unused1: null })).toBeNull();
    expect(unusedPoolGuidance({ ...observation, unused0: "0" })).toBeNull();
  });
});
