import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBootMetadataAssets } from "../src/tools/boot_metadata.ts";
import {
  KERNEL_CANDID_PACKAGE_PATH,
  KERNEL_STABLE_TYPES_PACKAGE_PATH,
  withKernelBuildMetadata,
  withKernelCandid,
} from "./package_metadata_fixture.ts";
import {
  compileMotokoWithCandid,
  type MopsCommandRunner,
} from "../src/tools/moc.ts";
import { registryApp } from "./app_registry_fixture.ts";

test("kernel Motoko builds use vendored Wasm and never resolve a host moc", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-kernel-wasm-build-"),
  );
  const calls: Parameters<MopsCommandRunner>[] = [];
  const run: MopsCommandRunner = async (...args) => {
    calls.push(args);
    if (args[0] !== "mops" || args[1].join(" ") !== "sources") {
      throw new Error(`Unexpected host command: ${args[0]} ${args[1].join(" ")}`);
    }
    return {
      stdout: "--package build-fixture packages/build-fixture\n",
      stderr: "",
    };
  };

  try {
    await Promise.all([
      fs.mkdir(path.join(root, "backend"), { recursive: true }),
      fs.mkdir(path.join(root, "packages", "build-fixture"), {
        recursive: true,
      }),
    ]);
    await fs.writeFile(
      path.join(root, "backend", "_neutron.mo"),
      `import Local "local";
       import Fixture "mo:build-fixture";
       persistent actor {
         public query func ping() : async Nat { Local.value + Fixture.value }
       }`,
      "utf8",
    );
    await Promise.all([
      fs.writeFile(
        path.join(root, "backend", "local.mo"),
        "module { public let value : Nat = 40 }",
        "utf8",
      ),
      fs.writeFile(
        path.join(root, "packages", "build-fixture", "lib.mo"),
        "module { public let value : Nat = 2 }",
        "utf8",
      ),
    ]);

    const result = await compileMotokoWithCandid({
      cwd: root,
      sourcePath: "backend/_neutron.mo",
      outputPath: "dist/neutron",
      emitStableTypes: true,
      run,
    });

    expect(calls).toEqual([["mops", ["sources"], { cwd: root }]]);
    expect(result).toEqual({
      wasmPath: path.join(root, "dist", "neutron"),
      candidPath: path.join(root, "dist", "neutron.did"),
      stableTypesPath: path.join(root, "dist", "neutron.most"),
    });

    const [wasm, candid, stable, implementation] = await Promise.all([
      fs.readFile(result.wasmPath),
      fs.readFile(result.candidPath, "utf8"),
      fs.readFile(result.stableTypesPath!, "utf8"),
      fs.readFile(
        new URL("../src/tools/moc.ts", import.meta.url),
        "utf8",
      ),
    ]);
    expect([...wasm.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
    expect(candid).toContain("ping");
    expect(stable.length).toBeGreaterThan(0);
    expect(implementation).not.toContain('"toolchain"');
    expect(implementation).not.toContain('"--fallback"');
    expect(implementation).not.toContain("process.env.MOC");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("prepared package uses the Candid emitted with its Wasm", () => {
  const oldCandid = new Uint8Array([1]);
  const exactCandid = new Uint8Array([2, 3]);
  const files = withKernelCandid(
    [
      { path: "index.html", content: new Uint8Array([4]) },
      { path: KERNEL_CANDID_PACKAGE_PATH, content: oldCandid },
    ],
    exactCandid,
  );

  expect(
    files.filter(({ path }) => path === KERNEL_CANDID_PACKAGE_PATH),
  ).toEqual([
    { path: KERNEL_CANDID_PACKAGE_PATH, content: exactCandid },
  ]);
});

test("prepared package includes the exact stable types emitted with its Wasm", () => {
  const exactCandid = new Uint8Array([2, 3]);
  const exactStableTypes = new Uint8Array([4, 5]);
  const files = withKernelBuildMetadata(
    [
      { path: "index.html", content: new Uint8Array([1]) },
      {
        path: KERNEL_CANDID_PACKAGE_PATH,
        content: new Uint8Array([6]),
      },
      {
        path: KERNEL_STABLE_TYPES_PACKAGE_PATH,
        content: new Uint8Array([7]),
      },
    ],
    exactCandid,
    exactStableTypes,
  );

  expect(
    files.filter(
      ({ path }) =>
        path === KERNEL_CANDID_PACKAGE_PATH ||
        path === KERNEL_STABLE_TYPES_PACKAGE_PATH,
    ),
  ).toEqual([
    { path: KERNEL_CANDID_PACKAGE_PATH, content: exactCandid },
    {
      path: KERNEL_STABLE_TYPES_PACKAGE_PATH,
      content: exactStableTypes,
    },
  ]);
});

test("legacy boot metadata uses the valid identity content encoding", () => {
  const assets = createBootMetadataAssets({
    appConfig: { kernel: registryApp({ id: "kernel", name: "Neutron" }) },
    canisterId: "aaaaa-aa",
  });

  expect(assets.map(({ key }) => key)).toEqual([
    "/system/apps.json",
    "/pkg/id.json",
  ]);
  expect(assets.map(({ val }) => val.content_encoding)).toEqual([
    "identity",
    "identity",
  ]);
});
