// All rights reserved. See ../LICENSE.
// Stable promotion consumes a frozen beta identity. It never builds or uploads.
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Principal } from "@dfinity/principal";
import { REPOSITORY_LIMITS, repositoryPackagePath, repositoryReleasePath } from "neutron-tools/src/repository.ts";
import { parseRepositoryChannelHeads, repositoryChannelHeadsPath, type RepositoryChannelHeads } from "neutron-tools/src/release_channels.js";
import { readCertifiedAsset, readReleaseAsset, updateSourceOrigin, type CertifiedFetch } from "../../update-source/src/http.ts";
import { PACKAGE_CONTENT_TYPE, RELEASE_CACHE_CONTROL, SOURCE_CONTENT_TYPE, SOURCE_COMPRESSED_MAX_BYTES, sha256Hex, UPDATE_SOURCE_RECEIPT_PROTOCOL } from "../../update-source/src/model.ts";
import { TRUSTED_PUBLISHER_CALLER, verifyArtifact, verifyChannelSupport } from "./first-party-publish.ts";
import { lockPublisherJournal, savePublisherJournal } from "./publisher-journal.ts";
import { json } from "./operator-wire.ts";

/** Only a decoded protocol rejection proves that this attempted mutation did
 * not commit. Transport failures retain their original pending identity. */
export class PromotionRejectedError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = "PromotionRejectedError"; }
}
export type PromotionEntry = {
  appId: string; candidateId: bigint; version: bigint; digest: Uint8Array;
  sourceDigest: [] | [Uint8Array]; packageSize: bigint; sourceSize: [] | [bigint];
  dependencies: { appId: string; minVersion: bigint }[];
  expectedBetaRevision: bigint; expectedStableCandidate: [] | [bigint]; expectedStableRevision: bigint;
};
export type PromotionReceipt = { id: bigint; owner: Principal; publisher: Principal; requestId: string; operation: "promote"; channel: "stable"; entries: PromotionEntry[]; createdAtNs: bigint };
export type TrustedPromotionTransport = {
  caller: Principal;
  prepare: (appIds: string[]) => Promise<{ entries: PromotionEntry[] }>;
  status: (requestId: string) => Promise<PromotionReceipt | null>;
  promote: (request: { requestId: string; entries: PromotionEntry[] }) => Promise<PromotionReceipt>;
};
export type PromotionOptions = { canister: string; appIds: string[]; journal: string; requestId?: string; execute?: boolean; refresh?: boolean; fetch: CertifiedFetch };
type SavedEntry = { appId: string; candidateId: string; version: string; digest: string; sourceDigest: string | null; packageSize: string; sourceSize: string | null; dependencies: { appId: string; minVersion: string }[]; expectedBetaRevision: string; expectedStableCandidate: string | null; expectedStableRevision: string };
type SavedReceipt = { id: string; owner: string; publisher: string; requestId: string; operation: "promote"; channel: "stable"; entries: SavedEntry[]; createdAtNs: string };
type Journal = { format: "marketplace-first-party-promote-v1"; operation: "promote"; channel: "stable"; canister: string; publisher: string; appIds: string[]; requestId: string; fingerprint: string; entries: SavedEntry[]; requested: boolean; receipt: SavedReceipt | null; rejection: { code: string; message: string } | null; verified: boolean };
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const nat = (value: string): bigint => { if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("The retained promotion journal contains an invalid integer."); return BigInt(value); };
const saveEntry = (entry: PromotionEntry): SavedEntry => ({ ...entry, candidateId: String(entry.candidateId), version: String(entry.version), digest: hex(entry.digest), sourceDigest: entry.sourceDigest[0] ? hex(entry.sourceDigest[0]) : null, packageSize: String(entry.packageSize), sourceSize: entry.sourceSize[0] === undefined ? null : String(entry.sourceSize[0]), expectedBetaRevision: String(entry.expectedBetaRevision), expectedStableCandidate: entry.expectedStableCandidate[0] === undefined ? null : String(entry.expectedStableCandidate[0]), expectedStableRevision: String(entry.expectedStableRevision), dependencies: entry.dependencies.map(dep => ({ appId: dep.appId, minVersion: String(dep.minVersion) })) });
function restoreEntry(entry: SavedEntry): PromotionEntry {
  if (!/^[a-z0-9_-]+$/.test(entry.appId) || !/^[0-9a-f]{64}$/.test(entry.digest) || (entry.sourceDigest !== null && !/^[0-9a-f]{64}$/.test(entry.sourceDigest)) || (entry.sourceDigest === null) !== (entry.sourceSize === null)) throw new Error("The retained promotion journal contains invalid artifact identities.");
  return { ...entry, candidateId: nat(entry.candidateId), version: nat(entry.version), digest: bytes(entry.digest), sourceDigest: entry.sourceDigest === null ? [] : [bytes(entry.sourceDigest)], packageSize: nat(entry.packageSize), sourceSize: entry.sourceSize === null ? [] : [nat(entry.sourceSize)], expectedBetaRevision: nat(entry.expectedBetaRevision), expectedStableCandidate: entry.expectedStableCandidate === null ? [] : [nat(entry.expectedStableCandidate)], expectedStableRevision: nat(entry.expectedStableRevision), dependencies: entry.dependencies.map(dep => ({ appId: dep.appId, minVersion: nat(dep.minVersion) })) };
}
export function promotionRequestId(canister: string, entries: PromotionEntry[]): string {
  return sha256Hex(new TextEncoder().encode(json({ operation: "promote", channel: "stable", canister, publisher: TRUSTED_PUBLISHER_CALLER, entries: entries.map(saveEntry) })));
}
function fingerprint(journal: Pick<Journal, "canister" | "appIds" | "requestId" | "entries">): string {
  return sha256Hex(new TextEncoder().encode(json({ operation: "promote", channel: "stable", canister: journal.canister, publisher: TRUSTED_PUBLISHER_CALLER, appIds: journal.appIds, requestId: journal.requestId, entries: journal.entries })));
}
function verifyReceipt(receipt: PromotionReceipt, journal: Journal): SavedReceipt {
  if (receipt.operation !== "promote" || receipt.channel !== "stable" || receipt.owner.toText() !== journal.publisher || receipt.publisher.toText() !== journal.publisher || receipt.requestId !== journal.requestId || receipt.id < 0n || json(receipt.entries.map(saveEntry)) !== json(journal.entries)) throw new Error("Promotion receipt differs from the retained operation, publisher or exact beta selection.");
  return { ...receipt, id: String(receipt.id), owner: receipt.owner.toText(), publisher: receipt.publisher.toText(), entries: receipt.entries.map(saveEntry), createdAtNs: String(receipt.createdAtNs) };
}
async function metadata(options: PromotionOptions, pathname: string): Promise<Uint8Array> {
  const result = await readCertifiedAsset({ origin: updateSourceOrigin({ canisterId: options.canister }), path: pathname, fetch: options.fetch, maximumBytes: REPOSITORY_LIMITS.releaseJsonBytes, expectedContentType: "application/json", expectedCacheControl: RELEASE_CACHE_CONTROL, accept: "application/json", cache: "no-cache" });
  if (result.status !== "found") throw new Error(`Certified channel metadata '${pathname}' is missing; promotion requires channel-aware evidence.`);
  if (result.etag.replace(/^W\//, "").replace(/^\"|\"$/g, "").toLowerCase() !== sha256Hex(result.bytes)) throw new Error("Certified channel metadata ETag differs from its SHA-256.");
  return result.bytes;
}
async function heads(options: PromotionOptions, appId: string): Promise<RepositoryChannelHeads> {
  const value = parseRepositoryChannelHeads(await metadata(options, repositoryChannelHeadsPath(appId)));
  if (value.source !== options.canister || value.id !== appId) throw new Error("Certified channel heads belong to a different source or app.");
  return value;
}
async function verifySelection(options: PromotionOptions, entries: PromotionEntry[]): Promise<void> {
  await verifyChannelSupport(options.canister, { fetch: options.fetch }, updateSourceOrigin({ canisterId: options.canister }));
  const versions = new Map(entries.map(entry => [entry.appId, entry.version]));
  for (const entry of entries) {
    const value = await heads(options, entry.appId), beta = value.beta;
    if (beta.candidate_id !== String(entry.candidateId) || beta.revision !== String(entry.expectedBetaRevision) || value.stable.candidate_id !== (entry.expectedStableCandidate[0] === undefined ? null : String(entry.expectedStableCandidate[0])) || value.stable.revision !== String(entry.expectedStableRevision) || !beta.release || beta.release.id !== entry.appId || BigInt(beta.release.version) !== entry.version || beta.release.sha256 !== hex(entry.digest) || BigInt(beta.release.size) !== entry.packageSize) throw new Error(`Current beta or stable changed for '${entry.appId}'. Retain this selection; explicitly refresh before selecting a replacement.`);
    if (value.stable.release && BigInt(value.stable.release.version) > entry.version) throw new Error(`Refusing to downgrade stable '${entry.appId}'.`);
    for (const dependency of entry.dependencies) {
      let version = versions.get(dependency.appId);
      if (version === undefined) {
        const stable = (await heads(options, dependency.appId)).stable.release;
        if (stable) { version = BigInt(stable.version); versions.set(dependency.appId, version); }
      }
      if (version === undefined || version < dependency.minVersion) throw new Error(`Stable dependency '${dependency.appId}' of '${entry.appId}' requires version ${dependency.minVersion}; select the compatible beta dependency in the same promotion.`);
    }
  }
}
function packageEvidence(entry: SavedEntry, origin: string) {
  const sourcePath = entry.sourceDigest === null ? null : `/repo/v1/sources/${entry.sourceDigest}.source.v1.msgpack.gz`;
  return { id: entry.appId, candidate_id: entry.candidateId, version: Number(nat(entry.version)), sha256: entry.digest, size: Number(nat(entry.packageSize)), package_path: repositoryPackagePath(entry.digest), release_path: repositoryReleasePath(entry.appId), source: sourcePath ? { url: `${origin}${sourcePath}`, path: sourcePath, sha256: entry.sourceDigest!, size: Number(nat(entry.sourceSize!)) } : null };
}
async function postflight(options: PromotionOptions, journal: Journal) {
  const origin = updateSourceOrigin({ canisterId: options.canister });
  const packages = [];
  for (const entry of journal.entries) {
    const evidence = packageEvidence(entry, origin), value = await heads(options, entry.appId);
    if (value.stable.candidate_id !== entry.candidateId || !value.stable.release || value.stable.release.version !== evidence.version || value.stable.release.sha256 !== entry.digest || value.stable.release.size !== evidence.size) throw new Error(`Certified stable release differs for '${entry.appId}'. The original promotion receipt is retained and will never replay an older mutation.`);
    const release = await readReleaseAsset({ origin, path: evidence.release_path, fetch: options.fetch });
    if (release.status !== "found" || json(release.record) !== json(value.stable.release)) throw new Error(`Stable projection does not match certified stable membership for '${entry.appId}'.`);
    await verifyArtifact({ origin, path: evidence.package_path, digest: entry.digest, size: evidence.size, mediaType: PACKAGE_CONTENT_TYPE }, { fetch: options.fetch });
    if (evidence.source) await verifyArtifact({ origin, path: evidence.source.path, digest: evidence.source.sha256, size: evidence.source.size, mediaType: SOURCE_CONTENT_TYPE }, { fetch: options.fetch });
    packages.push({ ...evidence, release_digest: release.digest });
  }
  return packages;
}

export async function promoteTrustedReleases(options: PromotionOptions, transport: TrustedPromotionTransport) {
  if (transport.caller.toText() !== TRUSTED_PUBLISHER_CALLER) throw new Error("Trusted promotion requires the exact assigned Blast identity 0 principal.");
  const principal = Principal.fromText(options.canister);
  if (principal.isAnonymous() || principal.toText() !== options.canister) throw new Error("Select a canonical marketplace canister.");
  const appIds = [...options.appIds].sort();
  if (!appIds.length || new Set(appIds).size !== appIds.length || appIds.some(id => !/^[a-z0-9_-]+$/.test(id))) throw new Error("Select explicit, distinct app IDs for promotion; there is no implicit all-app selection.");
  if (options.execute && options.refresh) throw new Error("Review --refresh separately before executing its new frozen selection.");
  const file = path.resolve(options.journal), origin = updateSourceOrigin({ canisterId: options.canister });
  await mkdir(path.dirname(file), { recursive: true });
  const unlock = await lockPublisherJournal(file, { operation: "promote", channel: "stable" });
  try {
    let journal: Journal | undefined;
    try {
      journal = JSON.parse(await readFile(file, "utf8")) as Journal;
      if (journal.format !== "marketplace-first-party-promote-v1" || journal.operation !== "promote" || journal.channel !== "stable" || journal.canister !== options.canister || journal.publisher !== TRUSTED_PUBLISHER_CALLER || json(journal.appIds) !== json(appIds) || journal.fingerprint !== fingerprint(journal) || (!options.refresh && options.requestId !== undefined && options.requestId !== journal.requestId)) throw new Error("This promotion journal belongs to another exact selection, source, publisher or request. Resume its original command.");
      journal.entries.forEach(restoreEntry);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (journal && options.refresh) {
      if (journal.requested && !journal.verified) throw new Error("Reconcile and verify the pending promotion before refreshing to a newer beta.");
      await savePublisherJournal(`${file}.${encodeURIComponent(journal.requestId)}.retained.json`, journal);
      journal = undefined;
    }
    if (!journal) {
      const selection = await transport.prepare(appIds);
      if (json(selection.entries.map(entry => entry.appId).sort()) !== json(appIds)) throw new Error("Prepared promotion does not contain exactly the requested app set.");
      const entries = [...selection.entries].sort((a, b) => a.appId.localeCompare(b.appId));
      for (const entry of entries) {
        if (entry.sourceDigest.length > 1 || entry.sourceSize.length > 1 || entry.expectedStableCandidate.length > 1 || entry.packageSize <= 0n || entry.packageSize > BigInt(REPOSITORY_LIMITS.packageBytes) || entry.version > BigInt(Number.MAX_SAFE_INTEGER) || (entry.sourceSize[0] !== undefined && (entry.sourceSize[0] <= 0n || entry.sourceSize[0] > BigInt(SOURCE_COMPRESSED_MAX_BYTES)))) throw new Error("Prepared promotion contains invalid artifact evidence.");
        restoreEntry(saveEntry(entry));
      }
      await verifySelection(options, entries);
      const requestId = options.requestId ?? promotionRequestId(options.canister, entries);
      if (!requestId.trim()) throw new Error("Provide a nonempty promotion request identity.");
      const value = { format: "marketplace-first-party-promote-v1" as const, operation: "promote" as const, channel: "stable" as const, canister: options.canister, publisher: TRUSTED_PUBLISHER_CALLER, appIds, requestId, entries: entries.map(saveEntry), requested: false, receipt: null, rejection: null, verified: false };
      journal = { ...value, fingerprint: fingerprint(value) };
      await savePublisherJournal(file, journal);
    }
    if (!options.execute) return { action: "promotion_review" as const, operation: "promote" as const, channel: "stable" as const, canister_id: options.canister, requestId: journal.requestId, journal: file, atomic: true, retained_selection: true, reconciled_batch_id: journal.receipt?.id ?? null, rejection: journal.rejection, packages: journal.entries.map(entry => ({ ...packageEvidence(entry, origin), expected_beta_revision: entry.expectedBetaRevision, expected_stable_candidate: entry.expectedStableCandidate, expected_stable_revision: entry.expectedStableRevision })) };
    let committed: string | null = null;
    const receipt = await transport.status(journal.requestId);
    if (receipt) { journal.receipt = verifyReceipt(receipt, journal); await savePublisherJournal(file, journal); }
    else if (journal.receipt) throw new Error("The saved promotion receipt is missing from protocol status. Retain its original recovery journal.");
    if (!journal.receipt) {
      const entries = journal.entries.map(restoreEntry);
      await verifySelection(options, entries);
      journal.requested = true; journal.rejection = null; await savePublisherJournal(file, journal);
      let result: PromotionReceipt;
      try { result = await transport.promote({ requestId: journal.requestId, entries }); }
      catch (error) {
        if (error instanceof PromotionRejectedError) {
          journal.requested = false; journal.rejection = { code: error.code, message: error.message };
          await savePublisherJournal(file, journal);
        }
        throw error;
      }
      journal.receipt = verifyReceipt(result, journal);
      await savePublisherJournal(file, journal);
      committed = journal.receipt.id === "0" ? null : journal.receipt.id;
    }
    const packages = await postflight(options, journal);
    journal.verified = true; await savePublisherJournal(file, journal);
    return { action: "promotion_verified" as const, protocol: UPDATE_SOURCE_RECEIPT_PROTOCOL, operation: "promote" as const, channel: "stable" as const, requestId: journal.requestId, canister_id: options.canister, origin, publisher: journal.publisher, atomic: true, batch_id: committed, reconciled_batch_id: journal.receipt.id, journal: file, published_at: new Date().toISOString(), packages: packages.map(entry => ({ ...entry, status: committed && journal!.entries.find(value => value.appId === entry.id)!.expectedStableCandidate !== entry.candidate_id ? "promoted" : "unchanged", source: entry.source ? { ...entry.source, status: "unchanged" } : null })) };
  } finally { await unlock(); }
}
