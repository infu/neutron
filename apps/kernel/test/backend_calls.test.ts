import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  listBackendReservationsForEndpoint,
  normalizeBackendReservation,
  requestBackendReservationForEndpoint,
} from "../src/backend_calls/service.ts";
import { Principal } from "@dfinity/principal";
import { CANISTER_METHOD_MAX_LENGTH } from "neutron-tools";
import {
  getRegisteredEndpoint,
  registerFrameContext,
  type RegisteredEndpoint,
} from "../src/frame_context.ts";
import { useAppsStore } from "../src/reducer/apps.ts";
import {
  approveBackendCallRequest,
  rejectBackendCallRequest,
  requestBackendCallConsent,
  useBackendCallConsentStore,
} from "../src/reducer/backend_calls.ts";
import { resetUiAttentionState } from "../src/ui_attention/owner.ts";
import { registryApp } from "./app_registry_fixture.ts";

const endpointSource = {} as Window;
const endpointContext = {
  role: "tile",
  appId: "wallet",
  tileId: "wallet",
  instanceId: "one",
  workspace: 1,
} as const;
let endpoint: RegisteredEndpoint;
let unregisterEndpoint: () => void = () => {};

beforeEach(() => {
  unregisterEndpoint = registerFrameContext(endpointSource, endpointContext, {
    origin: "null",
  });
  endpoint = getRegisteredEndpoint(
    "app:wallet:tile:wallet:instance:one",
  )!;
});

afterEach(() => {
  unregisterEndpoint();
  useAppsStore.setState({ list: {} });
  for (const request of Object.values(
    useBackendCallConsentStore.getState().requests,
  )) {
    rejectBackendCallRequest(request.id);
  }
  resetUiAttentionState();
});

test("backend consent remains pending until explicit owner action", async () => {
  const consent = requestBackendCallConsent({
    endpoint: endpoint.endpointId,
    appId: "wallet",
    source: {
      role: "tile",
      tileId: "wallet",
      instanceId: "one",
      workspace: 1,
    },
    actions: [
      {
        kind: "reserve",
        scope: { kind: "principal", principal: "ryjl3-tyaaa-aaaaa-aaaba-cai" },
      },
    ],
  });
  const pending = Object.values(useBackendCallConsentStore.getState().requests);
  expect(pending).toHaveLength(1);
  approveBackendCallRequest(pending[0]!.id);
  await expect(consent).resolves.toBeUndefined();
});

test("backend consent is cancelled when its app surface closes", async () => {
  const unregister = registerFrameContext(
    endpointSource,
    endpointContext,
    { origin: "null" },
  );
  const registered = getRegisteredEndpoint(endpoint.endpointId);
  expect(registered).not.toBeNull();

  const consent = requestBackendCallConsent({
    endpoint: endpoint.endpointId,
    ...(registered?.sessionId
      ? { endpointSession: registered.sessionId }
      : {}),
    appId: "wallet",
    source: {
      role: "tile",
      tileId: "wallet",
      instanceId: "one",
      workspace: 1,
    },
    actions: [
      {
        kind: "reserve",
        scope: { kind: "principal", principal: "ryjl3-tyaaa-aaaaa-aaaba-cai" },
      },
    ],
  });
  unregister();

  await expect(consent).rejects.toThrow("closed or reloaded");
  expect(useBackendCallConsentStore.getState().requests).toEqual({});
});

test("expired backend consent cannot leave a pending or hidden approval", async () => {
  const captured: { expire?: () => void } = {};
  const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
    ((callback: TimerHandler) => {
      if (typeof callback === "function") {
        captured.expire = () => callback();
      }
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
  );

  try {
    const consent = requestBackendCallConsent({
      endpoint: endpoint.endpointId,
      appId: "wallet",
      source: {
        role: "tile",
        tileId: "wallet",
        instanceId: "one",
        workspace: 1,
      },
      actions: [
        {
          kind: "reserve",
          scope: {
            kind: "exact",
            principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
            method: "balance_of",
          },
        },
      ],
    });
    if (!captured.expire) throw new Error("Missing backend consent timeout");
    captured.expire();

    await expect(consent).rejects.toThrow("Backend request expired");
    expect(useBackendCallConsentStore.getState().requests).toEqual({});
  } finally {
    timeoutSpy.mockRestore();
  }
});

test("endpoint replacement during preflight cannot create consent or apply grants", async () => {
  installWalletDeclaration(true);
  let applies = 0;

  await expect(
    requestBackendReservationForEndpoint(
      {
        actions: [],
        call: { method: "prepare_remote", args: [null] },
      },
      endpoint,
      {
        validateSelfCall: async () => {
          unregisterEndpoint();
        },
        executeSelfCall: async () => null,
        transport: {
          listReservations: async () => [],
          applyReservations: async () => {
            applies += 1;
            return [];
          },
        },
      },
    ),
  ).rejects.toThrow("endpoint is no longer active");

  expect(useBackendCallConsentStore.getState().requests).toEqual({});
  expect(applies).toBe(0);
});

test("backend consent has no hidden queue", async () => {
  const first = requestBackendCallConsent({
    endpoint: `${endpoint.endpointId}:first`,
    appId: "wallet",
    source: {
      role: "tile",
      tileId: "wallet",
      instanceId: "first",
      workspace: 1,
    },
    actions: [
      {
        kind: "reserve",
        scope: {
          kind: "principal",
          principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
        },
      },
    ],
  });

  await expect(
    Promise.resolve().then(() =>
      requestBackendCallConsent({
        endpoint: `${endpoint.endpointId}:overflow`,
        appId: "wallet",
        source: {
          role: "tile",
          tileId: "wallet",
          instanceId: "overflow",
          workspace: 1,
        },
        actions: [
          {
            kind: "reserve",
            scope: {
              kind: "principal",
              principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
            },
          },
        ],
      }),
    ),
  ).rejects.toThrow("Another app request is active");

  const request = Object.values(
    useBackendCallConsentStore.getState().requests,
  )[0];
  if (!request) throw new Error("Missing backend request");
  approveBackendCallRequest(request.id);
  await expect(first).resolves.toBeUndefined();
});

test("source-bound backend tools require the installed declaration", async () => {
  await expect(listBackendReservationsForEndpoint({}, endpoint)).rejects.toThrow(
    "does not declare",
  );
});

test("tray popouts cannot change durable backend access", async () => {
  installWalletDeclaration();
  const trayEndpoint: RegisteredEndpoint = {
    endpointId: "app:wallet:tray:instance:panel-one",
    source: {} as Window,
    context: { role: "tray", appId: "wallet", instanceId: "panel-one" },
  };

  await expect(
    requestBackendReservationForEndpoint(
      {
        actions: [
          {
            kind: "reserve",
            scope: {
              kind: "principal",
              principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
            },
          },
        ],
      },
      trayEndpoint,
      noCallRuntime(),
    ),
  ).rejects.toMatchObject({ code: "USER_INTERACTION_REQUIRED" });
  expect(useBackendCallConsentStore.getState().requests).toEqual({});
});

test("an app cannot request a reservation scope outside its manifest", async () => {
  installWalletDeclaration();

  await expect(
    requestBackendReservationForEndpoint(
      {
        actions: [
          {
            kind: "reserve",
            scope: { kind: "method", method: "status" },
          },
        ],
      },
      endpoint,
      noCallRuntime(),
    ),
  ).rejects.toThrow("does not declare method reservations");
  expect(useBackendCallConsentStore.getState().requests).toEqual({});
});

test("backend reservation batches reject duplicate scopes before consent", async () => {
  installWalletDeclaration();
  const scope = {
    kind: "principal",
    principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
  } as const;

  await expect(
    requestBackendReservationForEndpoint(
      {
        actions: [
          { kind: "release", scope },
          { kind: "reserve", scope },
        ],
      },
      endpoint,
      noCallRuntime(),
    ),
  ).rejects.toThrow("Duplicate backend reservation action");
  expect(useBackendCallConsentStore.getState().requests).toEqual({});
});

test("backend reservation requests require actions or a same-app call", async () => {
  installWalletDeclaration();

  await expect(
    requestBackendReservationForEndpoint(
      { actions: [] },
      endpoint,
      noCallRuntime(),
    ),
  ).rejects.toThrow("has no actions");
  expect(useBackendCallConsentStore.getState().requests).toEqual({});
});

test("invalid attached call arguments fail before consent or reservation work", async () => {
  installWalletDeclaration(true);
  let snapshots = 0;
  let applies = 0;
  let authorizations = 0;
  let executions = 0;

  await expect(
    requestBackendReservationForEndpoint(
      {
        actions: [
          {
            kind: "reserve",
            scope: {
              kind: "principal",
              principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
            },
          },
        ],
        call: { method: "prepare_remote", args: ["wrong Candid shape"] },
      },
      endpoint,
      {
        validateSelfCall: async () => {
          throw new Error("Invalid call JSON: live Candid rejected arguments");
        },
        executeSelfCall: async () => {
          executions += 1;
          return null;
        },
        authorize: async () => {
          authorizations += 1;
          return true;
        },
        transport: {
          listReservations: async () => {
            snapshots += 1;
            return [];
          },
          applyReservations: async () => {
            applies += 1;
            return [];
          },
        },
      },
    ),
  ).rejects.toThrow("live Candid rejected arguments");

  expect(useBackendCallConsentStore.getState().requests).toEqual({});
  expect({ snapshots, applies, authorizations, executions }).toEqual({
    snapshots: 0,
    applies: 0,
    authorizations: 0,
    executions: 0,
  });
});

test("owner sees the immutable attached arguments that are revalidated and executed", async () => {
  installWalletDeclaration(true);
  const suppliedArgs = [
    {
      tileId: "wallet-one",
      remote: { gameId: "game-7", host: "ryjl3-tyaaa-aaaaa-aaaba-cai" },
      metadata: JSON.parse('{"__proto__":{"visible":"retained"}}'),
    },
  ];
  const validatedArgs: unknown[] = [];
  let executedArgs: unknown = null;
  let appliedActions: unknown = null;

  const operation = requestBackendReservationForEndpoint(
    {
      actions: [],
      call: { method: "prepare_remote", args: suppliedArgs },
    },
    endpoint,
    {
      validateSelfCall: async (_method, args) => {
        validatedArgs.push(JSON.parse(JSON.stringify(args)));
      },
      executeSelfCall: async (_method, args) => {
        executedArgs = args;
        return { ok: true };
      },
      transport: {
        listReservations: async () => {
          throw new Error("Call-only requests do not need a pre-consent snapshot");
        },
        applyReservations: async (_appId, actions) => {
          appliedActions = actions;
          return [
            {
              id: 9n,
              appId: "wallet",
              installationUid: 1n,
              scopeKind: "principal",
              principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
              method: null,
              createdAt: 10n,
              createdBy: "ryjl3-tyaaa-aaaaa-aaaba-cai",
            },
          ];
        },
      },
    },
  );

  await tick();
  const pending = Object.values(
    useBackendCallConsentStore.getState().requests,
  )[0];
  if (!pending?.call) throw new Error("Missing attached-call disclosure");
  const displayedArgs = JSON.parse(JSON.stringify(pending.call.args));
  expect(Object.isFrozen(pending)).toBe(true);
  expect(Object.isFrozen(pending.call.args)).toBe(true);

  suppliedArgs[0]!.tileId = "mutated-after-request";
  suppliedArgs[0]!.remote.gameId = "hidden-game";
  expect(pending.call.args).toEqual(displayedArgs);
  expect(
    Object.prototype.hasOwnProperty.call(
      (pending.call.args[0] as { metadata: object }).metadata,
      "__proto__",
    ),
  ).toBe(true);

  approveBackendCallRequest(pending.id);
  await expect(operation).resolves.toEqual({
    reservations: [
      {
        id: "9",
        appId: "wallet",
        installationUid: "1",
        scopeKind: "principal",
        principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
        method: null,
        createdAt: "10",
        createdBy: "ryjl3-tyaaa-aaaaa-aaaba-cai",
      },
    ],
    callResult: { ok: true },
  });
  expect(validatedArgs).toEqual([displayedArgs, displayedArgs]);
  expect(executedArgs).toEqual(displayedArgs);
  expect(appliedActions).toEqual([]);
});

test("owner consent discloses trusted nested binary sidecar facts", async () => {
  installWalletDeclaration(true);
  const reviewArgs = [
    {
      profile: { avatar: null },
      attachments: [null, null],
    },
  ];
  const binaryFields = [
    {
      path: "args[0].profile.avatar",
      byteLength: 3,
      sha256: "a".repeat(64),
    },
    {
      path: "args[0].attachments[0]",
      byteLength: 2,
      sha256: "b".repeat(64),
    },
    {
      path: "args[0].attachments[1]",
      byteLength: 1,
      sha256: "c".repeat(64),
    },
  ];
  let executedArgs: unknown;

  const operation = requestBackendReservationForEndpoint(
    {
      actions: [],
      call: { method: "prepare_remote", args: reviewArgs },
    },
    endpoint,
    {
      validateSelfCall: async () => ({ args: reviewArgs, binaryFields }),
      executeSelfCall: async (_method, args) => {
        executedArgs = args;
        return { ok: true };
      },
      transport: {
        listReservations: async () => [],
        applyReservations: async () => [],
      },
    },
  );

  await tick();
  const pending = Object.values(
    useBackendCallConsentStore.getState().requests,
  )[0];
  if (!pending?.call) throw new Error("Missing attached-call disclosure");
  expect(pending.call.args).toEqual(reviewArgs);
  expect(pending.call.binaryFields).toEqual(binaryFields);
  expect(Object.isFrozen(pending.call.binaryFields)).toBe(true);
  expect(Object.isFrozen(pending.call.binaryFields?.[0])).toBe(true);

  approveBackendCallRequest(pending.id);
  await expect(operation).resolves.toEqual({
    reservations: [],
    callResult: { ok: true },
  });
  expect(executedArgs).toEqual(reviewArgs);
});

test("pending backend consent clones and freezes source and reservation facts", async () => {
  const source = {
    role: "tile" as const,
    tileId: "wallet",
    instanceId: "one",
    workspace: 1,
  };
  const actions = [
    {
      kind: "reserve" as const,
      scope: {
        kind: "exact" as const,
        principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
        method: "balance_of",
      },
      reservationPresentAtRequest: false,
    },
  ];
  const consent = requestBackendCallConsent({
    endpoint: endpoint.endpointId,
    appId: "wallet",
    source,
    actions,
  });
  const pending = Object.values(useBackendCallConsentStore.getState().requests)[0]!;

  source.instanceId = "mutated";
  actions[0]!.scope.method = "transfer";
  expect(pending.source).toMatchObject({ instanceId: "one" });
  expect(pending.actions[0]).toMatchObject({
    scope: { method: "balance_of" },
    reservationPresentAtRequest: false,
  });
  expect(Object.isFrozen(pending.actions)).toBe(true);
  expect(Object.isFrozen(pending.actions[0]!.scope)).toBe(true);

  rejectBackendCallRequest(pending.id);
  await expect(consent).rejects.toThrow("User rejected");
});

test("consent annotates authoritative existing state and applies its exact snapshot", async () => {
  installWalletDeclaration();
  const principal = "ryjl3-tyaaa-aaaaa-aaaba-cai";
  let appliedActions: unknown = null;
  const operation = requestBackendReservationForEndpoint(
    {
      actions: [
        {
          kind: "release",
          scope: { kind: "principal", principal },
        },
      ],
    },
    endpoint,
    {
      ...noCallRuntime(),
      transport: {
        listReservations: async () => [
          {
            id: 1n,
            appId: "wallet",
            installationUid: 1n,
            scopeKind: "principal",
            principal,
            method: null,
            createdAt: 2n,
            createdBy: principal,
          },
        ],
        applyReservations: async (_appId, actions) => {
          appliedActions = actions;
          return [];
        },
      },
    },
  );

  await tick();
  const pending = Object.values(
    useBackendCallConsentStore.getState().requests,
  )[0];
  if (!pending) throw new Error("Missing backend consent request");
  expect(pending.limits).toEqual({
    maxConcurrency: 20,
    maxCyclesPerCall: 0,
    maxCyclesPerDay: 0,
  });
  expect(Object.isFrozen(pending.limits)).toBe(true);
  expect(pending.actions).toEqual([
    {
      kind: "release",
      scope: { kind: "principal", principal },
      reservationPresentAtRequest: true,
    },
  ]);
  const displayedActions = JSON.parse(JSON.stringify(pending.actions));

  approveBackendCallRequest(pending.id);
  await expect(operation).resolves.toEqual({ reservations: [] });
  expect(appliedActions).toEqual(displayedActions);
});

test("authorization loss after approval cannot apply a grant or run an attached call", async () => {
  installWalletDeclaration(true);
  let executions = 0;
  const operation = requestBackendReservationForEndpoint(
    {
      actions: [
        {
          kind: "reserve",
          scope: {
            kind: "principal",
            principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
          },
        },
      ],
      call: { method: "prepare_remote", args: [null] },
    },
    endpoint,
    {
      validateSelfCall: async () => undefined,
      executeSelfCall: async () => {
        executions += 1;
        return null;
      },
      transport: {
        listReservations: async () => [],
        applyReservations: async () => {
          throw new Error("Caller is no longer authorized");
        },
      },
    },
  );

  await tick();
  const pending = Object.values(
    useBackendCallConsentStore.getState().requests,
  )[0];
  if (!pending) throw new Error("Missing backend consent request");
  approveBackendCallRequest(pending.id);

  await expect(operation).rejects.toThrow("no longer authorized");
  expect(executions).toBe(0);
  expect(useBackendCallConsentStore.getState().requests).toEqual({});
});

test("backend reservations decode absent Candid option methods", () => {
  const principal = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
  expect(
    normalizeBackendReservation({
      id: 1n,
      app_id: "wallet",
      installation_uid: 7n,
      scope_kind: "principal",
      principal: [principal],
      method: [],
      created_at: 2n,
      created_by: principal,
    }),
  ).toMatchObject({
    appId: "wallet",
    installationUid: 7n,
    scopeKind: "principal",
    principal: principal.toText(),
    method: null,
  });
});

test("backend reservations accept every compiler-owned physical method", () => {
  const principal = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
  const record = (method: string) => ({
    id: 1n,
    app_id: "wallet",
    installation_uid: 7n,
    scope_kind: "method",
    principal: [],
    method: [method],
    created_at: 2n,
    created_by: principal,
  });

  expect(
    normalizeBackendReservation(record("m".repeat(CANISTER_METHOD_MAX_LENGTH)))
      .method,
  ).toHaveLength(CANISTER_METHOD_MAX_LENGTH);
  expect(normalizeBackendReservation(record("1remote_method")).method).toBe(
    "1remote_method",
  );
  expect(() =>
    normalizeBackendReservation(
      record("m".repeat(CANISTER_METHOD_MAX_LENGTH + 1)),
    ),
  ).toThrow("Invalid backend method");
});

function noCallRuntime() {
  return {
    validateSelfCall: async () => undefined,
    executeSelfCall: async () => null,
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function installWalletDeclaration(withFunction = false) {
  useAppsStore.setState({
    list: {
      wallet: registryApp({
        id: "wallet",
        name: "Wallet",
        capabilities: {
          backend_calls: {
            api: 1,
            description: "Approved ledgers",
            reservation_scopes: ["principal"],
            max_concurrency: 20,
            max_cycles_per_call: 0,
            max_cycles_per_day: 0,
          },
        },
        ...(withFunction
          ? { func: { prepare_remote: { type: "update" as const } } }
          : {}),
      }),
    },
  });
}
