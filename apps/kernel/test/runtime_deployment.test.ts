import { expect, test } from "bun:test";
import { scopedLocalIdentityProvider } from "neutron-tools/src/runtime.js";
import {
  createKernelRuntimeConfig,
  encodeKernelRuntimeConfig,
  IC_RUNTIME_GATEWAY,
  IC_RUNTIME_IDENTITY_PROVIDER,
  isolatedFrameOriginTemplate,
  POCKETIC_RUNTIME_GATEWAY,
  runtimeUpdateSourceOrigin,
} from "neutron-tools/src/runtime_config.js";
import {
  assertRuntimeFrameUrl,
  loadRuntimeDeployment,
  resolveRuntimeDeployment,
} from "../src/runtime_deployment.ts";

const CANISTER_ID = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const UPDATE_SOURCE_ID = "r7inp-6aaaa-aaaaa-aaabq-cai";
const DEPLOYMENT_ID = "01".repeat(16);
const icConfig = createKernelRuntimeConfig({
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
});
const pocketIcConfig = createKernelRuntimeConfig({
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
    UPDATE_SOURCE_ID,
  ),
});

test("runtime deployment requires a certified config response", async () => {
  await expect(
    loadRuntimeDeployment(
      (async () =>
        new Response(encodeKernelRuntimeConfig(icConfig) as unknown as BodyInit, {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
      `https://${CANISTER_ID}.icp0.io/`,
    ),
  ).rejects.toThrow("response is not certified");
});

test("runtime deployment resolves an exact IC package binding", () => {
  expect(
    resolveRuntimeDeployment(icConfig, `https://${CANISTER_ID}.icp0.io/`),
  ).toEqual({
    target: "ic",
    canisterId: CANISTER_ID,
    deploymentId: DEPLOYMENT_ID,
    gateway: IC_RUNTIME_GATEWAY,
    identityProvider: IC_RUNTIME_IDENTITY_PROVIDER,
    rootKeyPolicy: "mainnet",
    allowLoopbackHttp: false,
    isolatedFrameOriginTemplate:
      `https://{prefix}--${CANISTER_ID}.icp0.io`,
    updateSourceOrigin: null,
    local: false,
  });
  expect(() =>
    resolveRuntimeDeployment(icConfig, `https://${CANISTER_ID}.raw.icp0.io/`),
  ).toThrow("certified canister origin");
});

test("runtime deployment resolves only the exact PocketIC binding", () => {
  expect(
    resolveRuntimeDeployment(
      pocketIcConfig,
      `http://${CANISTER_ID}.localhost:8000/`,
    ),
  ).toEqual({
    target: "pocketic",
    canisterId: CANISTER_ID,
    deploymentId: DEPLOYMENT_ID,
    gateway: POCKETIC_RUNTIME_GATEWAY,
    identityProvider: pocketIcConfig.identity_provider,
    rootKeyPolicy: "fetch",
    allowLoopbackHttp: true,
    isolatedFrameOriginTemplate:
      `http://{prefix}--${CANISTER_ID}.localhost:8000`,
    updateSourceOrigin:
      `http://${UPDATE_SOURCE_ID}.localhost:8000`,
    local: true,
    localHost: POCKETIC_RUNTIME_GATEWAY,
  });

  expect(() =>
    resolveRuntimeDeployment(
      pocketIcConfig,
      `https://${CANISTER_ID}.icp0.io/`,
    ),
  ).toThrow("unprefixed loopback canister origin");
  expect(() =>
    resolveRuntimeDeployment(
      pocketIcConfig,
      `http://other--${CANISTER_ID}.localhost:8000/`,
    ),
  ).toThrow("unprefixed loopback canister origin");
});

test("runtime deployment enforces its certified frame-origin template", () => {
  const deployment = resolveRuntimeDeployment(
    pocketIcConfig,
    `http://${CANISTER_ID}.localhost:8000/`,
  );
  expect(
    assertRuntimeFrameUrl(
      `http://ahello-a--${CANISTER_ID}.localhost:8000/app/hello/index.html`,
      true,
      deployment,
    ),
  ).toContain(`/app/hello/index.html`);
  expect(() =>
    assertRuntimeFrameUrl(
      `https://ahello-a--${CANISTER_ID}.icp0.io/app/hello/index.html`,
      true,
      deployment,
    ),
  ).toThrow("isolated runtime origin");
  expect(
    assertRuntimeFrameUrl(
      `http://${CANISTER_ID}.localhost:8000/app/hello/index.html`,
      false,
      deployment,
    ),
  ).toContain(`/app/hello/index.html`);
  expect(() =>
    assertRuntimeFrameUrl(
      `http://ahello-a--${CANISTER_ID}.localhost:8000/app/hello/index.html`,
      false,
      deployment,
    ),
  ).toThrow("Kernel runtime origin");
});
