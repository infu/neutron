import { describe, expect, test } from "bun:test";
import { actionTitle, canContinueSavedAction, newestSavedAction, retainedPool, savedActionInput, type SavedAction } from "../src/activity.tsx";
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
});

test("delayed history or status cannot undo a newer saved receipt", () => {
  const previous: SavedAction = { id: "test", input_json: record().input_json, state: "complete", detail: "Protocol success retained", created_at: "100", updated_at: "200", revision: "4" };
  const stale = { ...previous, state: "execution_requested", detail: "Waiting", updated_at: "199", revision: "3" };
  expect(newestSavedAction(previous, stale)).toBe(previous);
  expect(newestSavedAction(stale, previous)).toBe(previous);
});
