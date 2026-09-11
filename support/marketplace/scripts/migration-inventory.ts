// All rights reserved. See ../LICENSE.
// Read-only: this module does not publish, reserve names, or edit package manifests.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { preparePackageInstall, REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS } from "neutron-compiler/src/install.ts";
import { packageArchiveFilename } from "neutron-tools/src/package_archive.ts";
import { compareCanonicalText } from "neutron-tools/src/canonical.ts";
import { normalizeUpdateSourcePrincipal } from "neutron-tools/src/schema.ts";
import { parseRepositoryReleaseRecord, repositoryReleasePath, type RepositoryReleaseRecord } from "neutron-tools/src/repository.ts";
import { loadReleaseCatalog, productionReleaseCatalogPath, type ReleaseCatalog } from "../../update-source/src/release_catalog.ts";
import { inspectPackageFiles } from "../../update-source/src/model.ts";
import { readReleaseAsset, updateSourceOrigin, type CertifiedFetch } from "../../update-source/src/http.ts";
import { TRUSTED_PUBLISHER_CALLER } from "./first-party-publish.ts";

export type PublisherMapping = { appId: string; publisher: string };
export type TransitionFile = { appId: string; file: string };
export type ArchiveEvidence = {
  file: string;
  release: RepositoryReleaseRecord;
  title: string;
  updateSource: string | null;
  offeredSource: null | { file: string; url: string; sha256: string; size: number };
};
export type PublishedSnapshot = {
  updateSource: string;
  evidence: "supplied_snapshot" | "certified_gateway_observation";
  releases: RepositoryReleaseRecord[];
};
export type Inventory = {
  format: 1;
  oldSource: string;
  publishedEvidence: PublishedSnapshot["evidence"] | "not_read";
  packages: {
    appId: string;
    publisher: string;
    packedLocal: ArchiveEvidence | null;
    published: RepositoryReleaseRecord | null;
    localMatchesPublished: boolean | null;
  }[];
};

/** Require an explicit owner for every catalog identity, including the Kernel. */
export function publisherMap(catalog: ReleaseCatalog, values: readonly PublisherMapping[]): Map<string, string> {
  if (!Array.isArray(values)) throw new Error("publishers must be an explicit array of appId/publisher mappings.");
  const ids = new Set(catalog.packages.map(entry => entry.id));
  const result = new Map<string, string>();
  for (const value of values) {
    if (!value || !ids.has(value.appId)) throw new Error(`Publisher mapping contains an unknown app id '${value?.appId}'.`);
    if (result.has(value.appId)) throw new Error(`Duplicate publisher mapping for '${value.appId}'.`);
    result.set(value.appId, value.publisher === TRUSTED_PUBLISHER_CALLER
      ? TRUSTED_PUBLISHER_CALLER
      : normalizeUpdateSourcePrincipal(value.publisher, `publisher for '${value.appId}'`));
  }
  const missing = [...ids].filter(id => !result.has(id)).sort(compareCanonicalText);
  if (missing.length) throw new Error(`Missing publisher mapping: ${missing.join(", ")}. Ownership must not be inferred.`);
  return result;
}

export async function inspectMigrationArchive(file: string): Promise<ArchiveEvidence> {
  // Inspect individually: an inventory may exceed the old publisher's per-batch byte bound.
  // The shared inspector still enforces package and offered-source byte limits and hashes.
  const [inspected] = await inspectPackageFiles([path.resolve(file)]);
  if (!inspected) throw new Error(`Package '${file}' was not inspected.`);
  const prepared = preparePackageInstall(inspected.bytes, { limits: REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS });
  return {
    file: inspected.file,
    release: inspected.record,
    title: prepared.manifest.name,
    updateSource: prepared.manifest.update_source ?? null,
    offeredSource: inspected.hostedSource ? {
      file: inspected.hostedSource.file,
      url: inspected.hostedSource.url,
      sha256: inspected.hostedSource.sha256,
      size: inspected.hostedSource.size,
    } : null,
  };
}

function publishedMap(catalog: ReleaseCatalog, snapshot?: PublishedSnapshot): Map<string, RepositoryReleaseRecord> {
  if (!snapshot) return new Map();
  if (normalizeUpdateSourcePrincipal(snapshot.updateSource) !== catalog.updateSource) throw new Error("Published snapshot belongs to a different old update source.");
  if (snapshot.evidence !== "supplied_snapshot" && snapshot.evidence !== "certified_gateway_observation") throw new Error("Unknown published snapshot evidence kind.");
  const ids = new Set(catalog.packages.map(entry => entry.id));
  const result = new Map<string, RepositoryReleaseRecord>();
  for (const value of snapshot.releases) {
    const record = parseRepositoryReleaseRecord(value);
    if (!ids.has(record.id)) throw new Error(`Published snapshot contains unknown app '${record.id}'.`);
    if (result.has(record.id)) throw new Error(`Published snapshot repeats '${record.id}'.`);
    result.set(record.id, record);
  }
  return result;
}

/** Optional network reads use the existing certified production gateway reader. */
export async function readPublishedSnapshot(catalog: ReleaseCatalog, fetch?: CertifiedFetch): Promise<PublishedSnapshot> {
  const releases: RepositoryReleaseRecord[] = [];
  for (const { id } of [...catalog.packages].sort((a, b) => compareCanonicalText(a.id, b.id))) {
    const result = await readReleaseAsset({ origin: updateSourceOrigin({ canisterId: catalog.updateSource }), path: repositoryReleasePath(id), ...(fetch ? { fetch } : {}) });
    if (result.status === "missing") continue;
    if (result.record.id !== id) throw new Error(`Published release '${id}' returned a different app id.`);
    releases.push(result.record);
  }
  return { updateSource: catalog.updateSource, evidence: "certified_gateway_observation", releases };
}

export async function migrationInventory(options: {
  catalog: ReleaseCatalog;
  publishers: readonly PublisherMapping[];
  published?: PublishedSnapshot;
}): Promise<Inventory> {
  const owners = publisherMap(options.catalog, options.publishers);
  const published = publishedMap(options.catalog, options.published);
  const packages: Inventory["packages"] = [];
  for (const { id, directory } of [...options.catalog.packages].sort((a, b) => compareCanonicalText(a.id, b.id))) {
    const manifest = JSON.parse(await readFile(path.join(directory, "neutron.json"), "utf8"));
    if (manifest.id !== id) throw new Error(`Local manifest in '${directory}' does not declare '${id}'.`);
    const file = path.join(directory, packageArchiveFilename(id, manifest.version));
    let packedLocal: ArchiveEvidence | null = null;
    try {
      packedLocal = await inspectMigrationArchive(file);
    } catch (error) {
      // A missing archive is useful inventory information. A missing source sidecar,
      // malformed package, or failed manifest read is not an absent local build.
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT" && "path" in error && error.path === file)) throw error;
    }
    if (packedLocal && (packedLocal.release.id !== id || packedLocal.release.version !== manifest.version || packedLocal.updateSource !== (manifest.update_source ?? null))) throw new Error(`Packed local '${id}' does not match its source manifest.`);
    const remote = published.get(id) ?? null;
    packages.push({ appId: id, publisher: owners.get(id)!, packedLocal, published: remote, localMatchesPublished: packedLocal && remote ? sameRelease(packedLocal.release, remote) : null });
  }
  return { format: 1, oldSource: options.catalog.updateSource, publishedEvidence: options.published?.evidence ?? "not_read", packages };
}

function sameRelease(left: RepositoryReleaseRecord, right: RepositoryReleaseRecord): boolean {
  return left.id === right.id && left.version === right.version && left.sha256 === right.sha256 && left.size === right.size;
}

export type MigrationPlan = {
  format: 1;
  mode: "review_only";
  oldSource: string;
  marketplace: string;
  publishedEvidence: PublishedSnapshot["evidence"];
  initReservations: { appId: string; publisher: string; title: string }[];
  reservations: { method: "admin_reserve_app"; args: { appId: string; publisher: string; title: string; feeVersion: string } }[];
  packages: { appId: string; publisher: string; oldRelease: RepositoryReleaseRecord; transition: ArchiveEvidence }[];
  nextSteps: string[];
};

export async function prepareMigration(options: {
  catalog: ReleaseCatalog;
  marketplace: string;
  feeVersion: string;
  publishers: readonly PublisherMapping[];
  transitions: readonly TransitionFile[];
  published: PublishedSnapshot;
}): Promise<MigrationPlan> {
  const marketplace = normalizeUpdateSourcePrincipal(options.marketplace, "marketplace");
  if (marketplace === options.catalog.updateSource) throw new Error("Marketplace must differ from the existing source.");
  if (!/^[1-9][0-9]*$/.test(options.feeVersion)) throw new Error("feeVersion must be a positive canonical decimal integer read from marketplace_info.");
  const owners = publisherMap(options.catalog, options.publishers);
  const published = publishedMap(options.catalog, options.published);
  if (!Array.isArray(options.transitions)) throw new Error("transitions must list the exact appId/file pairs to inspect.");
  const files = new Map<string, string>();
  for (const { appId, file } of options.transitions) {
    if (!owners.has(appId)) throw new Error(`Transition contains unknown app '${appId}'.`);
    if (files.has(appId)) throw new Error(`Duplicate transition for '${appId}'.`);
    files.set(appId, file);
  }
  const packages: MigrationPlan["packages"] = [];
  for (const appId of [...owners.keys()].sort(compareCanonicalText)) {
    const oldRelease = published.get(appId);
    if (!oldRelease) throw new Error(`No published release evidence for '${appId}'; packed local bytes are not publication evidence.`);
    const file = files.get(appId);
    if (!file) throw new Error(`Missing exact transition package for '${appId}'.`);
    const transition = await inspectMigrationArchive(file);
    if (transition.release.id !== appId) throw new Error(`Transition '${file}' does not contain '${appId}'.`);
    if (transition.release.version <= oldRelease.version) throw new Error(`Transition '${appId}' must have a higher version than published ${oldRelease.version}.`);
    if (transition.updateSource !== marketplace) throw new Error(`Transition '${appId}' must use marketplace update_source ${marketplace}.`);
    if (transition.offeredSource && new URL(transition.offeredSource.url).origin !== updateSourceOrigin({ canisterId: marketplace })) throw new Error(`Transition '${appId}' offered source must be hosted by the configured marketplace.`);
    packages.push({ appId, publisher: owners.get(appId)!, oldRelease, transition });
  }
  return {
    format: 1, mode: "review_only", oldSource: options.catalog.updateSource, marketplace,
    publishedEvidence: options.published.evidence,
    initReservations: packages.map(entry => ({ appId: entry.appId, publisher: entry.publisher, title: entry.transition.title })),
    reservations: packages.map(entry => ({ method: "admin_reserve_app", args: { appId: entry.appId, publisher: entry.publisher, title: entry.transition.title, feeVersion: options.feeVersion } })),
    packages,
    nextSteps: [
      "Put the reviewed complete initReservations into the initial canister configuration so existing app IDs are reserved atomically before public submissions can race them. Later admin_reserve_app calls are for controlled additions, not initial migration.",
      ...(packages.some(entry => entry.publisher === TRUSTED_PUBLISHER_CALLER) ? [
        `For entries owned by ${TRUSTED_PUBLISHER_CALLER}, use the approved direct first-party upload and publication workflow as that exact trusted identity. The target must explicitly authorize this trusted publisher; an inventory mapping alone grants no authority.`,
      ] : []),
      ...(packages.some(entry => entry.publisher !== TRUSTED_PUBLISHER_CALLER) ? [
        "Upload ordinary publisher entries and their exact offered-source bytes through each publisher Neutron with attached cycles, then obtain auditor approval for each candidate.",
      ] : []),
      "Recheck the live old release records and approved marketplace candidates before publishing transition releases through the existing production workflow.",
      "Keep old public package bytes available. A transition release changes future update_source metadata; it does not delete or privatize previously public bytes.",
    ],
  };
}

async function cli(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || !args.length) {
    console.log("Usage: bun scripts/migration-inventory.ts <inventory|plan> --config FILE [--catalog FILE] [--published FILE | --live]\nConfig: { marketplace, feeVersion, publishers:[{appId,publisher}], transitions:[{appId,file}] }. Inventory only requires publishers. Relative transition paths resolve from the config directory. --live performs read-only certified gateway requests. Plan prints reviewable JSON and makes no updates.");
    return;
  }
  const mode = args.shift();
  if (mode !== "inventory" && mode !== "plan") throw new Error("Select inventory or plan.");
  const flags = new Map<string, string>();
  let live = false;
  while (args.length) {
    const flag = args.shift()!;
    if (flag === "--live") { if (live) throw new Error("Repeated --live."); live = true; continue; }
    if (!["--config", "--catalog", "--published"].includes(flag) || flags.has(flag)) throw new Error(`Unknown or repeated option '${flag}'.`);
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`Missing value for '${flag}'.`);
    flags.set(flag, value);
  }
  if (live && flags.has("--published")) throw new Error("Choose --live or --published, not both.");
  if (!flags.has("--config")) throw new Error("An explicit --config publisher mapping is required.");
  const configPath = path.resolve(flags.get("--config")!);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const catalog = await loadReleaseCatalog(flags.get("--catalog") ?? productionReleaseCatalogPath);
  const publishedFile = flags.get("--published");
  const published: PublishedSnapshot | undefined = live ? await readPublishedSnapshot(catalog) : publishedFile ? { ...JSON.parse(await readFile(publishedFile, "utf8")), evidence: "supplied_snapshot" } : undefined;
  let output: Inventory | MigrationPlan;
  if (mode === "inventory") output = await migrationInventory({ catalog, publishers: config.publishers, ...(published ? { published } : {}) });
  else {
    if (!published) throw new Error("Plan requires --live or --published; local archives do not establish the published version.");
    if (!Array.isArray(config.transitions)) throw new Error("transitions must list the exact appId/file pairs to inspect.");
    const transitions = config.transitions.map((entry: TransitionFile) => ({ ...entry, file: path.resolve(path.dirname(configPath), entry.file) }));
    output = await prepareMigration({ catalog, marketplace: config.marketplace, feeVersion: config.feeVersion, publishers: config.publishers, transitions, published });
  }
  console.log(JSON.stringify(output, null, 2));
}

if (import.meta.main) await cli().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
