import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { loadAuditedUnbundledNpmPackages, writeNpmBuildEvidence } from "../src/npm_build_evidence.ts";
import { buildThirdPartyNoticeBundle, THIRD_PARTY_NOTICE_MATERIAL_BUNDLE_PATH } from "../src/third_party_notices.ts";

async function fixture() {
  const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "neutron-sdk-notices-"));
  const appRoot = path.join(repositoryRoot, "apps/demo");
  await fs.mkdir(path.join(appRoot, "dist/web"), { recursive: true });
  await fs.mkdir(path.join(repositoryRoot, "legal"));
  const apacheLicensePath = path.join(repositoryRoot, "legal/Apache.txt");
  await fs.copyFile(path.resolve(import.meta.dir, "../LICENSE"), apacheLicensePath);
  return { repositoryRoot, appRoot, apacheLicensePath, mopsSourcesOutput: "" };
}
const artifact = "../../node_modules/@uniswap/v3-periphery/artifacts/contracts/Position.sol/Position.json";
async function proof(appRoot: string, contribution = 0) {
  const content = "export const ready = true;\n";
  const inputPath = path.resolve(appRoot, artifact);
  await fs.mkdir(path.dirname(inputPath), { recursive: true });
  await fs.writeFile(inputPath, "{}");
  await fs.copyFile(new URL("./fixtures/uniswap-v3-periphery-1.4.4.package.json", import.meta.url), path.resolve(appRoot, "../../node_modules/@uniswap/v3-periphery/package.json"));
  await fs.writeFile(path.join(appRoot, "dist/web/main.js"), content);
  await writeNpmBuildEvidence(appRoot, {
    inputs: { [artifact]: {} },
    outputs: { "dist/web/main.js": { bytes: Buffer.byteLength(content), inputs: { [artifact]: { bytesInOutput: contribution } } } },
  });
}

test("only current zero-contribution artifact evidence enables audited omission", async () => {
  const f = await fixture();
  try {
    expect((await loadAuditedUnbundledNpmPackages(f.appRoot, f.repositoryRoot)).omittedPackages.size).toBe(0);
    await proof(f.appRoot);
    const { omittedPackages: omitted } = await loadAuditedUnbundledNpmPackages(f.appRoot, f.repositoryRoot);
    expect([...omitted].some((key) => key.startsWith("@uniswap/v3-periphery@1.4.4\u0000"))).toBe(true);
    expect([...omitted].some((key) => key.startsWith("@uniswap/v3-periphery@1.4.5\u0000"))).toBe(false);
    await proof(f.appRoot, 1);
    expect([...(await loadAuditedUnbundledNpmPackages(f.appRoot, f.repositoryRoot)).omittedPackages].some((key) => key.startsWith("@uniswap/v3-periphery@"))).toBe(false);
    await proof(f.appRoot);
    await fs.appendFile(path.join(f.appRoot, "dist/web/main.js"), "// changed output");
    await expect(loadAuditedUnbundledNpmPackages(f.appRoot, f.repositoryRoot)).rejects.toThrow("Stale npm build evidence");
  } finally { await fs.rm(f.repositoryRoot, { recursive: true, force: true }); }
});

test("copied executable assets cannot bypass the evidenced build inventory", async () => {
  const f = await fixture();
  try {
    await proof(f.appRoot);
    await fs.writeFile(path.join(f.appRoot, "dist/web/copied.js"), "export const contractBytes = 'copied';");
    await expect(loadAuditedUnbundledNpmPackages(f.appRoot, f.repositoryRoot)).rejects.toThrow("absent from npm build evidence");
  } finally { await fs.rm(f.repositoryRoot, { recursive: true, force: true }); }
});

test("missing ethers license uses exact upstream text and refuses changed identity", async () => {
  const f = await fixture(), dependency = path.join(f.repositoryRoot, "node_modules/@ethersproject/logger");
  try {
    await fs.mkdir(dependency, { recursive: true });
    const manifest = await fs.readFile(new URL("./fixtures/ethers-logger-5.8.0.package.json", import.meta.url));
    await fs.writeFile(path.join(dependency, "package.json"), manifest);
    await fs.writeFile(path.join(f.appRoot, "package.json"), JSON.stringify({ name: "demo", dependencies: { "@ethersproject/logger": "5.8.0" } }));
    const bundle = await buildThirdPartyNoticeBundle(f);
    const exact = await fs.readFile(new URL("../assets/legal/Ethers-5.8.0.LICENSE", import.meta.url), "utf8");
    expect(new TextDecoder().decode(bundle.files[THIRD_PARTY_NOTICE_MATERIAL_BUNDLE_PATH])).toContain(exact);
    expect(bundle.components[0]?.selectedLicense).toBe("MIT");
    await fs.writeFile(path.join(dependency, "package.json"), JSON.stringify({ ...JSON.parse(manifest.toString()), description: "changed" }));
    await expect(buildThirdPartyNoticeBundle(f)).rejects.toThrow("fresh missing-license audit");
    await fs.writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: "@ethersproject/logger", version: "5.9.0", license: "MIT" }));
    await expect(buildThirdPartyNoticeBundle(f)).rejects.toThrow("no installed LICENSE");
  } finally { await fs.rm(f.repositoryRoot, { recursive: true, force: true }); }
});

test("audited README license remains exact and changed material is rejected", async () => {
  const f = await fixture(), dependency = path.join(f.repositoryRoot, "node_modules/brorand");
  try {
    await fs.mkdir(dependency, { recursive: true });
    for (const file of ["package.json", "README.md"]) await fs.copyFile(new URL(`./fixtures/brorand-1.1.0/${file}`, import.meta.url), path.join(dependency, file));
    await fs.writeFile(path.join(f.appRoot, "package.json"), JSON.stringify({ name: "demo", dependencies: { brorand: "1.1.0" } }));
    const bundle = await buildThirdPartyNoticeBundle(f);
    expect(new TextDecoder().decode(bundle.files[THIRD_PARTY_NOTICE_MATERIAL_BUNDLE_PATH])).toContain(await fs.readFile(path.join(dependency, "README.md"), "utf8"));
    await fs.appendFile(path.join(dependency, "README.md"), "\nChanged material\n");
    await expect(buildThirdPartyNoticeBundle(f)).rejects.toThrow("legal material hash changed");
  } finally { await fs.rm(f.repositoryRoot, { recursive: true, force: true }); }
});
