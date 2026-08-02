#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  compilePackages,
  preparePackageInstall,
  type PreparedPackageInstall,
} from "neutron-compiler/src/install.js";

type CliResult = { exitCode: number };
type Logger = Pick<Console, "log" | "error">;

export async function main(
  argv = process.argv.slice(2),
  logger: Logger = console,
): Promise<CliResult> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "compile":
        await compileCommand(args, logger);
        return { exitCode: 0 };
      case "help":
      case "--help":
      case "-h":
      case undefined:
        logger.log(helpText());
        return { exitCode: 0 };
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    return { exitCode: 1 };
  }
}

async function compileCommand(args: string[], logger: Logger): Promise<void> {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    options: {
      package: { type: "string", multiple: true, short: "p" },
      "wasm-out": { type: "string" },
      "candid-out": { type: "string" },
      "vetkeys-environment": { type: "string" },
    },
  });
  const packagePaths = requirePackages(parsed.values.package);
  const wasmOut = requireStringOption(parsed.values["wasm-out"], "--wasm-out");
  const candidOut = requireStringOption(
    parsed.values["candid-out"],
    "--candid-out",
  );
  const vetKeysEnvironment = parseVetKeysEnvironment(
    stringValue(parsed.values["vetkeys-environment"]) ?? "production",
  );
  const packages = await readPreparedPackages(packagePaths);
  const compiled = await compilePackages({
    packages,
    vetKeysEnvironment,
  });
  await writeOutputFile(wasmOut, compiled.wasm);
  await writeOutputFile(candidOut, compiled.candid);

  logger.log(`Compiled ${packages.length} package(s)`);
  logger.log(`Wasm: ${wasmOut}`);
  logger.log(`Candid: ${candidOut}`);
}

async function readPreparedPackages(
  packagePaths: string[],
): Promise<PreparedPackageInstall[]> {
  return Promise.all(
    packagePaths.map(async (packagePath) =>
      preparePackageInstall(new Uint8Array(await readFile(packagePath))),
    ),
  );
}

function requirePackages(value: string[] | string | undefined): string[] {
  const packages = Array.isArray(value) ? value : value ? [value] : [];
  if (packages.length === 0) {
    throw new Error("At least one --package path is required");
  }
  return packages;
}

function parseVetKeysEnvironment(value: string): "production" {
  if (value === "production") return value;
  if (value === "local") {
    throw new Error(
      "Local compilation requires verified PocketIC installation context; use neutron-provision",
    );
  }
  throw new Error("vetKeys environment must be production");
}

function stringValue(
  value: string | boolean | string[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireStringOption(
  value: string | boolean | string[] | undefined,
  option: string,
): string {
  const result = stringValue(value);
  if (!result) throw new Error(`${option} is required`);
  return result;
}

async function writeOutputFile(filePath: string, content: string | Uint8Array) {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, content);
}

function helpText(): string {
  return `Usage:
  neutron compile --package kernel.v0.3.6.neutron [--package app.neutron] --wasm-out neutron.wasm --candid-out neutron.did [--vetkeys-environment production]

Commands:
  compile  Compile one or more .neutron packages from disk into Wasm and Candid.
`;
}

if (import.meta.main) {
  const result = await main();
  process.exit(result.exitCode);
}
