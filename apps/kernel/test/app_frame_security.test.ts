import { expect, test } from "bun:test";
import type { AppInstanceProjection } from "../src/app_scope.ts";
import {
  appFrameAuthorityCurrent,
  appFrameEndpointAuthority,
  OPAQUE_APP_FRAME_SANDBOX,
  ORIGINFUL_APP_FRAME_SANDBOX,
  ordinaryAppFramePolicy,
  prepareOrdinaryAppFrame,
} from "../src/app_frame_security.ts";
import type { RuntimeDeployment } from "../src/runtime_deployment.ts";
import { registryApp } from "./app_registry_fixture.ts";

const canisterId = "4caro-hl777-77775-aaaba-cai";
const browserOriginNonce = "dc67918c9d79794438224f851f95897c";
const deployment: RuntimeDeployment = Object.freeze({
  target: "pocketic",
  canisterId,
  deploymentId: "deployment",
  gateway: "http://localhost:8000",
  identityProvider: "http://id.ai.localhost:8000/",
  rootKeyPolicy: "fetch",
  allowLoopbackHttp: true,
  isolatedFrameOriginTemplate:
    `http://{prefix}--${canisterId}.localhost:8000`,
  updateSourceOrigin: null,
  local: true,
  localHost: "http://localhost:8000",
});
const app = registryApp({
  id: "calls",
  name: "Calls",
  tiles: [
    { id: "call", title: "Call", path: "call.html" },
    { id: "notes", title: "Notes", path: "notes.html" },
  ],
  background: { path: "service.html" },
  tray: { title: "Calls", path: "tray.html", icon: "icon.svg" },
  capabilities: {
    browser_permissions: {
      api: 1,
      tiles: [
        { id: "call", features: ["microphone", "camera"] },
        { id: "notes", features: ["microphone"] },
      ],
    },
  },
});
const appInstance: AppInstanceProjection = Object.freeze({
  scope: Object.freeze({ appId: "calls", installationUid: "7" }),
  version: app.version,
  deploymentId: "deployment",
  capabilityPlanFingerprint: app.capability_plan_fingerprint,
  browserOriginNonce,
  browserOriginAuthorityEpoch: "1",
  residentFrameSecurity: "credentialless_opaque_v1",
});

test("ordinary frame policy binds each role and tile to its exact origin", () => {
  const call = ordinaryAppFramePolicy({
    appId: "calls",
    app,
    appInstance,
    endpoint: {
      role: "tile",
      path: "call.html",
      tileId: "call",
      instanceId: "one",
      workspace: 1,
    },
    deployment,
    browserSurfaceOriginAdopted: true,
  });
  const secondCall = ordinaryAppFramePolicy({
    appId: "calls",
    app,
    appInstance,
    endpoint: {
      role: "tile",
      path: "call.html",
      tileId: "call",
      instanceId: "two",
      workspace: 2,
    },
    deployment,
    browserSurfaceOriginAdopted: true,
  });
  const notes = ordinaryAppFramePolicy({
    appId: "calls",
    app,
    appInstance,
    endpoint: {
      role: "tile",
      path: "notes.html",
      tileId: "notes",
      instanceId: "one",
      workspace: 1,
    },
    deployment,
    browserSurfaceOriginAdopted: true,
  });
  const tray = ordinaryAppFramePolicy({
    appId: "calls",
    app,
    appInstance,
    endpoint: { role: "tray", path: "tray.html", instanceId: "one" },
    deployment,
    browserSurfaceOriginAdopted: true,
  });
  const background = ordinaryAppFramePolicy({
    appId: "calls",
    app,
    appInstance,
    endpoint: { role: "background", path: "service.html" },
    deployment,
    browserSurfaceOriginAdopted: true,
  });

  expect(call.origin).toBe(new URL(secondCall.src).origin);
  expect(new Set([call.origin, notes.origin, tray.origin, background.origin]).size)
    .toBe(4);
  expect(call.allow).toBe(
    `camera ${call.origin}; microphone ${call.origin}`,
  );
  expect(notes.allow).toBe(`microphone ${notes.origin}`);
  expect(tray.allow).toBeUndefined();
  expect(background.allow).toBeUndefined();
});

test("undeclared tiles receive no iframe browser-feature delegation", () => {
  const withoutPermissions = registryApp({
    id: "hello",
    name: "Hello",
    tiles: [{ id: "main", title: "Main" }],
  });
  const policy = ordinaryAppFramePolicy({
    appId: "hello",
    app: withoutPermissions,
    appInstance: {
      ...appInstance,
      scope: { appId: "hello", installationUid: "8" },
      capabilityPlanFingerprint:
        withoutPermissions.capability_plan_fingerprint,
    },
    endpoint: {
      role: "tile",
      path: "index.html",
      tileId: "main",
      instanceId: "one",
      workspace: 1,
    },
    deployment,
    browserSurfaceOriginAdopted: true,
  });
  expect(policy.allow).toBeUndefined();
});

test("frame authority is exact across scope, deployment, generation, and adoption", () => {
  const expected = appFrameEndpointAuthority({
    appId: "calls",
    app,
    appInstance,
    appGeneration: 7,
    browserSurfaceOriginAdopted: true,
  });
  const state = {
    list: { calls: app },
    appInstances: { calls: appInstance },
    runtimeGenerations: { calls: 7 },
    browserSurfaceOriginAppIds: ["calls"],
  } as const;

  expect(appFrameAuthorityCurrent(expected, state, false)).toBe(true);
  expect(appFrameAuthorityCurrent(expected, state, true)).toBe(false);
  expect(
    appFrameAuthorityCurrent(
      expected,
      { ...state, runtimeGenerations: { calls: 8 } },
      false,
    ),
  ).toBe(false);
  expect(
    appFrameAuthorityCurrent(
      expected,
      {
        ...state,
        appInstances: {
          calls: {
            ...appInstance,
            scope: { ...appInstance.scope, installationUid: "8" },
          },
        },
      },
      false,
    ),
  ).toBe(false);
  expect(
    appFrameAuthorityCurrent(
      expected,
      {
        ...state,
        appInstances: {
          calls: { ...appInstance, deploymentId: "replacement" },
        },
      },
      false,
    ),
  ).toBe(false);
  expect(
    appFrameAuthorityCurrent(
      expected,
      { ...state, browserSurfaceOriginAppIds: [] },
      false,
    ),
  ).toBe(false);
});

test("the bridge and unadopted apps preserve exact legacy opaque URLs", () => {
  const tile = ordinaryAppFramePolicy({
    appId: "calls",
    app,
    appInstance,
    endpoint: {
      role: "tile",
      path: "call.html",
      tileId: "call",
      instanceId: "one",
      workspace: 1,
    },
    deployment,
    browserSurfaceOriginAdopted: false,
  });
  const background = ordinaryAppFramePolicy({
    appId: "calls",
    app,
    appInstance,
    endpoint: { role: "background", path: "service.html" },
    deployment,
    browserSurfaceOriginAdopted: false,
  });
  expect(new URL(tile.src).origin).toBe(
    `http://acallsa--${canisterId}.localhost:8000`,
  );
  expect(new URL(background.src).origin).toBe(new URL(tile.src).origin);
  expect(tile.origin).toBe("null");
  expect(tile.allow).toBeUndefined();
  const bridgeFrame = fakeFrame(true, true);
  expect(prepareOrdinaryAppFrame(bridgeFrame.iframe, tile)).toEqual({
    source: bridgeFrame.iframe.contentWindow!,
    origin: "null",
  });
  expect(bridgeFrame.attributes.get("sandbox")).toBe(
    OPAQUE_APP_FRAME_SANDBOX,
  );

  const unadopted = ordinaryAppFramePolicy({
    appId: "calls",
    app,
    appInstance,
    endpoint: {
      role: "tile",
      path: "call.html",
      tileId: "call",
      instanceId: "unadopted",
      workspace: 1,
    },
    deployment,
    browserSurfaceOriginAdopted: false,
  });
  expect(new URL(unadopted.src).origin).toBe(new URL(tile.src).origin);
  expect(unadopted).toMatchObject({ origin: "null" });
  expect(unadopted.allow).toBeUndefined();

  const persistent = registryApp({
    id: "mail",
    name: "Mail",
    tiles: [{ id: "mail", title: "Mail" }],
    background: { path: "service.html" },
    tray: { title: "Mail", path: "tray.html", icon: "icon.svg" },
    capabilities: {
      persistent_browser_storage: { api: 1, surface: "background" },
    },
  });
  const persistentInstance: AppInstanceProjection = {
    ...appInstance,
    scope: { appId: "mail", installationUid: "8" },
    version: persistent.version,
    capabilityPlanFingerprint: persistent.capability_plan_fingerprint,
    residentFrameSecurity: "persistent_dedicated_v1",
  };
  for (const endpoint of [
    {
      role: "tile" as const,
      path: "index.html",
      tileId: "mail",
      instanceId: "one",
      workspace: 1,
    },
    {
      role: "tray" as const,
      path: "tray.html",
      instanceId: "one",
    },
  ]) {
    const policy = ordinaryAppFramePolicy({
      appId: "mail",
      app: persistent,
      appInstance: persistentInstance,
      endpoint,
      deployment,
      browserSurfaceOriginAdopted: false,
    });
    expect(new URL(policy.src).origin).toBe(
      `http://${canisterId}.localhost:8000`,
    );
    expect(policy).toMatchObject({ origin: "null" });
    expect(policy.allow).toBeUndefined();
  }
});

test("publication declarations do not create frame-origin exceptions", () => {
  const publicationCapabilities = {
    certified_assets: {
      api: 2 as const,
      max_entries: 32,
      max_committed_bytes: 1_048_576,
      max_object_bytes: 65_536,
      max_pending_stages: 1,
      max_staged_bytes: 65_536,
      max_batch_operations: 1,
      max_batch_bytes: 65_536,
      max_idempotency_receipts: 64,
      collections: [
        { id: "shares", mount: "shares", kind: "publication" as const },
      ],
    },
  };
  const publisher = registryApp({
    id: "publisher",
    name: "Publisher",
    version: 100,
    backend: { capabilities: { certified_assets: { api: 2 } } },
    capabilities: {
      ...publicationCapabilities,
      persistent_browser_storage: { api: 1, surface: "background" },
    },
    tiles: [{ id: "publisher", title: "Publisher" }],
    background: { path: "service.html" },
  });
  const publisherInstance: AppInstanceProjection = {
    ...appInstance,
    scope: { appId: "publisher", installationUid: "8" },
    version: publisher.version,
    capabilityPlanFingerprint: publisher.capability_plan_fingerprint,
  };
  const tile = ordinaryAppFramePolicy({
    appId: "publisher",
    app: publisher,
    appInstance: publisherInstance,
    endpoint: {
      role: "tile",
      path: "index.html",
      tileId: "publisher",
      instanceId: "one",
      workspace: 1,
    },
    deployment,
    browserSurfaceOriginAdopted: true,
  });
  const background = ordinaryAppFramePolicy({
    appId: "publisher",
    app: publisher,
    appInstance: publisherInstance,
    endpoint: { role: "background", path: "service.html" },
    deployment,
    browserSurfaceOriginAdopted: true,
  });
  expect(tile.origin).toStartWith("http://i");
  expect(tile.allow).toBeUndefined();
  expect(background.origin).toStartWith("http://i");

  const originAwarePublisher = registryApp({
    id: "origin_aware_publisher",
    name: "Origin-aware Publisher",
    version: 100,
    backend: { capabilities: { certified_assets: { api: 2 } } },
    capabilities: {
      ...publicationCapabilities,
      browser_permissions: {
        api: 1,
        tiles: [{ id: "publisher", features: ["camera"] }],
      },
    },
    tiles: [
      { id: "publisher", title: "Publisher" },
      { id: "preview", title: "Preview" },
    ],
  });
  const originAwareInstance = {
    ...publisherInstance,
    scope: { appId: "origin_aware_publisher", installationUid: "8" },
    version: 100,
    capabilityPlanFingerprint: originAwarePublisher.capability_plan_fingerprint,
  };
  const originAwarePolicy = ordinaryAppFramePolicy({
    appId: "origin_aware_publisher",
    app: originAwarePublisher,
    appInstance: originAwareInstance,
    endpoint: {
      role: "tile",
      path: "index.html",
      tileId: "publisher",
      instanceId: "one",
      workspace: 1,
    },
    deployment,
    browserSurfaceOriginAdopted: true,
  });
  expect(originAwarePolicy.origin).toStartWith("http://i");
  expect(originAwarePolicy.allow).toBe(`camera ${originAwarePolicy.origin}`);

  const siblingPolicy = ordinaryAppFramePolicy({
    appId: "origin_aware_publisher",
    app: originAwarePublisher,
    appInstance: originAwareInstance,
    endpoint: {
      role: "tile",
      path: "preview.html",
      tileId: "preview",
      instanceId: "one",
      workspace: 1,
    },
    deployment,
    browserSurfaceOriginAdopted: true,
  });
  expect(siblingPolicy.origin).toStartWith("http://i");
  expect(siblingPolicy.origin).not.toBe(originAwarePolicy.origin);
  expect(siblingPolicy.allow).toBeUndefined();

  const nonPublisher = registryApp({
    id: "ordinary",
    name: "Ordinary",
    version: 100,
    tiles: [{ id: "ordinary", title: "Ordinary" }],
  });
  expect(
    ordinaryAppFramePolicy({
      appId: "ordinary",
      app: nonPublisher,
      appInstance: {
        ...publisherInstance,
        scope: { appId: "ordinary", installationUid: "8" },
        version: 100,
        capabilityPlanFingerprint: nonPublisher.capability_plan_fingerprint,
      },
      endpoint: {
        role: "tile",
        path: "index.html",
        tileId: "ordinary",
        instanceId: "one",
        workspace: 1,
      },
      deployment,
      browserSurfaceOriginAdopted: true,
    }).origin,
  ).toStartWith("http://i");
});

test("credentialless qualification selects the originful policy before navigation", () => {
  const policy = ordinaryAppFramePolicy({
    appId: "calls",
    app,
    appInstance,
    endpoint: {
      role: "tile",
      path: "call.html",
      tileId: "call",
      instanceId: "one",
      workspace: 1,
    },
    deployment,
    browserSurfaceOriginAdopted: true,
  });
  const { iframe, attributes } = fakeFrame(true, true);
  const prepared = prepareOrdinaryAppFrame(iframe, policy);

  expect(prepared).toEqual({
    source: iframe.contentWindow!,
    origin: policy.origin,
  });
  expect(attributes.get("sandbox")).toBe(ORIGINFUL_APP_FRAME_SANDBOX);
  expect(attributes.get("allow")).toBe(policy.allow);
  expect(attributes.has("src")).toBe(false);
});

test("unsupported credentialless frames fall back opaque without delegation", () => {
  const policy = ordinaryAppFramePolicy({
    appId: "calls",
    app,
    appInstance,
    endpoint: {
      role: "tile",
      path: "call.html",
      tileId: "call",
      instanceId: "one",
      workspace: 1,
    },
    deployment,
    browserSurfaceOriginAdopted: true,
  });
  for (const [frameCredentialless, windowCredentialless] of [
    [false, true],
    [true, false],
  ] as const) {
    const { iframe, attributes } = fakeFrame(
      frameCredentialless,
      windowCredentialless,
    );
    attributes.set("allow", "camera *");
    const prepared = prepareOrdinaryAppFrame(iframe, policy);
    expect(prepared).toEqual({
      source: iframe.contentWindow!,
      origin: "null",
    });
    expect(attributes.get("sandbox")).toBe(OPAQUE_APP_FRAME_SANDBOX);
    expect(attributes.has("allow")).toBe(false);
    expect(attributes.has("src")).toBe(false);
  }
});

function fakeFrame(
  frameCredentialless: boolean,
  windowCredentialless: boolean,
): {
  iframe: HTMLIFrameElement;
  attributes: Map<string, string>;
} {
  const attributes = new Map<string, string>();
  const iframe = {
    credentialless: frameCredentialless,
    contentWindow: {
      credentialless: windowCredentialless,
    } as unknown as Window,
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    removeAttribute(name: string) {
      attributes.delete(name);
    },
  } as unknown as HTMLIFrameElement;
  return { iframe, attributes };
}
