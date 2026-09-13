import type { MsgBusToolContext } from "neutron-tools/app";
import { cycleView, hex, protocolClient, randomId, ProtocolError, type Client } from "./client.ts";
import { first, some, type Fee, type Option, type WirePromotionEntry, type WirePromotionReceipt } from "./protocol.ts";
import { listIntents, loadIntent, reviseIntent, saveIntent } from "./store.ts";
import type { PromotionQuote } from "./view-types.ts";

type SavedEntry = {
  appId: string; candidateId: string; version: string; digest: number[]; sourceDigest: number[] | null;
  packageSize: string; sourceSize: string | null; dependencies: Array<{ appId: string; minVersion: string }>;
  expectedBetaRevision: string; expectedStableCandidate: string | null; expectedStableRevision: string;
};
type SavedFee = { [K in keyof Fee]: string };
type PromotionPlan = { version: 1; requestId: string; canister: string; owner: string; entry: SavedEntry; fee: SavedFee };
type SavedPromotion = { version: 1; plan: PromotionPlan; state: "pending" | "fee_review" | "complete" | "rejected"; receiptId?: string; error?: string };
const key = (requestId: string) => `promotion:${requestId}`;

function saveEntry(entry: WirePromotionEntry): SavedEntry {
  return { appId: entry.appId, candidateId: String(entry.candidateId), version: String(entry.version), digest: [...entry.digest], sourceDigest: first(entry.sourceDigest) ? [...first(entry.sourceDigest)!] : null,
    packageSize: String(entry.packageSize), sourceSize: first(entry.sourceSize)?.toString() ?? null,
    dependencies: entry.dependencies.map(value => ({ appId: value.appId, minVersion: String(value.minVersion) })),
    expectedBetaRevision: String(entry.expectedBetaRevision), expectedStableCandidate: first(entry.expectedStableCandidate)?.toString() ?? null, expectedStableRevision: String(entry.expectedStableRevision) };
}
function wireEntry(entry: SavedEntry): WirePromotionEntry {
  return { appId: entry.appId, candidateId: BigInt(entry.candidateId), version: BigInt(entry.version), digest: Uint8Array.from(entry.digest), sourceDigest: some(entry.sourceDigest ? Uint8Array.from(entry.sourceDigest) : null),
    packageSize: BigInt(entry.packageSize), sourceSize: some(entry.sourceSize === null ? null : BigInt(entry.sourceSize)),
    dependencies: entry.dependencies.map(value => ({ appId: value.appId, minVersion: BigInt(value.minVersion) })),
    expectedBetaRevision: BigInt(entry.expectedBetaRevision), expectedStableCandidate: some(entry.expectedStableCandidate === null ? null : BigInt(entry.expectedStableCandidate)), expectedStableRevision: BigInt(entry.expectedStableRevision) };
}
function savedFee(fee: Fee): SavedFee { return Object.fromEntries(Object.entries(fee).map(([name, value]) => [name, String(value)])) as SavedFee; }
function wireFee(fee: SavedFee): Fee { return Object.fromEntries(Object.entries(fee).map(([name, value]) => [name, BigInt(value)])) as Fee; }
function view(plan: PromotionPlan): PromotionQuote {
  return { operationId: plan.requestId, appId: plan.entry.appId, release: { candidateId: plan.entry.candidateId, version: plan.entry.version, digest: hex(Uint8Array.from(plan.entry.digest)), sourceDigest: plan.entry.sourceDigest ? hex(Uint8Array.from(plan.entry.sourceDigest)) : null }, cycles: cycleView(wireFee(plan.fee)), opaque: plan };
}
function checkScope(client: Client, plan: PromotionPlan): void {
  if (plan.version !== 1 || plan.canister !== client.state.canisterId || plan.owner !== client.state.owner) throw new Error("Resume this release from its original marketplace and Neutron.");
}
function checkQuote(quote: PromotionQuote, plan: PromotionPlan): void {
  const expected = view(plan);
  if (quote.operationId !== expected.operationId || quote.appId !== expected.appId || JSON.stringify(quote.release) !== JSON.stringify(expected.release) || JSON.stringify(quote.cycles) !== JSON.stringify(expected.cycles)) throw new Error("The release selection changed after review. Review the exact beta again.");
}
async function unresolved(context: MsgBusToolContext, client: Client): Promise<SavedPromotion[]> {
  return (await listIntents<SavedPromotion>(context.kernel)).filter(row => row.id.startsWith("promotion:") && row.value.version === 1 && ["pending", "fee_review"].includes(row.value.state) && row.value.plan.canister === client.state.canisterId && row.value.plan.owner === client.state.owner).map(row => row.value);
}

/** Durable requests remain discoverable even if a lost response already made beta stable. */
export async function pendingPromotions(context: MsgBusToolContext): Promise<PromotionQuote[]> {
  const client = await protocolClient(context);
  return (await unresolved(context, client)).map(value => view(value.plan));
}

export async function quotePromotion(context: MsgBusToolContext, appId: string): Promise<PromotionQuote> {
  const client = await protocolClient(context);
  const pending = (await unresolved(context, client)).find(value => value.plan.entry.appId === appId);
  if (pending) {
    if (pending.state === "fee_review") {
      // A confirmed fee-version rejection has no promotion effect. Reprice
      // the original selection and request; never resolve a replacement beta.
      await client.refreshFeeSchedule();
      const fee = await client.estimateUpdate("release_promote", { requestId: pending.plan.requestId, entries: [wireEntry(pending.plan.entry)] });
      const revised: SavedPromotion = { ...pending, state: "pending", plan: { ...pending.plan, fee: savedFee(fee) } };
      await reviseIntent(context.kernel, key(pending.plan.requestId), pending, revised);
      return view(revised.plan);
    }
    return view(pending.plan);
  }
  const prepared = await client.query<{ entries: WirePromotionEntry[] }>("promotion_prepare", [{ appIds: [appId] }]);
  if (prepared.entries.length !== 1 || prepared.entries[0]!.appId !== appId) throw new Error("The marketplace returned a different release selection.");
  const entry = prepared.entries[0]!, requestId = randomId();
  const fee = await client.estimateUpdate("release_promote", { requestId, entries: [entry] });
  return view({ version: 1, requestId, canister: client.state.canisterId!, owner: client.state.owner, entry: saveEntry(entry), fee: savedFee(fee) });
}

function checkReceipt(receipt: WirePromotionReceipt, plan: PromotionPlan): void {
  if (receipt.requestId !== plan.requestId || receipt.owner.toText() !== plan.owner || receipt.publisher.toText() !== plan.owner || receipt.operation !== "promote" || receipt.channel !== "stable" || receipt.entries.length !== 1 || JSON.stringify(saveEntry(receipt.entries[0]!)) !== JSON.stringify(plan.entry)) throw new Error("The marketplace returned a receipt for a different release. This request is retained for recovery.");
}

export async function promote(context: MsgBusToolContext, quote: PromotionQuote): Promise<{ message: string }> {
  const plan = quote.opaque as PromotionPlan, client = await protocolClient(context);
  checkScope(client, plan); checkQuote(quote, plan);
  let retained = await loadIntent<SavedPromotion>(context.kernel, key(plan.requestId));
  if (retained && JSON.stringify(retained.plan) !== JSON.stringify(plan)) throw new Error("This release ID belongs to a different selection.");
  if (retained?.state === "rejected") throw new Error(retained.error ?? "This release selection is no longer current. Review the beta again.");
  if (retained?.state === "fee_review") throw new Error("The release cost changed. Review this same release again before continuing.");
  const message = `${plan.entry.appId} v${plan.entry.version} was released to stable.`;
  if (retained?.state === "complete") return { message };
  if (!retained) {
    retained = { version: 1, plan, state: "pending" };
    await saveIntent(context.kernel, key(plan.requestId), retained);
  }
  // A read failure is not proof that an earlier mutation failed. Keep this
  // request recoverable and never prepare a replacement beta as a fallback.
  const previous = first(await client.query<Option<WirePromotionReceipt>>("promotion_status", [{ requestId: plan.requestId }]));
  let receipt: WirePromotionReceipt;
  try {
    receipt = previous ?? await client.update<WirePromotionReceipt>("release_promote", { requestId: plan.requestId, entries: [wireEntry(plan.entry)] }, wireFee(plan.fee));
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "cycle_fee_version") {
      await reviseIntent(context.kernel, key(plan.requestId), retained, { ...retained, state: "fee_review" } satisfies SavedPromotion);
    }
    if (error instanceof ProtocolError && ["channel_conflict", "release_unavailable", "publisher_required", "dependency_unavailable", "dependency_version", "duplicate_app", "request_conflict", "invalid_request"].includes(error.code)) {
      await reviseIntent(context.kernel, key(plan.requestId), retained, { ...retained, state: "rejected", error: error.message } satisfies SavedPromotion);
    }
    throw error;
  }
  checkReceipt(receipt, plan);
  await reviseIntent(context.kernel, key(plan.requestId), retained, { ...retained, state: "complete", receiptId: String(receipt.id) } satisfies SavedPromotion);
  return { message };
}
