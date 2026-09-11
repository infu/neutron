import { afterEach, beforeEach, expect, test } from "bun:test";
import { oneTimeCycleCallForEndpoint, type OwnerCycleTransport } from "../src/backend_calls/one_time_cycles.ts";
import { registerFrameContext, getRegisteredEndpoint, type RegisteredEndpoint } from "../src/frame_context.ts";
import { useAppsStore } from "../src/reducer/apps.ts";
import { useBackendCallConsentStore, approveBackendCallRequest, rejectBackendCallRequest } from "../src/reducer/backend_calls.ts";
import { resetUiAttentionState } from "../src/ui_attention/owner.ts";
import { registryApp } from "./app_registry_fixture.ts";

const request = { requestId: "11".repeat(16), canister: "um5iw-rqaaa-aaaaq-qaaba-cai", method: "deposit", argsHex: "4449444c0000", cyclesAtoms: "50000000000000", allowPartial: true };
const scope = { appId: "wallet", installationUid: "77" };
let endpoint: RegisteredEndpoint;
let unregister: () => void;
let executions: any[];
let stored: any = null;
let transport: OwnerCycleTransport;
const quote = { ok: { balance: 55_000_000_000_000n, call_cost: 1_000_000n, min_remaining_cycles: 5_000_000_000_000n, max_cycles: 49_999_999_000_000n, actual_cycles: 49_999_999_000_000n, max_cycles_per_call: 0n, max_cycles_per_day: 0n } };

beforeEach(() => {
  const app = registryApp({ id: "wallet", name: "Wallet", capabilities: { backend_calls: { api: 1, description: "Ledgers", reservation_scopes: ["principal"], max_concurrency: 20, max_cycles_per_call: 0, max_cycles_per_day: 0 } } });
  useAppsStore.setState({ list: { wallet: app }, appInstances: { wallet: { scope, version: 326, deploymentId: "test-deployment", capabilityPlanFingerprint: app.capability_plan_fingerprint, browserOriginNonce: "0".repeat(32), browserOriginAuthorityEpoch: "1", residentFrameSecurity: "credentialless_opaque_v1" } } });
  unregister = registerFrameContext({} as Window, { role: "background", appId: "wallet" }, { appScope: scope, origin: "null" });
  endpoint = getRegisteredEndpoint("app:wallet:background")!;
  executions = []; stored = null;
  transport = {
    quote: async () => quote,
    status: async () => stored ? [stored] : [],
    list: async () => ({ calls: [], next_before: [] }),
    execute: async (input: any) => { executions.push(input); stored = { request: input, sequence: 1n, created_at: 10n, updated_at: 11n, dispatched: true, actual_cycles: 49_999_999_000_000n, result: [{ ok: Uint8Array.of(1, 2) }], charged_cycles: [49_999_999_000_000n] }; return { ok: stored }; },
  };
});
afterEach(() => {
  unregister();
  for (const item of Object.values(useBackendCallConsentStore.getState().requests)) rejectBackendCallRequest(item.id);
  useAppsStore.setState({ list: {}, appInstances: {} });
  resetUiAttentionState();
});
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const pending = () => Object.values(useBackendCallConsentStore.getState().requests)[0]!;

test("background requests require exact owner review even when the recurring cycle budget is zero", async () => {
  const operation = oneTimeCycleCallForEndpoint("request", { ...request }, endpoint, undefined, transport);
  await tick();
  expect(executions).toHaveLength(0);
  expect(pending().actions).toEqual([]);
  expect(pending().oneTimeCycleCall?.usualLimitPerCallAtoms).toBe("0");
  expect(pending().oneTimeCycleCall?.remainingCyclesAtoms).toBe("5000000000000");
  approveBackendCallRequest(pending().id);
  const result: any = await operation;
  expect(executions).toHaveLength(1);
  expect(executions[0].app_scope).toEqual({ app_id: "wallet", installation_uid: 77n });
  expect(result.result).toEqual({ replyHex: "0102" });
});

test("declining a one-time spend cannot dispatch or save a permission", async () => {
  const operation = oneTimeCycleCallForEndpoint("request", { ...request }, endpoint, undefined, transport);
  await tick(); rejectBackendCallRequest(pending().id);
  await expect(operation).rejects.toMatchObject({ code: "ONE_TIME_CYCLE_CALL_CANCELLED" });
  expect(executions).toEqual([]); expect(stored).toBeNull();
});

test("review retains immutable bytes, cap, destination, and mode from the original request", async () => {
  const payload = { ...request };
  const operation = oneTimeCycleCallForEndpoint("request", payload, endpoint, undefined, transport);
  await tick();
  payload.cyclesAtoms = "999999999999999"; payload.argsHex = "4449444c0001"; payload.allowPartial = false; payload.canister = "ryjl3-tyaaa-aaaaa-aaaba-cai";
  expect(Object.isFrozen(pending().oneTimeCycleCall)).toBe(true);
  expect(pending().oneTimeCycleCall?.cyclesAtoms).toBe(request.cyclesAtoms);
  approveBackendCallRequest(pending().id); await operation;
  expect(executions[0].call.cycles).toBe(50_000_000_000_000n);
  expect(executions[0].call.args).toEqual(Uint8Array.of(68, 73, 68, 76, 0, 0));
  expect(executions[0].allow_partial).toBe(true);
  expect(executions[0].call.canister.toText()).toBe(request.canister);
});

test("scope spoofing and endpoint replacement cannot reach owner execution", async () => {
  await expect(oneTimeCycleCallForEndpoint("request", { ...request, app_scope: { app_id: "other" } }, endpoint, undefined, transport)).rejects.toThrow("Unexpected");
  const operation = oneTimeCycleCallForEndpoint("request", { ...request }, endpoint, undefined, transport);
  await tick(); unregister();
  await expect(operation).rejects.toThrow("closed or reloaded");
  expect(executions).toHaveLength(0);
});

test("caller cancellation removes pending review without dispatch", async () => {
  const controller = new AbortController();
  const operation = oneTimeCycleCallForEndpoint("request", { ...request }, endpoint, controller.signal, transport);
  await tick(); controller.abort();
  await expect(operation).rejects.toMatchObject({ code: "ONE_TIME_CYCLE_CALL_CANCELLED" });
  expect(executions).toHaveLength(0);
});

test("lost response recovery returns the saved unknown outcome without another owner prompt or call", async () => {
  const operation = oneTimeCycleCallForEndpoint("request", { ...request }, endpoint, undefined, transport);
  await tick(); approveBackendCallRequest(pending().id); await operation;
  stored.result = []; stored.charged_cycles = [];
  const result: any = await oneTimeCycleCallForEndpoint("request", { ...request }, endpoint, undefined, transport);
  expect(result.dispatched).toBe(true); expect(result.result).toBeNull();
  expect(executions).toHaveLength(1); expect(pending()).toBeUndefined();
  await expect(oneTimeCycleCallForEndpoint("request", { ...request, cyclesAtoms: "2" }, endpoint, undefined, transport)).rejects.toThrow("different cycle call");
});

test("zero quote is read-only and pagination scope comes from the current endpoint", async () => {
  const result: any = await oneTimeCycleCallForEndpoint("quote", { ...request, cyclesAtoms: "0" }, endpoint, undefined, transport);
  expect(result.requestedCyclesAtoms).toBe("0"); expect(executions).toHaveLength(0); expect(pending()).toBeUndefined();
  let received: any;
  transport.list = async (value) => { received = value; return { calls: [], next_before: [2n] }; };
  const page: any = await oneTimeCycleCallForEndpoint("list", { before: "10", limit: 3 }, endpoint, undefined, transport);
  expect(received).toEqual({ app_scope: { app_id: "wallet", installation_uid: 77n }, before: [10n], limit: 3n });
  expect(page.nextBefore).toBe("2");
});

test("an exact amount above the safe maximum is rejected before opening consent", async () => {
  transport.quote = async () => ({ ok: { ...quote.ok, actual_cycles: 50_000_000_000_000n } });
  await expect(oneTimeCycleCallForEndpoint("request", { ...request, allowPartial: false }, endpoint, undefined, transport)).rejects.toMatchObject({ code: "ONE_TIME_CYCLE_CALL_NOT_DISPATCHED", message: expect.stringContaining("required Neutron reserve") });
  expect(pending()).toBeUndefined(); expect(executions).toHaveLength(0);
});

test("runtime rejects odd hexadecimal argument bytes before quoting or review", async () => {
  let quotes = 0;
  transport.quote = async () => { quotes += 1; return quote; };
  await expect(oneTimeCycleCallForEndpoint("quote", { ...request, argsHex: "4449444c0" }, endpoint, undefined, transport)).rejects.toThrow("hexadecimal bytes");
  expect(quotes).toBe(0); expect(pending()).toBeUndefined();
});

test("a failed initial status read cannot be classified as a safe new attempt", async () => {
  transport.status = async () => { throw new Error("Status connection interrupted"); };
  await expect(oneTimeCycleCallForEndpoint("request", { ...request }, endpoint, undefined, transport)).rejects.toMatchObject({ message: "Status connection interrupted" });
  expect(executions).toHaveLength(0); expect(pending()).toBeUndefined();
});

test("quote failure carries trusted pre-dispatch evidence through error serialization", async () => {
  transport.quote = async () => { throw new Error("Permission changed before review"); };
  let observed: unknown;
  try { await oneTimeCycleCallForEndpoint("request", { ...request }, endpoint, undefined, transport); } catch (error) { observed = error; }
  const { serializeBoundedError, toError } = await import("neutron-tools/protocol");
  expect(toError(serializeBoundedError(observed))).toMatchObject({ code: "ONE_TIME_CYCLE_CALL_NOT_DISPATCHED", message: "Permission changed before review" });
  expect(executions).toHaveLength(0);
});

test("execution interruption and cancellation after execution started remain uncertain", async () => {
  const controller = new AbortController();
  transport.execute = async (input) => { executions.push(input); controller.abort(); throw new Error("Execution reply lost"); };
  const operation = oneTimeCycleCallForEndpoint("request", { ...request }, endpoint, controller.signal, transport);
  await tick(); approveBackendCallRequest(pending().id);
  await expect(operation).rejects.toMatchObject({ message: "Execution reply lost" });
  expect(executions).toHaveLength(1);
});
