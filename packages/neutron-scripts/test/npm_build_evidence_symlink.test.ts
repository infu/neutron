import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { build } from "esbuild";
import { loadAuditedUnbundledNpmPackages, writeNpmBuildEvidence } from "../src/npm_build_evidence.ts";

const auditedKey = "@uniswap/v3-periphery@1.4.4\u0000d0a70553d6bbcc270261e3ebb9a3f17b8a3f8f00978f2d430233eaeb87350481";

async function fixture() {
  const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "neutron-symlink-evidence-"));
  const appRoot = path.join(repositoryRoot, "apps/demo");
  const packageRoot = path.join(repositoryRoot, "vendor/periphery");
  await fs.mkdir(path.join(appRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(packageRoot, "artifacts/contracts"), { recursive: true });
  await fs.mkdir(path.join(repositoryRoot, "node_modules/@uniswap"), { recursive: true });
  await fs.writeFile(path.join(appRoot, "package.json"), JSON.stringify({ name: "fixture-app", version: "1.0.0" }));
  await fs.copyFile(new URL("./fixtures/uniswap-v3-periphery-1.4.4.package.json", import.meta.url), path.join(packageRoot, "package.json"));
  await fs.writeFile(path.join(packageRoot, "artifacts/contracts/fixture.json"), JSON.stringify({ bytecode: "0x123456789abcdef" }));
  await fs.symlink(packageRoot, path.join(repositoryRoot, "node_modules/@uniswap/v3-periphery"), "dir");
  const prove = async (source: string) => {
    await fs.writeFile(path.join(appRoot, "src/main.js"), source);
    const result = await build({
      absWorkingDir: appRoot,
      entryPoints: ["src/main.js"],
      outdir: "dist/web",
      bundle: true,
      minify: true,
      platform: "browser",
      metafile: true,
    });
    await writeNpmBuildEvidence(appRoot, result.metafile!);
    return { metafile: result.metafile!, evidence: await loadAuditedUnbundledNpmPackages(appRoot, repositoryRoot) };
  };
  return { repositoryRoot, appRoot, packageRoot, prove };
}

test("real esbuild symlink inputs cannot omit emitted audited artifact bytes", async () => {
  const f = await fixture();
  try {
    const { metafile, evidence } = await f.prove("import artifact from '@uniswap/v3-periphery/artifacts/contracts/fixture.json'; console.log(artifact.bytecode);");
    const artifactInput = Object.keys(metafile.inputs).find((input) => input.endsWith("fixture.json"))!;
    expect(artifactInput).toBe("../../vendor/periphery/artifacts/contracts/fixture.json");
    expect(metafile.outputs["dist/web/main.js"]!.inputs[artifactInput]!.bytesInOutput).toBeGreaterThan(0);
    expect(evidence.omittedPackages.has(auditedKey)).toBe(false);
    expect(evidence.emittedPackageKeys.has(auditedKey)).toBe(true);
    expect([...evidence.emittedPackageKeys].some((key) => key.startsWith("fixture-app@"))).toBe(false);
  } finally { await fs.rm(f.repositoryRoot, { recursive: true, force: true }); }
});

test("zero-byte symlink omission requires artifact paths and exact package identity", async () => {
  const f = await fixture();
  try {
    const zero = await f.prove("import artifact from '@uniswap/v3-periphery/artifacts/contracts/fixture.json'; console.log('ready');");
    expect(Object.keys(zero.metafile.inputs)).toContain("../../vendor/periphery/artifacts/contracts/fixture.json");
    expect(zero.evidence.omittedPackages.has(auditedKey)).toBe(true);
    const nestedRoot = path.join(f.appRoot, "node_modules/@uniswap/v3-periphery");
    await fs.mkdir(path.join(nestedRoot, "artifacts/contracts"), { recursive: true });
    const previous = JSON.parse(await fs.readFile(path.join(f.packageRoot, "package.json"), "utf8"));
    await fs.writeFile(path.join(nestedRoot, "package.json"), JSON.stringify({ ...previous, version: "1.4.5" }));
    await fs.writeFile(path.join(nestedRoot, "artifacts/contracts/fixture.json"), JSON.stringify({ bytecode: "0xfedcba987654321" }));
    const mixed = await f.prove("import unused from '../../../vendor/periphery/artifacts/contracts/fixture.json'; import emitted from '@uniswap/v3-periphery/artifacts/contracts/fixture.json'; console.log(emitted.bytecode);");
    expect(mixed.evidence.omittedPackages.has(auditedKey)).toBe(true);
    expect([...mixed.evidence.emittedPackageKeys].some((key) => key.startsWith("@uniswap/v3-periphery@1.4.5\u0000"))).toBe(true);
    expect([...mixed.evidence.omittedPackages].some((key) => key.startsWith("@uniswap/v3-periphery@1.4.5\u0000"))).toBe(false);
    await fs.writeFile(path.join(f.packageRoot, "helper.js"), "export const unused = 'artifact helper';");
    const nonArtifact = await f.prove("import {unused} from '../../../vendor/periphery/helper.js'; console.log('ready');");
    expect(Object.keys(nonArtifact.metafile.inputs)).toContain("../../vendor/periphery/helper.js");
    expect(nonArtifact.evidence.omittedPackages.has(auditedKey)).toBe(false);
  } finally { await fs.rm(f.repositoryRoot, { recursive: true, force: true }); }
});

test("emitted workspace dependencies retain notice identity while own app is excluded", async () => {
  const f = await fixture();
  try {
    const workspaceRoot = path.join(f.repositoryRoot, "packages/sdk");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "fixture-sdk", version: "1.0.0", main: "index.js" }));
    await fs.writeFile(path.join(workspaceRoot, "index.js"), "export const sdk = 'workspace library';");
    await fs.symlink(workspaceRoot, path.join(f.repositoryRoot, "node_modules/fixture-sdk"), "dir");
    const { evidence } = await f.prove("import {sdk} from 'fixture-sdk'; console.log(sdk);");
    expect([...evidence.emittedPackageKeys].some((key) => key.startsWith("fixture-sdk@1.0.0\u0000"))).toBe(true);
    expect([...evidence.emittedPackageKeys].some((key) => key.startsWith("fixture-app@"))).toBe(false);
  } finally { await fs.rm(f.repositoryRoot, { recursive: true, force: true }); }
});
