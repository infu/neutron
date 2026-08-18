import { beforeEach, expect, mock, test } from "bun:test";
import { registryApp } from "./app_registry_fixture.ts";
import { uninstallDeploymentRecordFixture } from "./deployment_record_fixture.ts";

const capabilityPlanFingerprint = "a".repeat(64);

mock.module("icblast", () => ({
  default: () => async () => ({}),
  InternetIdentity: {
    create: async () => undefined,
    getIdentity: () => ({
      getPrincipal: () => ({
        toText: () => "2vxsx-fae",
      }),
    }),
    getPrincipal: () => ({
      toText: () => "2vxsx-fae",
    }),
    isAuthenticated: async () => false,
    login: async () => undefined,
    logout: async () => undefined,
  },
}));

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    location: {
      href: "http://aaaaa-aa.localhost:8000/",
    },
  },
});

const {
  appApprove,
  appReject,
  appRequest,
  clearInstallError,
  requestAppUninstall,
  resolveAppUninstall,
  useAppsStore,
} = await import("../src/reducer/apps.ts");
const {
  assertSignedCallEndpointCurrent,
  callApprove,
  callReject,
  callRequest,
  captureSignedCallEndpoint,
  dispatchSignedCallWithReplyFence,
  removeAllCallRequests,
  removeCallRequestsForApp,
  useRequestStore,
} = await import("../src/reducer/request.ts");
const { getRegisteredEndpoint, registerFrameContext } =
  await import("../src/frame_context.ts");
const { resetUiAttentionState } =
  await import("../src/ui_attention/owner.ts");

const frame = {
  role: "tile",
  appId: "hello",
  tileId: "main",
  instanceId: "hello-main-test",
  workspace: 1,
} as const;

const unregisterCallEndpoints: Array<() => void> = [];

function signedCallBinding(
  options: {
    appVersion?: number;
    appGeneration?: number;
    appScope?: { appId: string; installationUid: string };
  } = {},
) {
  const source = {} as Window;
  const unregister = registerFrameContext(source, frame, options);
  unregisterCallEndpoints.push(unregister);
  const endpoint = getRegisteredEndpoint(
    "app:hello:tile:main:instance:hello-main-test",
  );
  if (!endpoint) throw new Error("Missing signed-call endpoint");
  return { binding: captureSignedCallEndpoint(endpoint), endpoint, source };
}

function resetStores(): void {
  removeAllCallRequests();
  while (unregisterCallEndpoints.length) unregisterCallEndpoints.pop()?.();
  useAppsStore.setState({
    list: {},
    registryStatus: "idle",
    registryError: null,
    registryUpdatedAt: null,
    request: null,
    uninstallRequest: null,
    compiled: null,
    operation: null,
    operationBusy: false,
    installError: null,
  });
  useRequestStore.setState({ calls: {} });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function uninstallReview(
  record = uninstallDeploymentRecordFixture(),
) {
  return Object.freeze({
    record,
    suppliedPackages: Object.freeze([]),
  });
}

beforeEach(() => {
  resolveAppUninstall(false);
  resetUiAttentionState();
  resetStores();
});

test("app approval waits for the exact compiled deployment review", async () => {
  const request = appRequest({
    id: "hello",
    packageName: "Hello",
    packageVersion: 100,
    packageDigest: "0".repeat(64),
    size: 2,
    capabilityPlanFingerprint,
    capabilityDisclosures: [],
    permissions: [],
  });
  let resolved = false;
  request.then(
    () => {
      resolved = true;
    },
    () => {},
  );

  appApprove();
  await tick();

  expect(resolved).toBe(false);
  expect(useAppsStore.getState().request?.id).toBe("hello");

  useAppsStore.getState().setCompiled({ size: 5 });
  appApprove();

  await tick();
  expect(resolved).toBe(false);
  expect(useAppsStore.getState().request?.id).toBe("hello");

  useAppsStore.getState().setCompiled({
    size: 5,
    deploymentReview: uninstallReview(),
  });
  appApprove();

  await expect(request).resolves.toBeUndefined();
  expect(useAppsStore.getState().request).toBeNull();
  expect(useAppsStore.getState().compiled).toBeNull();
});

test("app rejection clears compiled and request state", async () => {
  const request = appRequest({
    id: "hello",
    packageName: "Hello",
    packageVersion: 100,
    packageDigest: "0".repeat(64),
    size: 2,
    capabilityPlanFingerprint,
    capabilityDisclosures: [],
    permissions: [],
  });

  useAppsStore.getState().setCompiled({ size: 5 });
  appReject();

  await expect(request).rejects.toThrow("User rejected");
  expect(useAppsStore.getState().compiled).toBeNull();
  expect(useAppsStore.getState().request).toBeNull();
});

test("install errors are explicit UI state and can be cleared", () => {
  useAppsStore
    .getState()
    .setInstallError({ kind: "install", message: "upload failed" });

  expect(useAppsStore.getState().installError?.message).toBe("upload failed");

  clearInstallError();

  expect(useAppsStore.getState().installError).toBeNull();
});

test("shared uninstall confirmation resolves and clears its request", async () => {
  const deploymentRecord = uninstallDeploymentRecordFixture();
  const deploymentReview = uninstallReview(deploymentRecord);
  const decision = requestAppUninstall({
    appId: "files",
    appName: "Files",
    memoryIds: ["files"],
    deploymentReview,
  });

  expect(useAppsStore.getState().uninstallRequest).toEqual({
    appId: "files",
    appName: "Files",
    memoryIds: ["files"],
    deploymentReview,
  });

  resolveAppUninstall(true);

  await expect(decision).resolves.toBe(true);
  expect(useAppsStore.getState().uninstallRequest).toBeNull();
});

test("cancelling the shared uninstall confirmation preserves app state", async () => {
  const apps = {
    files: registryApp({ id: "files", name: "Files" }),
  };
  useAppsStore.getState().setApps(apps);
  const before = useAppsStore.getState().list;
  const decision = requestAppUninstall({
    appId: "files",
    appName: "Files",
    memoryIds: ["files"],
    deploymentReview: uninstallReview(),
  });

  resolveAppUninstall(false);

  await expect(decision).resolves.toBe(false);
  expect(useAppsStore.getState().uninstallRequest).toBeNull();
  expect(useAppsStore.getState().list).toEqual(before);
  expect(useAppsStore.getState().installError).toBeNull();
});

test("uninstall confirmation is bound to the exact compiled destruction plan", () => {
  expect(() =>
    requestAppUninstall({
      appId: "files",
      appName: "Files",
      memoryIds: [],
      deploymentReview: uninstallReview(),
    }),
  ).toThrow("does not match the build record memory plan");
  expect(useAppsStore.getState().uninstallRequest).toBeNull();
});

test("kernel uninstall cannot enter the confirmation flow", () => {
  expect(() =>
    requestAppUninstall({
      appId: "kernel",
      appName: "Neutron",
      memoryIds: ["kernel"],
      deploymentReview: uninstallReview(),
    }),
  ).toThrow("kernel app cannot be uninstalled");
});

test("shared uninstall confirmation blocks required providers", () => {
  useAppsStore.getState().setApps({
    contacts: registryApp({
      id: "contacts",
      name: "Contacts",
      version: 102,
      func: {
        list_contacts: {
          type: "internal",
          async: "async*",
          expose: "apps",
        },
      },
    }),
    calendar: registryApp({
      id: "calendar",
      name: "Calendar",
      version: 100,
      dependencies: {
        people: {
          app: "contacts",
          min_version: 102,
          functions: ["list_contacts"],
        },
      },
    }),
  });

  expect(() =>
    requestAppUninstall({
      appId: "contacts",
      appName: "Contacts",
      memoryIds: [],
      deploymentReview: uninstallReview(
        uninstallDeploymentRecordFixture({
          appId: "contacts",
          memoryIds: [],
        }),
      ),
    }),
  ).toThrow("Contacts cannot be uninstalled; required by Calendar");
  expect(useAppsStore.getState().uninstallRequest).toBeNull();
});

test("call approval resolves pending request and removes it", async () => {
  const { binding } = signedCallBinding();
  const request = callRequest({
    canister: "aaaaa-aa",
    method: "hello_world",
    args: ["Alice"],
    binding,
  });
  const cid = Object.keys(useRequestStore.getState().calls)[0];
  if (!cid) throw new Error("Missing call request");

  callApprove({ cid });

  await expect(request).resolves.toBeUndefined();
  expect(useRequestStore.getState().calls).toEqual({});
});

test("call requests keep iframe-derived app and tile context", () => {
  const { binding } = signedCallBinding();
  callRequest({
    canister: "aaaaa-aa",
    method: "hello_world",
    args: ["Alice"],
    binding,
  }).catch(() => {});
  const cid = Object.keys(useRequestStore.getState().calls)[0];
  if (!cid) throw new Error("Missing call request");

  expect(useRequestStore.getState().calls[Number(cid)]?.frame).toEqual(frame);

  callReject({ cid });
});

test("call rejection rejects pending request and removes it", async () => {
  const { binding } = signedCallBinding();
  const request = callRequest({
    canister: "aaaaa-aa",
    method: "hello_world",
    args: ["Alice"],
    binding,
  });
  const cid = Object.keys(useRequestStore.getState().calls)[0];
  if (!cid) throw new Error("Missing call request");

  callReject({ cid });

  await expect(request).rejects.toThrow("User rejected");
  expect(useRequestStore.getState().calls).toEqual({});
});

test("app authority revocation cancels its pending signed call exactly once", async () => {
  const { binding } = signedCallBinding();
  const request = callRequest({
    canister: "aaaaa-aa",
    method: "hello_world",
    args: ["Alice"],
    binding,
  });

  removeCallRequestsForApp("hello");
  removeCallRequestsForApp("hello");

  await expect(request).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(useRequestStore.getState().calls).toEqual({});
});

test("signed-call bindings retain exact source, session, scope, and generation", () => {
  const { binding, endpoint } = signedCallBinding({
    appVersion: 103,
    appGeneration: 9,
    appScope: { appId: "hello", installationUid: "17" },
  });

  expect(assertSignedCallEndpointCurrent(binding)).toBe(endpoint);

  endpoint.sessionId = "replacement-session";
  expect(() => assertSignedCallEndpointCurrent(binding)).toThrow(
    "app surface changed",
  );
  endpoint.sessionId = binding.sessionId!;

  endpoint.appGeneration = 10;
  expect(() => assertSignedCallEndpointCurrent(binding)).toThrow(
    "app surface changed",
  );
  endpoint.appGeneration = binding.appGeneration!;

  endpoint.appScope = { appId: "hello", installationUid: "18" };
  expect(() => assertSignedCallEndpointCurrent(binding)).toThrow(
    "app surface changed",
  );
  endpoint.appScope = binding.appScope!;

  endpoint.source = {} as Window;
  expect(() => assertSignedCallEndpointCurrent(binding)).toThrow(
    "app surface changed",
  );
});

test("signed-call reply fences suppress stale success and rejection data", async () => {
  const { binding } = signedCallBinding();
  let resolveSuccess: ((value: { secret: string }) => void) | undefined;
  const successReply = new Promise<{ secret: string }>((resolve) => {
    resolveSuccess = resolve;
  });
  const staleSuccess = dispatchSignedCallWithReplyFence(
    () => successReply,
    () => assertSignedCallEndpointCurrent(binding),
  );
  // Even if a global pending fence later aborts and frontend state looks
  // current again, this in-flight call retains the invalidation epoch.
  removeAllCallRequests();
  resolveSuccess?.({ secret: "successful-secret" });
  const successError = await staleSuccess.catch((error: unknown) => error);
  expect(successError).toMatchObject({
    code: "REQUEST_CANCELLED",
    message: expect.stringContaining("outcome is unknown"),
  });
  expect(JSON.stringify(successError)).not.toContain("successful-secret");

  let rejectionAuthority = true;
  let rejectReply: ((error: Error) => void) | undefined;
  const rejectedReply = new Promise<never>((_resolve, reject) => {
    rejectReply = reject;
  });
  const staleRejection = dispatchSignedCallWithReplyFence(
    () => rejectedReply,
    () => {
      if (!rejectionAuthority) throw new Error("retired");
    },
  );
  rejectionAuthority = false;
  rejectReply?.(new Error("rejected-secret"));
  const rejectionError = await staleRejection.catch((error: unknown) => error);
  expect(rejectionError).toMatchObject({
    code: "REQUEST_CANCELLED",
    message: expect.stringContaining("outcome is unknown"),
  });
  expect(JSON.stringify(rejectionError)).not.toContain("rejected-secret");
});
