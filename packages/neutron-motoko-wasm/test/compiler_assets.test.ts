import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";

type CompilerManifest = {
  source: {
    repository: string;
    revision: string;
    build_command: string;
    nix_store_output: string;
    provenance: string;
  };
  sha256: Record<string, string>;
};

const packageRoot = path.resolve(import.meta.dir, "..");
const compilerRoot = path.join(packageRoot, "compiler");
const manifest = JSON.parse(
  await fs.readFile(path.join(compilerRoot, "manifest.json"), "utf8"),
) as CompilerManifest;

test("pins the custom Motoko compiler source build", () => {
  expect(manifest.source).toMatchObject({
    repository: "https://github.com/infu/neutron_motoko",
    revision: "b93f048c8b261e374daab0bb0d4e7f9f2d4b725a",
    build_command: "scripts/build-neutron-moc-wasm <output-directory>",
  });
  expect(manifest.source.nix_store_output).toMatch(
    /^\/nix\/store\/[a-z0-9]+-moc\.wasm$/,
  );
  expect(manifest.source.provenance).toContain(
    "result symlinks are not compiler provenance",
  );
});

test("ships the exact composite compiler license materials", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
  expect(packageJson.license).toBe("SEE LICENSE IN LICENSES.md");

  const expected = {
    LICENSE:
      "907f6cd96b832f00713d86983eede6ce20e8cf8e3a70d2537f57215b7504db95",
    "LICENSE.js_of_ocaml":
      "ade61810946164eda728c580946f52b70e709f3f5dbcba68534b2f41a8104cb6",
  };
  for (const [name, expectedDigest] of Object.entries(expected)) {
    const contents = await fs.readFile(path.join(packageRoot, name));
    expect(createHash("sha256").update(contents).digest("hex")).toBe(
      expectedDigest,
    );
    expect(contents.toString("utf8").split("\n").length - 1).toBeLessThanOrEqual(
      675,
    );
  }

  const index = await fs.readFile(
    path.join(packageRoot, "LICENSES.md"),
    "utf8",
  );
  const notice = await fs.readFile(path.join(packageRoot, "NOTICE"), "utf8");
  for (const text of [index, notice]) {
    expect(text).toContain("b93f048c8b261e374daab0bb0d4e7f9f2d4b725a");
    expect(text).toContain("e4d950bc1cbcb0f8fc61cce06b0c6a2c55f94581");
    expect(text).toContain("LICENSE.js_of_ocaml");
  }
  expect(index).toContain(
    "https://github.com/infu/neutron_motoko/tree/b93f048c8b261e374daab0bb0d4e7f9f2d4b725a",
  );
  expect(index).toContain(
    "https://github.com/ocsigen/js_of_ocaml/tree/e4d950bc1cbcb0f8fc61cce06b0c6a2c55f94581",
  );
  expect(index).not.toContain("third-party inventory is complete");
});

test("vendored compiler assets match every pinned SHA-256", async () => {
  const checksumText = await fs.readFile(
    path.join(compilerRoot, "SHA256SUMS"),
    "utf8",
  );
  const checksums = Object.fromEntries(
    checksumText
      .trim()
      .split("\n")
      .map((line) => {
        const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/);
        if (!match) throw new Error(`Invalid SHA256SUMS entry: ${line}`);
        return [match[2]!, match[1]!];
      }),
  );

  expect(checksums).toEqual(manifest.sha256);
  for (const [relativePath, expected] of Object.entries(manifest.sha256)) {
    const content = await fs.readFile(path.join(compilerRoot, relativePath));
    expect(createHash("sha256").update(content).digest("hex")).toBe(expected);
  }
});

test("ships the browser worker as a local wrapper around pinned assets", async () => {
  const loader = await fs.readFile(
    path.join(compilerRoot, "moc.wasm.js"),
    "utf8",
  );
  const worker = await fs.readFile(
    path.join(compilerRoot, "compiler-worker.js"),
    "utf8",
  );

  expect(loader).toContain("globalThis.NeutronMotokoReady=");
  expect(worker).toContain('importScripts("./moc.wasm.js")');
  expect(worker).toContain("globalThis.NeutronMotokoReady");
  expect(worker).toContain("waitForCompilerInitialization");
  expect(worker).toContain(
    "Motoko Wasm compiler artifact does not expose NeutronMotokoReady",
  );
  expect(worker).not.toContain("COMPILER_INITIALIZATION_POLL_MS");
  expect(worker).toContain("dispatchQueue");
  expect(worker).toContain('"compileWasm"');
  expect(worker).toContain("collectTransferableBuffers");
  expect(manifest.sha256).not.toHaveProperty("compiler-worker.js");
});

test("all compiler hosts require bounded readiness without polling", async () => {
  const service = await fs.readFile(
    path.resolve(compilerRoot, "../compiler-service.cjs"),
    "utf8",
  );
  const nodeLoader = await fs.readFile(
    path.resolve(compilerRoot, "../src/index.ts"),
    "utf8",
  );

  for (const host of [service, nodeLoader]) {
    expect(host).toContain("globalThis.NeutronMotokoReady");
    expect(host).toContain("waitForCompilerInitialization");
    expect(host).toContain("COMPILER_INITIALIZATION_TIMEOUT_MS");
    expect(host).toContain(
      "Motoko Wasm compiler artifact does not expose NeutronMotokoReady",
    );
    expect(host).toContain("Motoko Wasm compiler initialization failed");
  }
  expect(service).not.toMatch(/for\s*\([^)]*<\s*200/);
  expect(service).not.toContain("setTimeout(resolve, 25)");
});
