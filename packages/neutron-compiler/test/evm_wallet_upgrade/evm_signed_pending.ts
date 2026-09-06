import { expect } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { getAddress, keccak256, Transaction } from "ethers";
import type { DirectPocketIcCalls } from "../legacy_kernel_upgrade.pocketic.test.ts";
import { upgradeCapabilityPageMethod, type Capability } from "./existing_apps.ts";
import { evmUpgradeMethods, type CallApp, type FixtureCaller } from "./new_apps.ts";

export const signedRpcPrincipal = Principal.fromText("7hfb6-caaaa-aaaar-qadga-cai");
const captureMethod = IDL.Func([], [IDL.Record({ broadcasts: IDL.Vec(IDL.Text), reads: IDL.Vec(IDL.Text) })], ["query"]);
const configureMethod = IDL.Func([IDL.Variant({ uncertain: IDL.Null, accepted: IDL.Null, included: IDL.Null }), IDL.Text], [], []);
type Capture = { broadcasts: string[]; reads: string[] };
type Operation = Record<string, unknown> & {
  operation_id: bigint;
  review_revision: bigint;
  address: string;
  status: string;
  signature: [] | [string];
  transaction_hash: [] | [string];
  prepared_transaction: [] | [Record<string, unknown> & { nonce: string }];
};

function ok<T>(value: unknown): T {
  expect(value).toHaveProperty("ok");
  expect(value).not.toHaveProperty("err");
  return (value as { ok: T }).ok;
}

async function custodyCapability(direct: DirectPocketIcCalls, canister: Principal, owner: Principal): Promise<Capability> {
  const entries: Capability[] = [];
  let after: [] | [string] = [];
  do {
    const page = await direct.actorCall(canister, owner, "kernel_capabilities_page", upgradeCapabilityPageMethod, [{ after, limit: 100n }]) as { entries: Capability[]; next: [] | [string] };
    entries.push(...page.entries);
    after = page.next;
  } while (after.length !== 0);
  const candidates = entries.filter((row) => row.scope.app_id === "evm_wallet" && "wallet_custody_signing" in row.kind);
  expect(candidates).toHaveLength(1);
  return candidates[0]!;
}

/**
 * A reusable real-custody fixture for checked actor upgrades. Only the remote
 * RPC observations are scripted. The exact archive's backend prepares, signs,
 * serializes and journals the transaction through its real Kernel capability.
 * Ethers independently parses/reconstructs the signature, hash and signer.
 */
export async function seedSignedPending(options: {
  callApp: CallApp;
  direct: DirectPocketIcCalls;
  canister: Principal;
  owner: Principal;
  caller: FixtureCaller;
}): Promise<{
  evidence: Record<string, unknown>;
  assertRestoredAndReconcile(): Promise<void>;
}> {
  const { callApp, direct, canister, owner, caller } = options;
  const capture = async () => await direct.actorCall(signedRpcPrincipal, owner, "capture", captureMethod, []) as Capture;
  const configure = async (mode: "uncertain" | "accepted" | "included", hash: string) => {
    await direct.actorCall(signedRpcPrincipal, owner, "configure", configureMethod, [{ [mode]: null }, hash]);
  };
  const identity = { caller, request_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  const recoveredIdentity = { ...identity, caller: { ...caller, endpoint: "app:kitchensink:replacement-after-upgrade" } };
  const intent = {
    account_id: "main",
    chain_id: 1n,
    operation: { transaction: {
      to: "0x0000000000000000000000000000000000000002", value: "1234567", data: "0x",
      gas_limit: [] as string[], max_fee_per_gas: ["100"], max_priority_fee_per_gas: ["2"],
      gas_price: [] as string[], transaction_type: ["eip1559"], access_list: [],
    } },
  };
  const prepared = ok<Operation>(await callApp("evm_wallet", "evm_wallet_prepare_v1", evmUpgradeMethods.prepare, [{ identity, intent }]));
  expect(prepared.status).toBe("prepared");
  expect(prepared.prepared_transaction[0]).toMatchObject({ nonce: "9", gas_limit: "21000", transaction_type: "eip1559", value: "1234567" });
  const beforeSigning = await custodyCapability(direct, canister, owner);
  const signed = ok<Operation>(await callApp("evm_wallet", "evm_wallet_execute_v1", evmUpgradeMethods.execute, [{ identity, review_revision: prepared.review_revision }]));
  expect(signed.status).toBe("unknown");
  expect(signed.signature).toHaveLength(1);
  expect(signed.transaction_hash).toHaveLength(1);
  const firstCapture = await capture();
  expect(firstCapture.broadcasts).toHaveLength(1);
  const raw = firstCapture.broadcasts[0]!;
  const parsed = Transaction.from(raw);
  const hash = keccak256(raw);
  expect(parsed.serialized).toBe(raw);
  expect(parsed.hash).toBe(hash);
  expect(signed.transaction_hash).toEqual([hash]);
  expect(parsed.chainId).toBe(1n);
  expect(parsed.nonce).toBe(9);
  expect(parsed.type).toBe(2);
  expect(parsed.value).toBe(1234567n);
  expect(parsed.gasLimit).toBe(21000n);
  expect(parsed.maxFeePerGas).toBe(100n);
  expect(parsed.maxPriorityFeePerGas).toBe(2n);
  expect(parsed.to?.toLowerCase()).toBe(intent.operation.transaction.to);
  expect(parsed.data).toBe("0x");
  expect(parsed.accessList).toEqual([]);
  expect(parsed.from).toBe(getAddress(signed.address));
  expect(parsed.signature!.serialized.toLowerCase()).toBe(signed.signature[0]!.toLowerCase());
  const signedCapability = await custodyCapability(direct, canister, owner);
  expect(signedCapability.usage.total).toBe(beforeSigning.usage.total! + 1n);
  expect(signedCapability.usage.succeeded).toBe(beforeSigning.usage.succeeded! + 1n);
  for (const field of ["denied", "failed", "rate_limited", "busy", "revoked"]) expect(signedCapability.usage[field]).toBe(beforeSigning.usage[field]);
  const snapshotBefore = await callApp("evm_wallet", "evm_wallet_snapshot_v1", evmUpgradeMethods.snapshot, [null]);
  const historyBefore = await callApp("evm_wallet", "evm_wallet_history_v1", evmUpgradeMethods.history, [{ offset: 0n, limit: 20n }]);
  const evidence: Record<string, unknown> = {
    scope: "Real Kernel custody signature and exact Wallet archive; isolated scripted RPC observations, no external-chain acceptance claim",
    identity, operation_id: signed.operation_id, account: signed.address,
    raw, hash, nonce: parsed.nonce, chain_id: parsed.chainId, signature: signed.signature[0],
    signing_usage_before: beforeSigning.usage, signing_usage_after: signedCapability.usage,
    broadcasts_before: firstCapture.broadcasts,
  };

  return {
    evidence,
    async assertRestoredAndReconcile() {
      expect(await callApp("evm_wallet", "evm_wallet_snapshot_v1", evmUpgradeMethods.snapshot, [null])).toEqual(snapshotBefore);
      expect(await callApp("evm_wallet", "evm_wallet_history_v1", evmUpgradeMethods.history, [{ offset: 0n, limit: 20n }])).toEqual(historyBefore);
      expect(ok<Operation>(await callApp("evm_wallet", "evm_wallet_status_v1", evmUpgradeMethods.status, [{ identity: recoveredIdentity, refresh: false }]))).toEqual(signed);
      expect(await custodyCapability(direct, canister, owner)).toEqual(signedCapability);

      // Replaying execution must return the frozen pending result without
      // entering the signer or dispatching a second transaction.
      expect(ok<Operation>(await callApp("evm_wallet", "evm_wallet_execute_v1", evmUpgradeMethods.execute, [{ identity: recoveredIdentity, review_revision: prepared.review_revision }]))).toEqual(signed);
      expect(await capture()).toEqual(firstCapture);
      expect(await custodyCapability(direct, canister, owner)).toEqual(signedCapability);

      await configure("accepted", hash);
      const submitted = ok<Operation>(await callApp("evm_wallet", "evm_wallet_status_v1", evmUpgradeMethods.status, [{ identity: recoveredIdentity, refresh: true }]));
      expect(submitted.status).toBe("submitted");
      expect(submitted.transaction_hash).toEqual([hash]);
      expect(submitted.signature).toEqual(signed.signature);
      expect(submitted.prepared_transaction).toEqual(signed.prepared_transaction);
      const rebroadcast = await capture();
      expect(rebroadcast.broadcasts).toEqual([raw, raw]);
      expect(await custodyCapability(direct, canister, owner)).toEqual(signedCapability);
      expect(rebroadcast.reads.slice(firstCapture.reads.length)).toEqual([
        ...Array(3).fill("eth_getTransactionReceipt"), ...Array(3).fill("eth_getTransactionByHash"),
      ]);

      await configure("included", hash);
      const confirmed = ok<Operation>(await callApp("evm_wallet", "evm_wallet_status_v1", evmUpgradeMethods.status, [{ identity: recoveredIdentity, refresh: true }]));
      expect(confirmed.status).toBe("confirmed");
      expect(confirmed.finality).toEqual(["finalized"]);
      expect(confirmed.transaction_hash).toEqual([hash]);
      expect(confirmed.signature).toEqual(signed.signature);
      expect(confirmed.prepared_transaction).toEqual(signed.prepared_transaction);
      expect((await capture()).broadcasts).toEqual([raw, raw]);
      expect(await custodyCapability(direct, canister, owner)).toEqual(signedCapability);
      // The scripted node still reports nonce9. A new unsigned review must
      // advance past the restored reservation; retaining only the old public
      // transaction view while losing the reservation would incorrectly reuse9.
      const next = ok<Operation>(await callApp("evm_wallet", "evm_wallet_prepare_v1", evmUpgradeMethods.prepare, [{
        identity: { ...recoveredIdentity, request_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, intent,
      }]));
      expect(next.status).toBe("prepared");
      expect(next.prepared_transaction[0]?.nonce).toBe("10");
      expect(next.signature).toEqual([]);
      expect(next.transaction_hash).toEqual([]);
      expect((await capture()).broadcasts).toEqual([raw, raw]);
      expect(await custodyCapability(direct, canister, owner)).toEqual(signedCapability);
      evidence.broadcasts_after = (await capture()).broadcasts;
      evidence.signing_usage_after_reconciliation = signedCapability.usage;
      evidence.reconciled_status = confirmed.status;
      evidence.reconciled_receipt = confirmed.receipt_json;
      evidence.recovery_endpoint = recoveredIdentity.caller.endpoint;
      evidence.next_unsigned_nonce = next.prepared_transaction[0]!.nonce;
    },
  };
}
