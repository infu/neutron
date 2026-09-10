// All rights reserved. See ../LICENSE.
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  compileMotokoWithCandid,
  type CompiledMotokoPaths,
} from "neutron-scripts/src/compile_motoko.js";
import { parsePackageString, type PackageMap } from "neutron-scripts/src/walk.js";
import { ensureStorageInputs } from "./storage-inputs.ts";

const execFile = promisify(execFileCallback);
export const marketplaceProjectRoot = fileURLToPath(new URL("../", import.meta.url));

export type MarketplaceBuildOptions = {
  projectRoot?: string;
  sourcePath?: string;
  outputPath?: string;
};

export async function marketplacePackages(projectRoot = marketplaceProjectRoot): Promise<PackageMap> {
  const storagePackages = await ensureStorageInputs(projectRoot);
  const { stdout } = await execFile("mops", ["sources"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  const declaredPackages = parsePackageString(stdout.replace(/\n/g, " ").trim());
  return Object.fromEntries(
    Object.entries({ ...declaredPackages, ...storagePackages }).map(([name, location]) => [
      name,
      path.resolve(projectRoot, location),
    ]),
  );
}

export async function buildMarketplace(options: MarketplaceBuildOptions = {}): Promise<CompiledMotokoPaths> {
  const projectRoot = path.resolve(options.projectRoot ?? marketplaceProjectRoot);
  return compileMotokoWithCandid({
    cwd: projectRoot,
    sourcePath: options.sourcePath ?? "mo/main.mo",
    outputPath: options.outputPath ?? "build/marketplace.wasm",
    emitStableTypes: true,
    packages: await marketplacePackages(projectRoot),
  });
}

export function parseBuildArguments(args: readonly string[]): MarketplaceBuildOptions {
  const options: MarketplaceBuildOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    if (argument !== "--source" && argument !== "--output" && argument !== "--project-root") {
      throw new Error(`Unknown marketplace build argument: ${argument}`);
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) {
      throw new Error(`A value is required for ${argument}`);
    }
    if (argument === "--source") options.sourcePath = value;
    else if (argument === "--output") options.outputPath = value;
    else options.projectRoot = value;
  }
  return options;
}

if (import.meta.main) {
  const options = parseBuildArguments(process.argv.slice(2));
  options.outputPath ??= process.env.ICP_WASM_OUTPUT_PATH
    ?? process.env.MARKETPLACE_WASM_OUTPUT_PATH
    ?? "build/marketplace.wasm";
  buildMarketplace(options).then((result) => {
    console.log(`Built ${result.wasmPath}`);
    console.log(`Candid ${result.candidPath}`);
    console.log(`Stable types ${result.stableTypesPath}`);
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
