import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Principal } from "@dfinity/principal";
import type { MsgBusToolContext } from "neutron-tools/app";
import { checkoutType, decodeOpaque, encodeOpaque, type Checkout, type Info, type WireApp } from "../src/protocol.ts";
import type { WalletTokenInfo } from "../src/wallet.ts";

// Client caches and transport mocks must not leak into other application tests.
if (process.env.NEUTRON_MARKETPLACE_CHECKOUT_LATENCY_CHILD !== "1") {
  test("checkout query concurrency preserves canonical terms and recovery metadata", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NEUTRON_MARKETPLACE_CHECKOUT_LATENCY_CHILD: "1" }, timeout: 30_000,
      });
      expect(result.stderr).toContain("0 fail");
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  }, 35_000);
} else {
  const OWNER = Principal.fromText("3rurp-vyaaa-aaaay-aacua-cai");
  const PROTOCOL = Principal.fromText("233tv-xiaaa-aaaay-aacta-cai");
  const AFFILIATE = Principal.fromText("aaaaa-aa");
  const LEDGER = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
  const fee = { feeVersion: 1n, processingCycles: 100n, storageCycles: 0n, totalCycles: 100n, processingBytes: 0n, newStorageBytes: 0n };
  const info: Info = {
    version: 1n, canister: PROTOCOL,
    tokens: [{ ledger: LEDGER, symbol: "ckUSDC", decimals: 6, fee: 10_000n, rateSymbol: "USDC", burnAccount: [] }],
    fees: {}, referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n },
  };
  function listing(overrides: Partial<WireApp> = {}): WireApp {
    return {
      appId: "editor", publisher: PROTOCOL, publisherProfile: [{ publisherId: "aae", name: "aae" }],
      title: "Editor", summary: "An editor", description: "An editor with agent tools.", priceUsdMicros: 10_000_000n,
      revision: 7n, version: [117n], iconUrl: [], screenshots: [], iconArtifact: [], screenshotArtifacts: [],
      ratingCount: 2n, ratingTotal: 9n, owned: false, visible: true, ...overrides,
    };
  }
  function checkout(): Checkout {
    return {
      request: { requestId: "ab".repeat(16), appIds: ["editor"], ledger: LEDGER, referralCode: ["WELCOME"] }, buyer: OWNER,
      items: [{ appId: "editor", listingRevision: 7n, publisher: PROTOCOL, priceUsdMicros: 10_000_000n,
        paidAtoms: 9_000_000n, developerAtoms: 2_700_000n, affiliateAtoms: 2_700_000n, burnAtoms: 3_600_000n,
        releaseDigest: new Uint8Array(32).fill(5) }],
      amount: 9_000_000n, fee: 10_000n, affiliate: [AFFILIATE], rate: [], spender: { owner: PROTOCOL, subaccount: [new Uint8Array(32).fill(3)] },
      commitment: new Uint8Array(32).fill(7), quotedAtNs: 1n, cycles: fee,
    };
  }
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }
  // Advance the microtask queue without imposing a network-speed assertion.
  const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const writes: string[] = [];
  const walletReads: Array<{ ledger: string; owner: string }> = [];
  let apps: WireApp[];
  let currentQuote: Checkout;
  let detail: () => Promise<unknown>;
  let pricing: (request: Checkout["request"]) => Promise<unknown>;
  let balance: () => Promise<WalletTokenInfo>;
  let savedDiscount: string | null;
  let discountReads = 0;
  const walletInfo: WalletTokenInfo = {
    ledger: LEDGER.toText(), account: OWNER.toText(), name: "Chain-key USDC", symbol: "ckUSDC", decimals: 6,
    feeAtoms: "10000", balanceAtoms: "20000000", observedAtNs: "1789000000000000000",
  };
  const actualTransport = await import("../src/transport.ts");
  mock.module("../src/transport.ts", () => ({ ...actualTransport, makeAgent: async () => ({}), makeTransport: () => ({
    query: async (name: string, args: unknown[] = []) => {
      calls.push({ name, args });
      if (name === "marketplace_info") return info;
      if (name === "catalog_query") return { ok: { apps, nextCursor: [], asOfNs: 1n, refreshing: false } };
      if (name === "app_detail") return detail();
      if (name === "purchase_quote" || name === "ethereum_quote") return pricing(args[0] as Checkout["request"]);
      if (name === "ethereum_fees") return { prepare: fee, verify: fee, settle: fee, cancel: fee };
      throw new Error(`Unexpected query ${name}`);
    },
    reserve: async () => { writes.push("reserve"); throw new Error("Review must not reserve update access"); },
    update: async (name: string) => { writes.push(name); throw new Error("Review must not dispatch a protocol update"); },
  }) }));
  const actualWallet = await import("../src/wallet.ts");
  mock.module("../src/wallet.ts", () => ({ ...actualWallet,
    readWalletTokenInfo: async (_kernel: unknown, ledger: string, owner: string) => {
      walletReads.push({ ledger, owner });
      return balance();
    },
  }));
  const { clearClient, protocolClient } = await import("../src/client.ts");
  const { ethereumQuote } = await import("../src/ethereum_client.ts");
  const context = () => ({ signal: new AbortController().signal, kernel: {
    querySelf: async (name: string) => {
      if (name === "marketplace_state") return { seed: [], canister: [PROTOCOL.toText()], host: "https://icp-api.io", owner: OWNER.toText(), revision: 1 };
      if (name === "marketplace_discount_code") { discountReads++; return savedDiscount === null ? [] : [savedDiscount]; }
      throw new Error(`Unexpected local read ${name}`);
    },
    listApps: async () => ({ apps: [] }),
    updateSelf: async (name: string) => { writes.push(name); throw new Error("Review must not mutate local state"); },
  } }) as unknown as MsgBusToolContext;
  beforeEach(() => {
    clearClient(); calls.length = 0; writes.length = 0; walletReads.length = 0; discountReads = 0;
    apps = [listing()]; currentQuote = checkout(); savedDiscount = "WELCOME";
    detail = async () => ({ ok: { app: apps[0], candidate: [], audit: [], rating: [] } });
    pricing = async request => { currentQuote = { ...currentQuote, request }; return { ok: currentQuote }; };
    balance = async () => walletInfo;
  });
  afterEach(() => expect(writes).toEqual([]));
  async function warmed(from: "catalog" | "detail" = "catalog") {
    const client = await protocolClient(context());
    if (from === "catalog") await client.catalog({ tier: "paid", window: "week", search: "" });
    else await client.detail("editor");
    await client.purchaseCode(undefined);
    calls.length = 0;
    return client;
  }

  for (const source of ["catalog", "detail"] as const) test(`${source} presentation makes checkout one canonical query, concurrent with current Wallet balance`, async () => {
    const client = await warmed(source), quoteGate = deferred<unknown>(), walletGate = deferred<WalletTokenInfo>();
    pricing = async request => { currentQuote = { ...currentQuote, request }; return quoteGate.promise; };
    balance = () => walletGate.promise;
    const pending = client.quotePurchase({ appIds: ["editor"], token: "ckUSDC" });
    await nextTurn();
    // Neither independent read has replied yet: both must already be dispatched.
    expect(calls.map(call => call.name)).toEqual(["purchase_quote"]);
    expect(walletReads).toEqual([{ ledger: LEDGER.toText(), owner: OWNER.toText() }]);
    expect((calls[0]!.args[0] as Checkout["request"]).referralCode).toEqual(["WELCOME"]);
    expect(discountReads).toBe(1);
    quoteGate.resolve({ ok: currentQuote });
    walletGate.resolve({ ...walletInfo, balanceAtoms: "9019999" });
    const view = await pending;
    expect(calls.map(call => call.name)).toEqual(["purchase_quote"]);
    expect(view.items[0]).toMatchObject({ title: "Editor", publisherId: "aae", publisherName: "aae", priceUsdMicros: "10000000" });
    expect(view.payment.atoms).toBe("9000000");
    expect(view.totalDebit.atoms).toBe("9020000");
    expect(view.allocations.map(item => [item.kind, item.principal, item.amount.atoms])).toEqual([
      ["developer", PROTOCOL.toText(), "2700000"], ["affiliate", AFFILIATE.toText(), "2700000"], ["burn", null, "3600000"],
    ]);
    expect(view.opaque).toEqual(encodeOpaque(checkoutType, currentQuote));
    expect(decodeOpaque<Checkout>(checkoutType, view.opaque).items[0]!.releaseDigest).toEqual(currentQuote.items[0]!.releaseDigest);
    expect(view.warnings).toContain("Wallet's current balance is below the price plus estimated ledger fees.");
  });

  for (const cached of ["missing", "revised", "different_publisher"] as const) test(`${cached} metadata is fetched alongside Wallet while saved purchase terms remain authoritative`, async () => {
    const client = await protocolClient(context());
    if (cached !== "missing") client.listing(listing(cached === "revised" ? { revision: 6n } : { publisher: OWNER }));
    const metadataGate = deferred<unknown>(), walletGate = deferred<WalletTokenInfo>();
    detail = () => metadataGate.promise;
    balance = () => walletGate.promise;
    calls.length = 0;
    const pending = client.purchaseView(currentQuote, true);
    await nextTurn();
    expect(calls.map(call => call.name)).toEqual(["app_detail"]);
    expect(walletReads).toHaveLength(1);
    metadataGate.resolve({ ok: { app: listing({ title: "Current title", revision: 8n, priceUsdMicros: 12_000_000n }) } });
    walletGate.resolve(walletInfo);
    const view = await pending;
    expect(view.items[0]).toMatchObject({ title: "Current title", priceUsdMicros: "10000000", publisher: PROTOCOL.toText() });
    expect(view.payment.atoms).toBe("9000000");
    expect(view.opaque).toEqual(encodeOpaque(checkoutType, currentQuote));
  });

  test("a current publisher profile cannot be attributed to a retained quote's different publisher", async () => {
    const client = await protocolClient(context());
    detail = async () => ({ ok: { app: listing({ publisher: OWNER, publisherProfile: [{ publisherId: "different", name: "Different publisher" }] }) } });
    const view = await client.purchaseView(currentQuote);
    expect(view.items[0]).toMatchObject({ publisher: PROTOCOL.toText(), publisherId: null, publisherName: null });
    expect(view.allocations[0]!.principal).toBe(PROTOCOL.toText());
    expect(view.opaque).toEqual(encodeOpaque(checkoutType, currentQuote));
  });

  test("clearClient invalidates presentation and stored-preference caches", async () => {
    await warmed();
    clearClient();
    savedDiscount = "SECOND";
    const client = await protocolClient(context());
    calls.length = 0;
    const view = await client.quotePurchase({ appIds: ["editor"], token: "ckUSDC" });
    expect(calls.map(call => call.name)).toEqual(["purchase_quote", "app_detail"]);
    expect(discountReads).toBe(2);
    expect(view.affiliateCode).toBe("SECOND");
    expect(walletReads).toHaveLength(1);
  });

  for (const rail of ["ic", "ethereum"] as const) for (const code of ["INVALID", "SELF"] as const) test(`${rail} canonical pricing rejects ${code} rather than silently removing the saved discount`, async () => {
    savedDiscount = code;
    const client = await warmed();
    pricing = async request => {
      expect(request.referralCode).toEqual([code]);
      return { err: { code: code === "SELF" ? "self_referral" : "invalid_referral", message: `Canonical rejection: ${code}` } };
    };
    const result = rail === "ic" ? client.quotePurchase({ appIds: ["editor"], token: "ckUSDC" }) : ethereumQuote(context(), {
      appIds: ["editor"], ethereum: { wallet: "browser", payerAddress: "0xe70ab51ef2d86e70d834b4ac809d75e362ca23f2" },
    });
    await expect(result).rejects.toThrow(`Canonical rejection: ${code}`);
    expect(calls.map(call => call.name)).toEqual(rail === "ic" ? ["purchase_quote"] : ["ethereum_quote", "ethereum_fees"]);
    expect(discountReads).toBe(1);
  });

  test("a canonical free quote ignores a speculative Wallet error without losing the pricing result", async () => {
    const client = await warmed(), quoteGate = deferred<unknown>();
    balance = async () => { throw new Error("Wallet is unavailable"); };
    pricing = async request => { currentQuote = { ...currentQuote, request, amount: 0n, fee: 0n, affiliate: [],
      items: currentQuote.items.map(item => ({ ...item, listingRevision: 8n, priceUsdMicros: 0n, paidAtoms: 0n, developerAtoms: 0n, affiliateAtoms: 0n, burnAtoms: 0n })) };
      return quoteGate.promise;
    };
    apps = [listing({ revision: 8n, priceUsdMicros: 0n })];
    const pending = client.quotePurchase({ appIds: ["editor"], token: "ckUSDC" });
    // The speculative Wallet promise rejects while canonical pricing is held.
    await nextTurn();
    expect(walletReads).toHaveLength(1);
    quoteGate.resolve({ ok: currentQuote });
    const view = await pending;
    expect(view.totalDebit.atoms).toBe("0");
    expect(view.warnings).toEqual([]);
    expect(view.opaque).toEqual(encodeOpaque(checkoutType, currentQuote));
  });

  test("a paid canonical quote still requires a successful current Wallet read", async () => {
    const client = await warmed();
    balance = async () => { throw new Error("Current Wallet balance unavailable"); };
    await expect(client.quotePurchase({ appIds: ["editor"], token: "ckUSDC" })).rejects.toThrow("Current Wallet balance unavailable");
    expect(calls.map(call => call.name)).toEqual(["purchase_quote"]);
    expect(walletReads).toHaveLength(1);
  });

  test("a canonical free quote does not wait for the speculative paid-listing Wallet read", async () => {
    const client = await warmed(), walletGate = deferred<WalletTokenInfo>();
    balance = () => walletGate.promise;
    currentQuote = { ...currentQuote, amount: 0n, fee: 0n, affiliate: [],
      items: currentQuote.items.map(item => ({ ...item, listingRevision: 8n, priceUsdMicros: 0n, paidAtoms: 0n, developerAtoms: 0n, affiliateAtoms: 0n, burnAtoms: 0n })) };
    apps = [listing({ revision: 8n, priceUsdMicros: 0n })];
    const pending = client.quotePurchase({ appIds: ["editor"], token: "ckUSDC" });
    let completed = false;
    void pending.then(() => { completed = true; });
    await nextTurn();
    expect(completed).toBe(true);
    expect((await pending).totalDebit.atoms).toBe("0");
    expect(walletReads).toHaveLength(1);
    walletGate.resolve(walletInfo);
  });
}
