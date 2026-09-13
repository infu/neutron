// All rights reserved. See ../LICENSE.
import path from "node:path";
import { parseArgs } from "node:util";
import { loadReleaseCatalog } from "../../update-source/src/release_catalog.ts";
import { sha256Hex } from "../../update-source/src/model.ts";
import { json } from "./operator-wire.ts";
import { createFirstPartyEnvironment } from "./first-party-transport.ts";
import { promoteTrustedReleases } from "./first-party-promote.ts";
import { lockFirstPartyOperation } from "./publisher-journal.ts";

const root = path.resolve(import.meta.dir, "../../..");
const defaultCatalog = path.resolve(import.meta.dir, "../.private/production-release-catalog.trusted-id0.json");
const HELP = `Promote the exact selected current beta releases into stable

npm run updates:promote -- APP_ID [APP_ID...] [--catalog FILE] [--journal FILE] [--request ID] [--host URL] [--root-key FILE] [--refresh] [--execute]

The default reviews and freezes current beta candidate IDs, versions, package and
source digests, and expected beta/stable revisions in a local recovery journal.
It performs no remote mutation. Review the printed exact selection, then repeat
with --execute to promote that same set atomically. Promotion never rebuilds or
uploads archives or source artifacts. There is no implicit all-app selection.

After a lost response, repeat the exact command and journal before selecting a
new beta. A replacement beta conflicts with an uncommitted frozen selection.
A committed request reconciles its retained receipt without replaying mutation.
Repeat --execute to require verified receipt-v2 batch_id:null and unchanged
package/source identities. Use --refresh (without --execute) to review a later
beta after the prior operation is verified; pending outcomes cannot be replaced.
The prior exact journal is retained beside the new selection.

Only the configured first-party catalog and existing Blast identity 0 are used.
Default host: https://icp-api.io. Local hosts require --root-key FILE. The catalog
selects permitted app IDs and the actual Marketplace source; no build artifacts
or manifests are read or rewritten by promotion.
`;
const shellArgument = (value: string) => /^[A-Za-z0-9_./:=,-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";
export function promotionExecuteCommand(input: { appIds: string[]; catalog: string; journal: string; requestId: string; host: string; rootKeyFile?: string }): string {
  return ["npm", "run", "updates:promote", "--", ...input.appIds, "--catalog", input.catalog, "--journal", input.journal, "--request", input.requestId, "--host", input.host, ...(input.rootKeyFile ? ["--root-key", input.rootKeyFile] : []), "--execute"].map(shellArgument).join(" ");
}
type Dependencies = { environment?: typeof createFirstPartyEnvironment; write?: (value: string) => void };
export async function main(argv = process.argv.slice(2), dependencies: Dependencies = {}): Promise<void> {
  const args = parseArgs({ args: argv, allowPositionals: true, options: { catalog: { type: "string" }, journal: { type: "string" }, request: { type: "string" }, host: { type: "string" }, "root-key": { type: "string" }, refresh: { type: "boolean" }, execute: { type: "boolean" }, help: { type: "boolean" } } });
  const write = dependencies.write ?? ((value: string) => { process.stdout.write(value); });
  if (args.values.help) { write(HELP); return; }
  if (!args.positionals.length) throw new Error("Select explicit app IDs, for example: npm run updates:promote -- kernel wallet");
  const catalogFile = path.resolve(args.values.catalog ?? defaultCatalog);
  const catalog = await loadReleaseCatalog(catalogFile);
  const appIds = [...args.positionals].sort();
  for (const appId of appIds) if (!catalog.packages.some(entry => entry.id === appId)) throw new Error(`App '${appId}' is not in the selected first-party catalog.`);
  const group = sha256Hex(new TextEncoder().encode(json({ operation: "promote", channel: "stable", canister: catalog.updateSource, appIds })));
  const journal = path.resolve(args.values.journal ?? path.join(root, ".neutron/marketplace-publications", `promote-stable-${group}.json`));
  const unlock = args.values.execute ? await lockFirstPartyOperation("promote", "stable", catalog.updateSource) : undefined;
  try {
    const environment = await (dependencies.environment ?? createFirstPartyEnvironment)({ canister: catalog.updateSource, host: args.values.host ?? "https://icp-api.io", allowArtifactAuthorization: args.values.execute === true, ...(args.values["root-key"] ? { rootKeyFile: args.values["root-key"] } : {}) });
    const receipt = await promoteTrustedReleases({ canister: catalog.updateSource, appIds, journal, ...(args.values.request ? { requestId: args.values.request } : {}), execute: args.values.execute === true, refresh: args.values.refresh === true, fetch: environment.fetch }, environment.promotion);
    write(json(receipt.action === "promotion_review" ? { ...receipt, next_command: promotionExecuteCommand({ appIds, catalog: catalogFile, journal, requestId: receipt.requestId, host: args.values.host ?? "https://icp-api.io", ...(args.values["root-key"] ? { rootKeyFile: path.resolve(args.values["root-key"]) } : {}) }) } : receipt));
  } finally { await unlock?.(); }
}
if (import.meta.main) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
