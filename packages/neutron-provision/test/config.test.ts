import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { preparePackageInstall } from "neutron-compiler/src/install.js";
import {
  deriveNdeploySessionPath,
  loadNdeployConfig,
  parseNdeployConfig,
  resolveLocalPackagePaths,
  type NdeployArtifactSet,
  type NdeployPinnedArchiveConfig,
} from "../src/config.ts";
import { testKernelConnectionProviderSupport } from "./package_fixture.ts";

const AUTHORIZED_PRINCIPAL =
  "pbwxr-uqxlv-aiwi3-omw2n-ptdex-kyifb-kdsn6-zdiyd-ggzpu-nrzik-rqe";

describe("ndeploy archive-only config format 3", () => {
  test("requires one explicit app-neutral PocketIC profile", () => {
    for (const profile of ["minimal", "full_protocol_fixtures"] as const) {
      const config = pocketIcConfig({
        kind: "inline",
        kernel: { path: "kernel.neutron" },
        packages: [],
      });
      expect(
        parseNdeployConfig({
          ...config,
          target: { ...config.target, profile },
        }).target,
      ).toMatchObject({ kind: "pocketic", profile });
    }
    const config = pocketIcConfig({
      kind: "inline",
      kernel: { path: "kernel.neutron" },
      packages: [],
    });
    for (const profile of [undefined, "neutron-local-v1", "wallet"]) {
      const target = { ...config.target } as Record<string, unknown>;
      if (profile === undefined) delete target.profile;
      else target.profile = profile;
      expect(() =>
        parseNdeployConfig({ ...config, target }),
      ).toThrow(/target.*profile/u);
    }
  });

  test("loads and authenticates an external closed artifact set", async () => {
    await withArchiveFixture(async ({ root, artifactSet }) => {
      const filename = path.join(root, "wagyu.ndeploy.json");
      const artifactSetPath = path.join(
        root,
        ".neutron",
        "deploy",
        "wagyu.artifacts.json",
      );
      await mkdir(path.dirname(artifactSetPath), { recursive: true });
      await writeFile(
        artifactSetPath,
        `${JSON.stringify(artifactSet, null, 2)}\n`,
      );
      await writeFile(
        filename,
        `${JSON.stringify(
          pocketIcConfig({
            kind: "file",
            path: ".neutron/deploy/wagyu.artifacts.json",
          }),
          null,
          2,
        )}\n`,
      );

      const loaded = await loadNdeployConfig(filename);
      expect(loaded).toMatchObject({
        configPath: filename,
        configSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        sessionPath: path.join(root, "wagyu.ndeploy.session.json"),
        packageArtifacts: [
          {
            id: artifactSet.kernel.id,
            version: artifactSet.kernel.version,
            sha256: artifactSet.kernel.sha256,
            bytes: artifactSet.kernel.bytes,
          },
          {
            id: artifactSet.packages[0]!.id,
            version: artifactSet.packages[0]!.version,
            sha256: artifactSet.packages[0]!.sha256,
            bytes: artifactSet.packages[0]!.bytes,
          },
        ],
        target: {
          kind: "pocketic",
          nodeLabels: ["alpha", "bravo", "charlie"],
          authorizedPrincipals: [AUTHORIZED_PRINCIPAL],
        },
      });
    });
  });

  test("rejects pinned local inline records and format-2 build configs", async () => {
    await withArchiveFixture(async ({ root, artifactSet }) => {
      const filename = path.join(root, "inline.ndeploy.json");
      await writeFile(
        filename,
        `${JSON.stringify(
          pocketIcConfig({
            kind: "inline",
            kernel: artifactSet.kernel,
            packages: artifactSet.packages,
          }),
        )}\n`,
      );
      await expect(loadNdeployConfig(filename)).rejects.toThrow(
        "unknown field",
      );
    });

    expect(() =>
      parseNdeployConfig({
        format: 2,
        target: {
          kind: "pocketic",
          profile: "minimal",
          gateway_port: 8000,
          developer_identity_seed: 2,
          authorized_principals: [],
        },
        kernel: { build: "apps/kernel" },
        packages: [{ build: "apps/wagyu" }],
      }),
    ).toThrow("unknown field");
  });

  test("keeps path-only PocketIC archives lazy until reinstall resolution", async () => {
    await withArchiveFixture(async ({ root, artifactSet }) => {
      const filename = path.join(root, "local-paths.ndeploy.json");
      await writeFile(
        filename,
        `${JSON.stringify(
          pocketIcConfig({
            kind: "inline",
            kernel: { path: artifactSet.kernel.path },
            packages: artifactSet.packages.map(({ path: archivePath }) => ({
              path: archivePath,
            })),
          }),
        )}\n`,
      );

      const loaded = await loadNdeployConfig(filename);
      expect(loaded.packageArtifacts).toEqual([]);
      expect(loaded.localPackagePaths).toEqual(
        [artifactSet.kernel, ...artifactSet.packages].map(
          ({ path: archivePath }) => archivePath,
        ),
      );
      expect(await resolveLocalPackagePaths(loaded)).toEqual(
        [artifactSet.kernel, ...artifactSet.packages].map(({ path: archivePath }) =>
          path.join(root, archivePath),
        ),
      );
    });
  });

  test("does not require path-only local archives for status-time config load", async () => {
    await withTempDirectory(async (root) => {
      const filename = path.join(root, "missing-local.ndeploy.json");
      await writeFile(
        filename,
        `${JSON.stringify(
          pocketIcConfig({
            kind: "inline",
            kernel: { path: "archives/missing-kernel.neutron" },
            packages: [{ path: "archives/missing-wagyu.neutron" }],
          }),
        )}\n`,
      );
      const loaded = await loadNdeployConfig(filename);
      expect(loaded.packageArtifacts).toEqual([]);
      await expect(resolveLocalPackagePaths(loaded)).rejects.toThrow(
        "does not exist",
      );
    });
  });

  test("rejects partial local records while keeping IC and external sets fully pinned", async () => {
    await withArchiveFixture(async ({ root, artifactSet }) => {
      const partial = pocketIcConfig({
        kind: "inline",
        kernel: {
          path: artifactSet.kernel.path,
          sha256: artifactSet.kernel.sha256,
        },
        packages: artifactSet.packages.map(({ path: archivePath }) => ({
          path: archivePath,
        })),
      });
      expect(() => parseNdeployConfig(partial)).toThrow("unknown field");

      const mixed = pocketIcConfig({
        kind: "inline",
        kernel: artifactSet.kernel,
        packages: artifactSet.packages.map(({ path: archivePath }) => ({
          path: archivePath,
        })),
      });
      expect(() => parseNdeployConfig(mixed)).toThrow("unknown field");

      expect(() =>
        parseNdeployConfig({
          format: 3,
          target: {
            kind: "ic",
            host: "https://icp-api.io",
            identity_id: 0,
            subnet: "subnet",
            payment_icp: "1",
            controllers: [],
            deployment_evidence: {
              source: "ic_registry_certified_v1",
              registry_canister: "rwlgt-iiaaa-aaaaa-aaaaa-cai",
              root_key_sha256:
                "737ba355e855bd4b61279056603e05501db5e5bad147c6eba7be8c2a13f4b6b3",
              pricing_profile: "application_13_node",
            },
          },
          artifacts: {
            kind: "inline",
            kernel: { path: artifactSet.kernel.path },
            packages: [],
          },
        }),
      ).toThrow("missing field(s)");

      const externalPath = path.join(root, "local-paths.artifacts.json");
      await writeFile(
        externalPath,
        `${JSON.stringify({
          format: 1,
          kernel: { path: artifactSet.kernel.path },
          packages: [],
        })}\n`,
      );
      const configPath = path.join(root, "external-local.ndeploy.json");
      await writeFile(
        configPath,
        `${JSON.stringify(
          pocketIcConfig({
            kind: "file",
            path: path.basename(externalPath),
          }),
        )}\n`,
      );
      await expect(loadNdeployConfig(configPath)).rejects.toThrow(
        "missing field(s)",
      );
    });
  });

  test("rejects format-2 PocketIC configs", async () => {
    await withTempDirectory(async (root) => {
      const filename = path.join(root, "legacy.ndeploy.json");
      await writeFile(
        filename,
        `${JSON.stringify({
          format: 2,
          target: {
            kind: "pocketic",
            profile: "minimal",
            gateway_port: 8000,
            developer_identity_seed: 2,
            authorized_principals: [],
          },
          kernel: { build: "apps/kernel" },
          packages: [{ build: "apps/hello" }],
        })}\n`,
      );
      await expect(loadNdeployConfig(filename)).rejects.toThrow(
        "unknown field",
      );
    });
  });

  test("fails closed on changed bytes, digest, size, or manifest identity", async () => {
    await withArchiveFixture(async ({ root, artifactSet }) => {
      const filename = path.join(root, "bad.ndeploy.json");
      const artifactSetPath = path.join(root, "bad.artifacts.json");
      const variants: NdeployPinnedArchiveConfig[] = [
        { ...artifactSet.kernel, sha256: "0".repeat(64) },
        { ...artifactSet.kernel, bytes: artifactSet.kernel.bytes + 1 },
        { ...artifactSet.kernel, id: "not-kernel" },
        { ...artifactSet.kernel, version: artifactSet.kernel.version + 1 },
      ];
      for (const kernel of variants) {
        await writeFile(
          artifactSetPath,
          `${JSON.stringify({ ...artifactSet, kernel })}\n`,
        );
        await writeFile(
          filename,
          `${JSON.stringify(
            pocketIcConfig({
              kind: "file",
              path: path.basename(artifactSetPath),
            }),
          )}\n`,
        );
        await expect(loadNdeployConfig(filename)).rejects.toThrow(
          /mismatch/u,
        );
      }

      await writeFile(
        artifactSetPath,
        `${JSON.stringify(artifactSet)}\n`,
      );
      await writeFile(
        filename,
        `${JSON.stringify(
          pocketIcConfig({
            kind: "file",
            path: path.basename(artifactSetPath),
          }),
        )}\n`,
      );
      await writeFile(
        path.join(root, artifactSet.kernel.path),
        new Uint8Array(artifactSet.kernel.bytes),
      );
      await expect(loadNdeployConfig(filename)).rejects.toThrow(
        /SHA-256 mismatch/u,
      );
    });
  });

  test("requires an external set to exist and stay inside the config directory", async () => {
    await withTempDirectory(async (root) => {
      const filename = path.join(root, "missing.ndeploy.json");
      await writeFile(
        filename,
        `${JSON.stringify(
          pocketIcConfig({
            kind: "file",
            path: ".neutron/deploy/missing.artifacts.json",
          }),
        )}\n`,
      );
      await expect(loadNdeployConfig(filename)).rejects.toThrow(
        "Produce the pinned archive or publish the external artifact set",
      );

      const outside = path.join(path.dirname(root), "outside-artifacts.json");
      await writeFile(outside, "{}");
      await symlink(outside, path.join(root, "escaped-artifacts.json"));
      await writeFile(
        filename,
        `${JSON.stringify(
          pocketIcConfig({
            kind: "file",
            path: "escaped-artifacts.json",
          }),
        )}\n`,
      );
      await expect(loadNdeployConfig(filename)).rejects.toThrow("escapes");
      await rm(outside, { force: true });
    });
  });

  test("requires a closed ordered local-node declaration", () => {
    const artifacts = {
      kind: "file" as const,
      path: ".neutron/deploy/wagyu.artifacts.json",
    };
    expect(
      parseNdeployConfig(pocketIcConfig(artifacts)).target,
    ).toMatchObject({ nodes: ["alpha", "bravo", "charlie"] });
    for (const nodes of [
      [],
      ["alpha", "alpha"],
      ["Alpha"],
      Array.from({ length: 17 }, (_, index) => `n-${index}`),
    ]) {
      const config = pocketIcConfig(artifacts);
      expect(() =>
        parseNdeployConfig({
          ...config,
          target: { ...config.target, nodes },
        }),
      ).toThrow("target.nodes");
    }
  });

  test("derives exactly one session path from the config suffix", () => {
    expect(deriveNdeploySessionPath("/tmp/neutron.ndeploy.json")).toBe(
      "/tmp/neutron.ndeploy.session.json",
    );
    expect(() => deriveNdeploySessionPath("/tmp/neutron.json")).toThrow(
      ".ndeploy.json",
    );
  });
});

function pocketIcConfig(artifacts: unknown) {
  return {
    format: 3,
    target: {
      kind: "pocketic",
      profile: "minimal",
      gateway_port: 8000,
      developer_identity_seed: 2,
      authorized_principals: [AUTHORIZED_PRINCIPAL],
      nodes: ["alpha", "bravo", "charlie"],
    },
    artifacts,
  } as const;
}

async function withArchiveFixture(
  callback: (fixture: {
    root: string;
    artifactSet: NdeployArtifactSet;
  }) => Promise<void>,
): Promise<void> {
  await withTempDirectory(async (root) => {
    const artifactsDirectory = path.join(root, "archives");
    await mkdir(artifactsDirectory, { recursive: true });
    const kernel = await writeTestArchiveAndPin(
      "kernel",
      path.join(artifactsDirectory, "kernel.neutron"),
      root,
    );
    const app = await writeTestArchiveAndPin(
      "hello",
      path.join(artifactsDirectory, "hello.neutron"),
      root,
    );
    await callback({
      root,
      artifactSet: { format: 1, kernel, packages: [app] },
    });
  });
}

async function writeTestArchiveAndPin(
  id: "kernel" | "hello",
  destination: string,
  configDirectory: string,
): Promise<NdeployPinnedArchiveConfig> {
  const bytes = testPackageArchive(id);
  await writeFile(destination, bytes);
  const prepared = preparePackageInstall(bytes);
  return {
    path: path.relative(configDirectory, destination),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    id: prepared.manifest.id,
    version: prepared.manifest.version,
  };
}

function testPackageArchive(id: "kernel" | "hello"): Uint8Array {
  const module = new TextEncoder().encode(
    `module { public class Init() { public func package_id() : Text { "${id}" } } }`,
  );
  const entry = createHash("sha256").update(module).digest("hex");
  const files: Record<string, Uint8Array> = {
    "neutron.json": new TextEncoder().encode(
      JSON.stringify({
        format: 3,
        id,
        name: id === "kernel" ? "Test Kernel" : "Test Hello",
        version: 100,
        entry,
        func: {
          package_id: { type: "update", async: false },
        },
      }),
    ),
    "web/index.html": new TextEncoder().encode(`<main>${id}</main>`),
    [`mo/${entry}.mo`]: module,
  };
  if (id === "kernel") {
    files["connection-providers.json"] =
      testKernelConnectionProviderSupport();
  }
  const chunks: Uint8Array[] = [
    Uint8Array.of(0x80 | Object.keys(files).length),
  ];
  for (const [filename, content] of Object.entries(files)) {
    chunks.push(encodeMessagePackString(filename));
    chunks.push(
      encodeMessagePackBinary(new Uint8Array(gzipSync(content))),
    );
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function encodeMessagePackString(value: string): Uint8Array {
  const content = Buffer.from(value, "utf8");
  if (content.byteLength < 32) {
    return new Uint8Array(
      Buffer.concat([
        Buffer.from([0xa0 | content.byteLength]),
        content,
      ]),
    );
  }
  if (content.byteLength <= 0xff) {
    return new Uint8Array(
      Buffer.concat([
        Buffer.from([0xd9, content.byteLength]),
        content,
      ]),
    );
  }
  throw new Error("Test MessagePack string is unexpectedly large");
}

function encodeMessagePackBinary(value: Uint8Array): Uint8Array {
  if (value.byteLength <= 0xff) {
    return new Uint8Array(
      Buffer.concat([
        Buffer.from([0xc4, value.byteLength]),
        value,
      ]),
    );
  }
  if (value.byteLength <= 0xffff) {
    return new Uint8Array(
      Buffer.concat([
        Buffer.from([
          0xc5,
          value.byteLength >>> 8,
          value.byteLength & 0xff,
        ]),
        value,
      ]),
    );
  }
  throw new Error("Test MessagePack binary is unexpectedly large");
}

async function withTempDirectory(
  callback: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "ndeploy-config-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
