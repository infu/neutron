import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const sourceRoots = ["apps", "packages", "support"];
const sourceExtensions = new Set([
  ".cjs",
  ".js",
  ".json",
  ".mjs",
  ".sh",
  ".ts",
  ".yaml",
  ".yml",
]);
const excludedDirectories = new Set([
  ".git",
  ".mops",
  "build",
  "dist",
  "node_modules",
]);
const excludedFiles = new Set([
  "apps/kernel/test/build_runtime_repairs.test.ts",
  "package-lock.json",
  "packages/neutron-scripts/test/motoko_toolchain_boundary.test.ts",
]);
const forbidden = [
  {
    description: "a Mops-managed compiler or test command",
    pattern: /\bmops\s+(?:test|toolchain(?:\s+bin)?\s+moc)\b/,
  },
  {
    description: "a programmatic Mops toolchain compiler lookup",
    pattern:
      /\b(?:execFile|execute|spawn|spawnSync)\s*\(\s*["']mops["']\s*,\s*\[[\s\S]{0,200}["']toolchain["'][\s\S]{0,200}["']moc["']/,
  },
  {
    description: "the host MOC environment variable",
    pattern: /process\.env\.MOC\b/,
  },
  {
    description: "a native compiler resolver",
    pattern: /\bresolveMoc\s*\(/,
  },
  {
    description: "the cached Mops native compiler",
    pattern:
      /\.cache\/mops\/moc|["']\.cache["']\s*,\s*["']mops["']\s*,\s*["']moc["']/,
  },
  {
    description: "a direct native moc compile or interpreter command",
    pattern: /\bmoc\s+-(?:c|r)\b/,
  },
];

test("repo execution paths never invoke a host Motoko compiler", async () => {
  const violations: string[] = [];
  for (const sourceRoot of sourceRoots) {
    for await (const filePath of sourceFiles(
      path.join(repositoryRoot, sourceRoot),
    )) {
      const relativePath = path.relative(repositoryRoot, filePath);
      if (excludedFiles.has(relativePath)) continue;
      const source = await fs.readFile(filePath, "utf8");
      for (const rule of forbidden) {
        if (rule.pattern.test(source)) {
          violations.push(`${relativePath}: ${rule.description}`);
        }
      }
    }
  }
  expect(violations).toEqual([]);
});

async function* sourceFiles(directory: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (
        path.relative(repositoryRoot, child) ===
        "packages/neutron-motoko-wasm/compiler"
      ) {
        continue;
      }
      yield* sourceFiles(child);
      continue;
    }
    if (sourceExtensions.has(path.extname(entry.name))) {
      yield path.join(directory, entry.name);
    }
  }
}
