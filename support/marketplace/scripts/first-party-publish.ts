// All rights reserved. See ../LICENSE.
// Catalog orchestration. The live transport is supplied separately so ordinary
// publisher funding and trusted publication authority cannot be conflated.
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Principal } from "@dfinity/principal";
import { inspectUpdatePackage, sha256Hex, UPDATE_SOURCE_RECEIPT_PROTOCOL, PACKAGE_CONTENT_TYPE, SOURCE_CONTENT_TYPE } from "../../update-source/src/model.ts";
import { assertGatewayCertificationV2, readReleaseAsset, updateSourceOrigin, type CertifiedFetch } from "../../update-source/src/http.ts";
import { resolveReleaseCatalogPackageFiles, type ReleaseCatalog } from "../../update-source/src/release_catalog.ts";
import { repositoryReleasePath, type RepositoryReleaseRecord } from "neutron-tools/src/repository.ts";
import { preparePackageInstall } from "neutron-compiler/src/install.ts";
import { json } from "./operator-wire.ts";
import { preparePublisher, validatePreparedPublisher, TRUSTED_FIRST_PARTY_PUBLISHER, type Prepared } from "./publisher.ts";
import { lockPublisherJournal, savePublisherJournal } from "./publisher-journal.ts";

export const TRUSTED_PUBLISHER_CALLER = TRUSTED_FIRST_PARTY_PUBLISHER;
export const AUTOMATED_PUBLICATION_ANALYSIS = "Trusted first-party publication. Automated checks verified the exact .neutron archive SHA-256 and size, packed manifest identity/version/update source, package compiler install-preparation checks (including declared dependencies and memory migration structure), and any declared Complete App Source digest, size and build-input compatibility. This stamp records automated package validation; it is not a manual malware or application-behavior review.";

export type TrustedRelease = {
  prepared: Prepared;
  record: RepositoryReleaseRecord;
  packagePath: string;
  releasePath: string;
  source: null | { url: string; path: string; sha256: string; size: number };
};
export type TrustedCatalog = { canister: string; releases: TrustedRelease[] };
export type CandidateBinding = { candidateId: bigint; expectedDigest: Uint8Array; expectedSourceDigest: [] | [Uint8Array] };
export type BatchRequest = { requestId: string; candidates: CandidateBinding[]; analysis: string };
export type BatchEntry = { candidateId: bigint; appId: string; version: bigint; digest: Uint8Array; sourceDigest: [] | [Uint8Array]; auditId: bigint };
export type BatchReceipt = { id: bigint; owner: Principal; publisher: Principal; requestId: string; entries: BatchEntry[]; analysis: string; createdAtNs: bigint };
export type StagedCandidate = BatchEntry & { publisher: Principal };
export type TrustedPublishTransport = {
  /** Actual loaded signing identity, checked before queries or writes. */
  caller: Principal;
  stage: (release: TrustedRelease, options: { requestId: string; journal: string; publisher: string }) => Promise<Omit<StagedCandidate, "auditId">>;
  batchStatus: (requestId: string) => Promise<BatchReceipt | null>;
  publishBatch: (request: BatchRequest) => Promise<BatchReceipt>;
};
export type PublishOptions = { publisher: string; requestId: string; journal: string; execute?: boolean; fetch?: CertifiedFetch };
type SavedCandidate = { candidateId: string; appId: string; version: string; digest: string; sourceDigest: string | null };
type SavedBatch = { id: string; owner: string; publisher: string; requestId: string; entries: (SavedCandidate & { auditId: string })[]; analysis: string; createdAtNs: string };
type Journal = {
  format: "marketplace-first-party-publish-v1";
  fingerprint: string;
  requestId: string;
  canister: string;
  caller: string;
  publisher: string;
  changedAppIds: string[];
  staged: SavedCandidate[];
  batchRequested: boolean;
  batch: SavedBatch | null;
};
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));

export async function prepareTrustedCatalog(catalog: ReleaseCatalog, listings: ReadonlyMap<string, string> = new Map()): Promise<TrustedCatalog> {
  for (const id of listings.keys()) if (!catalog.packages.some(entry => entry.id === id)) throw new Error(`Listing '${id}' is absent from the release catalog.`);
  const files = await resolveReleaseCatalogPackageFiles(catalog);
  const releases: TrustedRelease[] = [];
  for (const file of files) {
    const id = catalog.packages[releases.length]!.id;
    const prepared = await preparePublisher(file, listings.get(id));
    const checked = inspectUpdatePackage(file, prepared.files[0]!.bytes);
    releases.push({ prepared, record: checked.record, packagePath: checked.packagePath, releasePath: checked.releasePath,
      source: checked.hostedSource ? { url: checked.hostedSource.url, path: checked.hostedSource.path, sha256: checked.hostedSource.sha256, size: checked.hostedSource.size } : null });
  }
  const result = { canister: catalog.updateSource, releases };
  validateCatalog(result);
  return result;
}

function validateCatalog(catalog: TrustedCatalog): void {
  const source = Principal.fromText(catalog.canister).toText();
  if (source !== catalog.canister || Principal.fromText(source).isAnonymous()) throw new Error("Select the canonical marketplace canister.");
  if (!catalog.releases.length || new Set(catalog.releases.map(release => release.record.id)).size !== catalog.releases.length) throw new Error("Select a nonempty catalog without duplicate app IDs.");
  const origin = updateSourceOrigin({ canisterId: source });
  for (const release of catalog.releases) {
    validatePreparedPublisher(release.prepared);
    const checked = inspectUpdatePackage(release.record.id, release.prepared.files[0]!.bytes);
    // Metadata supplied by a caller is never a substitute for the packed bytes.
    if (json(checked.record) !== json(release.record) || checked.packagePath !== release.packagePath || checked.releasePath !== release.releasePath) throw new Error("Catalog metadata differs from its inspected archive.");
    const expected = checked.hostedSource ? { url: checked.hostedSource.url, path: checked.hostedSource.path, sha256: checked.hostedSource.sha256, size: checked.hostedSource.size } : null;
    if (json(expected) !== json(release.source)) throw new Error("Catalog source metadata differs from the declared offered source.");
    if (release.source && release.source.url !== `${origin}${release.source.path}`) throw new Error("Offered source must use the marketplace's canonical certified origin.");
    // preparePublisher also performs the full source-snapshot/build-input check.
    const manifest = preparePackageInstall(release.prepared.files[0]!.bytes).manifest;
    if (manifest.id !== release.prepared.appId || manifest.update_source !== source) throw new Error("Catalog app identity or update source differs from the packed manifest.");
  }
}

function saveCandidate(candidate: Omit<StagedCandidate, "auditId">): SavedCandidate {
  return { candidateId: String(candidate.candidateId), appId: candidate.appId, version: String(candidate.version), digest: hex(candidate.digest), sourceDigest: candidate.sourceDigest[0] ? hex(candidate.sourceDigest[0]) : null };
}
function candidateMatches(saved: SavedCandidate, release: TrustedRelease): boolean {
  return /^(0|[1-9][0-9]*)$/.test(saved.candidateId) && saved.appId === release.record.id && saved.version === String(release.record.version) && saved.digest === release.record.sha256 && saved.sourceDigest === (release.source?.sha256 ?? null);
}
function saveBatch(value: BatchReceipt): SavedBatch {
  return { ...value, id: String(value.id), owner: value.owner.toText(), publisher: value.publisher.toText(), createdAtNs: String(value.createdAtNs), entries: value.entries.map(entry => ({ ...saveCandidate({ ...entry, publisher: value.publisher }), auditId: String(entry.auditId) })) };
}
function verifyBatch(receipt: BatchReceipt, journal: Journal): SavedBatch {
  const saved = saveBatch(receipt);
  if (saved.owner !== TRUSTED_PUBLISHER_CALLER || saved.publisher !== journal.publisher || saved.requestId !== journal.requestId || saved.analysis !== AUTOMATED_PUBLICATION_ANALYSIS || saved.entries.length !== journal.staged.length) throw new Error("Trusted publication receipt differs from the original batch identity or review.");
  const entries = [...saved.entries].sort((a, b) => a.appId.localeCompare(b.appId));
  const expected = [...journal.staged].sort((a, b) => a.appId.localeCompare(b.appId));
  for (let i = 0; i < expected.length; i++) {
    const { auditId, ...candidate } = entries[i]!;
    if (!/^(0|[1-9][0-9]*)$/.test(auditId) || json(candidate) !== json(expected[i])) throw new Error("Trusted publication receipt does not cover the exact staged candidates and source bytes.");
  }
  return saved;
}

async function current(release: TrustedRelease, options: PublishOptions, origin: string) {
  return readReleaseAsset({ origin, path: release.releasePath, ...(options.fetch ? { fetch: options.fetch } : {}) });
}
function isSame(record: RepositoryReleaseRecord, expected: RepositoryReleaseRecord) {
  return record.protocol === expected.protocol && record.id === expected.id && record.version === expected.version && record.sha256 === expected.sha256 && record.size === expected.size;
}
async function verifyDependencies(catalog: TrustedCatalog, options: PublishOptions, origin: string) {
  const selected = new Map(catalog.releases.map(release => [release.record.id, release.record.version]));
  const verified = new Map<string, number>();
  for (const release of catalog.releases) for (const dependency of release.prepared.dependencies) {
    let version = selected.get(dependency.appId) ?? verified.get(dependency.appId);
    if (version === undefined) {
      const remote = await readReleaseAsset({ origin, path: repositoryReleasePath(dependency.appId), ...(options.fetch ? { fetch: options.fetch } : {}) });
      if (remote.status === "found" && remote.record.id === dependency.appId) { version = remote.record.version; verified.set(dependency.appId, version); }
    }
    if (version === undefined || BigInt(version) < dependency.minVersion) throw new Error(`Dependency '${dependency.appId}' of '${release.record.id}' requires an approved or selected version of at least ${dependency.minVersion}.`);
  }
}

/** Preserve authenticated private cache headers. The old public-source reader
 * requires immutable public caching, which a paid artifact must never use. */
async function verifyArtifact(input: { origin: string; path: string; digest: string; size: number; mediaType: string }, options: PublishOptions) {
  const response = await (options.fetch ?? fetch)(`${input.origin}${input.path}`, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store", headers: { Accept: input.mediaType, "Accept-Encoding": "identity" }, signal: AbortSignal.timeout(30_000) });
  if (response.url && new URL(response.url).origin !== input.origin) throw new Error("Certified artifact returned from a different origin.");
  assertGatewayCertificationV2(response, input.path);
  if (response.status !== 200) throw new Error(`Certified artifact '${input.path}' returned HTTP ${response.status}.`);
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== input.mediaType) throw new Error("Certified artifact has an unexpected media type.");
  const cache = new Set((response.headers.get("cache-control") ?? "").toLowerCase().split(",").map(value => value.trim()));
  if (!(cache.has("private") && cache.has("no-store")) && !(cache.has("public") && cache.has("immutable"))) throw new Error("Certified artifact has an unexpected cache policy.");
  if (response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity") throw new Error("Certified artifact is not identity encoded.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        total += value.length;
        if (total > input.size) { await reader.cancel(); throw new Error("Certified artifact exceeds its expected size."); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const body = Uint8Array.from(Buffer.concat(chunks));
  if (total !== input.size || sha256Hex(body) !== input.digest) throw new Error("Certified artifact bytes differ from their expected size or SHA-256.");
  if (response.headers.get("etag")?.replace(/^W\//, "").replace(/^\"|\"$/g, "").toLowerCase() !== input.digest) throw new Error("Certified artifact ETag differs from its SHA-256.");
}
async function postflight(catalog: TrustedCatalog, options: PublishOptions, origin: string) {
  const releaseDigests = new Map<string, string>();
  for (const release of catalog.releases) {
    const remote = await current(release, options, origin);
    if (remote.status !== "found" || !isSame(remote.record, release.record)) throw new Error(`Certified current release differs for '${release.record.id}'. Any completed batch stays retained; do not create a replacement publication to recover it.`);
    releaseDigests.set(release.record.id, remote.digest);
    await verifyArtifact({ origin, path: release.packagePath, digest: release.record.sha256, size: release.record.size, mediaType: PACKAGE_CONTENT_TYPE }, options);
    if (release.source) await verifyArtifact({ origin, path: release.source.path, digest: release.source.sha256, size: release.source.size, mediaType: SOURCE_CONTENT_TYPE }, options);
  }
  return releaseDigests;
}

/** No live transport is selected implicitly. All mutation authority stays in the
 * server and the separately configured signer; a CLI flag cannot grant it. */
export async function publishTrustedCatalog(catalog: TrustedCatalog, options: PublishOptions, transport: TrustedPublishTransport) {
  if (transport.caller.toText() !== TRUSTED_PUBLISHER_CALLER) throw new Error("Trusted first-party publication requires the exact assigned Blast identity 0 principal.");
  validateCatalog(catalog);
  const publisher = Principal.fromText(options.publisher).toText();
  if (publisher !== TRUSTED_PUBLISHER_CALLER) throw new Error("Trusted first-party listings must belong to the assigned Blast identity 0 principal.");
  if (!options.requestId.trim()) throw new Error("Provide the retained catalog publication request ID.");
  const file = path.resolve(options.journal), origin = updateSourceOrigin({ canisterId: catalog.canister });
  const fingerprint = sha256Hex(new TextEncoder().encode(json({ canister: catalog.canister, caller: TRUSTED_PUBLISHER_CALLER, publisher, requestId: options.requestId, analysis: AUTOMATED_PUBLICATION_ANALYSIS, releases: catalog.releases.map(release => ({ record: release.record, source: release.source, dependencies: release.prepared.dependencies, listing: release.prepared.listing ?? null })) })));
  let unlock: (() => Promise<void>) | undefined;
  if (options.execute) { await mkdir(path.dirname(file), { recursive: true }); unlock = await lockPublisherJournal(file); }
  try {
    let journal: Journal | undefined;
    try {
      journal = JSON.parse(await readFile(file, "utf8")) as Journal;
      if (journal.format !== "marketplace-first-party-publish-v1" || journal.fingerprint !== fingerprint) throw new Error("This catalog journal belongs to different bytes, publisher, target or request ID. Resume the original publication.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!journal) {
      await verifyDependencies(catalog, options, origin);
      const changedAppIds: string[] = [];
      for (const release of catalog.releases) {
        const remote = await current(release, options, origin);
        if (remote.status === "found") {
          if (remote.record.id !== release.record.id) throw new Error("Certified release path contains a different app ID.");
          if (remote.record.version > release.record.version) throw new Error(`Refusing to downgrade '${release.record.id}'.`);
          if (remote.record.version === release.record.version && !isSame(remote.record, release.record)) throw new Error(`Version ${release.record.version} of '${release.record.id}' already contains different bytes.`);
        }
        if (remote.status !== "found" || !isSame(remote.record, release.record)) changedAppIds.push(release.record.id);
      }
      journal = { format: "marketplace-first-party-publish-v1", fingerprint, requestId: options.requestId, canister: catalog.canister, caller: TRUSTED_PUBLISHER_CALLER, publisher, changedAppIds, staged: [], batchRequested: false, batch: null };
      if (options.execute) await savePublisherJournal(file, journal);
    }
    const skippedListingAppIds = catalog.releases.filter(release => release.prepared.listing && !journal!.changedAppIds.includes(release.record.id)).map(release => release.record.id);
    if (!options.execute) return { action: "publication_review" as const, requestId: options.requestId, canister: catalog.canister, publisher, changedAppIds: journal.changedAppIds, skippedListingAppIds, analysis: AUTOMATED_PUBLICATION_ANALYSIS, atomic: true as const, batch_id: null, packages: catalog.releases.map(release => ({ ...release.record, source: release.source })) };
    let committedThisRun: string | null = null;
    if (journal.changedAppIds.length) {
      // An unknown batch may already have atomically published all releases.
      // Reconcile it before uploads or promotion; never create a replacement ID.
      const remoteBatch = await transport.batchStatus(journal.requestId);
      if (remoteBatch) { journal.batch = verifyBatch(remoteBatch, journal); await savePublisherJournal(file, journal); }
      else if (journal.batch) throw new Error("A previously completed batch is missing from protocol status. Its original evidence remains in the journal.");
      if (!journal.batch) {
        for (const id of journal.changedAppIds) {
          const release = catalog.releases.find(value => value.record.id === id);
          if (!release) throw new Error("Saved publication contains an app outside the retained catalog.");
          const previous = journal.staged.find(value => value.appId === id);
          if (previous) { if (!candidateMatches(previous, release)) throw new Error("Saved candidate differs from the original archive."); continue; }
          const candidate = await transport.stage(release, { requestId: sha256Hex(new TextEncoder().encode(`${journal.requestId}\0${id}`)), journal: `${file}.${id}.upload.json`, publisher });
          const saved = saveCandidate(candidate);
          if (candidate.publisher.toText() !== publisher || !candidateMatches(saved, release)) throw new Error("Staged candidate does not match the inspected publisher, package and source.");
          journal.staged.push(saved); await savePublisherJournal(file, journal);
        }
        const request: BatchRequest = { requestId: journal.requestId, candidates: journal.staged.map(value => ({ candidateId: BigInt(value.candidateId), expectedDigest: bytes(value.digest), expectedSourceDigest: value.sourceDigest ? [bytes(value.sourceDigest)] : [] })), analysis: AUTOMATED_PUBLICATION_ANALYSIS };
        journal.batchRequested = true; await savePublisherJournal(file, journal);
        const receipt = await transport.publishBatch(request);
        journal.batch = verifyBatch(receipt, journal); await savePublisherJournal(file, journal);
        committedThisRun = journal.batch.id;
      }
    }
    const releaseDigests = await postflight(catalog, options, origin);
    return { action: "publication_verified" as const, protocol: UPDATE_SOURCE_RECEIPT_PROTOCOL, requestId: journal.requestId, canister_id: catalog.canister, origin, publisher, skippedListingAppIds, atomic: true as const, batch_id: committedThisRun, reconciled_batch_id: journal.batch?.id ?? null, published_at: new Date().toISOString(), packages: catalog.releases.map(release => ({ ...release.record, package_path: release.packagePath, release_path: release.releasePath, release_digest: releaseDigests.get(release.record.id)!, status: committedThisRun && journal!.changedAppIds.includes(release.record.id) ? "published" : "unchanged", source: release.source ? { ...release.source, status: committedThisRun && journal!.changedAppIds.includes(release.record.id) ? "published" : "unchanged" } : null })) };
  } finally { await unlock?.(); }
}
