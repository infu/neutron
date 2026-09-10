// All rights reserved. See ../LICENSE.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadReleaseCatalog } from "../../update-source/src/release_catalog.ts";
import { sha256Hex } from "../../update-source/src/model.ts";
import { json } from "./operator-wire.ts";
import { prepareTrustedCatalog, publishTrustedCatalog, TRUSTED_PUBLISHER_CALLER, type TrustedCatalog } from "./first-party-publish.ts";
import { createFirstPartyEnvironment } from "./first-party-transport.ts";

const root = path.resolve(import.meta.dir, "../../..");
const defaultCatalog = path.resolve(import.meta.dir, "../.private/production-release-catalog.trusted-id0.json");
const HELP = `Trusted first-party marketplace catalog publisher

bun scripts/publish-catalog.ts --catalog FILE [--listings FILE] [--request ID] [--journal FILE] [--host URL] [--root-key FILE] [--execute]

Without --execute, validates the exact archives/source and reviews changes using
queries only. --execute stages changed packages, then atomically auto-approves
the exact release set as the assigned existing Blast identity 0. No new identity
is generated. Other publishers must use the ordinary Neutron-funded publisher.

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

Default catalog: support/marketplace/.private/production-release-catalog.trusted-id0.json
Default host: https://icp-api.io. Local hosts require --root-key FILE. This command
never publishes to the legacy source or changes package manifests.
`;

export function catalogRequestId(catalog: TrustedCatalog): string {
  return sha256Hex(new TextEncoder().encode(json({ canister: catalog.canister, publisher: TRUSTED_PUBLISHER_CALLER, releases: catalog.releases.map(release => ({ record: release.record, source: release.source, dependencies: release.prepared.dependencies, listing: release.prepared.listing ?? null })) })));
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

type Dependencies = { environment?: typeof createFirstPartyEnvironment; write?: (value: string) => void };
export async function main(argv = process.argv.slice(2), dependencies: Dependencies = {}): Promise<void> {
  const args = parseArgs({ args: argv, options: { catalog: { type: "string" }, listings: { type: "string" }, request: { type: "string" }, journal: { type: "string" }, host: { type: "string" }, "root-key": { type: "string" }, execute: { type: "boolean" }, help: { type: "boolean" } } });
  const write = dependencies.write ?? ((value: string) => { process.stdout.write(value); });
  if (args.values.help) { write(HELP); return; }
  const catalog = await loadReleaseCatalog(path.resolve(args.values.catalog ?? defaultCatalog));
  const prepared = await prepareTrustedCatalog(catalog, await loadListingFiles(args.values.listings));
  const requestId = args.values.request ?? catalogRequestId(prepared);
  const journal = path.resolve(args.values.journal ?? path.join(root, ".neutron/marketplace-publications", `${catalogRequestId(prepared)}.json`));
  const environment = await (dependencies.environment ?? createFirstPartyEnvironment)({ canister: prepared.canister, host: args.values.host ?? "https://icp-api.io", ...(args.values["root-key"] ? { rootKeyFile: args.values["root-key"] } : {}) });
  const receipt = await publishTrustedCatalog(prepared, { publisher: TRUSTED_PUBLISHER_CALLER, requestId, journal, execute: args.values.execute === true, fetch: environment.fetch }, environment.transport);
  write(json(receipt));
}
if (import.meta.main) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
