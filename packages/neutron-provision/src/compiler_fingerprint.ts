import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const FINGERPRINT_DOMAIN = "neutron-provision-compiler-source-v1";
const ROOT_INPUTS = [
  ".node-version",
  ".npmrc",
  ".nvmrc",
  ".tool-versions",
  "bunfig.toml",
  "flake.lock",
  "flake.nix",
  "package-lock.json",
  "package.json",
] as const;
const COMPILER_WORKSPACES = [
  "packages/neutron-compiler",
  // Complete local runtime dependency closure of neutron-compiler. This is a
  // closed compile-cache input list, not workspace/package discovery.
  "packages/neutron-motoko-wasm",
  "packages/neutron-security",
  "packages/neutron-tools",
] as const;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".mops",
  ".neutron",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "test-results",
]);
const SKIPPED_FILE_SUFFIXES = [".tsbuildinfo"] as const;

/**
 * Bind the local compiled-actor cache to the compiler implementation and its
 * shared runtime/tooling dependency. Package source is deliberately absent:
 * provision receives already-built archives whose exact hashes form the other
 * half of the cache key.
 */
export async function compilerSourceFingerprint(
  repositoryRoot: string,
): Promise<string> {
  const root = path.resolve(repositoryRoot);
  const files = new Set<string>();
  for (const relative of ROOT_INPUTS) {
    if (await regularFileOrMissing(path.join(root, relative))) {
      files.add(relative);
    }
  }
  for (const workspace of COMPILER_WORKSPACES) {
    const directory = path.join(root, workspace);
    const metadata = await lstat(directory).catch((error: unknown) => {
      if (isMissingFileError(error)) {
        throw new Error(
          `Repository ${root} does not contain required compiler workspace ${workspace}`,
        );
      }
      throw error;
    });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Compiler workspace ${directory} must be a real directory`);
    }
    await collectFiles(root, directory, files);
  }

  const hash = createHash("sha256")
    .update(FINGERPRINT_DOMAIN)
    .update("\0");
  for (const relative of [...files].sort()) {
    const bytes = await readFile(path.join(root, relative));
    hash
      .update(String(Buffer.byteLength(relative, "utf8")))
      .update("\0")
      .update(relative)
      .update("\0")
      .update(String(bytes.byteLength))
      .update("\0")
      .update(bytes);
  }
  return hash.digest("hex");
}

async function collectFiles(
  root: string,
  directory: string,
  files: Set<string>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    if (SKIPPED_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      continue;
    }
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Compiler source tree contains symlink ${filename}`);
    }
    if (entry.isDirectory()) {
      await collectFiles(root, filename, files);
    } else if (entry.isFile()) {
      files.add(path.relative(root, filename));
    }
  }
}

async function regularFileOrMissing(filename: string): Promise<boolean> {
  try {
    const metadata = await lstat(filename);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Compiler build input ${filename} must be a regular file`);
    }
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
