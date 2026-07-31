import { expect, test } from "bun:test";
import {
  createKernelRuntimeConfig,
  encodeKernelRuntimeConfig,
  IC_RUNTIME_GATEWAY,
  IC_RUNTIME_IDENTITY_PROVIDER,
  isolatedFrameOriginTemplate,
  KERNEL_RUNTIME_CONFIG_FORMAT,
  parseKernelRuntimeConfig,
  POCKETIC_RUNTIME_GATEWAY,
  runtimeUpdateSourceOrigin,
} from "../src/runtime_config.ts";
import { scopedLocalIdentityProvider } from "../src/runtime.ts";

const CANISTER_ID = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const DEPLOYMENT_ID = "01".repeat(16);

test("full runtime deployment config round-trips both compiler targets", () => {
  const configs = [
    createKernelRuntimeConfig({
      target: "ic",
      gateway: IC_RUNTIME_GATEWAY,
      identity_provider: IC_RUNTIME_IDENTITY_PROVIDER,
      canister_id: CANISTER_ID,
      deployment_id: DEPLOYMENT_ID,
      root_key_policy: "mainnet",
      allow_loopback_http: false,
      isolated_frame_origin_template: isolatedFrameOriginTemplate(
        "ic",
        CANISTER_ID,
      ),
      update_source_origin: null,
    }),
    createKernelRuntimeConfig({
      target: "pocketic",
      gateway: POCKETIC_RUNTIME_GATEWAY,
      identity_provider: scopedLocalIdentityProvider({
        neutronCanisterId: CANISTER_ID,
        localHost: POCKETIC_RUNTIME_GATEWAY,
      }),
      canister_id: CANISTER_ID,
      deployment_id: DEPLOYMENT_ID,
      root_key_policy: "fetch",
      allow_loopback_http: true,
      isolated_frame_origin_template: isolatedFrameOriginTemplate(
        "pocketic",
        CANISTER_ID,
      ),
      update_source_origin: runtimeUpdateSourceOrigin(
        "pocketic",
        "r7inp-6aaaa-aaaaa-aaabq-cai",
      ),
    }),
  ];
  for (const config of configs) {
    expect(parseKernelRuntimeConfig(encodeKernelRuntimeConfig(config))).toEqual(
      config,
    );
  }
});

test("runtime deployment config rejects extended and inconsistent records", () => {
  const base = {
    format: KERNEL_RUNTIME_CONFIG_FORMAT,
    target: "ic",
    gateway: IC_RUNTIME_GATEWAY,
    identity_provider: IC_RUNTIME_IDENTITY_PROVIDER,
    canister_id: CANISTER_ID,
    deployment_id: DEPLOYMENT_ID,
    root_key_policy: "mainnet",
    allow_loopback_http: false,
    isolated_frame_origin_template: isolatedFrameOriginTemplate(
      "ic",
      CANISTER_ID,
    ),
    update_source_origin: null,
  };
  expect(() =>
    parseKernelRuntimeConfig(JSON.stringify({ ...base, extra: true })),
  ).toThrow("unknown or missing fields");
  expect(() =>
    parseKernelRuntimeConfig(
      JSON.stringify({ ...base, gateway: POCKETIC_RUNTIME_GATEWAY }),
    ),
  ).toThrow("inconsistent network policy");
  expect(() =>
    parseKernelRuntimeConfig(
      JSON.stringify({
        ...base,
        update_source_origin: "https://not-a-real-cai.icp0.io",
      }),
    ),
  ).toThrow("inconsistent network policy");
  expect(() =>
    parseKernelRuntimeConfig(JSON.stringify({ ...base, format: 1 })),
  ).toThrow("Unsupported Kernel runtime config format");
  expect(() =>
    parseKernelRuntimeConfig(
      JSON.stringify({
        ...base,
        isolated_frame_origin_template:
          "https://{prefix}--aaaaa-aa.icp0.io",
      }),
    ),
  ).toThrow("inconsistent frame-origin policy");
  expect(() =>
    parseKernelRuntimeConfig(
      JSON.stringify({
        ...base,
        target: "pocketic",
        gateway: POCKETIC_RUNTIME_GATEWAY,
        identity_provider: scopedLocalIdentityProvider({
          neutronCanisterId: CANISTER_ID,
          localHost: POCKETIC_RUNTIME_GATEWAY,
        }),
        root_key_policy: "fetch",
        allow_loopback_http: true,
        isolated_frame_origin_template: isolatedFrameOriginTemplate(
          "pocketic",
          CANISTER_ID,
        ),
        update_source_origin: null,
      }),
    ),
  ).toThrow("inconsistent network policy");
});
