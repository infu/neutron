import path from "node:path";
import {
  COMMON_VALUE_FLAGS,
  createCliContext,
  failCli,
  parseArguments,
  printJson,
} from "../src/cli.ts";
import { publishPackageFiles } from "../src/publish.ts";
import {
  loadReleaseCatalog,
  resolveReleaseCatalogPackageFiles,
} from "../src/release_catalog.ts";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const defaultPublisherIdentity = path.join(
  repositoryRoot,
  ".neutron/update-source-publisher.json",
);

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArguments(argv, {
    valueFlags: COMMON_VALUE_FLAGS,
  });
  if (parsed.positional.length !== 1) {
    throw new Error(
      "Catalog publication requires exactly one release catalog path",
    );
  }

  const catalog = await loadReleaseCatalog(parsed.positional[0]!);
  const requestedCanister =
    parsed.values.get("canister-id") ??
    process.env.UPDATE_SOURCE_CANISTER_ID?.trim();
  if (requestedCanister && requestedCanister !== catalog.updateSource) {
    throw new Error(
      `Requested canister ${requestedCanister} does not match release catalog update source ${catalog.updateSource}`,
    );
  }
  parsed.values.set("canister-id", catalog.updateSource);
  if (
    !parsed.values.has("identity-file") &&
    !process.env.UPDATE_SOURCE_IDENTITY_FILE?.trim()
  ) {
    parsed.values.set("identity-file", defaultPublisherIdentity);
  }

  const packageFiles = await resolveReleaseCatalogPackageFiles(catalog);
  const { canisterId, origin, port } = await createCliContext(parsed, {
    requireIdentity: true,
  });
  const receipt = await publishPackageFiles(packageFiles, {
    canisterId,
    origin,
    port,
    progress: (message) => process.stderr.write(`${message}\n`),
  });
  printJson(receipt);
}

if (import.meta.main) {
  main().catch(failCli);
}
