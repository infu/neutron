import { describe, expect, test } from "bun:test";
import {
  NEUTRON_REPOSITORY_PROTOCOL,
  RepositoryProtocolError,
} from "neutron-tools/repository";
import { parseRepositoryBuildConfig } from "../src/model.ts";

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
        packages: [
          {
            file: "../../apps/hello/hello.v0.1.1.neutron",
            publisher: {
              name: "Example publisher",
              website: "https://example.invalid",
            },
          },
        ],
      },
    ],
  };
}

describe("example repository build model", () => {
  test("uses the same closed metadata policy as the v1 wire model", () => {
    const parsed = parseRepositoryBuildConfig(config());
    expect(parsed.info.provider.name).toBe("Example provider");
    expect(parsed.manifests[0]?.packages[0]?.publisher?.website).toBe(
      "https://example.invalid/",
    );
    expect(() =>
      parseRepositoryBuildConfig({ ...config(), script: "install.js" }),
    ).toThrow(RepositoryProtocolError);
    expect(() =>
      parseRepositoryBuildConfig({
        ...config(),
        info: { ...config().info, provider: { name: "x", website: "http://x" } },
      }),
    ).toThrow(RepositoryProtocolError);
  });

  test("rejects duplicate manifest ids and unknown manifest/package fields", () => {
    const duplicate = config();
    duplicate.manifests.push({ ...duplicate.manifests[0]! });
    expect(() => parseRepositoryBuildConfig(duplicate)).toThrow(
      RepositoryProtocolError,
    );

    const unknownManifest = config();
    (unknownManifest.manifests[0] as Record<string, unknown>).url = "https://x";
    expect(() => parseRepositoryBuildConfig(unknownManifest)).toThrow(
      RepositoryProtocolError,
    );

    const unknownPackage = config();
    (unknownPackage.manifests[0]!.packages[0] as Record<string, unknown>).digest =
      "a".repeat(64);
    expect(() => parseRepositoryBuildConfig(unknownPackage)).toThrow(
      RepositoryProtocolError,
    );
  });

  test("accepts only bounded relative .neutron package paths", () => {
    for (const file of ["/tmp/app.neutron", "../../app.wasm", "bad\0.neutron", ""]) {
      const value = config();
      value.manifests[0]!.packages[0]!.file = file;
      expect(() => parseRepositoryBuildConfig(value)).toThrow(
        RepositoryProtocolError,
      );
    }
  });
});
