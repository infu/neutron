import { describe, expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { normalizeToolDescriptor, validateToolArguments, validateToolResult, type MsgBusToolDescriptor } from "neutron-tools/protocol";
import type { JsonObject, MsgBusToolContext, ScopedKernelClient } from "neutron-tools/app";
import { createHistoryReader } from "neutron-wallet/src/history_reads.ts";
import { createHistoryToolHandlers, registerHistoryTools } from "neutron-wallet/src/history_tools.ts";
import type { HistoryQuery } from "neutron-wallet/src/history_transaction.ts";
import type { ActionPrepared } from "../src/action_backend.ts";
import { readPayoutEvidence } from "../src/payout_evidence.ts";
import { liquidityOwnerAccountIdentifier } from "../src/liquidity_reads.ts";

const OWNER = "3rurp-vyaaa-aaaay-aacua-cai", POOL = "mohjv-bqaaa-aaaag-qjyia-cai", ARCHIVE = "aaaaa-aa";
const ICP = "ryjl3-tyaaa-aaaaa-aaaba-cai", USDC = "xevnm-gaaaa-aaaar-qafnq-cai";
const CATALOG = [
  { principal: ICP, index: "qhbym-qaaaa-aaaaa-aaafq-cai", history_kind: "icp" },
  { principal: USDC, index: "xrs4b-hiaaa-aaaar-qafoa-cai", history_kind: "icrc" },
];
const TIME = 1788911851708006515n, BLOCK = 779771n, AMOUNT = 9007199254740993n;
const MEMO = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
const descriptors = new Map<string, MsgBusToolDescriptor>();
registerHistoryTools((name, definition) => { descriptors.set(name, normalizeToolDescriptor({ name, ...definition })); });
const bytes = (value: string) => Uint8Array.from(value.match(/../gu)!, byte => Number.parseInt(byte, 16));
const icrcAccount = (owner: string) => ({ owner: Principal.fromText(owner), subaccount: [] });
const icrcValue = (owner: string) => ({ Array: [{ Blob: Principal.fromText(owner).toUint8Array() }] });

function prepared(ledger: string): ActionPrepared {
  return {
    operation: { id: "a5".repeat(16), input_json: "{}", plan_json: "", funding_json: "[]", result_json: "", revision: "5", state: "settlement_pending", detail: "Successful protocol output awaits evidence", created_at: (TIME - 1n).toString(), updated_at: TIME.toString(),
      effects: [{ key: "swap", canister: POOL, method: "depositFromAndSwap", state: "succeeded", dispatched_at: (TIME - 1n).toString(), completed_at: TIME.toString(), result_nat: (AMOUNT + 10000n).toString() }] },
    plan: { pool: POOL, output_address: ledger },
  };
}

function fixture(ledger: string, fallback: boolean, noIndex = false) {
  const config = CATALOG.find(item => item.principal === ledger)!;
  const icp = config.history_kind === "icp";
  const from = liquidityOwnerAccountIdentifier(POOL), to = liquidityOwnerAccountIdentifier(OWNER);
  const operation = { Transfer: { from, to, amount: { e8s: AMOUNT }, fee: { e8s: 10000n }, spender: [] } };
  const indexTransaction = icp ? { id: BLOCK, transaction: { memo: 7n, icrc1_memo: [MEMO], operation, timestamp: [{ timestamp_nanos: TIME }], created_at_time: [] } }
    : { id: BLOCK, transaction: { kind: "transfer", timestamp: TIME, mint: [], burn: [], approve: [], transfer: [{ from: icrcAccount(POOL), to: icrcAccount(OWNER), spender: [], amount: AMOUNT, fee: [10000n], memo: [MEMO] }] } };
  const ledgerBlock = icp ? { timestamp: { timestamp_nanos: TIME }, transaction: { memo: 7n, icrc1_memo: [MEMO], created_at_time: { timestamp_nanos: TIME }, operation: [{ Transfer: { ...operation.Transfer, from: bytes(from), to: bytes(to) } }] } }
    : { Map: [["btype", { Text: "1xfer" }], ["ts", { Nat: TIME }], ["fee", { Nat: 10000n }], ["tx", { Map: [["from", icrcValue(POOL)], ["to", icrcValue(OWNER)], ["amt", { Nat: AMOUNT }], ["memo", { Blob: MEMO }]] }]] };
  const queries: Parameters<HistoryQuery>[0][] = [];
  const query: HistoryQuery = async request => {
    queries.push(request);
    // All wire options, principals, block IDs and callback references pass the
    // production reader's actual Candid types before reaching either app.
    IDL.decode(request.argTypes, IDL.encode(request.argTypes, request.args));
    let reply: unknown;
    if (request.canister === config.index) reply = request.method === "status" ? { num_blocks_synced: BLOCK + 1n }
      : { Ok: { balance: AMOUNT, oldest_tx_id: [BLOCK], transactions: [indexTransaction] } };
    else if (request.canister === ledger) {
      if (fallback) throw new Error("Ledger lookup temporarily unavailable");
      reply = icp ? { chain_length: BLOCK + 1n, first_block_index: BLOCK + 1n, blocks: [], archived_blocks: [{ start: BLOCK, length: 1n, callback: [Principal.fromText(ARCHIVE), "get_blocks"] }] }
        : { log_length: BLOCK + 1n, blocks: [], archived_blocks: [{ args: [{ start: BLOCK, length: 1n }], callback: [Principal.fromText(ARCHIVE), "icrc3_get_blocks"] }] };
    } else if (request.canister === ARCHIVE) reply = icp ? { Ok: { blocks: [ledgerBlock] } }
      : { log_length: BLOCK + 1n, blocks: [{ id: BLOCK, block: ledgerBlock }], archived_blocks: [] };
    else throw new Error("Unexpected query destination");
    return IDL.decode([request.resultType], IDL.encode([request.resultType], [reply]))[0];
  };
  const selfCalls: string[] = [];
  const walletContext = { reportProgress() {}, kernel: {
    querySelf: async (method: string, args: unknown[]) => {
      selfCalls.push(method); expect(args).toEqual([null]);
      if (method === "wallet_snapshot") return { owner: OWNER };
      if (method === "wallet_catalog") return CATALOG.map(entry => ({ ...entry, index: noIndex ? null : entry.index }));
      throw new Error("Unexpected self query");
    },
    updateSelf: async () => { throw new Error("Payout evidence must not issue a Wallet update"); },
  } } as unknown as MsgBusToolContext;
  const handlers = createHistoryToolHandlers(createHistoryReader(query, () => TIME + 1n));
  const kernel = { callTool: async (call: { target: string; name: string; arguments: JsonObject }) => {
    expect(call.target).toBe("app:wallet:background");
    const descriptor = descriptors.get(call.name)!;
    validateToolArguments(descriptor, call.arguments);
    const result = await (call.name === "wallet_account_transactions_v1" ? handlers.accountTransactions : handlers.transaction)(call.arguments, walletContext);
    validateToolResult(descriptor, result);
    // Include the actual cross-app JSON boundary (no bigint/principal objects).
    return JSON.parse(JSON.stringify(result));
  } } as unknown as Pick<ScopedKernelClient, "callTool">;
  return { kernel, queries, selfCalls };
}

describe("Wallet history to ICPSwap payout interoperability", () => {
  test.each([ICP, USDC])("%s canonical index and archive results remain exact contextual evidence", async ledger => {
    const f = fixture(ledger, false), action = prepared(ledger), before = JSON.stringify(action);
    const result = await readPayoutEvidence({ prepared: action, kernel: f.kernel, owner: OWNER, payoutBlocks: [{ ledger, blockIndex: BLOCK.toString() }] });
    expect(result).toMatchObject({ status: "observed", errors: [], settlementVerified: false, operationLinkVerified: false });
    expect(result.ledgers[0]).toMatchObject({ status: "observed", coverage: { source: { kind: "index", ledgerVerified: false }, pagination: { completeToOldest: true } }, candidates: [{ operationLinkVerified: false, transaction: { blockIndex: BLOCK.toString(), amountAtoms: AMOUNT.toString(), memoHex: "0001020304050607" } }] });
    expect(result.explicitBlocks[0]).toMatchObject({ status: "candidate", source: { canister: ARCHIVE, ledgerVerified: true, archived: true }, candidate: { operationLinkVerified: false }, transaction: { blockIndex: BLOCK.toString(), amountAtoms: AMOUNT.toString(), balanceEffectAtoms: AMOUNT.toString() } });
    expect(JSON.stringify(action)).toBe(before);
    expect(f.selfCalls).toEqual(["wallet_snapshot", "wallet_catalog", "wallet_snapshot", "wallet_catalog"]);
    expect(f.queries.some(query => query.canister === ARCHIVE)).toBe(true);
  });

  test("ledger failure keeps index fallback unverified through provider schemas and consumer parsing", async () => {
    const f = fixture(USDC, true);
    const result = await readPayoutEvidence({ prepared: prepared(USDC), kernel: f.kernel, owner: OWNER, payoutBlocks: [{ ledger: USDC, blockIndex: BLOCK.toString() }] });
    expect(result.explicitBlocks[0]).toMatchObject({ status: "candidate", source: { kind: "index", ledgerVerified: false, archived: false }, candidate: { operationLinkVerified: false } });
    expect(result.explicitBlocks[0]!.diagnostics[0]).toContain("Ledger lookup temporarily unavailable");
    expect(result.settlementVerified).toBe(false);
  });

  test("missing canonical index still permits an exact archive observation without manufacturing page coverage", async () => {
    const f = fixture(USDC, false, true);
    const result = await readPayoutEvidence({ prepared: prepared(USDC), kernel: f.kernel, owner: OWNER, payoutBlocks: [{ ledger: USDC, blockIndex: BLOCK.toString() }] });
    expect(result.status).toBe("partial");
    expect(result.ledgers[0]).toMatchObject({ status: "unavailable", candidates: [], coverage: { source: { canister: null }, pagination: { completeToOldest: false } } });
    expect(result.explicitBlocks[0]).toMatchObject({ status: "candidate", source: { ledgerVerified: true, archived: true } });
    expect(result.settlementVerified).toBe(false);
  });
});
