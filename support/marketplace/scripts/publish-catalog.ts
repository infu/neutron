// All rights reserved. See ../LICENSE.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadReleaseCatalog } from "../../update-source/src/release_catalog.ts";
import { sha256Hex } from "../../update-source/src/model.ts";
import { json } from "./operator-wire.ts";
import { prepareTrustedCatalog, publishTrustedCatalog, TRUSTED_PUBLISHER_CALLER, type TrustedCatalog } from "./first-party-publish.ts";
import { lockFirstPartyOperation } from "./publisher-journal.ts";
import { createFirstPartyEnvironment } from "./first-party-transport.ts";

const root = path.resolve(import.meta.dir, "../../..");
const defaultCatalog = path.resolve(import.meta.dir, "../.private/production-release-catalog.trusted-id0.json");
const HELP = `Trusted first-party marketplace catalog publisher

bun scripts/publish-catalog.ts --catalog FILE [--listings FILE] [--request ID] [--journal FILE] [--host URL] [--root-key FILE] [--execute]

Without --execute, validates the exact archives/source and reviews changes using
queries only. --execute stages changed packages, then atomically auto-approves
and publishes the exact set to beta as the assigned existing Blast identity 0.
Stable changes only through updates:promote. No new identity is generated. Other publishers must use the ordinary Neutron-funded publisher.

The catalog uses the existing {format:1, update_source, packages:[{id,directory}]}
format, pointing at the actual marketplace canister. The optional listings file
is an array of {appId,file}; each file is the ordinary publisher listing JSON.
Listing edits apply only to changed releases, not a metadata-only publication.
Read app_detail/publisher_apps for the expectedRevision of a reserved or existing
listing; null is for a new listing. Omit --listings to preserve existing details.
Relative listing files resolve
against the listings file. --request and --journal default deterministically from
the exact selected bytes/listings; reuse them and the same bytes after any lost
reply. The receipt retains protocol v2 and batch_id:null for a verified no-op.

Existing v1 journals are recovered under their original request ID and stable
release paths, including the predecessor's default journal filename. Recovery
never uploads or publishes. A missing original receipt or unfinished legacy
workflow blocks beta publication; retain its exact journals and artifact bytes.
Use --journal FILE for a custom predecessor journal. Do not replace its request.

Default catalog: support/marketplace/.private/production-release-catalog.trusted-id0.json
Default host: https://icp-api.io. Local hosts require --root-key FILE. This command
never publishes to the legacy source or changes package manifests.
`;

export function catalogRequestId(catalog: TrustedCatalog): string {
  return sha256Hex(new TextEncoder().encode(json({ operation: "publish", channel: "beta", canister: catalog.canister, publisher: TRUSTED_PUBLISHER_CALLER, releases: catalog.releases.map(release => ({ record: release.record, source: release.source, dependencies: release.prepared.dependencies, listing: release.prepared.listing ?? null })) })));
}

export function legacyCatalogRequestId(catalog: TrustedCatalog): string {
  return sha256Hex(new TextEncoder().encode(json({ canister: catalog.canister, publisher: TRUSTED_PUBLISHER_CALLER, releases: catalog.releases.map(release => ({ record: release.record, source: release.source, dependencies: release.prepared.dependencies, listing: release.prepared.listing ?? null })) })));
}

/** Locate the predecessor's durable outcome before choosing a new beta ID.
 * The old default filename depended on catalog bytes even with --request. */
export async function resolvePublicationIdentity(catalog: TrustedCatalog, options: { requestId?: string; journal?: string; journalDirectory?: string } = {}): Promise<{ requestId: string; journal: string }> {
  const directory = path.resolve(options.journalDirectory ?? path.join(root, ".neutron/marketplace-publications"));
  const predecessor = path.join(directory, `${legacyCatalogRequestId(catalog)}.json`);
  const selected = options.journal ? path.resolve(options.journal) : undefined;
  const read = async (filename: string): Promise<{ format?: unknown; requestId?: unknown } | undefined> => {
    try { return JSON.parse(await readFile(filename, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  const explicit = selected ? await read(selected) : undefined;
  if (explicit?.format === "marketplace-first-party-publish-v1") {
    if (typeof explicit.requestId !== "string" || !explicit.requestId.trim()) throw new Error("The original publication journal has no valid retained request ID.");
    return { requestId: options.requestId ?? explicit.requestId, journal: selected! };
  }
  // --journal remains an arbitrary retained pathname. A new beta operation
  // may have explicitly chosen the predecessor's deterministic filename.
  if (selected === predecessor && explicit?.format === "marketplace-first-party-publish-v2") {
    return { requestId: options.requestId ?? catalogRequestId(catalog), journal: selected };
  }
  const legacy = selected === predecessor ? explicit : await read(predecessor);
  if (legacy !== undefined) {
    if (legacy?.format !== "marketplace-first-party-publish-v1" || typeof legacy.requestId !== "string" || !legacy.requestId.trim()) throw new Error(`The predecessor publication journal is invalid: ${predecessor}. Preserve it before choosing a new beta identity.`);
    if (selected && selected !== predecessor) throw new Error(`Reconcile the original publication journal at ${predecessor} before using another beta journal.`);
    return { requestId: options.requestId ?? legacy.requestId, journal: predecessor };
  }
  return { requestId: options.requestId ?? catalogRequestId(catalog), journal: selected ?? path.join(directory, `publish-beta-${catalogRequestId(catalog)}.json`) };
}

export async function loadListingFiles(filename?: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!filename) return result;
  const absolute = path.resolve(filename), entries: unknown = JSON.parse(await readFile(absolute, "utf8"));
  if (!Array.isArray(entries)) throw new Error("The listings file must contain an array of {appId,file}.");
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Object.keys(entry).sort().join(",") !== "appId,file" || typeof entry.appId !== "string" || typeof entry.file !== "string" || !entry.file.trim()) throw new Error("Each listing mapping must contain exactly appId and file.");
    if (result.has(entry.appId)) throw new Error(`Repeated listing '${entry.appId}'.`);
    result.set(entry.appId, path.resolve(path.dirname(absolute), entry.file));
  }
  return result;
}

type Dependencies = { environment?: (options: Parameters<typeof createFirstPartyEnvironment>[0]) => Promise<Pick<Awaited<ReturnType<typeof createFirstPartyEnvironment>>, "transport" | "fetch">>; write?: (value: string) => void };
export async function main(argv = process.argv.slice(2), dependencies: Dependencies = {}): Promise<void> {
  const args = parseArgs({ args: argv, options: { catalog: { type: "string" }, listings: { type: "string" }, request: { type: "string" }, journal: { type: "string" }, host: { type: "string" }, "root-key": { type: "string" }, execute: { type: "boolean" }, help: { type: "boolean" } } });
  const write = dependencies.write ?? ((value: string) => { process.stdout.write(value); });
  if (args.values.help) { write(HELP); return; }
  const catalog = await loadReleaseCatalog(path.resolve(args.values.catalog ?? defaultCatalog));
  const prepared = await prepareTrustedCatalog(catalog, await loadListingFiles(args.values.listings));
  const unlock = args.values.execute ? await lockFirstPartyOperation("publish", "beta", prepared.canister) : undefined;
  try {
    const { requestId, journal } = await resolvePublicationIdentity(prepared, { ...(args.values.request ? { requestId: args.values.request } : {}), ...(args.values.journal ? { journal: args.values.journal } : {}) });
    const environment = await (dependencies.environment ?? createFirstPartyEnvironment)({ canister: prepared.canister, host: args.values.host ?? "https://icp-api.io", allowArtifactAuthorization: args.values.execute === true, ...(args.values["root-key"] ? { rootKeyFile: args.values["root-key"] } : {}) });
    const receipt = await publishTrustedCatalog(prepared, { publisher: TRUSTED_PUBLISHER_CALLER, requestId, journal, execute: args.values.execute === true, fetch: environment.fetch }, environment.transport);
    write(json(receipt));
  } finally { await unlock?.(); }
}
if (import.meta.main) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
