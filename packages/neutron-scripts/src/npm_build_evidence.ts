import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// These exact Solidity distributions are dependencies of the MIT Uniswap SDKs,
// but their contracts, bytecode and build tools are not part of the browser app.
// Omission requires current, hashed esbuild evidence of zero emitted bytes.
// A different version/manifest always takes the normal complete notice path.
const AUDITED_ARTIFACT_PACKAGES = [
  ["@uniswap/swap-router-contracts", "1.3.1", "c35f23d2b7e607e268f6e0a035491e693f5be8e372e68e3739b5c42a1a96ce34"],
  ["@uniswap/v3-periphery", "1.4.4", "d0a70553d6bbcc270261e3ebb9a3f17b8a3f8f00978f2d430233eaeb87350481"],
  ["@uniswap/v3-staker", "1.0.0", "7d7a276781849073e572f276b68aaa80aafc1f5a1b82b7b330305f1566f5dc62"],
] as const;

export const NPM_BUILD_EVIDENCE_PATH = "dist/third-party-build.json";

type Metafile = Readonly<{
  inputs: Record<string, unknown>;
  outputs: Record<string, Readonly<{
    bytes: number;
    inputs: Record<string, Readonly<{ bytesInOutput: number }>>;
  }>>;
}>;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function inside(root: string, value: string): string {
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Build evidence path is outside its root: ${value}`);
  }
  return resolved;
}

/** Called after the real browser build, never from a separate approximation. */
export async function writeNpmBuildEvidence(appRoot: string, metafile: Metafile): Promise<void> {
  const hashes: Record<string, string> = {};
  for (const [output, detail] of Object.entries(metafile.outputs)) {
    const bytes = await fs.readFile(inside(appRoot, output));
    if (bytes.byteLength !== detail.bytes) throw new Error(`Build output changed before evidence: ${output}`);
    hashes[output] = digest(bytes);
  }
  await fs.writeFile(path.join(appRoot, NPM_BUILD_EVIDENCE_PATH), JSON.stringify({
    format: 1,
    metafile,
    outputSha256: hashes,
  }));
}

/** Missing evidence preserves the existing conservative dependency closure. */
export async function loadAuditedUnbundledNpmPackages(
  appRoot: string,
  repositoryRoot: string,
): Promise<Readonly<{
  omittedPackages: ReadonlySet<string>;
  emittedPackageKeys: ReadonlySet<string>;
}>> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(appRoot, NPM_BUILD_EVIDENCE_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { omittedPackages: new Set(), emittedPackageKeys: new Set() };
    }
    throw error;
  }
  const evidence = JSON.parse(raw);
  const invalid = () => new Error("Invalid npm browser build evidence");
  if (evidence?.format !== 1 || !evidence.metafile || !evidence.outputSha256) throw invalid();
  const { inputs, outputs } = evidence.metafile;
  if (!inputs || !outputs || Object.keys(outputs).length === 0) throw invalid();
  const emittedInputs = new Set<string>();
  const provenOutputs = new Set<string>();
  for (const [output, untypedDetail] of Object.entries(outputs)) {
    const detail = untypedDetail as Metafile["outputs"][string];
    const outputPath = inside(appRoot, output);
    const realOutputPath = await fs.realpath(outputPath);
    inside(appRoot, realOutputPath);
    const bytes = await fs.readFile(realOutputPath);
    if (bytes.byteLength !== detail.bytes || digest(bytes) !== evidence.outputSha256[output]) {
      throw new Error(`Stale npm build evidence: ${output}`);
    }
    provenOutputs.add(outputPath);
    if (!detail.inputs) throw invalid();
    for (const [input, contribution] of Object.entries(detail.inputs)) {
      if (!Object.hasOwn(inputs, input) || !Number.isFinite(contribution.bytesInOutput) || contribution.bytesInOutput < 0) throw invalid();
      if (contribution.bytesInOutput > 0) emittedInputs.add(input);
    }
  }
  // Every executable browser asset must belong to the evidenced build. This
  // catches stale/copied JS or WASM that esbuild's output inventory omits.
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (/\.(?:[cm]?js|wasm)$/u.test(entry.name) && !provenOutputs.has(child)) {
        throw new Error(`Executable asset is absent from npm build evidence: ${child}`);
      }
    }
  };
  await visit(path.join(appRoot, "dist/web"));

  type PackageIdentity = Readonly<{ key: string; root: string }>;
  const identities = new Map<string, Promise<PackageIdentity | null>>();
  const findIdentity = (directory: string): Promise<PackageIdentity | null> => {
    if (directory === repositoryRoot) return Promise.resolve(null);
    const cached = identities.get(directory);
    if (cached !== undefined) return cached;
    const pending = (async () => {
      try {
        const manifestPath = await fs.realpath(path.join(directory, "package.json"));
        inside(repositoryRoot, manifestPath);
        const bytes = await fs.readFile(manifestPath);
        const manifest = JSON.parse(bytes.toString("utf8"));
        if (typeof manifest.name === "string" && typeof manifest.version === "string") {
          return { key: `${manifest.name}@${manifest.version}\u0000${digest(bytes)}`, root: directory };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return findIdentity(path.dirname(directory));
    })();
    identities.set(directory, pending);
    return pending;
  };

  // esbuild follows installed-package symlinks by default, so its input paths
  // may be in vendor/ or a workspace rather than node_modules/. Attribute the
  // real files to exact manifests instead of guessing from their path spelling.
  const packageInputs = new Map<string, { emitted: boolean; relativePath: string }[]>();
  const emittedPackageKeys = new Set<string>();
  for (const input of Object.keys(inputs)) {
    // These are esbuild-generated empty browser stubs, not installed files.
    if (input.startsWith("(disabled):") || input === "<runtime>") continue;
    const lexicalPath = inside(repositoryRoot, path.resolve(appRoot, input));
    const resolved = await fs.realpath(lexicalPath);
    inside(repositoryRoot, resolved);
    const identity = await findIdentity(path.dirname(resolved));
    if (identity === null) {
      if (emittedInputs.has(input) && lexicalPath.split(path.sep).includes("node_modules")) {
        throw new Error(`Emitted npm input has no package identity: ${input}`);
      }
      continue;
    }
    const group = packageInputs.get(identity.key) ?? [];
    group.push({ emitted: emittedInputs.has(input), relativePath: path.relative(identity.root, resolved).split(path.sep).join("/") });
    packageInputs.set(identity.key, group);
    if (emittedInputs.has(input) && identity.root !== appRoot) emittedPackageKeys.add(identity.key);
  }
  const omitted = new Set<string>();
  for (const [name, version, manifestHash] of AUDITED_ARTIFACT_PACKAGES) {
    const key = `${name}@${version}\u0000${manifestHash}`;
    const group = packageInputs.get(key) ?? [];
    if (group.some(({ emitted, relativePath }) => emitted || !relativePath.startsWith("artifacts/contracts/") || !relativePath.endsWith(".json"))) continue;
    omitted.add(key);
  }
  return { omittedPackages: omitted, emittedPackageKeys };
}
