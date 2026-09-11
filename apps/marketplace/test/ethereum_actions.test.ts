import { beforeEach, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Principal } from "@dfinity/principal";
import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import { checkoutType, encodeOpaque, type Checkout, type Fee } from "../src/protocol.ts";
import type { EthereumFees, EthereumInvoiceResult } from "../src/ethereum_protocol.ts";
import type { EthereumFundingKind, EthereumFundingJournal, EthereumFundingPlan, EthereumFundingRecord } from "../src/ethereum.ts";
import type { PurchaseQuote, EthereumWalletSource } from "../src/view-types.ts";

if (process.env.NEUTRON_MARKETPLACE_ETHEREUM_ACTIONS_CHILD !== "1") {
  test("Ethereum purchase authority, durable funding and independent verification", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NEUTRON_MARKETPLACE_ETHEREUM_ACTIONS_CHILD: "1" }, timeout: 30_000,
      });
      expect(result.stderr).toContain("0 fail");
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  }, 35_000);
} else {
  const actualClient = await import("../src/client.ts");
  const actualEthereum = await import("../src/ethereum.ts");
  const actualEthereumClient = await import("../src/ethereum_client.ts");
  const OWNER = "3rurp-vyaaa-aaaay-aacua-cai", PROTOCOL = "233tv-xiaaa-aaaay-aacta-cai", LEDGER = "xevnm-gaaaa-aaaar-qafnq-cai", ID = "aa".repeat(16);
  const PAYER = "0xe70ab51ef2d86e70d834b4ac809d75e362ca23f2", HELPER = "0x18901044688D3756C35Ed2b36D93e6a5B8e00E68", MINTER = "0xb25eA1D493B49a1DeD42aC5B1208cC618f9A9B80", TOKEN = actualEthereum.ETHEREUM_USDC;
  const principal = (text: string) => Principal.fromText(text), bytes = new Uint8Array(32).fill(3);
  const fee: Fee = { feeVersion: 1n, processingCycles: 100n, totalCycles: 100n, storageCycles: 0n, processingBytes: 0n, newStorageBytes: 0n };
  const fees: EthereumFees = { prepare: fee, verify: { ...fee, totalCycles: 500n, processingCycles: 500n }, settle: fee, cancel: fee };
  const wire: Checkout = { request: { requestId: ID, appIds: ["sample"], ledger: principal(LEDGER), referralCode: [] }, buyer: principal(OWNER), items: [{ appId: "sample", listingRevision: 1n, publisher: principal(PROTOCOL), priceUsdMicros: 1_000_000n, paidAtoms: 1_000_000n, developerAtoms: 300_000n, affiliateAtoms: 0n, burnAtoms: 700_000n, releaseDigest: bytes }], amount: 1_000_000n, fee: 10_000n, affiliate: [], rate: [], spender: { owner: principal(PROTOCOL), subaccount: [] }, commitment: bytes, cycles: fee, quotedAtNs: 1n };
  const money = (amount: bigint) => ({ atoms: String(amount), decimals: 6, symbol: "USDC" });
  function quote(source: EthereumWalletSource = "evm_wallet", frozen = false): PurchaseQuote {
    return { operationId: ID, commitment: actualClient.hex(bytes), appIds: ["sample"], items: [], token: "ckUSDC", subtotalUsdMicros: "1000000", discountUsdMicros: "0", payment: money(wire.amount), approvalFee: money(0n), collectionFee: money(wire.fee), totalDebit: money(wire.amount + wire.fee), allocations: [], cycles: actualClient.cycleView(fee), affiliateCode: "", warnings: [], opaque: encodeOpaque(checkoutType, wire), ethereum: { wallet: source, chainId: "1", payerAddress: PAYER, tokenAddress: TOKEN, recipientPrincipal: PROTOCOL, wrappingFee: money(wire.fee), prepareCycles: actualClient.cycleView(fee), verifyCycles: actualClient.cycleView(fees.verify), ...(frozen ? { helperAddress: HELPER, minterAddress: MINTER } : {}) } };
  }
  function fixture(): EthereumInvoiceResult {
    const route = { chainId: "1", tokenAddress: TOKEN, helperAddress: HELPER, minterAddress: MINTER, recipientPrincipal: PROTOCOL };
    const funding = actualEthereum.buildEthereumFundingPlan({ operationId: ID, amountAtoms: String(wire.amount + wire.fee), payerAddress: PAYER, principalWord: actualEthereum.principalToEthereumWord(PROTOCOL), subaccountWord: `0x${Buffer.from(bytes).toString("hex")}`, route }, route, { approval: "01".repeat(16), deposit: "02".repeat(16) });
    const transaction = (kind: EthereumFundingKind) => ({ ...funding.steps[kind].transaction, chainId: 1n, value: 0n });
    return { order: { requestId: ID, state: { prepared: null }, lastError: [], items: wire.items }, invoice: { id: 1n, owner: principal(OWNER), requestId: ID, orderId: 1n, subaccount: bytes, route: { chainId: 1n, minter: principal("sv3dd-oaaaa-aaaar-qacoa-cai"), helper: HELPER, minterAddress: MINTER, token: TOKEN, ledger: principal(LEDGER), decimals: 6 }, payer: PAYER, quoteContent: new Uint8Array(encodeOpaque(checkoutType, wire)), saleAtoms: wire.amount, grossAtoms: wire.amount + wire.fee, sweepFee: wire.fee, canceledAtNs: [], acceptedReceiptId: [], entitlementGrantedAtNs: [], revenueFinalizedAtNs: [], currentSweepId: [], nextSweepOrdinal: 0n, creditedBuyerAtoms: 0n, lastBalance: [], lastBalanceAtNs: [], nextCheckAtNs: 0n, createdAtNs: 1n, updatedAtNs: 1n, lastError: [] }, receipt: [], sweep: [], attempt: [], quote: wire, payment: { amountAtoms: wire.amount + wire.fee, saleAtoms: wire.amount, sweepFeeAtoms: wire.fee, approve: transaction("approval"), deposit: transaction("deposit") }, active: false, nextAction: { pay_ethereum: null }, entitled: false, earningsAvailable: false };
  }
  let stored: Map<string, Uint8Array>, events: string[], reviews: JsonObject[], updates: string[], sends: EthereumFundingKind[], observations: EthereumFundingKind[];
  let status: EthereumInvoiceResult | null, prepared: EthereumInvoiceResult, idCounter: number, ownerApproved: boolean, lostClaimReply: boolean;
  let states: Record<EthereumFundingKind, EthereumFundingRecord["state"]>, approvalRequired: boolean;
  const opKey = `ethereum:operation:${ID}`, stepKey = (kind: EthereumFundingKind) => `ethereum:step:${ID}:${kind}`;
  const saved = (id = opKey) => stored.has(id) ? JSON.parse(new TextDecoder().decode(stored.get(id)!)) : null;
  const client = { state: { owner: OWNER, canisterId: PROTOCOL }, info: { canister: principal(PROTOCOL) },
    update: async (name: string, request: Record<string, unknown>, estimate: Fee) => {
      updates.push(name); events.push(`update:${name}`);
      expect(saved()).not.toBeNull();
      if (name === "ethereum_prepare") { expect(estimate).toEqual(fees.prepare); expect(request.payer).toBe(PAYER); status = prepared; return status; }
      if (name === "ethereum_settle") {
        expect(estimate).toEqual(fees.settle); expect(status?.receipt.length).toBe(1);
        status = { ...prepared, entitled: true, nextAction: { wait_wrapping: null } }; return status;
      }
      if (name === "ethereum_verify") {
        expect(saved(stepKey("deposit"))?.record.state).toBe("confirmed");
        expect(request.transactionHash).toBe(saved(stepKey("deposit")).record.transactionHash);
        expect(estimate).toEqual(fees.verify); status = { ...prepared, entitled: true, nextAction: { wait_wrapping: null } }; return status;
      }
      throw new Error(`Unexpected update ${name}`);
    },
  };
  mock.module("../src/client.ts", () => ({ ...actualClient, protocolClient: async () => client, randomId: () => (++idCounter).toString(16).padStart(32, "0") }));
  mock.module("../src/ethereum_client.ts", () => ({ ...actualEthereumClient,
    ethereumQuote: async (_context: unknown, input: { ethereum: { wallet: EthereumWalletSource } }) => { events.push("quote"); return quote(input.ethereum.wallet); },
    ethereumInvoiceView: async (_context: unknown, result: EthereumInvoiceResult, source: EthereumWalletSource) => ({ ...quote(source, true), affiliateCode: result.quote.request.referralCode[0] ?? "" }),
    ethereumInvoiceStatus: async () => { events.push("status"); return status; }, ethereumFees: async () => fees,
  }));
  mock.module("../src/ethereum.ts", () => ({ ...actualEthereum,
    createEthereumFundingWallet: () => ({ accounts: async () => ({ accounts: [{ accountId: "main", address: PAYER }] }) }),
    readEthereumFundingWalletState: async () => ({ allowanceAtoms: approvalRequired ? "0" : String(wire.amount + wire.fee), balanceAtoms: "10000000", approvalRequired }),
    executeEvmFundingStep: async (plan: EthereumFundingPlan, kind: EthereumFundingKind, _wallet: unknown, journal: EthereumFundingJournal) => {
      observations.push(kind); events.push(`funding:${kind}`); expect(saved()?.plan).toEqual(plan);
      const old = await journal.read(kind);
      if (old?.state === "confirmed") return old;
      const initial: EthereumFundingRecord = { version: 1, invoiceId: ID, source: "evm_wallet", step: plan.steps[kind], state: "unknown", transactionHash: null, walletIntent: null, receipt: null, message: "Unknown" };
      const record = old ?? (await journal.claim(initial)).record;
      if (!old) { sends.push(kind); expect(saved(stepKey(kind))?.record).toEqual(initial); }
      const state = states[kind], hash = `0x${(kind === "approval" ? "11" : "22").repeat(32)}` as `0x${string}`;
      return journal.record(record, { ...record, state, transactionHash: state === "unknown" ? null : hash, message: state === "confirmed" ? "Confirmed" : "Pending" });
    },
  }));
  const { quoteEthereumPurchase, runEthereumPurchase, resumeEthereumPurchase, prepareEthereumBrowser, ethereumJournalClaim, ethereumJournalRecord, finishEthereumBrowser, ethereumSavedStatus } = await import("../src/ethereum_actions.ts");
  function context(root = false): MsgBusToolContext {
    return { agentMode: root, signal: new AbortController().signal,
      caller: { appId: root ? "agent" : "marketplace", installationUid: "install-1", role: root ? "background" : "tile", endpoint: root ? "app:agent:background" : "app:marketplace:tile:main:instance:test" },
      requestApproval: async (review: JsonObject) => { events.push("root_review"); reviews.push(review); },
      kernel: {
        querySelf: async (name: string, args: string[]) => { if (name !== "marketplace_draft") throw new Error(`Unexpected query ${name}`); return stored.has(args[0]!) ? [stored.get(args[0]!)] : []; },
        updateSelf: async (name: string, args: Array<{ id: string; value: Uint8Array; expected?: Uint8Array; revision?: string }>) => {
          const arg = args[0]!;
          if (name === "marketplace_save_draft") {
            const old = stored.get(arg.id);
            if (old && Buffer.compare(old, arg.value) !== 0) return { err: "Existing retained intent differs" };
            stored.set(arg.id, new Uint8Array(arg.value)); events.push(`save:${arg.id}`);
            if (lostClaimReply && arg.id.startsWith("ethereum:step:")) { lostClaimReply = false; throw new Error("Reply lost after durable claim"); }
            return { ok: arg.id };
          }
          if (name === "marketplace_revise_draft") {
            if (!stored.has(arg.id) || Buffer.compare(stored.get(arg.id)!, arg.expected!) !== 0) return { err: "Retained revision changed" };
            stored.set(`history:${arg.id}:${arg.revision}`, new Uint8Array(stored.get(arg.id)!)); stored.set(arg.id, new Uint8Array(arg.value)); events.push(`revise:${arg.id}`); return { ok: arg.id };
          }
          throw new Error(`Unexpected update ${name}`);
        },
        callTool: async (request: { name: string; arguments: { reviewJson: string } }) => { expect(request.name).toBe("marketplace_owner_review_v1"); events.push("owner_review"); reviews.push(JSON.parse(request.arguments.reviewJson)); return { approved: ownerApproved }; },
      },
    } as unknown as MsgBusToolContext;
  }
  beforeEach(() => { stored = new Map(); events = []; reviews = []; updates = []; sends = []; observations = []; status = null; prepared = fixture(); idCounter = 0; ownerApproved = true; lostClaimReply = false; approvalRequired = true; states = { approval: "confirmed", deposit: "submitted" }; });

  test("saved Ethereum quote retains its original discount when omitted", async () => {
    const retained = { ...quote("browser"), affiliateCode: "ORIGINAL" };
    stored.set(opKey, new TextEncoder().encode(JSON.stringify({ version: 1, kind: "ethereum_purchase", scope: { canister: PROTOCOL, owner: OWNER, callerApp: "marketplace", installation: "install-1", root: false }, quote: retained, source: "browser" })));
    const input = { operationId: ID, appIds: ["sample"], ethereum: { wallet: "browser" as const, payerAddress: PAYER } };
    expect(await quoteEthereumPurchase(context(), input)).toEqual(retained);
    await expect(quoteEthereumPurchase(context(), { ...input, affiliateCode: "NEW" })).rejects.toThrow("original Ethereum invoice");
    expect(events).toEqual([]); expect(updates).toEqual([]); expect(sends).toEqual([]);
  });
  test("Ethereum quote recovers the remote original discount before resolving a new default", async () => {
    status = { ...prepared, quote: { ...prepared.quote, request: { ...prepared.quote.request, referralCode: ["ORIGINAL"] } } };
    const input = { operationId: ID, appIds: ["sample"], ethereum: { wallet: "browser" as const, payerAddress: PAYER } };
    expect((await quoteEthereumPurchase(context(), input)).affiliateCode).toBe("ORIGINAL");
    await expect(quoteEthereumPurchase(context(), { ...input, ethereum: { ...input.ethereum, payerAddress: "0x1111111111111111111111111111111111111111" } })).rejects.toThrow("original apps and payer");
    expect(events).toEqual(["status", "status"]); expect(updates).toEqual([]); expect(sends).toEqual([]);
  });
  test("invoice and exact owner review are durable before the first funding call", async () => {
    const result = await runEthereumPurchase(context(), quote());
    expect(result.state).toBe("pending"); expect(updates).toEqual(["ethereum_prepare"]);
    expect(events.indexOf(`save:${opKey}`)).toBeLessThan(events.indexOf("update:ethereum_prepare"));
    expect(events.indexOf("update:ethereum_prepare")).toBeLessThan(events.indexOf("owner_review"));
    expect(events.indexOf("owner_review")).toBeLessThan(events.indexOf(`revise:${opKey}`));
    expect(events.indexOf(`revise:${opKey}`)).toBeLessThan(events.indexOf("funding:approval"));
    expect((reviews[0]!.quote as any).ethereum).toMatchObject({ helperAddress: HELPER, minterAddress: MINTER });
    expect(sends).toEqual(["approval", "deposit"]);
  });
  test("root exact reviews precede protocol preparation and payment without a tile prompt", async () => {
    states.deposit = "confirmed";
    expect((await runEthereumPurchase(context(true), quote())).state).toBe("complete");
    expect(events.filter(event => event === "root_review")).toHaveLength(2);
    expect(events).not.toContain("owner_review");
    expect(events.indexOf("root_review")).toBeLessThan(events.indexOf("update:ethereum_prepare"));
    expect(updates).toEqual(["ethereum_prepare", "ethereum_verify"]);
  });
  for (const field of ["data", "to", "from", "chainId", "value"] as const) test(`a mismatched protocol deposit ${field} cannot dispatch Wallet funding`, async () => {
    Object.assign(prepared.payment.deposit, { [field]: field === "data" ? "0xdeadbeef" : field === "chainId" ? 42161n : field === "value" ? 1n : "0x4444444444444444444444444444444444444444" });
    await expect(runEthereumPurchase(context(), quote())).rejects.toThrow("does not match its frozen Ethereum invoice");
    expect(sends).toEqual([]); expect(observations).toEqual([]); expect(saved().plan).toBeNull();
  });
  test("declining the frozen route review leaves an invoice but never funds it", async () => {
    ownerApproved = false;
    await expect(runEthereumPurchase(context(), quote())).rejects.toThrow("declined before dispatch");
    expect(updates).toEqual(["ethereum_prepare"]); expect(sends).toEqual([]); expect(saved().plan).toBeNull();
  });
  for (const change of ["caller", "installation", "mode", "owner", "protocol"] as const) test(`a saved payment cannot move to another ${change} scope`, async () => {
    await runEthereumPurchase(context(), quote()); const count = observations.length;
    const altered = context();
    if (change === "caller") altered.caller = { ...altered.caller!, appId: "other-app" };
    if (change === "installation") altered.caller = { ...altered.caller!, installationUid: "install-2" };
    if (change === "mode") altered.agentMode = true;
    const oldOwner = client.state.owner, oldCanister = client.state.canisterId;
    if (change === "owner") client.state.owner = PROTOCOL;
    if (change === "protocol") client.state.canisterId = OWNER;
    try { await expect(resumeEthereumPurchase(altered, ID)).rejects.toThrow("original application, Neutron, marketplace and agent mode"); }
    finally { client.state.owner = oldOwner; client.state.canisterId = oldCanister; }
    expect(observations).toHaveLength(count);
  });
  test("only a confirmed deposit triggers protocol verification; approval and pending deposit cannot grant access", async () => {
    const ctx = context(); states.approval = "submitted";
    expect((await runEthereumPurchase(ctx, quote())).state).toBe("pending"); expect(sends).toEqual(["approval"]); expect(updates).toEqual(["ethereum_prepare"]);
    states.approval = "confirmed";
    expect((await resumeEthereumPurchase(ctx, ID)).state).toBe("pending"); expect(sends).toEqual(["approval", "deposit"]); expect(updates).toEqual(["ethereum_prepare"]);
    states.deposit = "confirmed";
    expect(await resumeEthereumPurchase(ctx, ID)).toMatchObject({ state: "complete", entitled: true, settlement: { state: "pending" } });
    expect(sends).toEqual(["approval", "deposit"]); expect(updates).toEqual(["ethereum_prepare", "ethereum_verify"]);
  });
  test("an exact existing allowance skips the approval and still requires deposit verification", async () => {
    approvalRequired = false; states.deposit = "confirmed";
    expect((await runEthereumPurchase(context(), quote())).state).toBe("complete");
    expect(sends).toEqual(["deposit"]); expect(saved(stepKey("approval"))).toBeNull();
    expect(updates).toEqual(["ethereum_prepare", "ethereum_verify"]);
  });
  test("a protocol entitlement ends the purchase without repeating payment while wrapping is pending", async () => {
    const ctx = context(); await runEthereumPurchase(ctx, quote()); const count = observations.length;
    status = { ...prepared, entitled: true, nextAction: { wait_wrapping: null } };
    expect(await resumeEthereumPurchase(ctx, ID)).toMatchObject({ state: "complete", entitled: true, settlement: { state: "pending" } });
    expect(await ethereumSavedStatus(ctx, ID)).toMatchObject({ state: "complete", entitled: true });
    expect(observations).toHaveLength(count); expect(updates).toEqual(["ethereum_prepare"]);
  });
  test("a saved protocol receipt takes cheap settlement without resending or re-verifying Ethereum", async () => {
    const ctx = context(); await runEthereumPurchase(ctx, quote()); const count = observations.length;
    status = { ...prepared, nextAction: { settle: null }, receipt: [{ id: 2n, invoiceId: 1n, eventKey: "saved-proof", transactionHash: `0x${"22".repeat(32)}`, logIndex: 0n, blockNumber: 25_950_000n, blockHash: `0x${"33".repeat(32)}`, payer: PAYER, amount: wire.amount + wire.fee, observedAtNs: 10n }] };
    expect(await resumeEthereumPurchase(ctx, ID)).toMatchObject({ state: "complete", entitled: true });
    expect(observations).toHaveLength(count); expect(sends).toEqual(["approval", "deposit"]);
    expect(updates).toEqual(["ethereum_prepare", "ethereum_settle"]);
  });
  test("agents cannot use the owner-only browser funding path", async () => {
    await expect(prepareEthereumBrowser(context(true), quote("browser"))).rejects.toThrow("owner's Marketplace tile");
    const external = context(); external.caller = { ...external.caller!, appId: "agent", role: "background" };
    await expect(prepareEthereumBrowser(external, quote("browser"))).rejects.toThrow("owner's Marketplace tile");
    await expect(runEthereumPurchase(context(true), quote("browser"))).rejects.toThrow("connected Marketplace tile");
    expect(updates).toEqual([]); expect(stored.size).toBe(0);
  });
  async function browserRecord() {
    const ctx = context(), { plan } = await prepareEthereumBrowser(ctx, quote("browser"));
    const record: EthereumFundingRecord = { version: 1, invoiceId: ID, source: "browser", step: plan.steps.deposit, state: "unknown", transactionHash: null, walletIntent: null, receipt: null, message: null };
    return { ctx, record };
  }
  async function rejectedBrowserRecord() {
    const { ctx, record } = await browserRecord();
    await ethereumJournalClaim(ctx, ID, record);
    await ethereumJournalRecord(ctx, ID, record, { ...record, state: "rejected", message: "The browser wallet declined this transaction before submission." });
    return ctx;
  }
  test("a retained browser refusal is marked pre-submission without canceling the protocol invoice", async () => {
    const ctx = await rejectedBrowserRecord(), before = stored.size;
    expect(await ethereumSavedStatus(ctx, ID)).toMatchObject({ state: "failed", ethereumWallet: "browser", canceledBeforeSubmission: true });
    expect(saved(stepKey("deposit")).record).toMatchObject({ state: "rejected", transactionHash: null });
    expect(stored.size).toBe(before); expect(updates).toEqual(["ethereum_prepare"]); expect(sends).toEqual([]);
  });
  test("remote buyer-credit settlement outranks a stale local browser refusal", async () => {
    const ctx = await rejectedBrowserRecord();
    status = { ...prepared, invoice: { ...prepared.invoice, canceledAtNs: [15n] }, nextAction: { settle: null } };
    const result = await ethereumSavedStatus(ctx, ID);
    expect(result).toMatchObject({ state: "failed", settlement: { state: "pending" }, nextAction: "resume" });
    expect(result?.canceledBeforeSubmission).toBeUndefined();
    expect(updates).toEqual(["ethereum_prepare"]); expect(sends).toEqual([]);
  });
  test("remote receipt outranks a stale local browser refusal and keeps the original transaction hash", async () => {
    const ctx = await rejectedBrowserRecord(), transactionHash = `0x${"33".repeat(32)}`;
    status = { ...prepared, receipt: [{ id: 3n, invoiceId: 1n, eventKey: "remote-receipt", transactionHash, logIndex: 0n, blockNumber: 25_950_000n, blockHash: `0x${"44".repeat(32)}`, payer: PAYER, amount: wire.amount + wire.fee, observedAtNs: 10n }] };
    const result = await ethereumSavedStatus(ctx, ID);
    expect(result?.ethereumTransactionHash).toBe(transactionHash);
    expect(result?.canceledBeforeSubmission).toBeUndefined();
    expect(updates).toEqual(["ethereum_prepare"]); expect(sends).toEqual([]);
  });
  for (const evidence of ["balance", "sweep", "credit", "acceptedReceipt", "wrapping", "review", "feeShortfall"] as const) test(`remote ${evidence} evidence cannot be hidden by a stale local browser refusal`, async () => {
    const ctx = await rejectedBrowserRecord();
    status = { ...prepared, invoice: { ...prepared.invoice } };
    if (evidence === "balance") status.invoice.lastBalance = [1n];
    if (evidence === "sweep") status.invoice.currentSweepId = [4n];
    if (evidence === "credit") status.invoice.creditedBuyerAtoms = 1n;
    if (evidence === "acceptedReceipt") status.invoice.acceptedReceiptId = [4n];
    if (evidence === "wrapping") status.nextAction = { wait_wrapping: null };
    if (evidence === "review") status.nextAction = { review_required: null };
    if (evidence === "feeShortfall") status.nextAction = { fee_shortfall: null };
    expect((await ethereumSavedStatus(ctx, ID))?.canceledBeforeSubmission).toBeUndefined();
    expect(updates).toEqual(["ethereum_prepare"]); expect(sends).toEqual([]);
  });
  test("two same-record claim writers get exactly one winner through unique claim nonces", async () => {
    const { ctx, record } = await browserRecord();
    const claims = await Promise.all([ethereumJournalClaim(ctx, ID, record), ethereumJournalClaim(ctx, ID, record)]);
    expect(claims.filter(claim => claim.claimed)).toHaveLength(1);
    expect(claims.every(claim => JSON.stringify(claim.record) === JSON.stringify(record))).toBe(true);
    expect(saved(stepKey("deposit")).claimNonce).toMatch(/^[0-9a-f]{32}$/);
  });
  test("a lost durable claim reply recovers only its exact winning claim nonce", async () => {
    const { ctx, record } = await browserRecord(); lostClaimReply = true;
    expect((await ethereumJournalClaim(ctx, ID, record)).claimed).toBe(true);
    expect((await ethereumJournalClaim(ctx, ID, record)).claimed).toBe(false);
  });
  test("browser completion requires its retained confirmed deposit before independent verification", async () => {
    const { ctx, record } = await browserRecord();
    await ethereumJournalClaim(ctx, ID, record);
    expect((await finishEthereumBrowser(ctx, ID)).state).toBe("pending"); expect(updates).toEqual(["ethereum_prepare"]);
    const confirmed: EthereumFundingRecord = { ...record, state: "confirmed", transactionHash: `0x${"22".repeat(32)}` };
    await ethereumJournalRecord(ctx, ID, record, confirmed);
    expect(await finishEthereumBrowser(ctx, ID)).toMatchObject({ state: "complete", entitled: true });
    expect(updates).toEqual(["ethereum_prepare", "ethereum_verify"]);
  });
}
