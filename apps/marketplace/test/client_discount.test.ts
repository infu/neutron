import { expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Principal } from "@dfinity/principal";
import { IDL } from "@dfinity/candid";
import type { MsgBusToolContext } from "neutron-tools/app";
import { CONTRACT, type Checkout, type Info } from "../src/protocol.ts";

if (process.env.NEUTRON_MARKETPLACE_DISCOUNT_CLIENT_CHILD !== "1") {
  test("real IC and Ethereum quote clients inherit the durable discount without protocol updates", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], { env: { ...process.env, NEUTRON_MARKETPLACE_DISCOUNT_CLIENT_CHILD: "1" }, timeout: 30_000 });
      expect(result.stderr).toContain("0 fail");
    } catch (error) { const result = error as Error & { stdout?: string; stderr?: string }; throw new Error(`${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`); }
  }, 35_000);
} else {
  const owner = Principal.fromText("3rurp-vyaaa-aaaay-aacua-cai"), canister = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai"), ledger = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
  const fee = { feeVersion: 1n, processingCycles: 1n, storageCycles: 0n, totalCycles: 1n, processingBytes: 0n, newStorageBytes: 0n };
  const info: Info = { version: 1n, canister, tokens: [{ ledger, symbol: "ckUSDC", decimals: 6, fee: 10000n, rateSymbol: "USDC", burnAccount: [] }], fees: {}, referralTerms: { version: 1n, discountBps: 1250n, affiliateBps: 3000n, developerBps: 3000n } };
  const calls: Array<{ method: string; args: any[] }> = [];
  let saved: string | null = "WELCOME", selfReads = 0;
  let original: Checkout | null = null, offline = false;
  const drafts = new Map<string, unknown>();
  const actualTransport = await import("../src/transport.ts");
  mock.module("../src/transport.ts", () => ({ ...actualTransport, makeAgent: async () => ({}), makeTransport: () => ({
    query: async (method: string, args: any[] = []) => {
      calls.push({ method, args });
      if (method === "marketplace_info") { if (offline) throw new Error("Protocol offline"); return info; }
      if (method === "referral_quote") return { ok: { code: args[0], affiliate: canister, discountBps: 1250n, termsVersion: 1n } };
      if (method === "purchase_status") return { ok: original ? [{ quote: [original] }] : [] };
      if (method === "ethereum_fees") return { prepare: fee, verify: fee, settle: fee, cancel: fee };
      if (method === "purchase_quote" || method === "ethereum_quote") {
        const quote: Checkout = { request: args[0], buyer: owner, items: [], amount: 0n, fee: 0n, affiliate: args[0].referralCode.length ? [canister] : [], rate: [], spender: { owner: canister, subaccount: [] }, commitment: new Uint8Array(32), cycles: fee, quotedAtNs: 1n };
        return { ok: quote };
      }
      throw new Error(`Unexpected query ${method}`);
    }, update: async () => { throw new Error("No protocol update needed"); },
  }) }));
  const { protocolClient, clearClient, discount } = await import("../src/client.ts");
  const { ethereumQuote } = await import("../src/ethereum_client.ts");
  const context = { signal: new AbortController().signal, kernel: {
    querySelf: async (method: string, args: unknown[]) => {
      if (method === "marketplace_state") return { seed: [], canister: [canister.toText()], host: "https://icp-api.io", owner: owner.toText(), revision: 1 };
      if (method === "marketplace_draft") { const value = drafts.get(args[0] as string); return value ? [new TextEncoder().encode(JSON.stringify(value))] : []; }
      if (method === "marketplace_discount_code") { selfReads++; expect(args).toEqual([null]); return saved === null ? [] : [saved]; }
      throw new Error(`Unexpected local read ${method}`);
    }, updateSelf: async (method: string, args: Array<{ code: string | null }>) => {
      expect(method).toBe("marketplace_set_discount_code"); saved = args[0]!.code; return { ok: saved === null ? [] : [saved] };
    },
  } } as unknown as MsgBusToolContext;
  const selection = { wallet: "browser" as const, payerAddress: "0xe70ab51ef2d86e70d834b4ac809d75e362ca23f2" };
  test("new IC and Ethereum checkout inherit, override, clear and restore the same preference", async () => {
    clearClient(); const client = await protocolClient(context);
    expect((await client.quotePurchase({ appIds: [], token: "ckUSDC" })).affiliateCode).toBe("WELCOME");
    expect((await ethereumQuote(context, { appIds: [], ethereum: selection })).affiliateCode).toBe("WELCOME");
    expect((await ethereumQuote(context, { appIds: [], ethereum: selection, affiliateCode: "" })).affiliateCode).toBe("");
    expect((await client.quotePurchase({ appIds: [], token: "ckUSDC", affiliateCode: " other " })).affiliateCode).toBe("OTHER");
    expect(selfReads).toBe(1);
    expect(calls.filter(call => call.method === "referral_quote")).toHaveLength(0);
    await client.setDiscountCode("second");
    expect((await client.quotePurchase({ appIds: [], token: "ckUSDC" })).affiliateCode).toBe("SECOND");
    clearClient();
    expect((await (await protocolClient(context)).discount()).code).toBe("SECOND");
    expect(selfReads).toBe(2);
    await (await protocolClient(context)).setDiscountCode("");
    expect((await ethereumQuote(context, { appIds: [], ethereum: selection })).affiliateCode).toBe("");
    expect(saved).toBeNull();
  });
  test("an existing IC operation quote keeps its original code after the default changes", async () => {
    clearClient(); const client = await protocolClient(context);
    await client.setDiscountCode("SECOND");
    const quote = await client.quotePurchase({ appIds: ["editor"], token: "ckUSDC", affiliateCode: "WELCOME" });
    drafts.set(`operation:${quote.operationId}`, { kind: "purchase", scope: { owner: owner.toText(), canister: canister.toText() }, quote });
    const before = calls.length;
    expect((await client.quotePurchase({ appIds: ["editor"], token: "ckUSDC", operationId: quote.operationId })).affiliateCode).toBe("WELCOME");
    expect(calls).toHaveLength(before);
    drafts.clear();
    original = { request: { requestId: quote.operationId, appIds: ["editor"], ledger, referralCode: ["WELCOME"] }, buyer: owner, items: [], amount: 0n, fee: 0n, affiliate: [canister], rate: [], spender: { owner: canister, subaccount: [] }, commitment: new Uint8Array(32), cycles: fee, quotedAtNs: 1n };
    expect((await client.quotePurchase({ appIds: ["editor"], token: "ckUSDC", operationId: quote.operationId })).affiliateCode).toBe("WELCOME");
    expect(calls.slice(before).map(call => call.method)).toEqual(["purchase_status"]);
    original = null;
  });
  test("an offline protocol still exposes the durable code as inactive on restoration", async () => {
    clearClient(); saved = "WELCOME"; offline = true;
    expect(await discount(context)).toEqual({ code: "WELCOME", active: false, discountBps: 0, affiliate: null, error: "Protocol offline" });
    offline = false; clearClient();
    expect(await discount(context)).toMatchObject({ code: "WELCOME", active: true });
  });
  test("referral validation wire contract is query-only and preserves canonical terms", () => {
    const value = { ok: { code: "WELCOME", affiliate: canister, discountBps: 1250n, termsVersion: 3n } };
    expect(CONTRACT.referral_quote!.update).toBeUndefined();
    expect(IDL.decode(CONTRACT.referral_quote!.args, IDL.encode(CONTRACT.referral_quote!.args, ["WELCOME"]))).toEqual(["WELCOME"]);
    expect(IDL.decode(CONTRACT.referral_quote!.returns, IDL.encode(CONTRACT.referral_quote!.returns, [value]))[0]).toEqual(value);
  });
}
