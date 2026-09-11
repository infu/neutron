import { expect, test } from "bun:test";
import type { JsonObject, MsgBusToolContext, SelfCallObject } from "neutron-tools/app";
import { normalizeToolDescriptor, validateToolResult } from "neutron-tools/protocol";
import {
  handleWalletRefill, handleWalletRefillContinueRoot, handleWalletRefillPresentation,
  handleWalletRefillRoot, handleWalletRefillStatus, walletRefillInputSchema,
  walletRefillOperationId, walletRefillOutputSchema, type RefillToolServices,
} from "../src/refill_tools.ts";
import { transferIdBytes } from "../src/transfers.ts";
import type { RefillSnapshot } from "../src/refill.ts";

const owner = "3rurp-vyaaa-aaaay-aacua-cai";
const requestId = "ab".repeat(16);
const input: JsonObject = { requestId, kind: "icp_topup", amountAtoms: "10000000", target: null };
const snapshot: RefillSnapshot = {
  owner, observedAt: 1, icp: { ledger: "ryjl3-tyaaa-aaaaa-aaaba-cai", symbol: "ICP", decimals: 8, balanceAtoms: "50000000", feeAtoms: "10000", error: null },
  tcycles: { ledger: "um5iw-rqaaa-aaaaq-qaaba-cai", symbol: "TCYCLES", decimals: 12, balanceAtoms: "5000000000000", feeAtoms: "100000000", error: null },
  rate: { xdrPermyriadPerIcp: "20631", timestampSeconds: "1" }, errors: [],
};
function harness() {
  const calls: string[] = [];
  let saved: Record<string, unknown> | null = null;
  let losePrepare = false;
  let loseExecute = false;
  let statusFailure = false;
  let reads = 0;
  let published = 0;
  const context = {
    audience: "agent_root", agentMode: true, caller: { appId: "agent", installationUid: "5" },
    reportProgress() {},
    kernel: {
      async querySelf(method: string, args: SelfCallObject[]) {
        expect(method).toBe("wallet_read_v1");
        const arg = args[0]!;
        if ("snapshot" in arg) { calls.push("snapshot"); return { snapshot: { owner, configured: true, ledgers: [] } }; }
        if ("refill_status" in arg) { calls.push("status"); if (statusFailure) throw new Error("RPC unavailable"); const requested = arg.refill_status as Uint8Array; const matches = saved && [...requested].join(",") === [...saved.id as Uint8Array].join(","); return { refill_status: matches ? { ok: saved } : { err: "Wallet refill was not found" } }; }
        throw new Error("Unexpected query");
      },
      async updateSelf(method: string, args: SelfCallObject[]) {
        expect(method).toBe("wallet_refill_action_v1");
        const arg = args[0]!;
        if ("prepare" in arg) {
          calls.push("prepare");
          saved = { ...(arg.prepare as SelfCallObject), created_at: "1", updated_at: "1", phase: { prepared: null }, source_block: null, mint_block: null, minted_cycles: null, forward_block: null, refund_block: null, credited_cycles: null, duplicate: false, error: null, can_continue: false };
          if (losePrepare) throw new Error("Prepare reply interrupted");
          return { ok: saved };
        }
        if ("execute" in arg) {
          calls.push("execute");
          saved = { ...saved, phase: { notify_pending: null }, source_block: "44", can_continue: true };
          if (loseExecute) throw new Error("Execute reply interrupted");
          saved = { ...saved, phase: { complete: null }, credited_cycles: "206310000000", can_continue: false };
          return { ok: saved };
        }
        if ("continue_" in arg) {
          calls.push("continue");
          saved = { ...saved, phase: { complete: null }, credited_cycles: "206310000000", can_continue: false };
          return { ok: saved };
        }
        throw new Error("Unexpected update");
      },
    },
  } as unknown as MsgBusToolContext;
  const services: RefillToolServices = { async snapshot() { reads += 1; return snapshot; }, async publish() { published += 1; } };
  return { context, calls, services, get saved() { return saved; }, get reads() { return reads; }, get published() { return published; },
    set losePrepare(value: boolean) { losePrepare = value; }, set loseExecute(value: boolean) { loseExecute = value; }, set statusFailure(value: boolean) { statusFailure = value; } };
}

test("root refill reviews direct reads, saves before debit, and returns typed delivery evidence", async () => {
  const h = harness();
  const result = await handleWalletRefillRoot(input, h.context, h.services);
  expect(result).toMatchObject({ version: 1, callerRequestId: requestId, nextAction: "none", recovery: { operationId: walletRefillOperationId(h.context, requestId), rootContinueTool: "wallet_refill_continue_root_v1" }, operation: { phase: "complete", target: owner, creditedCycles: "206310000000", sourceBlockIndex: "44" } });
  expect(h.calls).toEqual(["snapshot", "status", "status", "prepare", "execute"]);
  expect(h.reads).toBe(1); expect(h.published).toBe(1);
  expect(h.saved?.id).toEqual(transferIdBytes(walletRefillOperationId(h.context, requestId)));
  const descriptor = normalizeToolDescriptor({ name: "wallet_refill_root_v1", inputSchema: walletRefillInputSchema, outputSchema: walletRefillOutputSchema });
  expect(() => validateToolResult(descriptor, result)).not.toThrow();
  h.calls.length = 0;
  await handleWalletRefillRoot(input, h.context, h.services);
  expect(h.calls).toEqual(["snapshot", "status", "status"]);
  expect(h.reads).toBe(1);
  await expect(handleWalletRefillRoot({ ...input, amountAtoms: "20000000" }, h.context, h.services)).rejects.toThrow("another refill");
});

test("normal mode opens one provider review and rejection cannot prepare or debit", async () => {
  const h = harness();
  let presented: unknown;
  const result = await handleWalletRefill(input, { ...h.context, audience: "app", presentUserInterface: async (value: unknown) => { presented = value; return { ok: true }; } } as unknown as MsgBusToolContext);
  expect(result).toEqual({ ok: true }); expect(h.calls).toEqual([]);
  expect(presented).toEqual({ tileId: "wallet", tool: "wallet_refill_present_v1", arguments: input });
  await expect(handleWalletRefillPresentation(input, { ...h.context, audience: "foreground_tile" } as MsgBusToolContext, async () => false, h.services)).rejects.toThrow("canceled before payment");
  expect(h.saved).toBeNull(); expect(h.calls).toEqual(["snapshot", "status", "status"]);
  await expect(handleWalletRefillRoot(input, { ...h.context, audience: undefined } as unknown as MsgBusToolContext, h.services)).rejects.toThrow("root-agent attestation");
});

test("lost preparation reply exposes the same retained request without sending money", async () => {
  const h = harness(); h.losePrepare = true;
  const result = await handleWalletRefillRoot(input, h.context, h.services);
  expect(result).toMatchObject({ operation: { phase: "prepared" }, nextAction: "continue_same_request" });
  expect(result.message).toContain("Prepare reply interrupted");
  expect(h.calls).toEqual(["snapshot", "status", "status", "prepare", "status"]);
  const recovery = result.recovery as JsonObject;
  expect(result.callerRequestId).toBe(requestId);
  expect(recovery.operationId).not.toBe(requestId);
  h.calls.length = 0;
  const recovered = await handleWalletRefillContinueRoot({ requestId: recovery.operationId! }, h.context, h.services);
  expect(recovered).toMatchObject({ operation: { phase: "complete" } });
  expect(h.calls).toEqual(["status", "execute"]);
});

test("lost transfer reply continues CMC notification on the same block and never funds again", async () => {
  const h = harness(); h.loseExecute = true;
  const result = await handleWalletRefillRoot(input, h.context, h.services);
  expect(result).toMatchObject({ operation: { phase: "notify_pending", sourceBlockIndex: "44" }, nextAction: "continue_same_request" });
  h.calls.length = 0;
  await handleWalletRefillRoot(input, h.context, h.services);
  expect(h.calls).toEqual(["snapshot", "status", "status", "continue"]);
  expect(h.reads).toBe(1);
  h.calls.length = 0;
  const status = await handleWalletRefillStatus({ requestId: walletRefillOperationId(h.context, requestId) }, h.context);
  expect(status).toMatchObject({ result: { operation: { phase: "complete" } } });
  expect(h.calls).toEqual(["status"]);
});

test("unavailable status does not become a fresh request; callers cannot collide across installs", async () => {
  const h = harness(); h.statusFailure = true;
  await expect(handleWalletRefillRoot(input, h.context, h.services)).rejects.toThrow("RPC unavailable");
  expect(h.saved).toBeNull(); expect(h.reads).toBe(0);
  const other = { ...h.context, caller: { ...h.context.caller, installationUid: "6" } } as unknown as MsgBusToolContext;
  expect(walletRefillOperationId(h.context, requestId)).not.toBe(walletRefillOperationId(other, requestId));
});


test("replaying the returned durable ID through root or normal creation cannot create another debit", async () => {
  const h = harness();
  const initial = await handleWalletRefillRoot(input, h.context, h.services);
  const durableId = (initial.recovery as JsonObject).operationId!;
  const returnedInput = { ...input, requestId: durableId };
  h.calls.length = 0;
  const root = await handleWalletRefillRoot(returnedInput, h.context, h.services);
  expect(root).toMatchObject({ operation: { requestId: durableId, phase: "complete" } });
  expect(h.calls).toEqual(["snapshot", "status"]);
  h.calls.length = 0;
  let approvals = 0;
  const normal = await handleWalletRefillPresentation(returnedInput, { ...h.context, audience: "foreground_tile" } as MsgBusToolContext, async () => { approvals += 1; return true; }, h.services);
  expect(normal).toMatchObject({ operation: { requestId: durableId, phase: "complete" } });
  expect(approvals).toBe(0);
  expect(h.calls).toEqual(["snapshot", "status"]);
  await expect(handleWalletRefillRoot({ ...returnedInput, amountAtoms: "20000000" }, h.context, h.services)).rejects.toThrow("another refill");
});
