import { expect } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import {
  walletUpgradeCommandId, walletUpgradeFundingRequest, walletUpgradeMethods,
} from "../legacy_kernel_upgrade.pocketic.test.ts";
import type { CallApp } from "./new_apps.ts";
import {
  ETH_LEDGER, GAS_BUDGET, MINTER, USDC_LEDGER, type JournalCanisters,
} from "./wallet_journal_canisters.ts";
import { contactMethods, icrcTransferArgs, transferMethods } from "./wallet_journal_types.ts";

type Receipt = {
  ledger: Principal; native: boolean; contact_id: bigint; address_id: bigint;
  amount: bigint; fee: bigint; block_index: bigint; secondary_block_index: bigint[];
  duplicate: boolean;
};
type Operation = {
  request_id: Uint8Array; ledger: Principal; amount: bigint; native: boolean;
  destination: string; created_at_ns: bigint; message: string[];
  settlement: Array<{ checked_at: bigint; status: Record<string, unknown> }>;
  status: { pending: null } | { succeeded: Receipt } | { rejected: string };
};
type Contact = {
  id: bigint; revision: bigint;
  addresses: Array<{ id: bigint; destination: Record<string, unknown> }>;
};
type TransferArgs = {
  from_subaccount: Uint8Array[];
  to: { owner: Principal; subaccount: Uint8Array[] };
  amount: bigint; fee: bigint[]; memo: Uint8Array[]; created_at_time: bigint[];
};

const id = (byte: number) => new Uint8Array(16).fill(byte);
const idKey = (value: Uint8Array) => Buffer.from(value).toString("hex");
const sameId = (a: Uint8Array, b: Uint8Array) => idKey(a) === idKey(b);
const decodeTransfer = (bytes: Uint8Array) => IDL.decode([icrcTransferArgs], bytes)[0] as unknown as TransferArgs;
const last = <T>(values: T[]): T => {
  expect(values.length).toBeGreaterThan(0);
  return values[values.length - 1]!;
};
function ok<T>(value: unknown, label: string): T {
  const reply = value as { ok?: T; err?: string };
  if (!("ok" in reply)) throw new Error(`${label}: ${reply.err ?? "missing ok result"}`);
  return reply.ok!;
}
function succeeded(operation: Operation): Receipt {
  if (!("succeeded" in operation.status)) {
    throw new Error(`Expected transfer success: ${JSON.stringify(operation, (_, value) => typeof value === "bigint" ? value.toString() : value)}`);
  }
  return operation.status.succeeded;
}

/**
 * Create journal state through the unmodified, published Wallet actor. The
 * scripted ledger/minter models accepted effects and lost replies; it is not a
 * qualification of the live ledger or minter protocol. All post-upgrade state
 * equality checks precede retries, acknowledgements, and fresh transfers.
 */
export async function seedTransferJournals(callApp: CallApp, canister: Principal, fixtures: JournalCanisters) {
  const wallet = walletUpgradeMethods();
  const invoke = (name: string, method: IDL.FuncClass, args: unknown[]) => callApp("wallet", name, method, args);
  const status = async (requestId: Uint8Array) => ok<Operation>(await invoke("wallet_transfer_status_v2", transferMethods.status, [requestId]), "read transfer");
  const resume = async (requestId: Uint8Array) => ok<Operation>(await invoke("wallet_transfer_resume_v2", transferMethods.resume, [requestId]), "resume transfer");
  const acknowledge = async (requestId: Uint8Array) => ok<Operation>(await invoke("wallet_transfer_acknowledge_v2", transferMethods.acknowledge, [requestId]), "acknowledge transfer");
  const pending = async () => await invoke("wallet_transfers_pending_v2", transferMethods.pending, [null]) as Operation[];
  const probes = async () => ({
    usdc: await fixtures.probe(USDC_LEDGER),
    eth: await fixtures.probe(ETH_LEDGER),
    minter: await fixtures.probe(MINTER),
  });

  await invoke("wallet_set_ledgers", wallet.setLedgers, [[USDC_LEDGER]]);
  await invoke("wallet_refresh_balances", wallet.refreshBalances, [null]);
  // This independent qualification starts with an empty Contacts306 root.
  const recipient = Principal.selfAuthenticating(new Uint8Array(32).fill(0xc7));
  expect(recipient.toText()).not.toBe(canister.toText());
  const ethRecipient = "0x1111111111111111111111111111111111111111";
  await callApp("contacts", "contacts_save", contactMethods.save, [{
    id: [], expected_revision: [], kind: { person: null },
    name: "Wallet journal upgrade recipient", notes: "Saved before the checked actor upgrade",
    addresses: [
      { id: [], address_label: ["IC transfer"], destination: { internet_computer: { owner: recipient, subaccount: [] } }, preferred: true },
      { id: [], address_label: ["Native withdrawal"], destination: { ethereum_mainnet: ethRecipient }, preferred: true },
    ],
  }]);
  const readContact = () => callApp("contacts", "contacts_get", contactMethods.get, [{ id: 1n }]) as Promise<Contact[]>;
  const contacts = await readContact();
  expect(contacts).toHaveLength(1);
  const contact = contacts[0]!;
  expect(contact.addresses).toHaveLength(2);
  const icAddress = contact.addresses.find((value) => "internet_computer" in value.destination)!;
  const nativeAddress = contact.addresses.find((value) => "ethereum_mainnet" in value.destination)!;
  expect(icAddress).toBeDefined();
  expect(nativeAddress).toBeDefined();

  const request = (byte: number, native: boolean, amount: bigint) => ({
    request_id: id(byte),
    transfer: {
      ledger: USDC_LEDGER,
      network: native ? { ethereum_mainnet: null } : { internet_computer: null },
      contact_id: contact.id, contact_revision: contact.revision,
      address_id: native ? nativeAddress.id : icAddress.id,
      expected_destination: native ? { ethereum_mainnet: ethRecipient } : { internet_computer: { owner: recipient, subaccount: [] } },
      amount,
    },
    withdrawal_quote: native ? [{ asset_fee: 10n, gas: [{ ledger: ETH_LEDGER, minter: MINTER, budget: GAS_BUDGET, ledger_fee: 10n }] }] : [],
  });
  const requests = {
    prepared: request(0xa1, false, 101_001n),
    acknowledged: request(0xa2, false, 101_002n),
    receipt: request(0xa3, false, 101_003n),
    unknownIc: request(0xa4, false, 101_004n),
    settledNative: request(0xa5, true, 2_000_005n),
    unknownNative: request(0xa6, true, 2_000_006n),
  };
  const prepare = async (value: ReturnType<typeof request>) => ok<Operation>(await invoke("wallet_transfer_prepare_v2", transferMethods.prepare, [value]), "prepare transfer");
  const initially = await probes();
  expect((await prepare(requests.prepared)).status).toEqual({ pending: null });
  expect(await probes()).toEqual(initially);

  await prepare(requests.acknowledged);
  const acknowledgedReceipt = succeeded(await resume(requests.acknowledged.request_id));
  expect(acknowledgedReceipt).toMatchObject({ native: false, amount: 101_002n, duplicate: false });
  await acknowledge(requests.acknowledged.request_id);
  await prepare(requests.receipt);
  expect(succeeded(await resume(requests.receipt.request_id))).toMatchObject({ native: false, amount: 101_003n, duplicate: false });

  // Timestamp uniqueness is externally observable. The private allocator field
  // itself is deliberately not read or patched by this actor qualification.
  const fund = async (byte: number) => {
    const fundingRequest = {
      ...walletUpgradeFundingRequest(byte, recipient, 333_333n), ledger: USDC_LEDGER,
      valid_until_ns: BigInt(Date.now() + 540_000) * 1_000_000n,
    };
    const commandId = walletUpgradeCommandId(fundingRequest);
    expect(await invoke("wallet_funding_prepare_v1", wallet.fundingPrepare, [fundingRequest]))
      .toMatchObject({ ok: { prepared: { command_id: commandId } } });
    const ledgerBefore = await fixtures.probe(USDC_LEDGER);
    const execution = await invoke("wallet_funding_execute_v1", wallet.fundingExecute, [{ command_id: commandId }]);
    expect(execution).toMatchObject({ transferred: { command_id: commandId, duplicate: false } });
    const ledgerAfter = await fixtures.probe(USDC_LEDGER);
    expect(ledgerAfter.transfer_calls).toBe(ledgerBefore.transfer_calls + 1n);
    expect(ledgerAfter.transfer_effects).toBe(ledgerBefore.transfer_effects + 1n);
    const args = decodeTransfer(last(ledgerAfter.transfer_args));
    expect(args).toMatchObject({ to: { owner: recipient, subaccount: [] }, amount: 333_333n, memo: [], fee: [10n] });
    expect(args.created_at_time).toHaveLength(1);
    const completed = await invoke("wallet_funding_prepare_v1", wallet.fundingPrepare, [fundingRequest]);
    expect(completed).toMatchObject({ ok: { completed: { result: execution } } });
    return { request: fundingRequest, commandId, execution, completed, args, raw_args: last(ledgerAfter.transfer_args) };
  };
  const fundingBefore = await fund(0xb1);

  await prepare(requests.unknownIc);
  const beforeLostIc = await fixtures.probe(USDC_LEDGER);
  await fixtures.configure(USDC_LEDGER, { lose_transfer_reply: true });
  const unknownIc = await resume(requests.unknownIc.request_id);
  expect(unknownIc.status).toEqual({ pending: null });
  expect(unknownIc.message).toHaveLength(1);
  const afterLostIc = await fixtures.probe(USDC_LEDGER);
  expect(afterLostIc.transfer_calls).toBe(beforeLostIc.transfer_calls + 1n);
  expect(afterLostIc.transfer_effects).toBe(beforeLostIc.transfer_effects + 1n);
  const frozenIcArgs = last(afterLostIc.transfer_args);
  expect(decodeTransfer(frozenIcArgs)).toMatchObject({ amount: requests.unknownIc.transfer.amount, memo: [requests.unknownIc.request_id], created_at_time: [unknownIc.created_at_ns] });
  // Configure scripts explicitly after their one-shot loss has been consumed.
  await fixtures.configure(USDC_LEDGER, { lose_transfer_reply: false });

  await prepare(requests.settledNative);
  const nativeReceipt = succeeded(await resume(requests.settledNative.request_id));
  expect(nativeReceipt).toMatchObject({ native: true, amount: 2_000_005n, duplicate: false });
  expect(nativeReceipt.secondary_block_index).toHaveLength(1);
  const submitted = ok<Operation>(await invoke("wallet_transfer_refresh_v2", transferMethods.refresh, [requests.settledNative.request_id]), "refresh native settlement");
  expect(submitted.settlement).toHaveLength(1);
  expect(submitted.settlement[0]!.status).toMatchObject({ submitted: { transaction_hash: `0x${"bb".repeat(32)}` } });

  await prepare(requests.unknownNative);
  const beforeLostNative = await probes();
  await fixtures.configure(MINTER, { lose_withdrawal_reply: true });
  const unknownNative = await resume(requests.unknownNative.request_id);
  expect(unknownNative.status).toEqual({ pending: null });
  expect(unknownNative.message).toHaveLength(1);
  const afterLostNative = await probes();
  expect(afterLostNative.usdc.approve_calls).toBe(beforeLostNative.usdc.approve_calls + 1n);
  expect(afterLostNative.usdc.approve_effects).toBe(beforeLostNative.usdc.approve_effects + 1n);
  expect(afterLostNative.eth.approve_calls).toBe(beforeLostNative.eth.approve_calls + 1n);
  expect(afterLostNative.eth.approve_effects).toBe(beforeLostNative.eth.approve_effects + 1n);
  expect(afterLostNative.minter.withdrawal_calls).toBe(beforeLostNative.minter.withdrawal_calls + 1n);
  expect(afterLostNative.minter.withdrawal_effects).toBe(beforeLostNative.minter.withdrawal_effects + 1n);
  await fixtures.configure(MINTER, { lose_withdrawal_reply: false });

  const entries = Object.entries(requests);
  const operations = async () => Object.fromEntries(await Promise.all(entries.map(async ([name, value]) => [name, await status(value.request_id)])));
  const before = {
    operations: await operations(), pending: await pending(), contact: await readContact(),
    probes: await probes(), funding: fundingBefore,
  };
  const pendingIds = before.pending.map((value) => idKey(value.request_id)).sort();
  expect(pendingIds).toEqual(entries.filter(([name]) => name !== "acknowledged").map(([, value]) => idKey(value.request_id)).sort());

  return {
    before,
    async verify() {
      const retained = {
        operations: await operations(), pending: await pending(), contact: await readContact(), probes: await probes(),
      };
      expect(retained).toEqual({ operations: before.operations, pending: before.pending, contact: before.contact, probes: before.probes });
      // Reusing each ID checks that its complete frozen intent and saved cost
      // review still decode; a conflicting amount must remain a conflict.
      for (const [name, saved] of entries) {
        expect(await prepare(saved)).toEqual(before.operations[name]);
        expect(await invoke("wallet_transfer_prepare_v2", transferMethods.prepare, [{
          ...saved, transfer: { ...saved.transfer, amount: saved.transfer.amount + 1n },
        }])).toEqual({ err: "Transfer request ID already belongs to a different intent" });
      }
      const mismatchedQuote = {
        ...requests.unknownNative,
        withdrawal_quote: [{ ...requests.unknownNative.withdrawal_quote[0]!, asset_fee: 11n }],
      };
      expect(await invoke("wallet_transfer_prepare_v2", transferMethods.prepare, [mismatchedQuote]))
        .toEqual({ err: "Transfer request ID already belongs to a different withdrawal cost review" });
      expect(await invoke("wallet_funding_prepare_v1", wallet.fundingPrepare, [fundingBefore.request])).toEqual(fundingBefore.completed);
      expect(await invoke("wallet_funding_execute_v1", wallet.fundingExecute, [{ command_id: fundingBefore.commandId }])).toEqual(fundingBefore.execution);
      expect(await probes()).toEqual(before.probes);

      const retryNative = await resume(requests.unknownNative.request_id);
      expect(retryNative.status).toEqual({ pending: null });
      expect(retryNative.message.join(" ")).toContain("minter call is not repeated");
      // Cached approvals and the accepted, ambiguous withdrawal survive. None
      // may be dispatched a second time, even though the fixture would accept it.
      const afterNativeRetry = await probes();
      expect(afterNativeRetry).toEqual(before.probes);

      const retryIc = succeeded(await resume(requests.unknownIc.request_id));
      expect(retryIc).toMatchObject({ native: false, amount: 101_004n, duplicate: true, block_index: 10_000n + beforeLostIc.transfer_effects });
      const afterIcRetry = await probes();
      expect(afterIcRetry.usdc.transfer_calls).toBe(before.probes.usdc.transfer_calls + 1n);
      expect(afterIcRetry.usdc.transfer_effects).toBe(before.probes.usdc.transfer_effects);
      expect(last(afterIcRetry.usdc.transfer_args)).toEqual(frozenIcArgs);
      expect(afterIcRetry.eth).toEqual(before.probes.eth);
      expect(afterIcRetry.minter).toEqual(before.probes.minter);

      // Acknowledged receipts stay suppressed; the previously unacknowledged
      // receipt is still actionable, and acknowledging it removes only that ID.
      const beforeAck = await pending();
      expect(beforeAck.some((value) => sameId(value.request_id, requests.acknowledged.request_id))).toBe(false);
      expect(beforeAck.some((value) => sameId(value.request_id, requests.receipt.request_id))).toBe(true);
      await acknowledge(requests.receipt.request_id);
      expect((await pending()).map((value) => idKey(value.request_id)))
        .toEqual(beforeAck.filter((value) => !sameId(value.request_id, requests.receipt.request_id)).map((value) => idKey(value.request_id)));
      const preparedReceipt = succeeded(await resume(requests.prepared.request_id));
      expect(preparedReceipt).toMatchObject({ native: false, amount: 101_001n, duplicate: false });

      const fundingAfter = await fund(0xb2);
      expect(fundingAfter.args.created_at_time[0]!).toBeGreaterThan(fundingBefore.args.created_at_time[0]!);
      expect({ ...fundingAfter.args, created_at_time: [] }).toEqual({ ...fundingBefore.args, created_at_time: [] });
      expect(fundingAfter.raw_args).not.toEqual(fundingBefore.raw_args);
      return {
        retained, after_native_retry: { operation: retryNative, probes: afterNativeRetry },
        after_ic_retry: { receipt: retryIc, probes: afterIcRetry }, prepared_receipt: preparedReceipt,
        funding_after: fundingAfter, final_probes: await probes(),
        timestamp_evidence: "Distinct, increasing captured funding created_at_time before and after upgrade; internal allocator value is not publicly exposed.",
      };
    },
  };
}
