import { describe, expect, test } from "bun:test";
import type { JsonValue, ScopedKernelClient } from "neutron-tools/app";
import { decodeIcrcAccount } from "neutron-tools/src/icrc_account.js";
import { validateToolArguments, validateToolResult } from "neutron-tools/src/protocol.ts";
import { walletFundingInputSchema, walletFundingOutputSchema } from "../../wallet/src/funding.ts";
import { walletTokenInfoOutputSchema } from "../../wallet/src/token_info.ts";
import {
  createPurchaseFundingRequest,
  parseFundingResult,
  parsePurchaseFundingRequest,
  parseWalletTokenInfo,
  readWalletTokenInfo,
  requestFunding,
  rootFundingInstruction,
  spenderAccountText,
} from "../src/wallet.ts";

const REQUEST_ID = "12".repeat(16);
const LEDGER = "xevnm-gaaaa-aaaar-qafnq-cai";
const OWNER = "3rurp-vyaaa-aaaay-aacua-cai";
const PROTOCOL = "233tv-xiaaa-aaaay-aacta-cai";
const SUBACCOUNT = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const savedInput = {
  requestId: REQUEST_ID, ledger: LEDGER, saleAtoms: "9000000",
  spender: spenderAccountText(PROTOCOL, SUBACCOUNT),
  validUntilNs: "1788974216360000000", expiresAtNs: "1788974316360000000",
};
const approval = (namespace = "marketplace") => ({
  status: "approved", commandId: `${namespace}:${REQUEST_ID}`,
  blockIndex: "779988", duplicate: false, message: null,
});
const token = () => ({
  ledger: LEDGER, account: OWNER, name: "Chain-key USD Coin", symbol: "ckUSDC", decimals: 6,
  feeAtoms: "10000", balanceAtoms: "99999999999999999999999", observedAtNs: "1788974216360000000",
});
type ToolCall = Parameters<ScopedKernelClient["callTool"]>[0];
function client(call: (args: ToolCall) => Promise<JsonValue>): Pick<ScopedKernelClient, "callTool"> {
  return { callTool: call as ScopedKernelClient["callTool"] };
}

describe("saved marketplace purchase allowance", () => {
  test("matches Wallet's actual schema, with purchase amount and exact quoted spender", () => {
    const request = createPurchaseFundingRequest(savedInput);
    expect(() => validateToolArguments({ name: "wallet_fund_v1", inputSchema: walletFundingInputSchema }, request)).not.toThrow();
    expect(request.amountAtoms).toBe("9000000");
    expect(request.route.spender).toBe(savedInput.spender);
    const decoded = decodeIcrcAccount(request.route.spender);
    expect(decoded.owner.toText()).toBe(PROTOCOL);
    expect(decoded.subaccount).toEqual(SUBACCOUNT);
    expect(request.validUntilNs).toBe(savedInput.validUntilNs);
    expect(request.route.expiresAtNs).toBe(savedInput.expiresAtNs);
  });

  test("restores expired saved intent without generating a replacement identity", () => {
    const saved = createPurchaseFundingRequest({ ...savedInput, validUntilNs: "1", expiresAtNs: "2" });
    expect(parsePurchaseFundingRequest(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(rootFundingInstruction(saved)).toEqual({ target: "app:wallet:background", name: "wallet_fund_root_v1", arguments: saved });
  });

  test("rejects unsupported routes, malformed accounts and incompatible Wallet amounts", () => {
    expect(() => createPurchaseFundingRequest({ ...savedInput, saleAtoms: "0" })).toThrow("positive");
    expect(() => createPurchaseFundingRequest({ ...savedInput, saleAtoms: "1.5" })).toThrow("amount");
    expect(() => createPurchaseFundingRequest({ ...savedInput, requestId: "new-id" })).toThrow("request ID");
    expect(() => createPurchaseFundingRequest({ ...savedInput, ledger: savedInput.spender })).toThrow("ledger");
    expect(() => createPurchaseFundingRequest({ ...savedInput, spender: "not-a-principal" })).toThrow("spender");
    expect(() => spenderAccountText(PROTOCOL, new Uint8Array(31))).toThrow("32 bytes");
    expect(() => createPurchaseFundingRequest({ ...savedInput, validUntilNs: "18446744073709551616" })).toThrow("deadline");
    expect(() => parsePurchaseFundingRequest({ ...createPurchaseFundingRequest(savedInput), route: { kind: "direct", to: PROTOCOL } })).toThrow("allowance");
  });
});

describe("Wallet approval evidence", () => {
  test("accepts confirmed and reused allowance evidence under the complete identity", () => {
    expect(() => validateToolResult({ name: "wallet_fund_v1", inputSchema: walletFundingInputSchema, outputSchema: walletFundingOutputSchema }, approval())).not.toThrow();
    expect(parseFundingResult(approval(), REQUEST_ID, "marketplace")).toEqual(approval());
    expect(parseFundingResult({ ...approval(), blockIndex: null, duplicate: true }, REQUEST_ID, "marketplace").status).toBe("approved");
    expect(parseFundingResult(approval("agent"), REQUEST_ID, "agent").commandId).toBe(`agent:${REQUEST_ID}`);
  });

  test("rejects identical request IDs from another namespace and another request", () => {
    expect(() => parseFundingResult(approval("agent"), REQUEST_ID, "marketplace")).toThrow("caller");
    expect(() => parseFundingResult(approval(), "34".repeat(16), "marketplace")).toThrow("request");
    expect(() => parseFundingResult({ ...approval(), commandId: `another:marketplace:${REQUEST_ID}` }, REQUEST_ID, "marketplace")).toThrow("caller");
  });

  test("does not promote pending/rejected replies or accept direct-transfer results", () => {
    for (const status of ["pending", "rejected"] as const) {
      const result = { ...approval(), status, blockIndex: null, duplicate: null, message: "Review the existing request." };
      expect(parseFundingResult(result, REQUEST_ID, "marketplace")).toEqual(result);
      expect(() => parseFundingResult({ ...result, blockIndex: "4" }, REQUEST_ID, "marketplace")).toThrow("approval evidence");
    }
    expect(() => parseFundingResult({ ...approval(), status: "transferred" }, REQUEST_ID, "marketplace")).toThrow("route");
    expect(() => parseFundingResult({ ...approval(), duplicate: null }, REQUEST_ID, "marketplace")).toThrow("approval evidence");
    expect(() => parseFundingResult({ ...approval(), blockIndex: 779988 }, REQUEST_ID, "marketplace")).toThrow("block index");
  });

  test("normal funding calls only the provider rail with the saved request", async () => {
    const calls: ToolCall[] = [];
    const saved = createPurchaseFundingRequest(savedInput);
    const result = await requestFunding(client(async args => { calls.push(args); return approval(); }), saved);
    expect(calls).toEqual([{ target: "app:wallet:background", name: "wallet_fund_v1", arguments: saved }]);
    expect(result.status).toBe("approved");
  });

  test("a lost funding reply propagates once and leaves recovery to the saved operation", async () => {
    let calls = 0;
    const failure = new Error("Message bus disconnected after dispatch");
    const kernel = client(async () => { calls++; throw failure; });
    await expect(requestFunding(kernel, createPurchaseFundingRequest(savedInput))).rejects.toBe(failure);
    expect(calls).toBe(1);
  });
});

describe("Wallet token reads", () => {
  test("preserves atomic precision and validates the ledger and account", () => {
    expect(() => validateToolResult({ name: "wallet_token_info_v1", inputSchema: { type: "object" }, outputSchema: walletTokenInfoOutputSchema }, token())).not.toThrow();
    expect(parseWalletTokenInfo(token(), LEDGER, OWNER)).toEqual(token());
    expect(() => parseWalletTokenInfo(token(), "ryjl3-tyaaa-aaaaa-aaaba-cai", OWNER)).toThrow("another ledger");
    expect(() => parseWalletTokenInfo(token(), LEDGER, PROTOCOL)).toThrow("another account");
    expect(() => parseWalletTokenInfo({ ...token(), balanceAtoms: 1 }, LEDGER)).toThrow("balance");
  });

  test("serializes overlapping Wallet consent reads and keeps the queue usable after an error", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const kernel = client(async () => {
      const index = calls++;
      if (index === 0) { await blocked; throw new Error("Wallet temporarily unavailable"); }
      return token();
    });
    const first = readWalletTokenInfo(kernel, LEDGER, OWNER);
    const firstResult = first.catch(error => error as Error);
    const second = readWalletTokenInfo(kernel, LEDGER, OWNER);
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    expect((await firstResult as Error).message).toBe("Wallet temporarily unavailable");
    expect(await second).toEqual(token());
    expect(calls).toBe(2);
  });

  test("a canceled queued read makes no Wallet call", async () => {
    const signal = AbortSignal.abort(new Error("View closed"));
    let calls = 0;
    await expect(readWalletTokenInfo(client(async () => { calls++; return token(); }), LEDGER, OWNER, signal)).rejects.toThrow("View closed");
    expect(calls).toBe(0);
  });
});
