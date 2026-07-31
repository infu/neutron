import { describe, expect, test } from "bun:test";
import path from "node:path";
import { sha256 } from "js-sha256";
import { NEUTRON_REPOSITORY_PROTOCOL } from "neutron-tools/repository";
import {
  generateRepository,
  repositorySetupLinks,
  splitChunks,
  type InspectedNeutronPackage,
} from "../src/generate.ts";

const workspaceRoot = "/workspace/neutron";
const configDir = path.join(workspaceRoot, "support/repository");
const hello = Uint8Array.of(1, 2, 3, 4);
const kitchen = Uint8Array.of(2, 8, 9);

function config() {
  return {
    info: {
      protocol: NEUTRON_REPOSITORY_PROTOCOL,
      name: "Example repository",
      provider: { name: "Example provider" },
    },
    manifests: [
      {
        id: "hello",
        revision: 1,
        name: "Hello",
        packages: [{ file: "../../apps/hello/hello.v0.1.1.neutron" }],
      },
      {
        id: "demopack",
        revision: 1,
        name: "Demo Pack",
        packages: [
          { file: "../../apps/hello/hello.v0.1.1.neutron" },
          { file: "../../apps/kitchensink/kitchensink.v0.2.0.neutron" },
        ],
      },
    ],
  };
}

const inspect = async (bytes: Uint8Array): Promise<InspectedNeutronPackage> =>
  bytes[0] === 1
    ? {
        id: "hello",
        version: 101,
        archiveEntries: 1,
        decodedBytes: bytes.byteLength,
        mutableFiles: 1,
      }
    : {
        id: "kitchensink",
        version: 200,
        archiveEntries: 1,
        decodedBytes: bytes.byteLength,
        mutableFiles: 1,
      };

const read = async (absolutePath: string): Promise<Uint8Array> => {
  if (absolutePath.endsWith("/hello/hello.v0.1.1.neutron")) return hello;
  if (absolutePath.endsWith("/kitchensink/kitchensink.v0.2.0.neutron")) return kitchen;
  throw new Error("missing");
};

describe("static repository generator", () => {
  test("derives identities, hashes, sizes and content-addressed resources", async () => {
    const generated = await generateRepository({
      config: config(),
      configDir,
      workspaceRoot,
      readPackage: read,
      inspectPackage: inspect,
    });
    expect(generated.index.manifests.map((entry) => entry.id)).toEqual([
      "demopack",
      "hello",
    ]);
    expect(generated.packages.size).toBe(2);
    expect(generated.manifests.get("demopack")?.manifest.packages).toEqual([
      {
        id: "hello",
        version: 101,
        sha256: sha256(hello),
        size: hello.byteLength,
      },
      {
        id: "kitchensink",
        version: 200,
        sha256: sha256(kitchen),
        size: kitchen.byteLength,
      },
    ]);
    expect(generated.resources.map((resource) => resource.path)).toEqual(
      [...generated.resources.map((resource) => resource.path)].sort(),
    );
    expect(generated.resources.some((resource) =>
      resource.path === `/repo/v1/packages/${sha256(hello)}.neutron`
    )).toBe(true);
    expect(generated.motokoSource).toContain("public let resources");
  });

  test("is byte-for-byte deterministic and reads a shared package once", async () => {
    let reads = 0;
    const options = {
      config: config(),
      configDir,
      workspaceRoot,
      readPackage: async (absolutePath: string) => {
        reads += 1;
        return read(absolutePath);
      },
      inspectPackage: inspect,
    };
    const first = await generateRepository(options);
    expect(reads).toBe(2);
    reads = 0;
    const second = await generateRepository(options);
    expect(reads).toBe(2);
    expect(second.motokoSource).toBe(first.motokoSource);
    expect(second.indexBytes).toEqual(first.indexBytes);
  });

  test("sorts manifest ids by the protocol's locale-independent order", async () => {
    const punctuated = config();
    punctuated.manifests = [
      {
        id: "demo_a",
        revision: 1,
        name: "Underscore",
        packages: [{ file: "../../apps/hello/hello.v0.1.1.neutron" }],
      },
      {
        id: "demo-a",
        revision: 1,
        name: "Hyphen",
        packages: [{ file: "../../apps/hello/hello.v0.1.1.neutron" }],
      },
    ];
    const generated = await generateRepository({
      config: punctuated,
      configDir,
      workspaceRoot,
      readPackage: read,
      inspectPackage: inspect,
    });
    expect(generated.index.manifests.map(({ id }) => id)).toEqual([
      "demo-a",
      "demo_a",
    ]);
  });

  test("fails on missing files, workspace escapes, and filename identity mismatch", async () => {
    await expect(
      generateRepository({
        config: config(),
        configDir,
        workspaceRoot,
        readPackage: async () => {
          throw new Error("ENOENT");
        },
        inspectPackage: inspect,
      }),
    ).rejects.toThrow("Unable to read repository package");

    const escaped = config();
    escaped.manifests[0]!.packages[0]!.file = "../../../outside/app.neutron";
    await expect(
      generateRepository({
        config: escaped,
        configDir,
        workspaceRoot,
        readPackage: read,
        inspectPackage: inspect,
      }),
    ).rejects.toThrow("escapes the workspace");

    await expect(
      generateRepository({
        config: config(),
        configDir,
        workspaceRoot,
        readPackage: read,
        inspectPackage: async () => ({
          id: "different",
          version: 101,
          archiveEntries: 1,
          decodedBytes: 1,
          mutableFiles: 1,
        }),
      }),
    ).rejects.toThrow("identity is different v0.1.1");
  });

  test("rejects duplicate app identities inside one generated manifest", async () => {
    const duplicate = config();
    duplicate.manifests[1]!.packages[1]!.file =
      "../../apps/hello-copy/hello.v0.1.1.neutron";
    await expect(
      generateRepository({
        config: duplicate,
        configDir,
        workspaceRoot,
        readPackage: async (absolutePath) =>
          absolutePath.includes("kitchensink") ? kitchen : hello,
        inspectPackage: inspect,
      }),
    ).rejects.toThrow("repeats app id 'hello'");
  });

  test("rejects manifests that exceed remote decoded aggregate limits", async () => {
    await expect(
      generateRepository({
        config: config(),
        configDir,
        workspaceRoot,
        readPackage: read,
        inspectPackage: async (bytes) => ({
          id: bytes[0] === 1 ? "hello" : "kitchensink",
          version: bytes[0] === 1 ? 101 : 200,
          archiveEntries: 1,
          decodedBytes: 128 * 1024 * 1024,
          mutableFiles: 1,
        }),
      }),
    ).rejects.toThrow("aggregate decoded-byte limit");
  });

  test("rejects manifests that cannot fit one kernel install journal", async () => {
    await expect(
      generateRepository({
        config: config(),
        configDir,
        workspaceRoot,
        readPackage: read,
        inspectPackage: async (bytes) => ({
          id: bytes[0] === 1 ? "hello" : "kitchensink",
          version: bytes[0] === 1 ? 101 : 200,
          archiveEntries: 1,
          decodedBytes: 1,
          mutableFiles: 3_997,
        }),
      }),
    ).rejects.toThrow("install-journal copies");
  });

  test("chunks at the fixed boundary and prints pinned fragment links", async () => {
    expect(splitChunks(Uint8Array.of(1, 2, 3, 4, 5), 2)).toEqual([
      Uint8Array.of(1, 2),
      Uint8Array.of(3, 4),
      Uint8Array.of(5),
    ]);
    const generated = await generateRepository({
      config: config(),
      configDir,
      workspaceRoot,
      readPackage: read,
      inspectPackage: inspect,
    });
    const links = repositorySetupLinks(
      generated,
      "rrkah-fqaaa-aaaaa-aaaaq-cai",
      "https://dispenser.example/",
    );
    expect(links).toHaveLength(2);
    expect(links[0]?.url).toMatch(
      /^https:\/\/dispenser\.example\/#repo=rrkah-fqaaa-aaaaa-aaaaq-cai&manifest=demopack&digest=[a-f0-9]{64}$/,
    );
  });
});
