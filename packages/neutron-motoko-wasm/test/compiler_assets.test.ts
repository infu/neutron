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

const compilerRoot = path.resolve(import.meta.dir, "../compiler");
const manifest = JSON.parse(
  await fs.readFile(path.join(compilerRoot, "manifest.json"), "utf8"),
) as CompilerManifest;

test("pins the custom Motoko compiler source build", () => {
  expect(manifest.source).toMatchObject({
    repository: "https://github.com/infu/neutron_motoko",
    revision: "d7ed0a92b6219d784b7143e0851ed64b55dfc25a",
    build_command: "scripts/build-neutron-moc-wasm <output-directory>",
  });
  expect(manifest.source.nix_store_output).toMatch(
    /^\/nix\/store\/[a-z0-9]+-moc\.wasm$/,
  );
  expect(manifest.source.provenance).toContain(
    "result symlinks are not compiler provenance",
  );
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
