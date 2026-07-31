import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canisterOrigin } from "neutron-tools/src/runtime.ts";
import productionDispenserCanisters from "../dispenser/.icp/data/mappings/ic.ids.json";
import { generateRepository, repositorySetupLinks } from "./src/generate.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(root, "../..");
const configPath = path.join(root, "repository.json");
const outputPath = path.join(root, "mo/GeneratedRepository.mo");
const config = JSON.parse(await readFile(configPath, "utf8"));
const generated = await generateRepository({
  config,
  configDir: root,
  workspaceRoot,
});

await writeFile(outputPath, generated.motokoSource);
console.log(
  `Generated ${generated.resources.length} certified resources (${generated.packages.size} unique packages)`,
);

const repositoryPrincipal = process.env.REPOSITORY_CANISTER_ID;
const dispenserOrigin =
  process.env.REPOSITORY_DISPENSER_ORIGIN ??
  canisterOrigin({ canisterId: productionDispenserCanisters.frontend });
if (repositoryPrincipal) {
  for (const link of repositorySetupLinks(
    generated,
    repositoryPrincipal,
    dispenserOrigin,
  )) {
    console.log(`${link.manifest}: ${link.url}`);
  }
} else {
  for (const manifest of generated.index.manifests) {
    console.log(
      `${manifest.id}: ${dispenserOrigin}#repo=<repository-canister-principal>&manifest=${manifest.id}&digest=${manifest.digest}`,
    );
  }
  console.log("Set REPOSITORY_CANISTER_ID to print directly usable setup links.");
}
