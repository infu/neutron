import { beforeEach, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import type { MsgBusToolContext } from "neutron-tools/app";
import { CONTRACT, checkoutType, ethereumFeesType, ethereumInvoiceResultType, encodeOpaque, type Checkout, type Info } from "../src/protocol.ts";
import type { EthereumFees, EthereumInvoiceResult } from "../src/ethereum_protocol.ts";

if (process.env.NEUTRON_MARKETPLACE_ETHEREUM_CLIENT_CHILD !== "1") {
  test("Ethereum checkout wire contract, pricing and recovery views", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NEUTRON_MARKETPLACE_ETHEREUM_CLIENT_CHILD: "1" }, timeout: 30_000,
      });
      expect(result.stderr).toContain("0 fail");
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  }, 35_000);
} else {
  const OWNER = Principal.fromText("3rurp-vyaaa-aaaay-aacua-cai"), PROTOCOL = Principal.fromText("233tv-xiaaa-aaaay-aacta-cai"), LEDGER = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
  const PAYER = "0xe70ab51ef2d86e70d834b4ac809d75e362ca23f2", HELPER = "0x18901044688D3756C35Ed2b36D93e6a5B8e00E68", MINTER = "0xb25eA1D493B49a1DeD42aC5B1208cC618f9A9B80", TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const info: Info = { version: 1n, canister: PROTOCOL, tokens: [{ ledger: LEDGER, symbol: "ckUSDC", decimals: 6, fee: 10_000n, rateSymbol: "USDC", burnAccount: [] }], fees: {}, referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n } };
  const fees: EthereumFees = {
    prepare: { feeVersion: 2n, processingCycles: 100n, storageCycles: 0n, totalCycles: 100n, processingBytes: 0n, newStorageBytes: 0n },
    verify: { feeVersion: 2n, processingCycles: 50_000_000_100n, storageCycles: 0n, totalCycles: 50_000_000_100n, processingBytes: 0n, newStorageBytes: 0n },
    settle: { feeVersion: 2n, processingCycles: 200n, storageCycles: 0n, totalCycles: 200n, processingBytes: 0n, newStorageBytes: 0n },
    cancel: { feeVersion: 2n, processingCycles: 20n, storageCycles: 0n, totalCycles: 20n, processingBytes: 0n, newStorageBytes: 0n },
  };
  const quote: Checkout = {
    request: { requestId: "ab".repeat(16), appIds: ["saved_app"], ledger: LEDGER, referralCode: [] }, buyer: OWNER,
    items: [{ appId: "saved_app", listingRevision: 1n, publisher: PROTOCOL, priceUsdMicros: 9_000_000n, paidAtoms: 9_000_000n,
      developerAtoms: 2_700_000n, affiliateAtoms: 0n, burnAtoms: 6_300_000n, releaseDigest: new Uint8Array(32).fill(5) }],
    amount: 9_000_000n, fee: 10_000n, affiliate: [], rate: [], spender: { owner: PROTOCOL, subaccount: [] },
    commitment: new Uint8Array(32).fill(7), quotedAtNs: 1n, cycles: fees.prepare,
  };
  function invoice(): EthereumInvoiceResult {
    return { order: { requestId: quote.request.requestId, state: { prepared: null }, lastError: [], items: quote.items },
      invoice: { id: 5n, owner: OWNER, requestId: quote.request.requestId, orderId: 4n, subaccount: new Uint8Array(32).fill(3),
        route: { chainId: 1n, minter: Principal.fromText("sv3dd-oaaaa-aaaar-qacoa-cai"), helper: HELPER, minterAddress: MINTER, token: TOKEN, ledger: LEDGER, decimals: 6 },
        payer: PAYER, quoteContent: new Uint8Array(encodeOpaque(checkoutType, quote)), saleAtoms: quote.amount, grossAtoms: quote.amount + quote.fee, sweepFee: quote.fee,
        canceledAtNs: [], acceptedReceiptId: [], entitlementGrantedAtNs: [], revenueFinalizedAtNs: [], currentSweepId: [], nextSweepOrdinal: 0n,
        creditedBuyerAtoms: 0n, lastBalance: [], lastBalanceAtNs: [], nextCheckAtNs: 0n, createdAtNs: 1n, updatedAtNs: 1n, lastError: [] },
      receipt: [], sweep: [], attempt: [], quote,
      payment: { amountAtoms: quote.amount + quote.fee, saleAtoms: quote.amount, sweepFeeAtoms: quote.fee,
        approve: { chainId: 1n, from: PAYER, to: TOKEN, value: 0n, data: "0x095ea7b3" },
        deposit: { chainId: 1n, from: PAYER, to: HELPER, value: 0n, data: "0x00" } },
      active: false, nextAction: { pay_ethereum: null }, entitled: false, earningsAvailable: false,
    };
  }
  const calls: Array<{ name: string; args: unknown[] }> = [];
  let current = invoice();
  let nextCursor: [] | [bigint] = [];
  const actualTransport = await import("../src/transport.ts");
  mock.module("../src/transport.ts", () => ({ ...actualTransport, makeAgent: async () => ({}), makeTransport: () => ({
    query: async (name: string, args: unknown[] = []) => {
      calls.push({ name, args });
      if (name === "marketplace_info") return info;
      if (name === "ethereum_fees") return fees;
      if (name === "ethereum_quote") return { ok: quote };
      if (name === "app_detail") return { err: { code: "app_unavailable", message: "Release revoked" } };
      if (name === "ethereum_status") return { ok: [current] };
      if (name === "ethereum_history") return { ok: { invoices: [current], nextCursor } };
      throw new Error(`Unexpected query ${name}`);
    },
    update: async () => { throw new Error("A checkout read must not dispatch an update"); },
  }) }));
  const { clearClient } = await import("../src/client.ts");
  const { ethereumQuote, ethereumFees, ethereumInvoiceView, ethereumOperationView, ethereumInvoiceStatus, ethereumStatus, ethereumHistory } = await import("../src/ethereum_client.ts");
  const context = { signal: new AbortController().signal, kernel: {
    querySelf: async () => ({ seed: [], canister: [PROTOCOL.toText()], host: "https://icp-api.io", owner: OWNER.toText(), revision: 1 }),
  } } as unknown as MsgBusToolContext;
  beforeEach(() => { clearClient(); calls.length = 0; current = invoice(); nextCursor = []; });

  test("the exact public Ethereum invoice Candid fields round-trip", () => {
    current.receipt = [{ id: 8n, invoiceId: 5n, eventKey: "1:hash:3", transactionHash: `0x${"12".repeat(32)}`, logIndex: 3n, blockNumber: 25_950_000n, blockHash: `0x${"34".repeat(32)}`, payer: PAYER, amount: current.invoice.grossAtoms, observedAtNs: 10n }];
    current.sweep = [{ id: 9n, invoiceId: 5n, ordinal: 0n, purpose: { sale: null }, amount: quote.amount, fee: quote.fee, attemptId: 10n, finalizedAtNs: [], createdAtNs: 10n, updatedAtNs: 10n }];
    current.attempt = [{ block: [], state: { outcome_unknown: null }, hadUnknown: true }];
    const decoded = IDL.decode([ethereumInvoiceResultType], IDL.encode([ethereumInvoiceResultType], [current]))[0] as EthereumInvoiceResult;
    expect(decoded.invoice.route).toEqual(current.invoice.route);
    expect(decoded.invoice).toEqual(current.invoice);
    expect(decoded.receipt).toEqual(current.receipt);
    expect(decoded.sweep).toEqual(current.sweep);
    expect(decoded.attempt).toEqual(current.attempt);
    expect(decoded.payment).toEqual(current.payment);
    expect(decoded.quote).toEqual(current.quote);
  });
  test("ethereum_fees is a plain record query and updates retain fixed fee versions", async () => {
    expect(await ethereumFees(context)).toEqual(fees);
    expect(IDL.decode(CONTRACT.ethereum_fees!.returns, IDL.encode([ethereumFeesType], [fees]))[0]).toEqual(fees);
    for (const [method, request] of Object.entries({
      ethereum_prepare: { quote, payer: PAYER, feeVersion: 2n },
      ethereum_verify: { requestId: quote.request.requestId, transactionHash: `0x${"12".repeat(32)}`, feeVersion: 2n },
      ethereum_settle: { requestId: quote.request.requestId, feeVersion: 2n }, ethereum_cancel: { requestId: quote.request.requestId, feeVersion: 2n },
    })) {
      expect(CONTRACT[method]!.update).toBe(true);
      expect(IDL.decode(CONTRACT[method]!.args, IDL.encode(CONTRACT[method]!.args, [request]))[0]).toEqual(request);
    }
  });
  test("Ethereum review prices USDC once without an IC approval fee or Wallet backend read", async () => {
    const view = await ethereumQuote(context, { appIds: ["saved_app"], affiliateCode: "  ", operationId: quote.request.requestId, ethereum: { wallet: "browser", payerAddress: PAYER } });
    expect(view.payment).toEqual({ atoms: "9000000", decimals: 6, symbol: "USDC" });
    expect(view.approvalFee).toEqual({ atoms: "0", decimals: 6, symbol: "USDC" });
    expect(view.collectionFee).toEqual({ atoms: "10000", decimals: 6, symbol: "USDC" });
    expect(view.totalDebit.atoms).toBe("9010000");
    expect(view.allocations.every(allocation => allocation.amount.symbol === "USDC")).toBe(true);
    expect(view.ethereum).toMatchObject({ wallet: "browser", chainId: "1", recipientPrincipal: PROTOCOL.toText(), prepareCycles: { total: "100" }, verifyCycles: { total: "50000000100" } });
    expect(view.ethereum!.helperAddress).toBeUndefined();
    expect(view.opaque).toEqual(encodeOpaque(checkoutType, quote));
    expect(calls.find(call => call.name === "ethereum_quote")!.args).toEqual([{ requestId: quote.request.requestId, appIds: ["saved_app"], ledger: LEDGER, referralCode: [] }]);
    expect(calls.map(call => call.name).sort()).toEqual(["app_detail", "ethereum_fees", "ethereum_quote", "marketplace_info"]);
  });
  test("a missing payer prevents an ambiguous checkout review", async () => {
    await expect(ethereumQuote(context, { appIds: ["saved_app"], affiliateCode: "", ethereum: { wallet: "browser" } })).rejects.toThrow("Select the Ethereum wallet");
    expect(calls).toEqual([]);
  });
  test("retained invoice metadata survives a revoked listing with frozen helper and amount", async () => {
    const view = await ethereumInvoiceView(context, current, "evm_wallet");
    expect(view.items[0]).toMatchObject({ id: "saved_app", publisher: PROTOCOL.toText(), priceUsdMicros: "9000000", version: "" });
    expect(view.warnings.some(warning => warning.includes("Current listing details"))).toBe(true);
    expect(view.ethereum).toMatchObject({ wallet: "evm_wallet", helperAddress: HELPER, minterAddress: MINTER });
    expect(view.opaque).toEqual(encodeOpaque(checkoutType, quote));
  });
  test("a retained invoice cannot change the saved checkout amount", async () => {
    current.invoice.grossAtoms += 1n;
    await expect(ethereumInvoiceView(context, current, "browser")).rejects.toThrow("amount differs");
  });
  test("verified entitlement completes app access while wrapping remains pending", () => {
    current.entitled = true; current.nextAction = { wait_wrapping: null };
    current.receipt = [{ id: 8n, invoiceId: 5n, eventKey: "receipt", transactionHash: `0x${"12".repeat(32)}`, logIndex: 3n, blockNumber: 25_950_000n, blockHash: `0x${"34".repeat(32)}`, payer: PAYER, amount: current.invoice.grossAtoms, observedAtNs: 10n }];
    expect(ethereumOperationView(current, "browser")).toMatchObject({ state: "complete", nextAction: "none", entitled: true, ethereumWallet: "browser", ethereumTransactionHash: current.receipt[0]!.transactionHash, settlement: { state: "pending" } });
    current.earningsAvailable = true;
    expect(ethereumOperationView(current).settlement?.state).toBe("complete");
  });
  test("an active invoice and an operator-review outcome never invite another payment", () => {
    current.active = true;
    expect(ethereumOperationView(current)).toMatchObject({ state: "pending", nextAction: "none", entitled: false });
    current.active = false; current.nextAction = { review_required: null };
    expect(ethereumOperationView(current)).toMatchObject({ state: "review_required", nextAction: "review", entitled: false });
    expect(ethereumOperationView(current).message).toContain("do not send another payment");
  });
  test("canceled invoices and missing entitlement never appear purchased", () => {
    current.invoice.canceledAtNs = [20n]; current.nextAction = { none: null };
    expect(ethereumOperationView(current)).toMatchObject({ state: "failed", nextAction: "none", entitled: false, checkoutCanceled: true });
    current.invoice.canceledAtNs = []; current.order.state = { complete: null }; current.nextAction = { none: null };
    expect(ethereumOperationView(current)).toMatchObject({ state: "pending", nextAction: "none", entitled: false });
    expect(ethereumOperationView(current).checkoutCanceled).toBeUndefined();
  });
  test("historical canceled invoices keep their quiet terminal status in status and history reads", async () => {
    current.invoice.canceledAtNs = [20n]; current.nextAction = { none: null }; current.invoice.lastBalance = [0n];
    expect(await ethereumStatus(context, current.invoice.requestId)).toMatchObject({ state: "failed", nextAction: "none", checkoutCanceled: true });
    expect((await ethereumHistory(context)).items[0]).toMatchObject({ state: "failed", nextAction: "none", checkoutCanceled: true });
  });
  test("background balance polling does not reopen an unpaid canceled invoice", () => {
    current.invoice.canceledAtNs = [20n]; current.nextAction = { none: null };
    for (const active of [false, true, false]) {
      current.active = active;
      expect(ethereumOperationView(current)).toMatchObject({ state: "failed", nextAction: "none", checkoutCanceled: true });
    }
  });
  for (const evidence of ["balance", "credit", "acceptedReceipt", "sweep", "priorSweep", "entitlement", "revenue", "review", "settle", "feeShortfall", "wrapping"] as const) test(`cancellation with ${evidence} is not treated as an unpaid terminal checkout`, () => {
    current.invoice.canceledAtNs = [20n]; current.nextAction = { none: null };
    if (evidence === "balance") current.invoice.lastBalance = [1n];
    if (evidence === "credit") current.invoice.creditedBuyerAtoms = 1n;
    if (evidence === "acceptedReceipt") current.invoice.acceptedReceiptId = [1n];
    if (evidence === "sweep") current.invoice.currentSweepId = [1n];
    if (evidence === "priorSweep") current.invoice.nextSweepOrdinal = 1n;
    if (evidence === "entitlement") current.invoice.entitlementGrantedAtNs = [1n];
    if (evidence === "revenue") current.invoice.revenueFinalizedAtNs = [1n];
    if (evidence === "review") current.nextAction = { review_required: null };
    if (evidence === "settle") current.nextAction = { settle: null };
    if (evidence === "feeShortfall") current.nextAction = { fee_shortfall: null };
    if (evidence === "wrapping") current.nextAction = { wait_wrapping: null };
    expect(ethereumOperationView(current).checkoutCanceled).toBeUndefined();
    current.active = true;
    expect(ethereumOperationView(current).checkoutCanceled).toBeUndefined();
  });
  test("a canceled invoice with late funds can still resume buyer-credit settlement", () => {
    current.invoice.canceledAtNs = [20n]; current.nextAction = { settle: null };
    expect(ethereumOperationView(current)).toMatchObject({ state: "failed", nextAction: "resume", entitled: false, settlement: { state: "pending" } });
    expect(ethereumOperationView(current).checkoutCanceled).toBeUndefined();
    current.active = true;
    expect(ethereumOperationView(current).nextAction).toBe("none");
  });
  test("status and paginated history preserve original identities using queries only", async () => {
    expect(await ethereumInvoiceStatus(context, quote.request.requestId)).toEqual(current);
    expect(await ethereumStatus(context, quote.request.requestId)).toMatchObject({ operationId: quote.request.requestId, entitled: false });
    nextCursor = [17n];
    const page = await ethereumHistory(context, "23");
    expect(page.nextCursor).toBe("17"); expect(page.items[0]!.operationId).toBe(quote.request.requestId);
    expect(calls.find(call => call.name === "ethereum_history")!.args).toEqual([{ cursor: [23n], limit: 24n }]);
  });
}
