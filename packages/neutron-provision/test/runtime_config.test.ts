import { describe, expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import { parseKernelRuntimeConfig } from "neutron-tools/src/runtime_config.js";
import type { PreparedDeployment } from "../src/artifact.ts";
import { bindDeploymentRuntimeConfig } from "../src/runtime_config.ts";

describe("final deployment runtime binding", () => {
  test("injects a canister-bound PocketIC config into the Kernel files", () => {
    const deployment = fixtureDeployment();
    const canisterId = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai").toText();
    const updateSourceCanisterId = Principal.fromText(
      "r7inp-6aaaa-aaaaa-aaabq-cai",
    ).toText();
    const config = bindDeploymentRuntimeConfig({
      deployment,
      canisterId,
      target: "pocketic",
      updateSourceCanisterId,
    });
    expect(config.canister_id).toBe(canisterId);
    expect(config.deployment_id).toBe("a".repeat(32));
    expect(config.isolated_frame_origin_template).toBe(
      `http://{prefix}--${canisterId}.localhost:8000`,
    );
    expect(config.update_source_origin).toBe(
      `http://${updateSourceCanisterId}.localhost:8000`,
    );
    const file = deployment.packages[0]!.files.find(
      ({ path }) => path === "system/runtime-config.json",
    );
    expect(file).toBeDefined();
    expect(parseKernelRuntimeConfig(file!.content)).toEqual(config);
  });

  test("uses fixed mainnet policy for an IC binding", () => {
    const deployment = fixtureDeployment();
    const config = bindDeploymentRuntimeConfig({
      deployment,
      canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
      target: "ic",
    });
    expect(config).toMatchObject({
      target: "ic",
      gateway: "https://icp-api.io",
      identity_provider: "https://id.ai",
      root_key_policy: "mainnet",
      allow_loopback_http: false,
      isolated_frame_origin_template:
        "https://{prefix}--rrkah-fqaaa-aaaaa-aaaaq-cai.icp0.io",
      update_source_origin: null,
    });
  });

  test("rejects a local binding without the provision-owned update source", () => {
    expect(() =>
      bindDeploymentRuntimeConfig({
        deployment: fixtureDeployment(),
        canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
        target: "pocketic",
      }),
    ).toThrow("requires the provision-owned update source");
  });
});

function fixtureDeployment(): PreparedDeployment {
  return {
    packages: [
      {
        isKernel: true,
        manifest: { id: "kernel" },
        files: [],
      },
    ],
    compiled: { deploymentId: "a".repeat(32) },
  } as unknown as PreparedDeployment;
}
