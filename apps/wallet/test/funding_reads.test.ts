import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { encodeIcrcAccount } from "neutron-tools/src/icrc_account.js";
import { createFundingReader } from "../src/funding_reads.ts";
import { parsePrincipal } from "../src/icrc_account.ts";
import type { WalletFundingRequest } from "../src/funding.ts";
import type { HistoryQuery } from "../src/history_transaction.ts";

const owner = "3rurp-vyaaa-aaaay-aacua-cai";
const ledger = "xevnm-gaaaa-aaaar-qafnq-cai";
const spender = "sj2r4-haaaa-aaaay-aadgq-cai";
const balance = 900719925474099312345n;
const metadata = [
  ["icrc1:name", { Text: "Chain-key USDC" }],
  ["icrc1:symbol", { Text: "ckUSDC" }],
  ["icrc1:decimals", { Nat: 6n }],
  ["icrc1:logo", { Text: "data:image/png;base64," + "a".repeat(80_000) }],
];
const factsMetadata = [["icrc1:name", { Text: "Chain-key USDC" }], ["icrc1:symbol", { Text: "ckUSDC" }], ["icrc1:decimals", { Nat: "6" }]];
function request(route: WalletFundingRequest["route"] = { kind: "allowance", spender, expiresAtNs: "1800000000000000000" }): WalletFundingRequest {
  return { requestId: "ab".repeat(16), ledger, amountAtoms: "1000000", validUntilNs: "1799999999000000000", route };
}
function harness({ beforeReply, loadOwner }: { beforeReply?: () => Promise<void>; loadOwner?: () => Promise<string> } = {}) {
  const calls: Parameters<HistoryQuery>[0][] = [];
  const query: HistoryQuery = async (call) => {
    // Exact Candid types are exercised, including the tuple metadata vector and
    // optional binary spender subaccount, rather than accepting plain mocks.
    IDL.decode(call.argTypes, IDL.encode(call.argTypes, call.args));
    calls.push(call);
    await beforeReply?.();
    const reply = call.method === "icrc1_metadata" ? metadata
      : call.method === "icrc1_fee" ? 10000n
      : call.method === "icrc1_balance_of" ? balance
      : { allowance: balance, expires_at: [1799999999999999999n] };
    return IDL.decode([call.resultType], IDL.encode([call.resultType], [reply]))[0];
  };
  return { calls, reader: createFundingReader({ query, loadOwner: loadOwner ?? (async () => owner) }) };
}

test("allowance review performs three public reads concurrently, preserving exact values and binary subaccounts", async () => {
  const allStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { calls, reader } = harness({ beforeReply: async () => { if (calls.length === 3) allStarted.resolve(); await release.promise; } });
  const subaccount = new Uint8Array(32).fill(8);
  const spenderAccount = encodeIcrcAccount({ owner: parsePrincipal(spender, "spender"), subaccount });
  const pending = reader.readFundingFacts(request({ kind: "allowance", spender: spenderAccount, expiresAtNs: "1800000000000000000" }));
  await allStarted.promise;
  expect(calls.map((call) => call.method).sort()).toEqual(["icrc1_fee", "icrc1_metadata", "icrc2_allowance"]);
  expect(calls.every((call) => call.canister === ledger)).toBe(true);
  const args = calls.find((call) => call.method === "icrc2_allowance")!.args[0] as { account: { owner: Principal; subaccount: [] }; spender: { owner: Principal; subaccount: [Uint8Array] } };
  expect(args.account.owner.toText()).toBe(owner);
  expect(args.account.subaccount).toEqual([]);
  expect(args.spender.owner.toText()).toBe(spender);
  expect(args.spender.subaccount).toEqual([subaccount]);
  release.resolve();
  expect(await pending).toEqual({ owner, metadata: factsMetadata, fee: "10000", allowance: { allowance: balance.toString(), expires_at: "1799999999999999999" } });
});

test("direct transfer review omits unused allowance and balance requests", async () => {
  const { calls, reader } = harness();
  expect(await reader.readFundingFacts(request({ kind: "direct", to: spender, memoHex: null }))).toEqual({ owner, metadata: factsMetadata, fee: "10000", allowance: null });
  expect(calls.map((call) => call.method).sort()).toEqual(["icrc1_fee", "icrc1_metadata"]);
});

test("token observations read exact default-account balance and omit display assets from backend facts", async () => {
  const { calls, reader } = harness();
  const facts = await reader.readTokenFacts(ledger);
  expect(facts).toEqual({ owner, metadata: factsMetadata, fee: "10000", balance: balance.toString() });
  expect(JSON.stringify(facts)).not.toContain("base64");
  expect(calls.map((call) => call.method).sort()).toEqual(["icrc1_balance_of", "icrc1_fee", "icrc1_metadata"]);
  const account = calls.find((call) => call.method === "icrc1_balance_of")!.args[0] as { owner: Principal; subaccount: [] };
  expect(account.owner.toText()).toBe(owner);
  expect(account.subaccount).toEqual([]);
});

test("aborted reads issue no queries and an in-flight cancellation returns before the replica does", async () => {
  const stopped = new AbortController();
  stopped.abort(new Error("Read cancelled"));
  const idle = harness();
  await expect(idle.reader.readTokenFacts(ledger, stopped.signal)).rejects.toThrow("Read cancelled");
  expect(idle.calls).toHaveLength(0);

  const allStarted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const { calls, reader } = harness({ beforeReply: async () => { if (calls.length === 3) allStarted.resolve(); await release.promise; } });
  const active = new AbortController();
  const result = reader.readTokenFacts(ledger, active.signal);
  await allStarted.promise;
  active.abort(new Error("Dismissed review"));
  await expect(result).rejects.toThrow("Dismissed review");
  release.resolve();
  await Promise.resolve();
  expect(calls).toHaveLength(3);
});

test("owner and ledger validation fails before direct ledger requests", async () => {
  const { calls, reader } = harness({ loadOwner: async () => "not-a-principal" });
  await expect(reader.readTokenFacts(ledger)).rejects.toThrow("Invalid Wallet owner");
  await expect(reader.readTokenFacts("invalid-ledger")).rejects.toThrow("Invalid Wallet token ledger");
  expect(calls).toHaveLength(0);
});
