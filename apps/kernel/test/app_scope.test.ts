import { afterEach, expect, test } from "bun:test";
import {
  normalizeAppInstanceInventory,
  sameAppInstance,
  sameAppInstanceInventory,
  sameAppScope,
} from "../src/app_scope.ts";
import { ResidentFrameSecurityMode } from "../src/capabilities/plan.ts";
import type { RegisteredEndpoint } from "../src/frame_context.ts";
import {
  assertEndpointAppScope,
  assertFrontendAuthorityCommitted,
} from "../src/runtime_authority.ts";
import { useAppsStore } from "../src/reducer/apps.ts";

const fingerprint = "a".repeat(64);

function instance(
  appId: string,
  installationUid: bigint,
  nonce: string,
  authorityEpoch: bigint = 1n,
): Record<string, unknown> {
  return {
    scope: { app_id: appId, installation_uid: installationUid },
    version: 100n,
    deployment_id: "deployment",
    capability_plan_fingerprint: fingerprint,
    browser_origin_nonce: nonce,
    browser_origin_authority_epoch: authorityEpoch,
    resident_frame_security: {
      [ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1]: null,
    },
  };
}

afterEach(() => {
  useAppsStore.setState({
    appInstances: {},
    operation: null,
    pendingInstallRecovery: null,
    runtimeAuthorityFence: null,
  });
});

test("runtime app instances are exact, canonical, and deployment-bound", () => {
  const normalized = normalizeAppInstanceInventory(
    [
      instance("alpha", 1n, "1".padStart(32, "0")),
      instance("kernel", 2n, "2".padStart(32, "0")),
    ],
    "deployment",
  );

  expect(normalized.alpha).toMatchObject({
    scope: { appId: "alpha", installationUid: "1" },
    deploymentId: "deployment",
    browserOriginNonce: "00000000000000000000000000000001",
    browserOriginAuthorityEpoch: "1",
    residentFrameSecurity:
      ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1,
  });
  expect(
    sameAppScope(normalized.alpha?.scope, {
      appId: "alpha",
      installationUid: "1",
    }),
  ).toBe(true);
  expect(sameAppInstance(normalized.alpha, normalized.alpha)).toBe(true);
  expect(sameAppInstanceInventory(normalized, normalized)).toBe(true);
  expect(
    sameAppInstance(normalized.alpha, {
      ...normalized.alpha!,
      deploymentId: "next-deployment",
    }),
  ).toBe(false);
  expect(
    sameAppInstance(normalized.alpha, {
      ...normalized.alpha!,
      browserOriginAuthorityEpoch: "2",
    }),
  ).toBe(false);
  expect(
    sameAppInstance(normalized.alpha, {
      ...normalized.alpha!,
      residentFrameSecurity:
        ResidentFrameSecurityMode.CREDENTIALLESS_EPHEMERAL_DEDICATED_V1,
    }),
  ).toBe(false);

  expect(() =>
    normalizeAppInstanceInventory(
      [
        instance("kernel", 2n, "2".padStart(32, "0")),
        instance("alpha", 1n, "1".padStart(32, "0")),
      ],
      "deployment",
    ),
  ).toThrow("not canonical");
  expect(() =>
    normalizeAppInstanceInventory(
      [
        instance("alpha", 1n, "1".padStart(32, "0")),
        instance("kernel", 1n, "2".padStart(32, "0")),
      ],
      "deployment",
    ),
  ).toThrow("uid is invalid or repeated");
  expect(() =>
    normalizeAppInstanceInventory(
      [
        {
          ...instance("alpha", 1n, "1".padStart(32, "0")),
          browser_origin_nonce: "invalid",
        },
      ],
      "deployment",
    ),
  ).toThrow("browser-origin nonce");
  expect(() =>
    normalizeAppInstanceInventory(
      [instance("alpha", 1n, "1".padStart(32, "0"), 0n)],
      "deployment",
    ),
  ).toThrow("browser-origin authority epoch");
  expect(() =>
    normalizeAppInstanceInventory(
      [
        {
          ...instance("alpha", 1n, "1".padStart(32, "0")),
          resident_frame_security: { "persistent-ish": null },
        },
      ],
      "deployment",
    ),
  ).toThrow("resident frame security mode");
  expect(() =>
    normalizeAppInstanceInventory(
      [{ ...instance("alpha", 1n, "1".padStart(32, "0")), extra: true }],
      "deployment",
    ),
  ).toThrow("unknown or missing fields");
  for (const appId of ["_alpha", "alpha_", "alpha__beta"]) {
    expect(() =>
      normalizeAppInstanceInventory(
        [instance(appId, 1n, "1".padStart(32, "0"))],
        "deployment",
      ),
    ).toThrow("invalid app id");
  }
});

test("runtime inventory accepts exactly 256 total apps and rejects one more", () => {
  const boundary = [
    ...Array.from({ length: 255 }, (_, index) => {
      const appId = `app_${index.toString().padStart(3, "0")}`;
      const installationUid = BigInt(index + 1);
      return instance(
        appId,
        installationUid,
        installationUid.toString(16).padStart(32, "0"),
      );
    }),
    instance("kernel", 256n, "100".padStart(32, "0")),
  ];

  expect(
    Object.keys(normalizeAppInstanceInventory(boundary, "deployment")),
  ).toHaveLength(256);
  expect(() =>
    normalizeAppInstanceInventory(
      [
        ...boundary,
        instance("overflow_app", 257n, "101".padStart(32, "0")),
      ],
      "deployment",
    ),
  ).toThrow("Runtime app-instance inventory is invalid");
});

test("frontend authority rejects pending and retired installation scopes", () => {
  const current = {
    scope: { appId: "alpha", installationUid: "7" },
    version: 100,
    deploymentId: "deployment",
    capabilityPlanFingerprint: fingerprint,
    browserOriginNonce: "7".padStart(32, "0"),
    browserOriginAuthorityEpoch: "1",
    residentFrameSecurity:
      ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1,
  };
  useAppsStore.setState({ appInstances: { alpha: current } });
  const endpoint = {
    endpointId: "app:alpha:background",
    source: {} as Window,
    context: { role: "background", appId: "alpha" },
    appScope: current.scope,
  } satisfies RegisteredEndpoint;

  expect(() => assertEndpointAppScope(endpoint)).not.toThrow();
  expect(() =>
    assertEndpointAppScope({
      endpointId: endpoint.endpointId,
      source: endpoint.source,
      context: endpoint.context,
    }),
  ).toThrow("missing its installation scope");
  expect(() =>
    assertEndpointAppScope({
      ...endpoint,
      appScope: { appId: "alpha", installationUid: "8" },
    }),
  ).toThrow("retired installation");

  useAppsStore.setState({
    operation: { kind: "install", appId: "alpha", phase: "activating" },
  });
  expect(() => assertFrontendAuthorityCommitted()).toThrow(
    "pending installation",
  );
});
