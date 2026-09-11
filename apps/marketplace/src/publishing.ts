import type { MsgBusToolContext } from "neutron-tools/app";
import { protocolClient, cycleView, ProtocolError, type Client } from "./client.ts";
import { first, some, type Fee, type Option, type WireApp } from "./protocol.ts";
import { loadIntent, saveIntent } from "./store.ts";
import { unbase64, type PublicationPlan, UPLOAD_CHUNK_BYTES } from "./publication.ts";
import type { PublicationQuote } from "./view-types.ts";
import { validateListingText } from "./listing-text.ts";

type Upload = { requestId: string; uploadedBytes: bigint; size: bigint; artifactId: Option<bigint>; state: Record<string, null> };
type SavedPublication = { version: 1; canister: string; owner: string; plan: PublicationPlan; originalRevision: string | null; iconArtifact: string | null; screenshotArtifacts: string[] };
function validatePlan(plan: PublicationPlan): void {
  const price = BigInt(plan.priceUsdMicros);
  if (price !== 0n && (price < 1_000_000n || price > 50_000_000n)) throw new Error("Apps must be free or priced from $1 to $50.");
  if (!plan.title.trim() || !plan.summary.trim() || !plan.appId) throw new Error("Add the app ID, title and excerpt.");
  for (const file of plan.artifacts) if (!Number.isSafeInteger(file.size) || file.size < 1 || file.digest.length !== 32) throw new Error("An uploaded artifact has an invalid size or SHA-256 digest.");
}
function listingRequest(plan: PublicationPlan, existing: WireApp | null) {
  return { appId: plan.appId, title: plan.title, summary: plan.summary, description: plan.description, priceUsdMicros: BigInt(plan.priceUsdMicros), iconArtifact: existing?.iconArtifact ?? [], screenshots: existing?.screenshotArtifacts ?? [], expectedRevision: existing ? [existing.revision] : [] };
}
function uploadRequest(plan: PublicationPlan, index: number) {
  const file = plan.artifacts[index]!;
  return { requestId: file.requestId, appId: plan.appId, digest: Uint8Array.from(file.digest), size: BigInt(file.size), mediaType: file.mediaType, purpose: { [file.purpose]: null } };
}
async function existingApp(client: Client, appId: string): Promise<WireApp | null> {
  try { return (await client.detailWire(appId)).app; }
  catch (error) { if (error instanceof ProtocolError && ["not_found", "app_not_found"].includes(error.code)) return null; throw error; }
}
export async function quotePublication(context: MsgBusToolContext, plan: PublicationPlan): Promise<PublicationQuote> {
  validatePlan(plan);
  validateListingText(plan);
  const client = await protocolClient(context);
  const current = await existingApp(client, plan.appId);
  const base = await client.estimateUpdate("listing_save", listingRequest(plan, current));
  let processing = base.processingCycles, storage = 0n;
  for (let index = 0; index < plan.artifacts.length; index++) {
    const file = plan.artifacts[index]!;
    const begin = await client.estimateUpdate("upload_begin", uploadRequest(plan, index), BigInt(file.size));
    const finish = await client.estimateUpdate("upload_finish", { requestId: file.requestId });
    processing += begin.processingCycles + finish.processingCycles;
    storage += begin.storageCycles;
    for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) processing += (await client.estimateUpdate("upload_chunk", { requestId: file.requestId, offset: BigInt(offset), bytes: new Uint8Array(Math.min(UPLOAD_CHUNK_BYTES, file.size - offset)) })).processingCycles;
  }
  if (plan.artifacts.some(f => f.purpose === "image")) processing += (await client.estimateUpdate("listing_save", { ...listingRequest(plan, current), expectedRevision: [0n], iconArtifact: plan.artifacts.some(f => f.role === "icon") ? [0n] : current?.iconArtifact ?? [], screenshots: plan.artifacts.some(f => f.role === "screenshot") ? plan.artifacts.filter(f => f.role === "screenshot").map(() => 0n) : current?.screenshotArtifacts ?? [] })).processingCycles;
  if (plan.version) processing += (await client.estimateUpdate("candidate_submit", { requestId: plan.requestId, appId: plan.appId, version: BigInt(plan.version), artifactId: 0n, sourceArtifactId: plan.artifacts.some(f => f.role === "source") ? [0n] : [], dependencies: plan.dependencies.map(d => ({ appId: d.appId, minVersion: BigInt(d.minVersion) })) })).processingCycles;
  const total: Fee = { ...base, processingCycles: processing, storageCycles: storage, totalCycles: processing + storage };
  return { cycles: cycleView(total), bytes: plan.artifacts.reduce((sum, f) => sum + f.size, 0), coverageEndsAt: new Date(Date.now() + 365 * 86400000).toISOString(), warnings: ["One assigned auditor must approve the exact release before it appears in the store.", "The operator funds storage after the prepaid first year."], opaque: plan };
}
async function saved(context: MsgBusToolContext, requestId: string): Promise<SavedPublication> {
  const value = await loadIntent<SavedPublication>(context.kernel, `publication:${requestId}`);
  const client = await protocolClient(context);
  if (!value || value.canister !== client.state.canisterId || value.owner !== client.state.owner) throw new Error("Resume this upload from its original marketplace and Neutron.");
  return value;
}
function sameMetadata(app: WireApp, plan: PublicationPlan): boolean { return app.title === plan.title && app.summary === plan.summary && app.description === plan.description && String(app.priceUsdMicros) === plan.priceUsdMicros; }
export async function beginPublication(context: MsgBusToolContext, quote: PublicationQuote): Promise<{ requestId: string }> {
  const plan = quote.opaque as PublicationPlan; validatePlan(plan);
  let retained = await loadIntent<SavedPublication>(context.kernel, `publication:${plan.requestId}`);
  // Exact saved publications may predate today's listing limits. Their original
  // scope, reviewed plan and remote listing must still pass the checks below.
  if (!retained) validateListingText(plan);
  const client = await protocolClient(context);
  if (retained) {
    await saved(context, plan.requestId);
    if (JSON.stringify(retained.plan) !== JSON.stringify(plan)) throw new Error("This upload ID belongs to different files or listing text.");
  } else {
    const current = await existingApp(client, plan.appId);
    if (current && current.publisher.toText() !== client.state.owner) throw new Error("This app ID belongs to another publisher.");
    retained = { version: 1, canister: client.state.canisterId!, owner: client.state.owner, plan, originalRevision: current ? String(current.revision) : null, iconArtifact: current ? first(current.iconArtifact)?.toString() ?? null : null, screenshotArtifacts: current?.screenshotArtifacts.map(String) ?? [] };
    await saveIntent(context.kernel, `publication:${plan.requestId}`, retained);
  }
  const current = await existingApp(client, plan.appId);
  if (!current || !sameMetadata(current, plan)) {
    if (current && String(current.revision) !== retained.originalRevision) throw new Error("The listing changed after this upload was prepared. Review its current content first.");
    await client.update("listing_save", { appId: plan.appId, title: plan.title, summary: plan.summary, description: plan.description, priceUsdMicros: BigInt(plan.priceUsdMicros), iconArtifact: retained.iconArtifact ? [BigInt(retained.iconArtifact)] : [], screenshots: retained.screenshotArtifacts.map(BigInt), expectedRevision: retained.originalRevision ? [BigInt(retained.originalRevision)] : [] });
  }
  return { requestId: plan.requestId };
}
export async function beginArtifact(context: MsgBusToolContext, requestId: string, index: number): Promise<{ uploadedBytes: number }> {
  const publication = await saved(context, requestId), file = publication.plan.artifacts[index];
  if (!file) throw new Error("No such artifact belongs to this upload.");
  const client = await protocolClient(context), request = uploadRequest(publication.plan, index);
  const fee = await client.estimateUpdate("upload_begin", request, BigInt(file.size));
  const upload = await client.update<Upload>("upload_begin", request, fee);
  return { uploadedBytes: Number(upload.uploadedBytes) };
}
export async function writeArtifact(context: MsgBusToolContext, input: { requestId: string; index: number; offset: number; bytes: string }): Promise<{ uploadedBytes: number }> {
  const publication = await saved(context, input.requestId), file = publication.plan.artifacts[input.index];
  if (!file) throw new Error("No such artifact belongs to this upload.");
  const client = await protocolClient(context), bytes = unbase64(input.bytes);
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset + bytes.length > file.size) throw new Error("The chunk does not fit its saved artifact.");
  const upload = await client.update<Upload>("upload_chunk", { requestId: file.requestId, offset: BigInt(input.offset), bytes });
  return { uploadedBytes: Number(upload.uploadedBytes) };
}
export async function finishArtifact(context: MsgBusToolContext, requestId: string, index: number): Promise<void> {
  const publication = await saved(context, requestId), file = publication.plan.artifacts[index];
  if (!file) throw new Error("No such artifact belongs to this upload.");
  const client = await protocolClient(context);
  await client.update("upload_finish", { requestId: file.requestId });
}
export async function finishPublication(context: MsgBusToolContext, requestId: string): Promise<{ message: string }> {
  const publication = await saved(context, requestId), plan = publication.plan, client = await protocolClient(context);
  const artifacts: Array<{ id: bigint; role: string }> = [];
  for (const file of plan.artifacts) {
    const upload = await client.update<Upload>("upload_finish", { requestId: file.requestId });
    const artifactId = first(upload.artifactId);
    if (artifactId === null) throw new Error("An uploaded file is not yet finalized. Resume this upload.");
    artifacts.push({ id: artifactId, role: file.role });
  }
  const current = (await client.detailWire(plan.appId)).app;
  if (!sameMetadata(current, plan)) throw new Error("The listing changed during upload. Your files are retained; review the new listing before submission.");
  const icon = artifacts.find(a => a.role === "icon")?.id ?? first(current.iconArtifact);
  const screenshots = artifacts.filter(a => a.role === "screenshot").map(a => a.id);
  if (artifacts.some(a => a.role === "icon" || a.role === "screenshot")) {
    const desired = screenshots.length ? screenshots : current.screenshotArtifacts;
    if (icon !== first(current.iconArtifact) || desired.map(String).join(",") !== current.screenshotArtifacts.map(String).join(",")) await client.update("listing_save", { appId: plan.appId, title: plan.title, summary: plan.summary, description: plan.description, priceUsdMicros: BigInt(plan.priceUsdMicros), iconArtifact: some(icon), screenshots: desired, expectedRevision: [current.revision] });
  }
  const packageArtifact = artifacts.find(a => a.role === "package");
  if (packageArtifact && plan.version) await client.update("candidate_submit", { requestId: plan.requestId, appId: plan.appId, version: BigInt(plan.version), artifactId: packageArtifact.id, sourceArtifactId: some(artifacts.find(a => a.role === "source")?.id), dependencies: plan.dependencies.map(d => ({ appId: d.appId, minVersion: BigInt(d.minVersion) })) });
  return { message: packageArtifact ? "Your release was submitted for review. It becomes available after an assigned auditor approves it." : "Your listing changes are saved." };
}
