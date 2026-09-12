// All rights reserved. See ../LICENSE.
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  compileMotokoWithCandid,
  type CompiledMotokoPaths,
} from "neutron-scripts/src/compile_motoko.js";
import { parsePackageString, type PackageMap } from "neutron-scripts/src/walk.js";
import { exposeCandidService } from "../../marketplace/scripts/public-candid.ts";

const execFile = promisify(execFileCallback);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const isSha256 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
export const feedbackProjectRoot = fileURLToPath(new URL("../", import.meta.url));

export type FeedbackBuildOptions = {
  projectRoot?: string;
  sourcePath?: string;
  outputPath?: string;
};

interface StorageInputs {
  format: "feedback-private-storage-inputs-v1";
  ashrootRevision: string;
  schemaSha256: string;
  generatedManifestSha256: string;
  runtimeManifestSha256: string;
}

async function verifiedFile(file: string, expected: string): Promise<Uint8Array> {
  const bytes = await readFile(file);
  if (!isSha256(expected) || sha256(bytes) !== expected) {
    throw new Error(`Prepared feedback storage input changed: ${file}`);
  }
  return bytes;
}

async function verifyManifest(directory: string, name: string, expected: string): Promise<void> {
  const encoded = await verifiedFile(path.join(directory, name), expected);
  const manifest = JSON.parse(new TextDecoder().decode(encoded)) as {
    files?: { path: string; sha256: string; size: number }[];
  };
  if (!Array.isArray(manifest?.files) || manifest.files.length === 0) {
    throw new Error(`Invalid prepared feedback storage manifest: ${name}`);
  }
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0 ||
        path.isAbsolute(entry.path) || entry.path.split(/[\\/]/u).some((part) => part === "..") ||
        seen.has(entry.path) || !isSha256(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`Invalid prepared feedback storage manifest file: ${name}`);
    }
    seen.add(entry.path);
    const bytes = await verifiedFile(path.join(directory, entry.path), entry.sha256);
    if (bytes.byteLength !== entry.size) throw new Error(`Prepared feedback storage input size changed: ${entry.path}`);
  }
}

/** Ordinary builds verify reviewed inputs; they never fetch or regenerate Ashroot. */
async function storagePackages(projectRoot: string): Promise<PackageMap> {
  let receipt: StorageInputs;
  try {
    receipt = JSON.parse(await readFile(path.join(projectRoot, ".private/storage-inputs.json"), "utf8")) as StorageInputs;
  } catch (cause) {
    throw new Error("Feedback storage inputs are not prepared; restore the reviewed private build inputs before building.", { cause });
  }
  if (!receipt || receipt.format !== "feedback-private-storage-inputs-v1" ||
      typeof receipt.ashrootRevision !== "string" || !/^[0-9a-f]{40}$/u.test(receipt.ashrootRevision) ||
      !isSha256(receipt.schemaSha256) || !isSha256(receipt.generatedManifestSha256) || !isSha256(receipt.runtimeManifestSha256)) {
    throw new Error("Invalid feedback private storage-input receipt");
  }
  await verifiedFile(path.join(projectRoot, "ashroot.json"), receipt.schemaSha256);
  const runtime = path.join(projectRoot, ".private/ashroot");
  await Promise.all([
    verifyManifest(path.join(projectRoot, ".ashroot"), "manifest.json", receipt.generatedManifestSha256),
    verifyManifest(runtime, ".ashroot-runtime.json", receipt.runtimeManifestSha256),
  ]);
  return { ashroot: runtime };
}

export async function feedbackPackages(projectRoot = feedbackProjectRoot): Promise<PackageMap> {
  const root = path.resolve(projectRoot);
  const preparedPackages = await storagePackages(root);
  const { stdout } = await execFile("mops", ["sources"], { cwd: root, encoding: "utf8" });
  const declaredPackages = parsePackageString(stdout.replace(/\n/g, " ").trim());
  return Object.fromEntries(
    Object.entries({ ...declaredPackages, ...preparedPackages }).map(([name, location]) => [
      name,
      path.resolve(root, location),
    ]),
  );
}

export async function buildFeedback(options: FeedbackBuildOptions = {}): Promise<CompiledMotokoPaths> {
  const projectRoot = path.resolve(options.projectRoot ?? feedbackProjectRoot);
  const compiled = await compileMotokoWithCandid({
    cwd: projectRoot,
    sourcePath: options.sourcePath ?? "mo/main.mo",
    outputPath: options.outputPath ?? "build/feedback.wasm",
    emitStableTypes: true,
    packages: await feedbackPackages(projectRoot),
  });
  // Expose the protocol contract so non-controller CLI clients can discover it.
  await exposeCandidService(compiled.wasmPath);
  return compiled;
}

export function parseBuildArguments(args: readonly string[]): FeedbackBuildOptions {
  const options: FeedbackBuildOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    if (argument !== "--source" && argument !== "--output" && argument !== "--project-root") {
      throw new Error(`Unknown feedback build argument: ${argument}`);
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`A value is required for ${argument}`);
    if (argument === "--source") options.sourcePath = value;
    else if (argument === "--output") options.outputPath = value;
    else options.projectRoot = value;
  }
  return options;
}

if (import.meta.main) {
  const options = parseBuildArguments(process.argv.slice(2));
  options.outputPath ??= process.env.ICP_WASM_OUTPUT_PATH
    ?? process.env.FEEDBACK_WASM_OUTPUT_PATH
    ?? "build/feedback.wasm";
  buildFeedback(options).then((result) => {
    console.log(`Built ${result.wasmPath}`);
    console.log(`Candid ${result.candidPath}`);
    console.log(`Stable types ${result.stableTypesPath}`);
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
