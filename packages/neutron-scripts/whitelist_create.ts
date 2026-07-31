import { exec as callbackExec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import chalk from "chalk";
import { disposeMotokoCompiler } from "neutron-motoko-wasm";
import {
  getDependencies,
  parsePackageString,
  walkReplace,
  type HashFiles,
  type PackageMap,
} from "neutron-scripts/src/walk.js";

const exec = promisify(callbackExec);
const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));

// Only these Core facades are known false positives. Random is deliberately
// absent: consensus randomness is a metered kernel capability, never an
// ambient standard-library call available to ordinary apps.
const acceptable = /(?:^|\/)(?:Principal|Runtime)\.mo$/;

// These modules expose privileged system APIs and must never be whitelisted.
const unacceptable = [
  /(?:^|\/)ExperimentalCycles\.mo$/,
  /(?:^|\/)ExperimentalInternetComputer\.mo$/,
  /(?:^|\/)ExperimentalStableMemory\.mo$/,
  /(?:^|\/)CertifiedData\.mo$/,
  /(?:^|\/)Cycles\.mo$/,
  /(?:^|\/)InternetComputer\.mo$/,
  /(?:^|\/)Region\.mo$/,
  /(?:^|\/)StableMemory\.mo$/,
  /(?:^|\/)Timer\.mo$/,
];

const sourceResult = await exec("mops sources", { cwd: projectRoot });
const relativePackages = parsePackageString(
  sourceResult.stdout.replace(/\n/g, " ").trim(),
);
const packages: PackageMap = Object.fromEntries(
  Object.entries(relativePackages).map(([name, root]) => [
    name,
    path.resolve(projectRoot, root),
  ]),
);
const trustedRoots = Object.entries(packages).filter(
  ([name]) => name === "core",
);
if (trustedRoots.length === 0) {
  throw new Error(
    `No mo:core package found under ${projectRoot}; run mops install first`,
  );
}

const files: string[] = [];
for (const [, root] of trustedRoots) {
  files.push(...(await collectMotokoFiles(root)));
}

const hashfiles: HashFiles = {};
const usedHashes: string[] = [];
for (const file of files.sort()) {
  const dependencies = await getDependencies(
    null,
    file,
    packages,
    hashfiles,
  );
  walkReplace(dependencies, hashfiles, usedHashes, { allowDangerous: true });
}

console.log(chalk.blue("Final whitelisted hashes"));
const whitelisted: Record<
  string,
  {
    path: string;
    text: Array<{ line: number; code: string }>;
    ast: string[];
  }
> = {};
hashcheck: for (const [hash, file] of Object.entries(hashfiles)) {
  if (!file.final) continue;
  if (!file.dangers) throw new Error(`Missing danger analysis for ${file.path}`);
  if (!file.dangers.text.length && !file.dangers.ast.length) continue;
  const reviewedPath = path.relative(projectRoot, file.path);
  if (!acceptable.test(reviewedPath)) continue;
  for (const regex of unacceptable) {
    if (regex.test(reviewedPath)) continue hashcheck;
  }

  const text = file.dangers.text.map(({ line, code }) => ({ line, code }));
  whitelisted[hash] = { path: reviewedPath, text, ast: file.dangers.ast };
  console.log({ hash, path: reviewedPath, text, ast: file.dangers.ast });
}

const output = `export type WhitelistEntry = {
  path: string;
  text: Array<{ line: number; code: string }>;
  ast: string[];
};

export const whitelist: Record<string, WhitelistEntry> = ${JSON.stringify(whitelisted, null, 2)};
`;
await fs.writeFile(path.join(scriptsRoot, "whitelist.ts"), output);
await fs.writeFile(
  path.join(scriptsRoot, "..", "neutron-compiler", "whitelist.ts"),
  output,
);
await disposeMotokoCompiler();

async function collectMotokoFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMotokoFiles(target)));
    } else if (entry.isFile() && entry.name.endsWith(".mo")) {
      files.push(target);
    }
  }
  return files;
}
