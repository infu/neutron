import { expect } from "bun:test";
import { Principal } from "@dfinity/principal";
import type { CallApp } from "./new_apps.ts";
import { bridgeMethods } from "./wallet_journal_types.ts";
import { MINTER, USDC_LEDGER, type JournalCanisters } from "./wallet_journal_canisters.ts";

const id = (byte: number) => new Uint8Array(16).fill(byte);
const hash = (byte: string) => `0x${byte.repeat(64)}`;
const account = "0x1111111111111111111111111111111111111111";

// Public API snapshots intentionally include every Wallet315 bridge field.
// The scripted event stream qualifies journal restoration, not Ethereum or
// the real ckETH protocol. No test reaches into managed-memory internals.
export async function seedBridgeJournals(callApp: CallApp, canister: Principal, fixtures: JournalCanisters) {
  const invoke = async (name: keyof typeof bridgeMethods, argument: unknown): Promise<any> => {
    const suffix = name === "record" ? "record_step" : name;
    const reply: any = await callApp("wallet", `wallet_bridge_${suffix}_v1`, bridgeMethods[name], [argument]);
    expect(reply, `bridge ${name}`).toHaveProperty("ok");
    return reply.ok;
  };
  const prepare = (byte: number, source: object, subaccount: Uint8Array[]) => invoke("prepare", {
    id: id(byte), ledger: USDC_LEDGER, source, account, amount: 4_200_000n + BigInt(byte), subaccount,
  });
  const claim = (intent: any, step: string, operation: string[] = []) => invoke("claim", {
    id: intent.id, revision: intent.revision, step: { [step]: null }, operation_id: operation,
  });
  const record = (intent: any, step: string, transactionHash: string) => invoke("record", {
    id: intent.id, revision: intent.revision, step: { [step]: null }, state: { confirmed: null }, transaction_hash: [transactionHash], error: [],
  });
  let external = await prepare(0x31, { external: null }, []);
  expect(external.event_cursor).toBe(50n);
  external = await record(await claim(external, "reset_approval"), "reset_approval", hash("1"));
  external = await record(await claim(external, "approval"), "approval", hash("2"));
  external = await claim(external, "deposit");
  expect(external.steps[2]).toMatchObject({ state: { unknown: null }, transaction_hash: [], operation_id: [] });

  const subaccount = new Uint8Array(32).fill(0x43);
  let evm = await prepare(0x32, { evm: null }, [subaccount]);
  evm = await record(await claim(evm, "approval", ["wallet315-upgrade-approval"]), "approval", hash("3"));
  evm = await record(await claim(evm, "deposit", ["wallet315-upgrade-deposit"]), "deposit", hash("4"));
  await fixtures.configure(MINTER, { events: [
    { timestamp: 100n, payload: { FutureUnknown: "future event remains skippable" } },
    { timestamp: 101n, payload: { AcceptedErc20Deposit: {
      transaction_hash: hash("4"), block_number: 19_000_123n, log_index: 7n,
      from_address: account, value: evm.amount, principal: canister, subaccount: [subaccount],
      erc20_contract_address: evm.quote.token_address[0],
    } } },
    { timestamp: 102n, payload: { MintedCkErc20: {
      event_source: { transaction_hash: hash("4"), log_index: 7n },
      erc20_contract_address: evm.quote.token_address[0], mint_block_index: 900_123n,
    } } },
  ] });
  evm = await invoke("refresh", { id: evm.id, event_page_length: 3n });
  expect(evm.event_cursor).toBe(53n);
  expect(evm.accepted_deposit).toEqual([{ log_index: 7n, block_number: 19_000_123n, event_index: 51n }]);
  expect(evm.mint).toEqual([{ ledger_block_index: 900_123n, event_index: 52n, verified_ledger: false }]);
  expect(evm.error.length).toBe(1);
  expect(evm.quote.recipient).toEqual(canister);
  expect(evm.quote.subaccount_word).toBe(`0x${Buffer.from(subaccount).toString("hex")}`);
  const list = () => callApp("wallet", "wallet_bridge_list_v1", bridgeMethods.list, [{ ledger: [USDC_LEDGER], after: [], limit: 1n }]) as Promise<any>;
  const firstPage = await list();
  expect(firstPage.records).toEqual([external]);
  expect(firstPage.next).toEqual([external.id]);
  const secondPage = await callApp("wallet", "wallet_bridge_list_v1", bridgeMethods.list, [{ ledger: [USDC_LEDGER], after: firstPage.next, limit: 1n }]);
  expect(secondPage).toEqual({ records: [evm], next: [] });
  const before = { external, evm, firstPage, secondPage };
  return {
    before,
    async verify() {
      expect(await invoke("status", external.id)).toEqual(external);
      expect(await invoke("status", evm.id)).toEqual(evm);
      expect(await list()).toEqual(firstPage);
      expect(await callApp("wallet", "wallet_bridge_list_v1", bridgeMethods.list, [{ ledger: [USDC_LEDGER], after: firstPage.next, limit: 1n }])).toEqual(secondPage);
      // Reloading an unknown external transaction cannot turn it back into an
      // unclaimed send, and preparation replays the frozen original review.
      expect(await prepare(0x31, { external: null }, [])).toEqual(external);
      expect(await prepare(0x32, { evm: null }, [subaccount])).toEqual(evm);
      const rejected: any = await callApp("wallet", "wallet_bridge_claim_v1", bridgeMethods.claim, [{ id: external.id, revision: external.revision, step: { deposit: null }, operation_id: [] }]);
      expect(rejected.err).toContain("already claimed");
      // A hash attributed before the upgrade remains owned by its original
      // execution even if a different intent later recovers a manual hash.
      const duplicate: any = await callApp("wallet", "wallet_bridge_record_step_v1", bridgeMethods.record, [{ id: external.id, revision: external.revision, step: { deposit: null }, state: { confirmed: null }, transaction_hash: [hash("4")], error: [] }]);
      expect(duplicate.err).toContain("already recorded");
      expect(await invoke("status", external.id)).toEqual(external);
      const refreshed = await invoke("refresh", { id: evm.id, event_page_length: 3n });
      expect(refreshed.event_cursor).toBe(53n);
      expect(refreshed.accepted_deposit).toEqual(evm.accepted_deposit);
      expect(refreshed.mint).toEqual(evm.mint);
      expect(refreshed.error.length).toBe(1);
      return { retained: before, repeated_claim_error: rejected.err, duplicate_hash_error: duplicate.err, refreshed };
    },
  };
}
