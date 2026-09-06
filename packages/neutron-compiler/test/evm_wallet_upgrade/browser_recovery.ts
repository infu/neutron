import { expect } from "bun:test";
import { IDL } from "@dfinity/candid";
import type { Principal } from "@dfinity/principal";
import type { DirectPocketIcCalls } from "../legacy_kernel_upgrade.pocketic.test.ts";
import { upgradeCapabilityPageMethod, type Capability } from "./existing_apps.ts";
import { evmUpgradeMethods, type CallApp, type FixtureCaller } from "./new_apps.ts";
import { signedRpcPrincipal } from "./evm_signed_pending.ts";

const identityType = IDL.Record({
  caller: IDL.Record({ app_id: IDL.Text, installation_uid: IDL.Nat64, endpoint: IDL.Text }),
  request_id: IDL.Text,
});
const identityRequest = IDL.Record({ identity: identityType });
const operationResult = evmUpgradeMethods.execute.retTypes[0]!;
const optionalText = IDL.Opt(IDL.Text);
const observation = IDL.Record({
  block_number: IDL.Text, balance: IDL.Text, pending_nonce: IDL.Text, mined_nonce: IDL.Text,
  gas_price: IDL.Text, max_priority_fee_per_gas: IDL.Text, base_fee_per_gas: IDL.Text,
});
const browserMethods = {
  operation: IDL.Func([identityRequest], [operationResult], ["query"]),
  submission: IDL.Func([identityRequest], [IDL.Variant({
    ok: IDL.Record({ chain_id: IDL.Nat, transaction_hash: IDL.Text, raw_transaction: IDL.Text }), err: IDL.Text,
  })], ["query"]),
  prepare: IDL.Func([IDL.Record({ request: evmUpgradeMethods.prepare.argTypes[0]!, observation })], [operationResult], []),
  finish: IDL.Func([IDL.Record({
    identity: identityType, review_revision: IDL.Nat, balance: IDL.Text,
    pending_nonce: IDL.Text, mined_nonce: IDL.Text,
    gas_estimate: IDL.Text, gas_limit: IDL.Text, simulation: IDL.Text,
  })], [operationResult], []),
  observe: IDL.Func([IDL.Record({
    identity: identityType, transaction_hash: IDL.Text, transaction_json: IDL.Text,
    receipt_json: optionalText, canonical_block_json: optionalText,
    safe_block_json: optionalText, finalized_block_json: optionalText, broadcast_error: optionalText,
  })], [operationResult], []),
};
const captureMethod = IDL.Func([], [IDL.Record({ broadcasts: IDL.Vec(IDL.Text), reads: IDL.Vec(IDL.Text) })], ["query"]);
const tokenObservation = IDL.Record({ value: optionalText, error: optionalText });
const tokenEvidence = IDL.Record({
  chain_id: IDL.Nat, contract: IDL.Text, method: IDL.Text, owner: IDL.Text,
  spender: optionalText, recipient: optionalText, amount: IDL.Text, recognition: IDL.Text,
  block_number: optionalText, block_hash: optionalText, block_error: optionalText,
  observed_at: IDL.Int, balance: tokenObservation, allowance: IDL.Opt(tokenObservation),
});
const evidenceMethod = IDL.Func([IDL.Record({ identity: identityType, review_revision: IDL.Nat, refresh: IDL.Bool })], [IDL.Variant({
  ok: IDL.Record({ token_evidence: IDL.Opt(tokenEvidence) }), err: IDL.Text,
})], []);
type Identity = { caller: FixtureCaller; request_id: string };
type Operation = Record<string, unknown> & {
  operation_id: bigint; review_revision: bigint; status: string; address: string;
  signature: string[]; transaction_hash: string[]; finality: string[];
  prepared_transaction: Array<Record<string, unknown> & { nonce: string }>;
};
function ok<T = Record<string, unknown>>(value: unknown): T {
  expect(value).toHaveProperty("ok");
  expect(value).not.toHaveProperty("err");
  return (value as { ok: T }).ok;
}

/** Seed an actual nonempty released evidence root through EVM107's public API.
 * Scripted token reads may be unavailable; those recorded errors are durable
 * observations too and must not disappear when browser RPC replaces outcalls. */
export async function seedReleasedTokenEvidence(callApp: CallApp, caller: FixtureCaller): Promise<() => Promise<void>> {
  const identity = { caller, request_id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" };
  const prepared = ok<Operation>(await callApp("evm_wallet", "evm_wallet_prepare_v1", evmUpgradeMethods.prepare, [{
    identity, intent: {
      account_id: "main", chain_id: 1n, operation: { transaction: {
        to: "0x3333333333333333333333333333333333333333", value: "0",
        data: "0x095ea7b3" + "0000000000000000000000004444444444444444444444444444444444444444" + "0000000000000000000000000000000000000000000000000000000000000007",
        gas_limit: [], max_fee_per_gas: ["100"], max_priority_fee_per_gas: ["2"],
        gas_price: [], transaction_type: ["eip1559"], access_list: [],
      } },
    },
  }]));
  expect(prepared.status).toBe("prepared");
  const request = { identity, review_revision: prepared.review_revision, refresh: true };
  const saved = ok<{ token_evidence: Array<Record<string, unknown>> }>(await callApp("evm_wallet", "evm_wallet_review_evidence_v1", evidenceMethod, [request]));
  expect(saved.token_evidence).toHaveLength(1);
  expect(saved.token_evidence[0]).toMatchObject({ chain_id: 1n, method: "approve", amount: "7", recognition: "erc20_calldata" });
  // EVM107 increments the approval revision and timestamp when refreshing
  // evidence. Preserve the committed post-refresh operation, not its old review.
  const savedOperation = ok<Operation>(await callApp("evm_wallet", "evm_wallet_status_v1", evmUpgradeMethods.status, [{ identity, refresh: false }]));
  expect(savedOperation.review_revision).toBe(prepared.review_revision + 1n);
  return async () => {
    expect(ok<typeof saved>(await callApp("evm_wallet", "evm_wallet_review_evidence_v1", evidenceMethod, [{ identity, review_revision: savedOperation.review_revision, refresh: false }]))).toEqual(saved);
    expect(ok<Operation>(await callApp("evm_wallet", "evm_wallet_status_v1", evmUpgradeMethods.status, [{ identity, refresh: false }]))).toEqual(savedOperation);
  };
}

/** Capture after the released backend has signed and lost its submission reply.
 * Recovery below exercises the new public browser-observation protocol directly,
 * not a browser UI or acceptance by an external Ethereum node. */
export async function captureBrowserRecovery(options: {
  callApp: CallApp; direct: DirectPocketIcCalls; canister: Principal; owner: Principal;
  signedEvidence: Record<string, unknown>;
}): Promise<() => Promise<Record<string, unknown>>> {
  const { callApp, direct, canister, owner, signedEvidence } = options;
  const originalIdentity = signedEvidence.identity as Identity;
  const identity = { ...originalIdentity, caller: { ...originalIdentity.caller, endpoint: "app:kitchensink:browser-after-upgrade" } };
  const raw = String(signedEvidence.raw), hash = String(signedEvidence.hash);
  const signed = ok<Operation>(await callApp("evm_wallet", "evm_wallet_status_v1", evmUpgradeMethods.status, [{ identity: originalIdentity, refresh: false }]));
  const snapshot = await callApp("evm_wallet", "evm_wallet_snapshot_v1", evmUpgradeMethods.snapshot, [null]);
  const history = await callApp("evm_wallet", "evm_wallet_history_v1", evmUpgradeMethods.history, [{ offset: 0n, limit: 20n }]);
  const capture = async () => await direct.actorCall(signedRpcPrincipal, owner, "capture", captureMethod, []) as { reads: string[]; broadcasts: string[] };
  const rpcBefore = await capture();
  const custody = async (): Promise<Capability> => {
    const entries: Capability[] = [];
    let after: [] | [string] = [];
    do {
      const page = await direct.actorCall(canister, owner, "kernel_capabilities_page", upgradeCapabilityPageMethod, [{ after, limit: 100n }]) as { entries: Capability[]; next: [] | [string] };
      entries.push(...page.entries); after = page.next;
    } while (after.length);
    const matches = entries.filter(row => row.scope.app_id === "evm_wallet" && "wallet_custody_signing" in row.kind);
    expect(matches).toHaveLength(1);
    return matches[0]!;
  };
  const signingBefore = await custody();
  return async () => {
    expect(await callApp("evm_wallet", "evm_wallet_snapshot_v1", evmUpgradeMethods.snapshot, [null])).toEqual(snapshot);
    expect(await callApp("evm_wallet", "evm_wallet_history_v1", evmUpgradeMethods.history, [{ offset: 0n, limit: 20n }])).toEqual(history);
    expect(ok<Operation>(await callApp("evm_wallet", "evm_wallet_operation_v1", browserMethods.operation, [{ identity }]))).toEqual(signed);
    expect(ok<Operation>(await callApp("evm_wallet", "evm_wallet_execute_v1", evmUpgradeMethods.execute, [{ identity, review_revision: signed.review_revision }]))).toEqual(signed);
    expect(await custody()).toEqual(signingBefore);
    expect(ok<Record<string, unknown>>(await callApp("evm_wallet", "evm_wallet_submission_v1", browserMethods.submission, [{ identity }]))).toEqual({ chain_id: 1n, transaction_hash: hash, raw_transaction: raw });
    // The legacy status API must no longer dispatch replicated RPC requests.
    expect(ok<Operation>(await callApp("evm_wallet", "evm_wallet_status_v1", evmUpgradeMethods.status, [{ identity, refresh: true }]))).toEqual(signed);
    expect(await capture()).toEqual(rpcBefore);

    const observe = (transaction: unknown, receipt?: unknown, block?: unknown, finalized?: unknown) => callApp("evm_wallet", "evm_wallet_observe_browser_v1", browserMethods.observe, [{
      identity, transaction_hash: hash, transaction_json: JSON.stringify(transaction),
      receipt_json: receipt === undefined ? [] : [JSON.stringify(receipt)],
      canonical_block_json: block === undefined ? [] : [JSON.stringify(block)],
      safe_block_json: [], finalized_block_json: finalized === undefined ? [] : [JSON.stringify(finalized)], broadcast_error: [],
    }]);
    const unknown = ok<Operation>(await observe(null));
    expect(unknown.status).toBe("unknown");
    expect(unknown.transaction_hash).toEqual([hash]);
    const submission = ok(await callApp("evm_wallet", "evm_wallet_submission_v1", browserMethods.submission, [{ identity }]));
    expect(submission).toEqual({ chain_id: 1n, transaction_hash: hash, raw_transaction: raw });

    const transaction = { hash, from: signed.address, to: "0x0000000000000000000000000000000000000002", chainId: "0x1", nonce: "0x9", value: "0x12d687", gas: "0x5208", input: "0x" };
    const submitted = ok<Operation>(await observe(transaction));
    expect(submitted.status).toBe("submitted");
    expect(submitted.signature).toEqual(signed.signature);
    const bad = await observe({ ...transaction, nonce: "0xa" });
    expect(bad).toHaveProperty("err");
    expect(ok<Operation>(await callApp("evm_wallet", "evm_wallet_operation_v1", browserMethods.operation, [{ identity }]))).toEqual(submitted);

    const blockHash = "0x" + "ab".repeat(32);
    const block = { number: "0x64", hash: blockHash };
    const receipt = { transactionHash: hash, blockNumber: "0x64", blockHash, status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x64", logs: [] };
    const confirmed = ok<Operation>(await observe(transaction, receipt, block, block));
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.finality).toEqual(["finalized"]);
    expect(confirmed.signature).toEqual(signed.signature);
    expect(confirmed.transaction_hash).toEqual([hash]);
    expect(confirmed.prepared_transaction).toEqual(signed.prepared_transaction);
    expect(await callApp("evm_wallet", "evm_wallet_submission_v1", browserMethods.submission, [{ identity }])).toHaveProperty("err");

    // Stale provider nonce9 must not overwrite the released reservation at9.
    const nextIdentity = { ...identity, request_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
    const next = ok<Operation>(await callApp("evm_wallet", "evm_wallet_prepare_browser_v1", browserMethods.prepare, [{
      request: { identity: nextIdentity, intent: signed.intent },
      observation: { block_number: "0x64", balance: "1000000000000000000", pending_nonce: "9", mined_nonce: "9", gas_price: "100", max_priority_fee_per_gas: "2", base_fee_per_gas: "49" },
    }]));
    expect(next.status).toBe("preparing");
    expect(next.prepared_transaction[0]?.nonce).toBe("10");
    const prepared = ok<Operation>(await callApp("evm_wallet", "evm_wallet_finish_prepare_browser_v1", browserMethods.finish, [{
      identity: nextIdentity, review_revision: next.review_revision, balance: "1000000000000000000",
      pending_nonce: "9", mined_nonce: "9", gas_estimate: "21000", gas_limit: "21000", simulation: "0x",
    }]));
    expect(prepared.status).toBe("prepared");
    expect(prepared.prepared_transaction[0]?.nonce).toBe("10");
    expect(prepared.signature).toEqual([]);
    expect(prepared.transaction_hash).toEqual([]);
    expect(await capture()).toEqual(rpcBefore);
    expect(await custody()).toEqual(signingBefore);
    return {
      scope: "Public browser preparation/submission/observation APIs via actual Candid calls; no browser UI or external-chain acceptance claim",
      recovery_identity: identity, retained_raw: raw, retained_hash: hash,
      reconciled_status: confirmed.status, receipt: confirmed.receipt_json,
      next_unsigned_nonce: prepared.prepared_transaction[0]!.nonce,
      signing_capability_before: signingBefore, signing_capability_after: await custody(),
      legacy_rpc_before: rpcBefore, legacy_rpc_after: await capture(),
      additional_replicated_rpc_calls: 0, additional_signatures: 0,
    };
  };
}
