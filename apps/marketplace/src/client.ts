import { Ed25519KeyIdentity } from "@dfinity/identity";
import type { Identity } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { IDL } from "@dfinity/candid";
import { isJsonObject, type MsgBusToolContext } from "neutron-tools/app";
import { readIdentity, readState, configureState, readDiscountCode, saveDiscountCode, loadIntent, type StoredState } from "./store.ts";
import { createDiscountPreferences, type ReferralQuote } from "./discount.ts";
import { makeAgent, makeTransport } from "./transport.ts";
import { readAccess } from "./read_access.ts";
import { CONTRACT, first, some, encodeOpaque, checkoutType, withdrawalType, type Info, type WireApp, type Fee, type Checkout, type WithdrawQuote, type WireResult, type Option, type Token } from "./protocol.ts";
import { readWalletTokenInfo } from "./wallet.ts";
import type { AppDetail, AppListing, Page, LibraryApp, PublishedApp, Earnings, Session, Money, CycleEstimate, OperationResult, PurchaseQuote, WithdrawalQuote, PaymentToken, AppTier, RankingWindow } from "./view-types.ts";

export class ProtocolError extends Error { constructor(public readonly code: string, message: string) { super(message); } }
export function response<T>(value: { ok: T } | { err: { code: string; message: string } }): T {
  if ("err" in value) throw new ProtocolError(value.err.code, value.err.message);
  return value.ok;
}
export function randomId(): string { return [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, "0")).join(""); }
export function date(ns: bigint): string { return new Date(Number(ns / 1_000_000n)).toISOString(); }
export function hex(value: Uint8Array): string { return [...value].map(x => x.toString(16).padStart(2, "0")).join(""); }
export function cycleView(fee: Fee): CycleEstimate { return { total: String(fee.totalCycles), processing: String(fee.processingCycles), storage: String(fee.storageCycles), schedule: String(fee.feeVersion) }; }
export function money(token: Token, value: bigint): Money { return { atoms: String(value), decimals: token.decimals, symbol: token.symbol }; }
export function operationView(result: WireResult): OperationResult {
  const operation = result.order ?? result.withdrawal;
  if (!operation) throw new Error("The protocol returned no operation record.");
  const block = first(result.attempt)?.block[0];
  const identity = { operationId: operation.requestId, ...(block !== undefined ? { ledgerBlock: String(block) } : {}) };
  const state = Object.keys(operation.state)[0];
  const next = Object.keys(result.nextAction ?? {})[0];
  const detail = first(operation.lastError);
  if (state === "complete") return { ...identity, state: "complete", nextAction: "none", message: result.order ? "Your apps are in My Apps and can be installed anytime." : "Withdrawal confirmed.", ...(operation.items ? { appIds: operation.items.map(i => i.appId) } : {}) };
  if (result.active || next === "await_current_call") return { ...identity, state: "pending", nextAction: "none", message: detail ?? "The original ledger call is still active. Status will refresh without sending another payment." };
  if (next === "review_required") return { ...identity, state: "pending", nextAction: "none", message: `${detail ?? "The original ledger outcome is unresolved and needs operator review."} Do not send another payment; retain this operation ID.` };
  if (state === "failed") return { ...identity, state: "failed", nextAction: "review", message: detail ?? "The operation was not completed. Review the saved request before trying again." };
  return { ...identity, state: "pending", nextAction: "resume", message: detail ?? "The original operation is still being reconciled. Resume this request without starting another payment." };
}
type Detail = { app: WireApp; candidate: Option<{ id: bigint; version: bigint; digest: Uint8Array; state: Record<string, null>; createdAtNs: bigint }>; audit: Option<{ auditor: Principal; decision: Record<string, null>; analysis: string; reason: Option<string>; createdAtNs: bigint }>; rating: Option<{ stars: bigint; review: string }> };
let savedState: StoredState | null = null;
let stateFlight: Promise<StoredState> | null = null;
let connected = false;
let browserReadIdentity: Identity | null = null;
let clientGeneration = 0;
let connectionFlight: { generation: number; promise: Promise<Session> } | null = null;
let agentCache: { key: string; agent: Awaited<ReturnType<typeof makeAgent>> } | null = null;
let infoCache: { key: string; info: Promise<Info> } | null = null;
let discountCache: { key: string; preference: ReturnType<typeof createDiscountPreferences> } | null = null;
let installedAppsFlight: Promise<ReadonlySet<string>> | null = null;

async function installedApps(context: MsgBusToolContext): Promise<ReadonlySet<string> | null> {
  context.signal?.throwIfAborted();
  // Concurrent storefront sections share one Kernel read. Keep no completed
  // snapshot, so opening another listing observes installs and uninstalls.
  if (!installedAppsFlight) {
    const flight = Promise.resolve().then(() => context.kernel.listApps()).then(apps => {
      if (!isJsonObject(apps) || !Array.isArray(apps.apps)) throw new Error("Installed app information is unavailable.");
      return new Set(apps.apps.flatMap(app => isJsonObject(app) && typeof app.id === "string" ? [app.id] : []));
    }).finally(() => { if (installedAppsFlight === flight) installedAppsFlight = null; });
    installedAppsFlight = flight;
  }
  try {
    const apps = await installedAppsFlight;
    context.signal?.throwIfAborted();
    return apps;
  } catch {
    context.signal?.throwIfAborted();
    return null;
  }
}

async function currentState(context: MsgBusToolContext): Promise<StoredState> {
  if (savedState) return savedState;
  if (!stateFlight) {
    const generation = clientGeneration;
    stateFlight = readState(context.kernel).then(s => { if (generation === clientGeneration) savedState = s; return s; }).finally(() => { if (generation === clientGeneration) stateFlight = null; });
  }
  return stateFlight;
}
export function session(state: StoredState): Session { return { configured: state.canisterId !== null, canisterId: state.canisterId ?? "", host: state.host, account: state.owner, connected }; }
export function clearClient(): void { clientGeneration++; savedState = null; stateFlight = null; connected = false; browserReadIdentity = null; connectionFlight = null; agentCache = null; infoCache = null; discountCache = null; installedAppsFlight = null; }
export async function configured(context: MsgBusToolContext, input: { canisterId: string; host: string }): Promise<Session> {
  const state = await configureState(context.kernel, input); clearClient(); savedState = state; return session(state);
}
export async function protocolClient(context: MsgBusToolContext) {
  const generation = clientGeneration;
  const state = await currentState(context);
  if (!state.canisterId) throw new Error("Marketplace configuration is unavailable. Update the app and retry setup.");
  const key = `${state.host}:${state.canisterId}:${state.revision}:${browserReadIdentity?.getPrincipal().toText() ?? "legacy"}`;
  if (!agentCache || agentCache.key !== key) agentCache = { key, agent: await makeAgent(state, browserReadIdentity ?? (state.seed ? Ed25519KeyIdentity.generate(state.seed) : undefined)) };
  const transport = makeTransport({ canisterId: state.canisterId, agent: agentCache.agent, contract: CONTRACT, kernel: context.kernel });
  if (!infoCache || infoCache.key !== key) infoCache = { key, info: transport.query<Info>("marketplace_info").catch(error => { if (infoCache?.key === key) infoCache = null; throw error; }) };
  const info = await infoCache.info;
  if (info.canister.toText() !== state.canisterId) throw new Error("The marketplace returned a different canister identity.");
  const token = (symbol: PaymentToken | string): Token => {
    const value = info.tokens.find(t => t.symbol === symbol);
    if (!value) throw new Error(`${symbol} is not accepted by this marketplace.`);
    return value;
  };
  async function query<T>(name: string, args: unknown[] = []): Promise<T> { return response(await transport.query(name, args)); }
  const discountKey = `${state.owner}:${state.host}:${state.canisterId}:${state.revision}:${generation}`;
  if (!discountCache || discountCache.key !== discountKey) discountCache = { key: discountKey, preference: createDiscountPreferences() };
  const preference = discountCache.preference;
  const discountAccess = {
    owner: state.owner,
    read: () => readDiscountCode(context.kernel),
    save: (code: string | null) => saveDiscountCode(context.kernel, code),
    validate: (code: string) => query<ReferralQuote>("referral_quote", [code]),
    checkCurrent: () => {
      context.signal?.throwIfAborted();
      if (generation !== clientGeneration) throw new Error("The marketplace account changed. Refresh before changing or using its discount.");
    },
  };
  async function fee(operation = "update", processingBytes = 0n, newStorageBytes = 0n): Promise<Fee> {
    const schedule = info.fees;
    const base = ["purchase", "withdraw", "grant"].includes(operation) ? schedule[operation] : schedule.updateBase;
    if (base === undefined || schedule.version === undefined || schedule.updateByte === undefined || schedule.storageByteYear === undefined) throw new Error("The marketplace fixed cycle schedule is incomplete.");
    const processingCycles = base + processingBytes * schedule.updateByte, storageCycles = newStorageBytes * schedule.storageByteYear;
    return { feeVersion: schedule.version, processingCycles, storageCycles, totalCycles: processingCycles + storageCycles, processingBytes, newStorageBytes };
  }
  async function update<T>(name: string, request: Record<string, unknown>, quote?: Fee): Promise<T> {
    const estimate = quote ?? await estimateUpdate(name, request);
    context.signal?.throwIfAborted();
    // Production routes are reviewed and granted during installation. Keep
    // the runtime path for a custom protocol or explicitly revoked access.
    await transport.reserve();
    context.signal?.throwIfAborted();
    if (generation !== clientGeneration) throw new Error("Marketplace settings changed during setup. Retry using the current marketplace.");
    return response(await transport.update(name, [{ ...request, feeVersion: estimate.feeVersion }], estimate.totalCycles));
  }
  async function estimateUpdate(name: string, request: Record<string, unknown>, newStorageBytes = 0n): Promise<Fee> {
    const method = CONTRACT[name];
    if (!method?.update) throw new Error("No marketplace update contract exists for this method.");
    const args = { ...request, feeVersion: info.fees.version };
    const count = BigInt(IDL.encode(method.args, [args]).byteLength);
    return fee(name === "upload_begin" ? "upload" : "update", count, newStorageBytes);
  }
  async function grantSourceAccess(request: { request_id: string; token: string; paths: string[]; fee_version: bigint }, cycles: bigint): Promise<void> {
    context.signal?.throwIfAborted();
    await transport.reserve();
    context.signal?.throwIfAborted();
    if (generation !== clientGeneration) throw new Error("Marketplace settings changed during setup. Resume using the original marketplace.");
    // Never expose a private bearer or remote transport text in diagnostics.
    // An interrupted reply retains this exact request for reconciliation.
    try {
      const result = response<{ request_id: string; paths: string[]; accepted_cycles: bigint }>(await transport.update("repo_access_v1", [request], cycles));
      if (result.request_id !== request.request_id || JSON.stringify(result.paths) !== JSON.stringify(request.paths) || typeof result.accepted_cycles !== "bigint" || result.accepted_cycles < 0n || result.accepted_cycles > cycles) throw new Error("Invalid source access receipt");
    } catch {
      throw new Error("Source access could not be confirmed. Continue this same installation to reconcile its saved access request.");
    }
  }
  function artifactUrl(value: string): string {
    const replica = new URL(state.host);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(replica.hostname);
    const base = local ? `${replica.protocol}//${state.canisterId}.localhost${replica.port ? `:${replica.port}` : ""}` : `https://${state.canisterId}.icp0.io`;
    const url = new URL(value, base);
    if (url.origin !== new URL(base).origin) throw new Error("A marketplace image referenced another origin.");
    return url.toString();
  }
  function listing(value: WireApp, installed?: ReadonlySet<string> | null): AppListing {
    const icon = first(value.iconUrl);
    const counts = first(value.acquisitionCounts ?? []);
    return { id: value.appId, title: value.title, summary: value.summary, category: "Apps", publisher: value.publisher.toText(), priceUsdMicros: String(value.priceUsdMicros), ...(icon ? { iconUrl: artifactUrl(icon) } : {}), version: String(first(value.version) ?? 0n), rating: value.ratingCount ? Number(value.ratingTotal) / Number(value.ratingCount) : null, ratingCount: Number(value.ratingCount), ...(counts ? { freeAcquisitions: String(counts.free), paidPurchases: String(counts.paid) } : {}), owned: value.owned, ...(installed ? { installed: installed.has(value.appId) } : {}) };
  }
  async function detailWire(appId: string): Promise<Detail> { return query("app_detail", [appId]); }
  async function detail(appId: string): Promise<AppDetail> {
    const [value, installed] = await Promise.all([detailWire(appId), installedApps(context)]);
    const review = first(value.audit), candidate = first(value.candidate), rating = first(value.rating);
    return { ...listing(value.app, installed), description: value.app.description, screenshots: value.app.screenshots.map(url => ({ url: artifactUrl(url) })), audit: review ? { auditor: review.auditor.toText(), verdict: Object.keys(review.decision)[0] as "approved" | "rejected" | "revoked", analysis: first(review.reason) ?? review.analysis, date: date(review.createdAtNs), packageHash: candidate ? hex(candidate.digest) : "" } : null, ownRating: rating ? { stars: Number(rating.stars), text: rating.review } : null };
  }
  async function purchaseView(quote: Checkout, includeWallet = false): Promise<PurchaseQuote> {
    const selected = info.tokens.find(t => t.ledger.toText() === quote.request.ledger.toText());
    if (!selected) throw new Error("The saved purchase names an unavailable payment token.");
    const items: AppListing[] = [], warnings: string[] = [];
      for (const item of quote.items) {
        try {
          items.push({ ...listing((await detailWire(item.appId)).app), publisher: item.publisher.toText(), priceUsdMicros: String(item.priceUsdMicros) });
        } catch {
          context.signal?.throwIfAborted();
          // A revoked release or an unavailable catalog must not prevent the
          // original quote and ledger attempt from being recovered. The exact
          // release digest remains in opaque; no current version is inferred.
          items.push({ id: item.appId, title: item.appId, summary: "Saved purchase", category: "Apps", publisher: item.publisher.toText(), priceUsdMicros: String(item.priceUsdMicros), version: "", rating: null, ratingCount: 0 });
          warnings.push(`Current listing details for ${item.appId} are unavailable. This review uses the saved purchase; current release availability is not confirmed.`);
        }
      }
      const wallet = includeWallet && quote.amount ? await readWalletTokenInfo(context.kernel, selected.ledger.toText(), state.owner) : null;
      const approvalFee = quote.amount ? quote.fee : 0n;
      const listUsd = quote.items.reduce((total, item) => total + item.priceUsdMicros, 0n);
      const affiliate = first(quote.affiliate);
      const discount = affiliate ? listUsd * info.referralTerms.discountBps / 10000n : 0n;
      const allocations: PurchaseQuote["allocations"] = quote.items.map(item => ({ kind: "developer", principal: item.publisher.toText(), amount: money(selected, item.developerAtoms), label: items.find(app => app.id === item.appId)?.title ?? item.appId }));
      if (affiliate) allocations.push({ kind: "affiliate", principal: affiliate.toText(), amount: money(selected, quote.items.reduce((sum, item) => sum + item.affiliateAtoms, 0n)) });
      allocations.push({ kind: "burn", principal: first(selected.burnAccount)?.owner.toText() ?? null, amount: money(selected, quote.items.reduce((sum, item) => sum + item.burnAtoms, 0n)), label: "Burning NTN" });
      const rate = first(quote.rate);
      if (rate && (first(rate.lastError) || BigInt(Date.now()) * 1_000_000n - rate.observedAtNs > 86_400_000_000_000n)) warnings.push("Using the last known token price. Review its observation time before paying.");
      if (wallet && BigInt(wallet.balanceAtoms) < quote.amount + quote.fee + approvalFee) warnings.push("Wallet's current balance is below the price plus estimated ledger fees.");
      return { operationId: quote.request.requestId, commitment: hex(quote.commitment), appIds: quote.request.appIds, items, token: selected.symbol as PaymentToken, subtotalUsdMicros: String(listUsd), discountUsdMicros: String(discount), payment: money(selected, quote.amount), approvalFee: money(selected, approvalFee), collectionFee: money(selected, quote.amount ? quote.fee : 0n), totalDebit: money(selected, quote.amount + (quote.amount ? quote.fee : 0n) + approvalFee), allocations, cycles: cycleView(quote.cycles), affiliateCode: first(quote.request.referralCode) ?? "", ...(rate ? { priceObservedAt: date(rate.observedAtNs) } : {}), warnings, opaque: encodeOpaque(checkoutType, quote) };
  }
  function withdrawalView(quote: WithdrawQuote): WithdrawalQuote {
    const selected = info.tokens.find(t => t.ledger.toText() === quote.request.ledger.toText());
    if (!selected) throw new Error("The saved withdrawal names an unavailable payment token.");
    return { operationId: quote.request.requestId, token: selected.symbol as PaymentToken, destination: quote.request.to.owner.toText(), debit: money(selected, quote.request.totalDebit), fee: money(selected, quote.fee), receive: money(selected, quote.netAmount), cycles: cycleView(quote.cycles), warnings: [], opaque: encodeOpaque(withdrawalType, quote) };
  }
  return { state, transport, info, token, query, fee, update,
    discount: () => preference.discount(discountAccess),
    setDiscountCode: (code: string) => preference.set(discountAccess, code),
    purchaseCode: (explicit: string | undefined) => preference.purchaseCode(discountAccess, explicit), estimateUpdate, grantSourceAccess, listing, detailWire, detail, purchaseView, withdrawalView,
    async catalog(input: { tier: AppTier; window: RankingWindow; search: string; cursor?: string }): Promise<Page<AppListing>> {
      const parsed = input.cursor ? JSON.parse(input.cursor) as { generation: string; offset: string } : null;
      const [value, installed] = await Promise.all([
        query<{ apps: WireApp[]; nextCursor: Option<{ generation: bigint; offset: bigint }>; asOfNs: bigint; refreshing: boolean }>("catalog_query", [{ search: input.search, tier: { [input.tier]: null }, window: { [input.window]: null }, cursor: parsed ? [{ generation: BigInt(parsed.generation), offset: BigInt(parsed.offset) }] : [], limit: 24n }]),
        installedApps(context),
      ]);
      const next = first(value.nextCursor);
      const warning = [value.refreshing ? "Rankings are refreshing. These results share the displayed snapshot time." : "", installed === null ? "Installed-app status is unavailable." : ""].filter(Boolean).join(" ");
      // System packages stay available to the installer and update source, but
      // do not occupy the storefront or its discovery-tool results.
      return { items: value.apps.filter(app => app.appId !== "kernel" && app.appId !== "marketplace").map(app => listing(app, installed)), nextCursor: next ? JSON.stringify({ generation: String(next.generation), offset: String(next.offset) }) : null, asOf: date(value.asOfNs), ...(warning ? { warning } : {}) };
    },
    async library(cursor?: string): Promise<Page<LibraryApp>> {
      const value = await query<{ apps: WireApp[]; nextCursor: Option<bigint> }>("library_query", [{ cursor: cursor ? [BigInt(cursor)] : [], limit: 24n }]);
      const installed = new Map<string, string>();
      let warning: string | undefined;
      try {
        const apps = await context.kernel.listApps();
        if (!isJsonObject(apps) || !Array.isArray(apps.apps)) throw new Error("Installed app information is unavailable.");
        const ids = new Set(apps.apps.flatMap(app => isJsonObject(app) && typeof app.id === "string" ? [app.id] : []));
        for (const app of value.apps) if (ids.has(app.appId)) {
          const detail = await context.kernel.describeApp(app.appId);
          if (!isJsonObject(detail) || typeof detail.version !== "number" || !Number.isSafeInteger(detail.version)) throw new Error("An installed app version is unavailable.");
          installed.set(app.appId, String(detail.version));
        }
      } catch { warning = "Installed-app status is unavailable. Neutron will check existing installations before installing."; }
      return { items: value.apps.map(app => ({ ...listing(app), acquiredAt: "", installedVersion: installed.get(app.appId) ?? null, available: app.visible, ...(!app.visible ? { unavailableReason: "No approved release is currently available. Your ownership is retained." } : {}) })), nextCursor: first(value.nextCursor)?.toString() ?? null, ...(warning ? { warning } : {}) };
    },
    async publisherApps(cursor?: string): Promise<Page<PublishedApp>> {
      const value = await query<{ apps: WireApp[]; nextCursor: Option<bigint> }>("publisher_apps", [{ cursor: cursor ? [BigInt(cursor)] : [], limit: 24n }]);
      const items: PublishedApp[] = [];
      for (const app of value.apps) {
        const details = await detailWire(app.appId), candidate = first(details.candidate), review = first(details.audit);
        const state = candidate ? Object.keys(candidate.state)[0] : "draft";
        items.push({ ...listing(app), status: (state === "pending" ? "in_review" : state) as PublishedApp["status"], ...(review && first(review.reason) ? { rejectionReason: first(review.reason)! } : {}) });
      }
      return { items, nextCursor: first(value.nextCursor)?.toString() ?? null };
    },
    async earnings(): Promise<Earnings> {
      const value = await query<{ credits: Array<{ ledger: Principal; available: bigint; reserved: bigint }>; referral: Option<{ code: string }> }>("earnings_query");
      return { referralCode: first(value.referral)?.code ?? null, affiliateDiscountBps: Number(info.referralTerms.discountBps), affiliateShareBps: Number(info.referralTerms.affiliateBps), balances: info.tokens.map(t => {
        const balance = value.credits.find(c => c.ledger.toText() === t.ledger.toText());
        return { token: t.symbol as PaymentToken, available: money(t, balance?.available ?? 0n), reserved: money(t, balance?.reserved ?? 0n), earned: null };
      }) };
    },
    async quotePurchase(input: { appIds: string[]; token: PaymentToken; affiliateCode?: string | undefined; operationId?: string }): Promise<PurchaseQuote> {
      const selected = token(input.token);
      if (input.operationId && input.affiliateCode === undefined) {
        // A caller can inspect an interrupted purchase without knowing its old
        // referral. The remembered default applies only after proving this ID new.
        const saved = await loadIntent<{ kind: string; scope: { owner: string; canister: string }; quote: PurchaseQuote }>(context.kernel, `operation:${input.operationId}`);
        if (saved) {
          if (saved.kind !== "purchase" || saved.scope.owner !== state.owner || saved.scope.canister !== state.canisterId || saved.quote.token !== input.token || JSON.stringify(saved.quote.appIds) !== JSON.stringify(input.appIds)) throw new Error("This operation has different saved purchase inputs.");
          return saved.quote;
        }
        const original = first(await query<Option<WireResult>>("purchase_status", [{ requestId: input.operationId }]));
        if (original) {
          const retained = first(original.quote ?? []);
          if (!retained || !("buyer" in retained) || retained.buyer.toText() !== state.owner || retained.request.ledger.toText() !== selected.ledger.toText() || JSON.stringify(retained.request.appIds) !== JSON.stringify(input.appIds)) throw new Error("The original purchase quote is unavailable or names different inputs. Recover the original request without changing its payment.");
          return purchaseView(retained);
        }
      }
      const affiliateCode = await preference.purchaseCode(discountAccess, input.affiliateCode);
      const quote = await query<Checkout>("purchase_quote", [{ requestId: input.operationId ?? randomId(), appIds: input.appIds, ledger: selected.ledger, referralCode: some(affiliateCode || null) }]);
      return purchaseView(quote, true);
    },
    async quoteWithdrawal(input: { token: PaymentToken; amountAtoms: string; destination: string; operationId?: string }): Promise<WithdrawalQuote> {
      const selected = token(input.token);
      const quote = await query<WithdrawQuote>("withdraw_quote", [{ requestId: input.operationId ?? randomId(), ledger: selected.ledger, to: { owner: Principal.fromText(input.destination), subaccount: [] }, totalDebit: BigInt(input.amountAtoms) }]);
      return withdrawalView(quote);
    },
  };
}
export type Client = Awaited<ReturnType<typeof protocolClient>>;
export async function discount(context: MsgBusToolContext) {
  let client: Client;
  try { client = await protocolClient(context); }
  catch (error) {
    context.signal?.throwIfAborted();
    // The protocol may be offline before its info/read client is ready. Preserve
    // the Neutron's code in the modal while clearly withholding activation.
    const code = await readDiscountCode(context.kernel);
    return { code, active: false, discountBps: 0, affiliate: null, error: error instanceof Error ? error.message : String(error) };
  }
  return client.discount();
}
export async function setDiscountCode(context: MsgBusToolContext, code: string) { return (await protocolClient(context)).setDiscountCode(code); }
export async function initialize(context: MsgBusToolContext): Promise<Session> {
  const state = await currentState(context);
  if (!state.canisterId) return session(state);
  try { return await ensureConnection(context, false); }
  catch (error) {
    context.signal?.throwIfAborted();
    // Public browsing remains available when private access needs attention.
    return { ...session(await currentState(context)), connected: false, connectionError: error instanceof Error ? error.message : String(error) };
  }
}
export async function connect(context: MsgBusToolContext): Promise<Session> {
  return ensureConnection(context, true);
}

async function ensureConnection(context: MsgBusToolContext, restoreRevoked: boolean): Promise<Session> {
  const generation = clientGeneration;
  const checkCurrent = () => {
    context.signal?.throwIfAborted();
    if (generation !== clientGeneration) throw new Error("Marketplace settings changed during setup. Retry using the current marketplace.");
  };
  if (!connectionFlight || connectionFlight.generation !== generation) {
    const promise = (async () => {
      const state = await currentState(context);
      checkCurrent();
      if (!state.canisterId) throw new Error("Marketplace configuration is unavailable. Update the app and retry setup.");
      const identity = state.seed ? { state, identity: Ed25519KeyIdentity.generate(state.seed) } : await readIdentity(context.kernel);
      checkCurrent();
      savedState = identity.state;
      const access = browserReadIdentity ?? await readAccess(context.kernel, identity.state, identity.identity);
      checkCurrent();
      browserReadIdentity = access;
      const client = await protocolClient(context);
      try {
        await client.earnings();
      } catch (error) {
        checkCurrent();
        const missing = error instanceof ProtocolError && (error.code === "delegate_required" || error.code === "authentication_required" || (restoreRevoked && error.code === "delegate_revoked"));
        if (!missing) throw error;
        await client.update("read_delegate_set", { browser: access.getPrincipal(), active: true });
      }
      checkCurrent();
      connected = true;
      return session(identity.state);
    })().catch(error => { if (generation === clientGeneration) connected = false; throw error; }).finally(() => {
      if (connectionFlight?.promise === promise) connectionFlight = null;
    });
    connectionFlight = { generation, promise };
  }
  const result = await connectionFlight.promise;
  context.signal?.throwIfAborted();
  return result;
}
