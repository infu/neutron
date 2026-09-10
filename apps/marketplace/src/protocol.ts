import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import type { Contract } from "./transport.ts";

const text = IDL.Text, nat = IDL.Nat, nat64 = IDL.Nat64, int = IDL.Int, bool = IDL.Bool, principal = IDL.Principal;
const blob = IDL.Vec(IDL.Nat8), opt = IDL.Opt, vec = IDL.Vec, rec = IDL.Record;
const variant = (...names: string[]) => IDL.Variant(Object.fromEntries(names.map(name => [name, IDL.Null])));
const result = (type: IDL.Type) => IDL.Variant({ ok: type, err: rec({ code: text, message: text }) });
const account = rec({ owner: principal, subaccount: opt(blob) });
const feeSchedule = rec({ version: nat, updateBase: nat, updateByte: nat, storageByteYear: nat, purchase: nat, withdraw: nat, grant: nat, xrc: nat });
const token = rec({ ledger: principal, symbol: text, decimals: IDL.Nat8, fee: nat, rateSymbol: text, burnAccount: opt(account) });
const terms = rec({ version: nat, discountBps: nat, affiliateBps: nat, developerBps: nat });
export const feeType = rec({ feeVersion: nat, processingCycles: nat, storageCycles: nat, totalCycles: nat, processingBytes: nat, newStorageBytes: nat });
const cursor = rec({ generation: nat64, offset: nat });
const pageRequest = rec({ cursor: opt(nat64), limit: nat });
const historyCursor = IDL.Variant({ start: IDL.Null, after: nat64, done: IDL.Null });
const app = rec({ appId: text, publisher: principal, title: text, summary: text, description: text, priceUsdMicros: nat, revision: nat64, version: opt(nat), iconUrl: opt(text), screenshots: vec(text), iconArtifact: opt(nat64), screenshotArtifacts: vec(nat64), ratingCount: nat, ratingTotal: nat, owned: bool, visible: bool });
const candidate = rec({ id: nat64, appId: text, version: nat, publisher: principal, digest: blob, sourceDigest: opt(blob), state: variant("pending", "approved", "rejected", "revoked"), createdAtNs: int });
const audit = rec({ auditor: principal, decision: variant("approved", "rejected", "revoked"), analysis: text, reason: opt(text), createdAtNs: int });
const rating = rec({ stars: nat, review: text });
const purchaseRequest = rec({ requestId: text, appIds: vec(text), ledger: principal, referralCode: opt(text) });
const purchaseItem = rec({ appId: text, listingRevision: nat64, publisher: principal, priceUsdMicros: nat, paidAtoms: nat, developerAtoms: nat, affiliateAtoms: nat, burnAtoms: nat, releaseDigest: blob });
const rate = rec({ id: nat64, ledger: principal, symbol: text, usdRate: nat, decimals: IDL.Nat32, observedAtNs: int, refreshedAtNs: int, lastError: opt(text) });
export const checkoutType = rec({ request: purchaseRequest, buyer: principal, items: vec(purchaseItem), amount: nat, fee: nat, affiliate: opt(principal), rate: opt(rate), spender: account, commitment: blob, cycles: feeType, quotedAtNs: int });
const operationState = variant("prepared", "funding_required", "dispatched", "outcome_unknown", "failed", "complete");
const order = rec({ requestId: text, state: operationState, lastError: opt(text), items: vec(purchaseItem) });
const attempt = rec({ block: opt(nat), state: variant("prepared", "dispatched", "outcome_unknown", "no_effect", "succeeded"), hadUnknown: bool });
const nextAction = IDL.Variant({ none: IDL.Null, await_current_call: IDL.Null, funding_required: IDL.Null, review_fee: IDL.Null, wait_ledger_time: nat64, review_terms: IDL.Null, retry_same_attempt: IDL.Null, review_required: IDL.Null });
const purchaseResult = rec({ order, attempt: opt(attempt), quote: opt(checkoutType), active: bool, nextAction });
const withdrawalRequest = rec({ requestId: text, ledger: principal, to: account, totalDebit: nat });
export const withdrawalType = rec({ request: withdrawalRequest, owner: principal, fee: nat, netAmount: nat, available: nat, commitment: blob, cycles: feeType });
const withdrawal = rec({ requestId: text, state: operationState, lastError: opt(text) });
const withdrawalResult = rec({ withdrawal, attempt: opt(attempt), quote: opt(withdrawalType), active: bool, nextAction });
const feeVersion = rec({ feeVersion: nat });
const opRequest = rec({ requestId: text });
const charge = rec({ cycles: nat, processingCycles: nat, storageCycles: nat, coverageUntilNs: int });
const upload = rec({ id: nat64, requestId: text, appId: text, digest: blob, size: nat64, uploadedBytes: nat64, state: variant("uploading", "attached", "aborted"), artifactId: opt(nat64), charge });
const read = (args: IDL.Type[], output: IDL.Type) => ({ args, returns: [output] });
const update = (args: IDL.Type[], output: IDL.Type) => ({ ...read(args, result(output)), update: true });
/** Public Candid DTOs only. Query result records deliberately omit unused internal fields. */
export const CONTRACT: Contract = {
  marketplace_info: read([], rec({ version: nat, canister: principal, tokens: vec(token), fees: feeSchedule, referralTerms: terms })),
  fee_quote: read([rec({ operation: variant("update", "upload", "purchase", "withdraw", "grant"), processingBytes: nat, newStorageBytes: nat })], feeType),
  catalog_query: read([rec({ search: text, tier: variant("free", "paid"), window: variant("week", "month", "all"), cursor: opt(cursor), limit: nat })], result(rec({ apps: vec(app), nextCursor: opt(cursor), asOfNs: int, generation: nat64, refreshing: bool }))),
  app_detail: read([text], result(rec({ app, candidate: opt(candidate), audit: opt(audit), rating: opt(rating) }))),
  library_query: read([pageRequest], result(rec({ apps: vec(app), nextCursor: opt(nat64) }))),
  publisher_apps: read([pageRequest], result(rec({ apps: vec(app), nextCursor: opt(nat64) }))),
  earnings_query: read([], result(rec({ credits: vec(rec({ ledger: principal, owner: principal, available: nat, reserved: nat })), referral: opt(rec({ code: text })) }))),
  purchase_quote: read([purchaseRequest], result(checkoutType)),
  purchase_status: read([opRequest], result(opt(purchaseResult))),
  withdraw_quote: read([withdrawalRequest], result(withdrawalType)),
  withdraw_status: read([opRequest], result(opt(withdrawalResult))),
  operation_history: read([rec({ purchaseCursor: historyCursor, withdrawalCursor: historyCursor, limit: nat })], result(rec({ purchases: vec(purchaseResult), withdrawals: vec(withdrawalResult), nextPurchaseCursor: historyCursor, nextWithdrawalCursor: historyCursor }))),
  read_delegate_set: update([rec({ browser: principal, active: bool, feeVersion: nat })], IDL.Null),
  purchase: update([rec({ quote: checkoutType, feeVersion: nat })], purchaseResult),
  withdraw: update([rec({ quote: withdrawalType, feeVersion: nat })], withdrawalResult),
  referral_get_or_create: update([feeVersion], rec({ code: text })),
  rating_set: update([rec({ appId: text, stars: nat, review: text, feeVersion: nat })], rating),
  listing_save: update([rec({ appId: text, title: text, summary: text, description: text, priceUsdMicros: nat, iconArtifact: opt(nat64), screenshots: vec(nat64), expectedRevision: opt(nat64), feeVersion: nat })], app),
  upload_begin: update([rec({ requestId: text, appId: text, digest: blob, size: nat64, mediaType: text, purpose: variant("package", "source", "image"), feeVersion: nat })], upload),
  upload_chunk: update([rec({ requestId: text, offset: nat64, bytes: blob, feeVersion: nat })], upload),
  upload_finish: update([rec({ requestId: text, feeVersion: nat })], upload),
  candidate_submit: update([rec({ requestId: text, appId: text, version: nat, artifactId: nat64, sourceArtifactId: opt(nat64), dependencies: vec(rec({ appId: text, minVersion: nat })), feeVersion: nat })], candidate),
  install_prepare: update([rec({ requestId: text, appIds: vec(text), feeVersion: nat })], rec({ canister: principal, manifestId: text, digest: text, setupUrl: text, appIds: vec(text) })),
};
export type Option<T> = [] | [T];
export const some = <T>(value: T | null | undefined): Option<T> => value === null || value === undefined ? [] : [value];
export const first = <T>(value: Option<T>): T | null => value[0] ?? null;
export type Fee = { feeVersion: bigint; processingCycles: bigint; storageCycles: bigint; totalCycles: bigint; processingBytes: bigint; newStorageBytes: bigint };
export type Token = { ledger: Principal; symbol: string; decimals: number; fee: bigint; rateSymbol: string; burnAccount: Option<{ owner: Principal; subaccount: Option<Uint8Array> }> };
export type Info = { version: bigint; canister: Principal; tokens: Token[]; fees: Record<string, bigint>; referralTerms: { version: bigint; discountBps: bigint; affiliateBps: bigint; developerBps: bigint } };
export type WireApp = { appId: string; publisher: Principal; title: string; summary: string; description: string; priceUsdMicros: bigint; revision: bigint; version: Option<bigint>; iconUrl: Option<string>; screenshots: string[]; iconArtifact: Option<bigint>; screenshotArtifacts: bigint[]; ratingCount: bigint; ratingTotal: bigint; owned: boolean; visible: boolean };
export type PurchaseItem = { appId: string; listingRevision: bigint; publisher: Principal; priceUsdMicros: bigint; paidAtoms: bigint; developerAtoms: bigint; affiliateAtoms: bigint; burnAtoms: bigint; releaseDigest: Uint8Array };
export type Checkout = { request: { requestId: string; appIds: string[]; ledger: Principal; referralCode: Option<string> }; buyer: Principal; items: PurchaseItem[]; amount: bigint; fee: bigint; affiliate: Option<Principal>; rate: Option<{ id: bigint; ledger: Principal; symbol: string; usdRate: bigint; decimals: number; observedAtNs: bigint; refreshedAtNs: bigint; lastError: Option<string> }>; spender: { owner: Principal; subaccount: Option<Uint8Array> }; commitment: Uint8Array; cycles: Fee; quotedAtNs: bigint };
export type WithdrawQuote = { request: { requestId: string; ledger: Principal; to: { owner: Principal; subaccount: Option<Uint8Array> }; totalDebit: bigint }; owner: Principal; fee: bigint; netAmount: bigint; available: bigint; commitment: Uint8Array; cycles: Fee };
export type WireOperation = { requestId: string; state: Record<string, null>; lastError: Option<string>; items?: PurchaseItem[] };
export type WireResult = { order?: WireOperation; withdrawal?: WireOperation; attempt: Option<{ block: Option<bigint>; state: Record<string, null>; hadUnknown: boolean }>; quote?: Option<Checkout | WithdrawQuote>; active?: boolean; nextAction?: Record<string, null | bigint> };
export function encodeOpaque(type: IDL.Type, value: unknown): number[] { return [...new Uint8Array(IDL.encode([type], [value]))]; }
export function decodeOpaque<T>(type: IDL.Type, value: unknown): T {
  if (!Array.isArray(value) || !value.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) throw new Error("The saved marketplace quote is invalid.");
  return IDL.decode([type], Uint8Array.from(value))[0] as T;
}
