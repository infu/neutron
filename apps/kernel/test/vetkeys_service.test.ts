import { describe, expect, test } from "bun:test";
import {
  KernelPolicyError,
  VET_KEYS_ERROR_CODES,
  isVetKeysError,
  toError,
  type JsonValue,
  type KernelPolicyErrorCode,
} from "neutron-tools";
import {
  serializeVetKeysActionError,
  VetKeysBrowserBroker,
  type VetKeysBrokerBackend,
  type VetKeysManifestProjection,
} from "../src/vetkeys/service.ts";
import { normalizeVetKeysIcblastSuccess } from "../src/vetkeys/icblast_boundary.ts";
import type { RegisteredEndpoint } from "../src/frame_context.ts";

const OWNER = "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe";
const KEY_MANAGER = "l7put-ak4xb-iq2fx-7zgzw-n57my-5meck-krbld-etgzd-5lnha-zkuff-3ae";

function tile(appId = "mail", endpointId = `app:${appId}:tile:main:instance:one`): RegisteredEndpoint {
  return {
    endpointId,
    source: {} as Window,
    context: {
      role: "tile",
      appId,
      tileId: "main",
      instanceId: "one",
      workspace: 1,
    },
    appVersion: 100,
    sessionId: `${appId}-tile-session`,
  };
}

function background(
  appId = "mail",
  endpointId = `app:${appId}:background`,
): RegisteredEndpoint {
  return {
    endpointId,
    source: {} as Window,
    context: { role: "background", appId },
    appVersion: 100,
    sessionId: `${appId}-background-session`,
  };
}

function tray(appId = "mail"): RegisteredEndpoint {
  return {
    endpointId: `app:${appId}:tray:instance:one`,
    source: {} as Window,
    context: { role: "tray", appId, instanceId: "one" },
    appVersion: 100,
    sessionId: `${appId}-tray-session`,
  };
}

function manifest(): VetKeysManifestProjection {
  return {
    version: 100,
    slots: [{ id: "mailbox", purpose: "Encrypt and decrypt private Mail" }],
  };
}

function rawSlot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slot: "mailbox",
    purpose: "Encrypt and decrypt private Mail",
    key_holder: OWNER,
    status: { enabled: null },
    environment: { local: null },
    current_generation: "1",
    previous_generation: [],
    generations: [
      {
        generation: "1",
        status: { current: null },
        key_name: "test_key_1",
        public_fingerprint: [],
      },
    ],
    created_at: "1",
    updated_at: "1",
    last_used_at: [],
    total_derivations: "0",
    approximate_cycle_spend: "0",
    ...overrides,
  };
}

function rawPublicInfo(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    canister_principal: "efadq-gl777-77774-aaaba-cai",
    slot: "mailbox",
    generation: "1",
    suite: "bls12_381_g2",
    key_name: "test_key_1",
    public_key: new Array(96).fill(7),
    public_fingerprint: new Array(32).fill(8),
    derivation_input: new Array(32).fill(9),
    ...overrides,
  };
}

function makeBroker(options: {
  backend?: Partial<VetKeysBrokerBackend>;
  endpoints?: Map<string, RegisteredEndpoint>;
  manifests?: Record<string, VetKeysManifestProjection | null>;
  authorize?: () => Promise<void>;
  auth?: () => {
    logged: boolean;
    authorized: boolean;
    principal: string;
  };
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  digest?: (value: Uint8Array) => Promise<Uint8Array>;
  authorityCommitted?: () => boolean;
} = {}) {
  const endpoints = options.endpoints ?? new Map<string, RegisteredEndpoint>();
  const backend: VetKeysBrokerBackend = {
    list: async () => [rawSlot()],
    binding: async () => "1",
    lifecycle: async () => ({ ok: rawSlot() }),
    publicKey: async () => ({ ok: rawPublicInfo() }),
    derive: async () => ({
      ok: {
        encrypted_key: new Array(192).fill(5),
        public_info: rawPublicInfo(),
      },
    }),
    ...options.backend,
  };
  let authorizations = 0;
  let randomSequence = 0;
  const broker = new VetKeysBrowserBroker({
    backend,
    manifest: (appId) =>
      options.manifests?.[appId] === undefined
        ? manifest()
        : options.manifests[appId],
    auth: options.auth ??
      (() => ({ logged: true, authorized: true, principal: OWNER })),
    endpoint: (id) => endpoints.get(id) ?? null,
    ...(options.authorityCommitted
      ? { authorityCommitted: options.authorityCommitted }
      : {}),
    authorizeLifecycle: async () => {
      authorizations += 1;
      await options.authorize?.();
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.digest ? { digest: options.digest } : {}),
    randomBytes: options.randomBytes ??
      ((length) => {
        randomSequence += 1;
        return Uint8Array.from(
          { length },
          (_, index) => (index + randomSequence) & 0xff,
        );
      }),
  });
  return { broker, backend, endpoints, authorizations: () => authorizations };
}

describe("app-isolated vetKeys browser broker", () => {
  test("rejects a retired installation scope and pending frontend authority", async () => {
    const endpoint = {
      ...background(),
      appScope: { appId: "mail", installationUid: "7" },
    };
    let committed = true;
    let resolveList!: (value: unknown) => void;
    const pendingList = new Promise<unknown>((resolve) => {
      resolveList = resolve;
    });
    const { broker, endpoints } = makeBroker({
      manifests: {
        mail: { ...manifest(), installationUid: "7" },
      },
      authorityCommitted: () => committed,
      backend: { list: async () => pendingList },
    });
    endpoints.set(endpoint.endpointId, endpoint);

    const request = broker.list({}, endpoint);
    committed = false;
    resolveList([rawSlot()]);
    await expect(request).rejects.toMatchObject({
      name: "VetKeysError",
      code: "source_gone",
    });

    committed = true;
    const replacement = {
      ...endpoint,
      appScope: { appId: "mail", installationUid: "8" },
    };
    endpoints.set(endpoint.endpointId, replacement);
    await expect(broker.list({}, replacement)).rejects.toMatchObject({
      name: "VetKeysError",
      code: "source_gone",
    });
  });

  test("derives app identity from the live source and normalizes only declared slots", async () => {
    const endpoint = background();
    const calls: string[] = [];
    const { broker, endpoints } = makeBroker({
      backend: {
        list: async (appId) => {
          calls.push(appId);
          return [rawSlot()];
        },
      },
    });
    endpoints.set(endpoint.endpointId, endpoint);

    await expect(broker.list({}, endpoint)).resolves.toMatchObject({
      slots: [
        {
          slot: "mailbox",
          keyHolder: OWNER,
          status: "enabled",
          currentGeneration: "1",
          environment: "local",
        },
      ],
    });
    expect(calls).toEqual(["mail"]);
    await expect(
      broker.list({ appId: "wallet" }, endpoint),
    ).rejects.toMatchObject({ name: "VetKeysError", code: "invalid_request" });
  });

  test("strictly normalizes canonical Candid option arrays", async () => {
    const endpoint = background();
    const fingerprint = new Uint8Array(32).fill(6);
    const canonical = rawSlot({
      previous_generation: [2n],
      last_used_at: [9n],
      generations: [
        {
          generation: 1n,
          status: { current: null },
          key_name: "test_key_1",
          public_fingerprint: [fingerprint],
        },
        {
          generation: 2n,
          status: { previous: null },
          key_name: "test_key_1",
          public_fingerprint: [],
        },
      ],
    });
    const { broker, endpoints } = makeBroker({
      backend: { list: async () => [canonical] },
    });
    endpoints.set(endpoint.endpointId, endpoint);

    await expect(broker.list({}, endpoint)).resolves.toMatchObject({
      slots: [{
        previousGeneration: "2",
        lastUsedAt: "9",
        generations: [
          { generation: "1", publicFingerprint: [...fingerprint] },
          { generation: "2", publicFingerprint: null },
        ],
      }],
    });
  });

  test("rejects malformed Candid option arrays", async () => {
    const endpoint = background();
    const malformed = [
      rawSlot({ previous_generation: [2n, 3n] }),
      rawSlot({ last_used_at: [9n, 10n] }),
      rawSlot({
        generations: [{
          generation: 1n,
          status: { current: null },
          key_name: "test_key_1",
          public_fingerprint: [
            new Uint8Array(32).fill(1),
            new Uint8Array(32).fill(2),
          ],
        }],
      }),
      rawSlot({
        generations: [{
          generation: 1n,
          status: { current: null },
          key_name: "test_key_1",
          public_fingerprint: [new Uint8Array(31)],
        }],
      }),
    ];

    for (const slot of malformed) {
      const { broker, endpoints } = makeBroker({
        backend: { list: async () => [slot] },
      });
      endpoints.set(endpoint.endpointId, endpoint);
      await expect(broker.list({}, endpoint)).rejects.toThrow(/^Invalid vetKeys/u);
    }
  });

  test("normalizes icblast hex vectors and omitted option fields", async () => {
    const projectedSlot = rawSlot();
    delete projectedSlot.previous_generation;
    delete projectedSlot.last_used_at;
    const projectedGenerations = projectedSlot.generations as Array<Record<string, unknown>>;
    delete projectedGenerations[0]!.public_fingerprint;

    const requester = background();
    const endpoints = new Map([[requester.endpointId, requester]]);
    const projectedPublicInfo = rawPublicInfo({
      public_key: "07".repeat(96),
      public_fingerprint: "08".repeat(32),
      derivation_input: "09".repeat(32),
    });
    const { broker } = makeBroker({
      endpoints,
      backend: {
        list: async () => [projectedSlot],
        publicKey: async () => normalizeVetKeysIcblastSuccess(
          "kernel_vetkeys_public_key",
          projectedPublicInfo as JsonValue,
        ),
        derive: async () => normalizeVetKeysIcblastSuccess(
          "kernel_vetkeys_derive",
          {
            encrypted_key: "05".repeat(192),
            public_info: projectedPublicInfo as JsonValue,
          },
        ),
      },
    });

    await expect(broker.list({}, requester)).resolves.toMatchObject({
      slots: [{
        previousGeneration: null,
        lastUsedAt: null,
        generations: [{ publicFingerprint: null }],
      }],
    });
    await expect(
      broker.publicKey({ slot: "mailbox", generation: "1" }, requester),
    ).resolves.toMatchObject({
      publicKey: new Array(96).fill(7),
      publicFingerprint: new Array(32).fill(8),
      derivationInput: new Array(32).fill(9),
    });

    const challenge = await beginChallenge(broker, requester);
    broker.approve(
      { challengeId: challenge.challengeId },
      requester,
      APPROVAL_CONTEXT,
    );
    await expect(challenge.completion).resolves.toMatchObject({
      encryptedKey: new Array(192).fill(5),
      publicInfo: { publicKey: new Array(96).fill(7) },
    });
  });

  test("rejects malformed nonce, transport key, generation, and authority fields", async () => {
    const endpoint = background();
    const { broker, endpoints } = makeBroker();
    endpoints.set(endpoint.endpointId, endpoint);
    const invalidRequests = [
      deriveRequest({ transportPublicKey: new Array(47).fill(3) }),
      deriveRequest({ transportPublicKey: new Array(49).fill(3) }),
      deriveRequest({ transportPublicKey: [256, ...new Array(47).fill(3)] }),
      deriveRequest({ transportPublicKey: [-1, ...new Array(47).fill(3)] }),
      deriveRequest({ requestNonce: new Array(31).fill(4) }),
      deriveRequest({ requestNonce: new Array(33).fill(4) }),
      deriveRequest({ requestNonce: [0.5, ...new Array(31).fill(4)] }),
      deriveRequest({ generation: "0" }),
      deriveRequest({ generation: "01" }),
      deriveRequest({ generation: "18446744073709551616" }),
      { ...deriveRequest(), appId: "wallet" },
    ];

    for (const request of invalidRequests) {
      await expect(
        broker.begin(request, endpoint, () => {}, BEGIN_CONTEXT),
      ).rejects.toMatchObject({ name: "VetKeysError", code: "invalid_request" });
    }
    expect(broker.snapshot()).toEqual({ pending: 0, dispatched: 0 });
  });

  test("copies nonce and transport inputs before awaits and detects a changed transport binding", async () => {
    const endpoint = background();
    const endpoints = new Map([[endpoint.endpointId, endpoint]]);
    const listGate = deferred<unknown>();
    const seenTransport: number[][] = [];
    const { broker } = makeBroker({
      endpoints,
      backend: {
        list: async () => listGate.promise,
        derive: async (_appId, _slot, _generation, transportPublicKey) => {
          seenTransport.push(transportPublicKey);
          return {
            ok: {
              encrypted_key: new Array(192).fill(5),
              public_info: rawPublicInfo(),
            },
          };
        },
      },
    });
    const transportPublicKey = new Array(48).fill(3);
    const requestNonce = new Array(32).fill(4);
    const challenge = beginChallenge(
      broker,
      endpoint,
      deriveRequest({ transportPublicKey, requestNonce }),
    );

    transportPublicKey.fill(91);
    requestNonce.fill(92);
    listGate.resolve([rawSlot()]);
    const opened = await challenge;
    broker.approve(
      { challengeId: opened.challengeId },
      endpoint,
      APPROVAL_CONTEXT,
    );
    await expect(opened.completion).resolves.toMatchObject({
      publicInfo: { generation: "1" },
    });
    expect(seenTransport).toEqual([new Array(48).fill(3)]);

    let digestCalls = 0;
    const changed = makeBroker({
      endpoints,
      digest: async () => {
        digestCalls += 1;
        return new Uint8Array(32).fill(digestCalls);
      },
    });
    const altered = await beginChallenge(changed.broker, endpoint);
    changed.broker.approve(
      { challengeId: altered.challengeId },
      endpoint,
      APPROVAL_CONTEXT,
    );
    await expect(altered.completion).rejects.toMatchObject({
      code: "source_gone",
    });
    expect(changed.broker.snapshot()).toEqual({ pending: 0, dispatched: 0 });
  });

  test("lifecycle requests require a focused direct tile and one-shot owner consent", async () => {
    const endpoint = tile();
    const { broker, endpoints, authorizations } = makeBroker();
    endpoints.set(endpoint.endpointId, endpoint);

    await expect(
      broker.request(
        { action: "reserve", slot: "mailbox" },
        endpoint,
        { focused: false, delegated: false, agentActive: false },
      ),
    ).rejects.toMatchObject({ code: "source_gone" });

    await expect(
      broker.request(
        { action: "reserve", slot: "mailbox" },
        endpoint,
        { focused: true, delegated: false, agentActive: false },
      ),
    ).resolves.toMatchObject({ retired: false, slot: { slot: "mailbox" } });
    expect(authorizations()).toBe(1);
  });

  test("lifecycle consent cannot survive auth, manifest, or tile-session changes", async () => {
    const cases: Array<{
      mutate(input: {
        endpoint: RegisteredEndpoint;
        endpoints: Map<string, RegisteredEndpoint>;
        manifests: Record<string, VetKeysManifestProjection | null>;
        auth: { logged: boolean; authorized: boolean; principal: string };
      }): void;
      code: string;
    }> = [
      {
        mutate: ({ auth }) => {
          auth.principal = "l7put-ak4xb-iq2fx-7zgzw-n57my-5meck-krbld-etgzd-5lnha-zkuff-3ae";
        },
        code: "owner_required",
      },
      {
        mutate: ({ manifests }) => {
          manifests.mail = { ...manifest(), version: 101 };
        },
        code: "source_gone",
      },
      {
        mutate: ({ endpoint, endpoints }) => {
          endpoints.set(endpoint.endpointId, {
            ...endpoint,
            sessionId: "replacement-session",
          });
        },
        code: "source_gone",
      },
    ];

    for (const entry of cases) {
      const endpoint = tile();
      const endpoints = new Map([[endpoint.endpointId, endpoint]]);
      const manifests: Record<string, VetKeysManifestProjection | null> = {
        mail: manifest(),
      };
      const auth = { logged: true, authorized: true, principal: OWNER };
      const { broker, authorizations } = makeBroker({
        endpoints,
        manifests,
        auth: () => ({ ...auth }),
        authorize: async () => {
          entry.mutate({ endpoint, endpoints, manifests, auth });
        },
      });

      await expect(
        broker.request(
          { action: "reserve", slot: "mailbox" },
          endpoint,
          { focused: true, delegated: false, agentActive: false },
        ),
      ).rejects.toMatchObject({ code: entry.code });
      expect(authorizations()).toBe(1);
    }
  });

  test("snapshots the principal value across lifecycle consent", async () => {
    const endpoint = tile();
    const endpoints = new Map([[endpoint.endpointId, endpoint]]);
    const auth = { logged: true, authorized: true, principal: OWNER };
    const { broker } = makeBroker({
      endpoints,
      auth: () => auth,
      authorize: async () => {
        auth.principal = "l7put-ak4xb-iq2fx-7zgzw-n57my-5meck-krbld-etgzd-5lnha-zkuff-3ae";
      },
    });

    await expect(
      broker.request(
        { action: "reserve", slot: "mailbox" },
        endpoint,
        { focused: true, delegated: false, agentActive: false },
      ),
    ).rejects.toMatchObject({ code: "owner_required" });
  });

  test("lets an authorized non-manager recover seamlessly only through its exact originating endpoint", async () => {
    const resident = background();
    const mailTile = tile();
    const otherTile = tile("wallet");
    const endpoints = new Map([
      [resident.endpointId, resident],
      [mailTile.endpointId, mailTile],
      [otherTile.endpointId, otherTile],
    ]);
    const deriveCalls: string[] = [];
    const deriveBindings: string[] = [];
    const { broker } = makeBroker({
      endpoints,
      backend: {
        list: async () => [rawSlot({ key_holder: KEY_MANAGER })],
        binding: async () => "47",
        derive: async (
          appId,
          _slot,
          _generation,
          _transportPublicKey,
          expectedSlotUid,
        ) => {
          deriveCalls.push(appId);
          deriveBindings.push(expectedSlotUid);
          return {
            ok: {
              encrypted_key: new Array(192).fill(5),
              public_info: rawPublicInfo(),
            },
          };
        },
      },
    });
    let challenge: { challengeId: string; expiresAt: string } | undefined;
    const resultPromise = broker.begin(
      {
        slot: "mailbox",
        generation: "1",
        transportPublicKey: new Array(48).fill(3),
        requestNonce: new Array(32).fill(4),
      },
      resident,
      (value) => {
        challenge = value as typeof challenge;
      },
      { delegated: true, agentActive: true },
    );
    await waitFor(() => challenge !== undefined);
    expect(deriveCalls).toEqual([]);

    expect(captureSynchronousError(() =>
      broker.approve(
        { challengeId: challenge!.challengeId },
        otherTile,
        {
          focused: true,
          userActivated: true,
          delegated: false,
          agentActive: false,
        },
      ),
    )).toMatchObject({ name: "VetKeysError", code: "source_gone" });

    expect(captureSynchronousError(() =>
      broker.approve(
        { challengeId: challenge!.challengeId },
        mailTile,
        {
          focused: false,
          userActivated: false,
          delegated: true,
          agentActive: true,
        },
      ),
    )).toMatchObject({ name: "VetKeysError", code: "source_gone" });

    expect(
      broker.approve(
        { challengeId: challenge!.challengeId },
        resident,
        {
          focused: false,
          userActivated: false,
          delegated: true,
          agentActive: true,
        },
      ),
    ).toEqual({ approved: true });
    await expect(resultPromise).resolves.toMatchObject({
      encryptedKey: expect.any(Array),
      publicInfo: { slot: "mailbox", generation: "1" },
    });
    expect(deriveCalls).toEqual(["mail"]);
    expect(deriveBindings).toEqual(["47"]);
    expect(broker.snapshot()).toEqual({ pending: 0, dispatched: 0 });
  });

  test("expires and consumes opaque challenges exactly once", async () => {
    let now = 1_000;
    const requester = background();
    const endpoints = new Map([[requester.endpointId, requester]]);
    const expiring = makeBroker({ endpoints, now: () => now });
    const stale = await beginChallenge(expiring.broker, requester);
    expect(stale.expiresAt).toBe("61000");
    now = 61_001;
    expect(expiring.broker.snapshot()).toEqual({ pending: 0, dispatched: 0 });
    await expect(stale.completion).rejects.toMatchObject({
      name: "VetKeysError",
      code: "challenge_expired",
    });
    expect(captureSynchronousError(() =>
      expiring.broker.approve(
        { challengeId: stale.challengeId },
        requester,
        APPROVAL_CONTEXT,
      ),
    )).toMatchObject({ name: "VetKeysError", code: "challenge_expired" });

    const deriveGate = deferred<unknown>();
    const singleUse = makeBroker({
      endpoints,
      backend: { derive: async () => deriveGate.promise },
    });
    const live = await beginChallenge(singleUse.broker, requester);
    expect(
      singleUse.broker.approve(
        { challengeId: live.challengeId },
        requester,
        APPROVAL_CONTEXT,
      ),
    ).toEqual({ approved: true });
    expect(captureSynchronousError(() =>
      singleUse.broker.approve(
        { challengeId: live.challengeId },
        requester,
        APPROVAL_CONTEXT,
      ),
    )).toMatchObject({ name: "VetKeysError", code: "challenge_consumed" });
    deriveGate.resolve({
      ok: {
        encrypted_key: new Array(192).fill(5),
        public_info: rawPublicInfo(),
      },
    });
    await expect(live.completion).resolves.toMatchObject({
      publicInfo: { slot: "mailbox" },
    });
    await waitFor(() => singleUse.broker.snapshot().dispatched === 0);
    expect(captureSynchronousError(() =>
      singleUse.broker.approve(
        { challengeId: live.challengeId },
        requester,
        APPROVAL_CONTEXT,
      ),
    )).toMatchObject({ name: "VetKeysError", code: "challenge_consumed" });
  });

  test("retains exactly 256 terminal challenges and evicts the oldest", async () => {
    const requester = background();
    const endpoints = new Map([[requester.endpointId, requester]]);
    let sequence = 0;
    let selected = 0;
    let useSequence = true;
    const { broker } = makeBroker({
      endpoints,
      now: () => 1_000,
      randomBytes: (length) => {
        let value = useSequence ? sequence++ : selected;
        const bytes = new Uint8Array(length);
        for (let offset = 0; offset < 4; offset += 1) {
          bytes[length - 1 - offset] = value & 0xff;
          value = Math.floor(value / 256);
        }
        return bytes;
      },
    });

    let oldestChallengeId = "";
    for (let index = 0; index < 257; index += 1) {
      const challenge = await beginChallenge(broker, requester);
      if (index === 0) oldestChallengeId = challenge.challengeId;
      expect(
        broker.approve(
          { challengeId: challenge.challengeId },
          requester,
          APPROVAL_CONTEXT,
        ),
      ).toEqual({ approved: true });
      await expect(challenge.completion).resolves.toMatchObject({
        publicInfo: { slot: "mailbox" },
      });
    }
    await waitFor(() => broker.snapshot().dispatched === 0);

    // Entry 1 is still retained, so eight identical allocation attempts fail.
    // Entry 0 was the sole eviction when entry 256 crossed the exact cap.
    useSequence = false;
    selected = 1;
    await expect(
      broker.begin(
        deriveRequest(),
        requester,
        () => {},
        BEGIN_CONTEXT,
      ),
    ).rejects.toThrow("Unable to allocate a key challenge");
    selected = 0;
    const reused = await beginChallenge(broker, requester);
    expect(reused.challengeId).toBe(oldestChallengeId);
    broker.approve(
      { challengeId: reused.challengeId },
      requester,
      APPROVAL_CONTEXT,
    );
    await expect(reused.completion).resolves.toMatchObject({
      publicInfo: { slot: "mailbox" },
    });
  });

  test("requester closure and replacement cancel pending and dispatched results", async () => {
    const requester = tile(
      "mail",
      "app:mail:tile:requester:instance:one",
    );
    const endpoints = new Map([[requester.endpointId, requester]]);
    const pendingBroker = makeBroker({ endpoints });
    const pending = await beginChallenge(pendingBroker.broker, requester);
    endpoints.delete(requester.endpointId);
    pendingBroker.broker.reconcileEndpoints();
    await expect(pending.completion).rejects.toMatchObject({
      code: "source_gone",
    });
    expect(pendingBroker.broker.snapshot()).toEqual({
      pending: 0,
      dispatched: 0,
    });

    endpoints.set(requester.endpointId, requester);
    const deriveGate = deferred<unknown>();
    const dispatchedBroker = makeBroker({
      endpoints,
      backend: { derive: async () => deriveGate.promise },
    });
    const dispatched = await beginChallenge(dispatchedBroker.broker, requester);
    dispatchedBroker.broker.approve(
      { challengeId: dispatched.challengeId },
      requester,
      APPROVAL_CONTEXT,
    );
    await waitFor(() => dispatchedBroker.broker.snapshot().dispatched === 1);
    endpoints.set(requester.endpointId, {
      ...requester,
      sessionId: "replacement-session",
    });
    dispatchedBroker.broker.reconcileEndpoints();
    await expect(dispatched.completion).rejects.toMatchObject({
      code: "source_gone",
    });
    deriveGate.resolve({
      ok: {
        encrypted_key: new Array(192).fill(5),
        public_info: rawPublicInfo(),
      },
    });
    await waitFor(() => dispatchedBroker.broker.snapshot().dispatched === 0);
    expect(dispatchedBroker.broker.snapshot()).toEqual({
      pending: 0,
      dispatched: 0,
    });
  });

  test("tray recovery stays denied while delegated and Agent tool work may recover", async () => {
    const requester = background();
    const otherSurface = tile();
    const trayEndpoint = tray();
    const endpoints = new Map([
      [requester.endpointId, requester],
      [otherSurface.endpointId, otherSurface],
      [trayEndpoint.endpointId, trayEndpoint],
    ]);
    const { broker } = makeBroker({ endpoints });

    await expect(
      broker.begin(deriveRequest(), trayEndpoint, () => {}, BEGIN_CONTEXT),
    ).rejects.toMatchObject({ code: "source_gone" });
    for (const context of [
      { delegated: false, agentActive: true },
      { delegated: true, agentActive: false },
    ]) {
      const challenge = await beginChallenge(
        broker,
        requester,
        deriveRequest(),
        context,
      );
      expect(
        broker.approve(
          { challengeId: challenge.challengeId },
          requester,
          {
            focused: false,
            userActivated: false,
            delegated: context.delegated,
            agentActive: context.agentActive,
          },
        ),
      ).toEqual({ approved: true });
      await expect(challenge.completion).resolves.toMatchObject({
        publicInfo: { slot: "mailbox" },
      });
      await waitFor(() => broker.snapshot().dispatched === 0);
    }

    const challenge = await beginChallenge(broker, requester);
    expect(captureSynchronousError(() =>
      broker.approve(
        { challengeId: challenge.challengeId },
        otherSurface,
        APPROVAL_CONTEXT,
      ),
    )).toMatchObject({ name: "VetKeysError", code: "source_gone" });
    expect(captureSynchronousError(() =>
      broker.approve(
        { challengeId: challenge.challengeId },
        trayEndpoint,
        APPROVAL_CONTEXT,
      ),
    )).toMatchObject({ name: "VetKeysError", code: "source_gone" });
    endpoints.delete(requester.endpointId);
    broker.reconcileEndpoints();
    await expect(challenge.completion).rejects.toMatchObject({
      code: "source_gone",
    });
  });

  test("bounds pending challenges per app and globally, then cleans every reservation", async () => {
    const perAppEndpoints = new Map<string, RegisteredEndpoint>();
    const perAppBroker = makeBroker({ endpoints: perAppEndpoints });
    const perAppChallenges: Awaited<ReturnType<typeof beginChallenge>>[] = [];
    for (let index = 0; index < 8; index += 1) {
      const endpoint = background(
        "mail",
        `app:mail:background:instance:${index}`,
      );
      perAppEndpoints.set(endpoint.endpointId, endpoint);
      perAppChallenges.push(
        await beginChallenge(perAppBroker.broker, endpoint),
      );
    }
    const ninth = background("mail", "app:mail:background:instance:nine");
    perAppEndpoints.set(ninth.endpointId, ninth);
    await expect(
      perAppBroker.broker.begin(
        deriveRequest(),
        ninth,
        () => {},
        BEGIN_CONTEXT,
      ),
    ).rejects.toMatchObject({ code: "busy" });
    expect(perAppBroker.broker.snapshot()).toEqual({
      pending: 8,
      dispatched: 0,
    });
    perAppEndpoints.clear();
    perAppBroker.broker.reconcileEndpoints();
    await Promise.all(
      perAppChallenges.map((challenge) =>
        expect(challenge.completion).rejects.toMatchObject({
          code: "source_gone",
        }),
      ),
    );
    expect(perAppBroker.broker.snapshot()).toEqual({
      pending: 0,
      dispatched: 0,
    });

    const globalEndpoints = new Map<string, RegisteredEndpoint>();
    const globalBroker = makeBroker({ endpoints: globalEndpoints });
    const globalChallenges: Awaited<ReturnType<typeof beginChallenge>>[] = [];
    for (let appIndex = 0; appIndex < 8; appIndex += 1) {
      const appId = `fixture${appIndex}`;
      for (let endpointIndex = 0; endpointIndex < 8; endpointIndex += 1) {
        const endpoint = background(
          appId,
          `app:${appId}:background:instance:${endpointIndex}`,
        );
        globalEndpoints.set(endpoint.endpointId, endpoint);
        globalChallenges.push(
          await beginChallenge(globalBroker.broker, endpoint),
        );
      }
    }
    const sixtyFifth = background("overflow");
    globalEndpoints.set(sixtyFifth.endpointId, sixtyFifth);
    await expect(
      globalBroker.broker.begin(
        deriveRequest(),
        sixtyFifth,
        () => {},
        BEGIN_CONTEXT,
      ),
    ).rejects.toMatchObject({ code: "busy" });
    expect(globalBroker.broker.snapshot()).toEqual({
      pending: 64,
      dispatched: 0,
    });
    globalEndpoints.clear();
    globalBroker.broker.reconcileEndpoints();
    await Promise.allSettled(
      globalChallenges.map((challenge) => challenge.completion),
    );
    expect(globalBroker.broker.snapshot()).toEqual({
      pending: 0,
      dispatched: 0,
    });
  });

  test("enforces one derivation per app and four globally before backend awaits", async () => {
    const sameAppFirst = background(
      "mail",
      "app:mail:background:instance:first",
    );
    const sameAppSecond = background(
      "mail",
      "app:mail:background:instance:second",
    );
    const sameAppEndpoints = new Map([
      [sameAppFirst.endpointId, sameAppFirst],
      [sameAppSecond.endpointId, sameAppSecond],
    ]);
    const sameAppGates = [deferred<unknown>(), deferred<unknown>()];
    let sameAppCalls = 0;
    const sameAppBroker = makeBroker({
      endpoints: sameAppEndpoints,
      backend: {
        derive: async () => sameAppGates[sameAppCalls++]!.promise,
      },
    });
    const first = await beginChallenge(sameAppBroker.broker, sameAppFirst);
    const second = await beginChallenge(sameAppBroker.broker, sameAppSecond);
    sameAppBroker.broker.approve(
      { challengeId: first.challengeId },
      sameAppFirst,
      APPROVAL_CONTEXT,
    );
    expect(captureSynchronousError(() =>
      sameAppBroker.broker.approve(
        { challengeId: second.challengeId },
        sameAppSecond,
        APPROVAL_CONTEXT,
      ),
    )).toMatchObject({ name: "VetKeysError", code: "busy" });
    expect(sameAppBroker.broker.snapshot()).toEqual({
      pending: 2,
      dispatched: 1,
    });
    sameAppGates[0]!.resolve(successfulDerivation());
    await expect(first.completion).resolves.toMatchObject({
      publicInfo: { slot: "mailbox" },
    });
    await waitFor(() => sameAppBroker.broker.snapshot().dispatched === 0);
    sameAppBroker.broker.approve(
      { challengeId: second.challengeId },
      sameAppSecond,
      APPROVAL_CONTEXT,
    );
    sameAppGates[1]!.resolve(successfulDerivation());
    await expect(second.completion).resolves.toMatchObject({
      publicInfo: { slot: "mailbox" },
    });
    await waitFor(() => sameAppBroker.broker.snapshot().dispatched === 0);

    const globalEndpoints = new Map<string, RegisteredEndpoint>();
    const globalGates = new Map<string, Deferred<unknown>>();
    const globalBroker = makeBroker({
      endpoints: globalEndpoints,
      backend: {
        derive: async (appId) => globalGates.get(appId)!.promise,
      },
    });
    const challenges: Array<{
      appId: string;
      challenge: Awaited<ReturnType<typeof beginChallenge>>;
      requester: RegisteredEndpoint;
    }> = [];
    for (let index = 0; index < 5; index += 1) {
      const appId = `parallel${index}`;
      const requester = background(appId);
      globalEndpoints.set(requester.endpointId, requester);
      globalGates.set(appId, deferred<unknown>());
      challenges.push({
        appId,
        challenge: await beginChallenge(globalBroker.broker, requester),
        requester,
      });
    }
    for (const entry of challenges.slice(0, 4)) {
      globalBroker.broker.approve(
        { challengeId: entry.challenge.challengeId },
        entry.requester,
        APPROVAL_CONTEXT,
      );
    }
    expect(globalBroker.broker.snapshot()).toEqual({
      pending: 5,
      dispatched: 4,
    });
    const fifth = challenges[4]!;
    expect(captureSynchronousError(() =>
      globalBroker.broker.approve(
        { challengeId: fifth.challenge.challengeId },
        fifth.requester,
        APPROVAL_CONTEXT,
      ),
    )).toMatchObject({ name: "VetKeysError", code: "busy" });

    globalGates.get(challenges[0]!.appId)!.resolve(successfulDerivation());
    await expect(challenges[0]!.challenge.completion).resolves.toMatchObject({
      publicInfo: { slot: "mailbox" },
    });
    await waitFor(() => globalBroker.broker.snapshot().dispatched === 3);
    globalBroker.broker.approve(
      { challengeId: fifth.challenge.challengeId },
      fifth.requester,
      APPROVAL_CONTEXT,
    );
    for (const entry of challenges.slice(1)) {
      globalGates.get(entry.appId)!.resolve(successfulDerivation());
    }
    await Promise.all(
      challenges.slice(1).map((entry) => entry.challenge.completion),
    );
    await waitFor(() => globalBroker.broker.snapshot().dispatched === 0);
    expect(globalBroker.broker.snapshot()).toEqual({
      pending: 0,
      dispatched: 0,
    });
  });

  test("rejects post-await results when the source session is replaced", async () => {
    const endpoint = background();
    const endpoints = new Map([[endpoint.endpointId, endpoint]]);
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const { broker } = makeBroker({
      endpoints,
      backend: { list: async () => pending },
    });
    const operation = broker.list({}, endpoint);
    endpoints.set(endpoint.endpointId, {
      ...endpoint,
      sessionId: "replacement-session",
    });
    release([rawSlot()]);
    await expect(operation).rejects.toMatchObject({ code: "source_gone" });
  });

  test("does not create a challenge after authorization, principal, or manifest changes during begin", async () => {
    for (const change of ["principal", "authorization", "manifest"] as const) {
      const endpoint = background();
      const endpoints = new Map([[endpoint.endpointId, endpoint]]);
      const auth = { logged: true, authorized: true, principal: OWNER };
      const manifests: Record<string, VetKeysManifestProjection | null> = {
        mail: manifest(),
      };
      const bindingGate = deferred<string>();
      let bindingCalls = 0;
      const { broker } = makeBroker({
        endpoints,
        auth: () => ({ ...auth }),
        manifests,
        backend: {
          binding: async () => {
            bindingCalls += 1;
            return bindingGate.promise;
          },
        },
      });
      const operation = broker.begin(
        deriveRequest(),
        endpoint,
        () => {},
        BEGIN_CONTEXT,
      );
      await waitFor(() => bindingCalls === 1);
      if (change === "principal") {
        auth.principal = KEY_MANAGER;
      } else if (change === "authorization") {
        auth.authorized = false;
      } else {
        manifests.mail = { ...manifest(), version: 101 };
      }
      bindingGate.resolve("1");
      await expect(operation).rejects.toMatchObject({
        code: change === "manifest" ? "source_gone" : "owner_required",
      });
      expect(broker.snapshot()).toEqual({ pending: 0, dispatched: 0 });
    }
  });

  test("withholds post-derive results after authorization, principal, manifest, or requester changes", async () => {
    for (const change of ["principal", "authorization", "manifest", "session"] as const) {
      const requester = background();
      const endpoints = new Map([[requester.endpointId, requester]]);
      const auth = { logged: true, authorized: true, principal: OWNER };
      const manifests: Record<string, VetKeysManifestProjection | null> = {
        mail: manifest(),
      };
      const deriveGate = deferred<unknown>();
      let deriveCalls = 0;
      const { broker } = makeBroker({
        endpoints,
        auth: () => ({ ...auth }),
        manifests,
        backend: {
          derive: async () => {
            deriveCalls += 1;
            return deriveGate.promise;
          },
        },
      });
      const pending = await beginChallenge(broker, requester);
      broker.approve(
        { challengeId: pending.challengeId },
        requester,
        APPROVAL_CONTEXT,
      );
      await waitFor(() => deriveCalls === 1);
      if (change === "principal") {
        auth.principal = KEY_MANAGER;
      } else if (change === "authorization") {
        auth.authorized = false;
      } else if (change === "manifest") {
        manifests.mail = null;
      } else {
        endpoints.set(requester.endpointId, {
          ...requester,
          sessionId: "replacement-session",
        });
      }
      deriveGate.resolve(successfulDerivation());
      await expect(pending.completion).rejects.toMatchObject({
        code: change === "manifest" || change === "session"
          ? "source_gone"
          : "owner_required",
      });
      await waitFor(() => broker.snapshot().dispatched === 0);
      expect(broker.snapshot()).toEqual({ pending: 0, dispatched: 0 });
    }
  });

  test("rejects changed generation output and forwards post-await status/holder closure", async () => {
    const requester = background();
    const endpoints = new Map([[requester.endpointId, requester]]);
    for (const result of [
      {
        ok: {
          encrypted_key: new Array(192).fill(5),
          public_info: rawPublicInfo({ generation: "2" }),
        },
      },
      { err: { disabled: null } },
      { err: { owner_required: null } },
      { err: { generation_unavailable: null } },
    ]) {
      const { broker } = makeBroker({
        endpoints,
        backend: { derive: async () => result },
      });
      const pending = await beginChallenge(broker, requester);
      broker.approve(
        { challengeId: pending.challengeId },
        requester,
        APPROVAL_CONTEXT,
      );
      const error = await pending.completion.catch(
        (caught: unknown) => caught,
      );
      const wire = serializeVetKeysActionError(error);
      expect(Object.hasOwn(wire, "stack")).toBe(false);
      if ("err" in result) {
        expect(wire).toMatchObject({
          name: "VetKeysError",
          code: Object.keys(result.err)[0],
        });
      } else {
        expect(wire).toEqual({
          name: "VetKeysError",
          message: "App-isolated key operation failed",
          code: "key_unavailable",
        });
      }
      await waitFor(() => broker.snapshot().dispatched === 0);
    }
  });

  test("coalesces identical public-key requests and revalidates each source", async () => {
    const first = tile("mail", "app:mail:tile:first:instance:one");
    const second = tile("mail", "app:mail:tile:second:instance:two");
    const endpoints = new Map([
      [first.endpointId, first],
      [second.endpointId, second],
    ]);
    let release!: (value: unknown) => void;
    const deferred = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { broker } = makeBroker({
      endpoints,
      backend: {
        publicKey: async () => {
          calls += 1;
          return deferred;
        },
      },
    });

    const left = broker.publicKey(
      { slot: "mailbox", generation: "1" },
      first,
    );
    const right = broker.publicKey(
      { slot: "mailbox", generation: "1" },
      second,
    );
    await waitFor(() => calls === 1);
    release({ ok: rawPublicInfo() });

    const [leftResult, rightResult] = await Promise.all([left, right]);
    expect(calls).toBe(1);
    expect(leftResult).toEqual(rightResult);
  });

  test("preserves the closed SDK error contract without exposing a stack", async () => {
    const endpoint = background();
    const { broker, endpoints } = makeBroker({
      backend: {
        publicKey: async () => ({
          err: { busy: null },
        }),
      },
    });
    endpoints.set(endpoint.endpointId, endpoint);

    const brokerError = await broker
      .publicKey({ slot: "mailbox", generation: "1" }, endpoint)
      .catch((error: unknown) => error);
    expect(brokerError).toMatchObject({
      name: "VetKeysError",
      code: "busy",
      message: "The key service is busy",
    });
    const wireError = serializeVetKeysActionError(brokerError);
    expect(wireError).toEqual({
      name: "VetKeysError",
      message: "The key service is busy",
      code: "busy",
    });
    expect(Object.hasOwn(wireError, "stack")).toBe(false);

    const sdkError = toError(wireError);
    expect(isVetKeysError(sdkError)).toBe(true);
    expect(sdkError).toMatchObject({
      code: "busy",
    });
  });

  test("maps every surrounding kernel policy failure into the closed vetKeys domain", () => {
    const expected = {
      UI_BUSY: "busy",
      APP_PAUSED: "source_gone",
      REQUEST_EXPIRED: "challenge_expired",
      REQUEST_CANCELLED: "source_gone",
      OWNER_REQUIRED: "owner_required",
      USER_INTERACTION_REQUIRED: "source_gone",
      INVOCATION_INVALID: "invalid_request",
      INVALID_REQUEST: "invalid_request",
      SCOPED_CONTEXT_REQUIRED: "invalid_request",
      VETKEYS_UNAVAILABLE: "key_unavailable",
      AGENT_CONSENT_DENIED: "source_gone",
      AGENT_CONSENT_TIMEOUT: "source_gone",
      AGENT_CONSENT_LIMIT: "busy",
      AGENT_MODE_REVOKED: "source_gone",
      AGENT_MODE_LIMIT: "busy",
    } as const satisfies Record<KernelPolicyErrorCode, (typeof VET_KEYS_ERROR_CODES)[number]>;

    for (const [policyCode, vetKeysCode] of Object.entries(expected) as Array<
      [KernelPolicyErrorCode, (typeof VET_KEYS_ERROR_CODES)[number]]
    >) {
      const wire = serializeVetKeysActionError(
        new KernelPolicyError(
          policyCode,
          `private policy detail for ${policyCode}`,
          { retryAfterMs: 1_201 },
        ),
      );
      expect(wire).toMatchObject({ name: "VetKeysError", code: vetKeysCode });
      expect(JSON.stringify(wire)).not.toContain(policyCode);
      expect(JSON.stringify(wire)).not.toContain("private policy detail");
      expect(Object.hasOwn(wire, "stack")).toBe(false);
      expect(Object.hasOwn(wire, "retryAfterMs")).toBe(false);
      expect(Object.hasOwn(wire, "retryAfterSeconds")).toBe(false);
      expect(isVetKeysError(toError(wire))).toBe(true);
    }
  });

  test("classifies browser slot-state failures without general policy codes", async () => {
    const endpoint = background();
    const cases: Array<{
      code: (typeof VET_KEYS_ERROR_CODES)[number];
      list: () => Promise<unknown>;
      manifests?: Record<string, VetKeysManifestProjection | null>;
      generation?: string;
    }> = [
      { code: "not_reserved", list: async () => [] },
      {
        code: "manifest_suspended",
        list: async () => [rawSlot({ status: { manifest_suspended: null } })],
      },
      {
        code: "disabled",
        list: async () => [rawSlot({ status: { disabled: null } })],
      },
      {
        code: "generation_unavailable",
        list: async () => [rawSlot()],
        generation: "2",
      },
      {
        code: "not_declared",
        list: async () => [rawSlot()],
        manifests: {
          mail: { version: 100, slots: [{ id: "other", purpose: "Other" }] },
        },
      },
    ];

    for (const entry of cases) {
      const endpoints = new Map([[endpoint.endpointId, endpoint]]);
      const { broker } = makeBroker({
        endpoints,
        ...(entry.manifests ? { manifests: entry.manifests } : {}),
        backend: { list: entry.list },
      });
      const error = await broker.begin(
        deriveRequest({ generation: entry.generation ?? "1" }),
        endpoint,
        () => {},
        BEGIN_CONTEXT,
      ).catch((caught: unknown) => caught);
      const wire = serializeVetKeysActionError(error);
      expect(wire).toMatchObject({ name: "VetKeysError", code: entry.code });
      expect(isVetKeysError(toError(wire))).toBe(true);
      expect(JSON.stringify(wire)).not.toMatch(/[A-Z_]{3,}/u);
    }
  });

  test("serializes every closed backend error without detail or stack leakage", async () => {
    const endpoint = background();
    for (const code of VET_KEYS_ERROR_CODES) {
      const { broker, endpoints } = makeBroker({
        backend: {
          publicKey: async () => ({
            err: { [code]: null },
          }),
        },
      });
      endpoints.set(endpoint.endpointId, endpoint);
      const brokerError = await broker
        .publicKey({ slot: "mailbox", generation: "1" }, endpoint)
        .catch((error: unknown) => error);
      expect(brokerError).toMatchObject({
        name: "VetKeysError",
        code,
      });
      const wireError = serializeVetKeysActionError(brokerError);
      expect(wireError).toMatchObject({
        name: "VetKeysError",
        code,
      });
      expect(typeof wireError.message).toBe("string");
      expect(Object.hasOwn(wireError, "stack")).toBe(false);
      expect(JSON.stringify(wireError)).not.toContain("backend");
      expect(JSON.stringify(wireError)).not.toContain("management reject");
      expect(Object.hasOwn(wireError, "retryAfterSeconds")).toBe(false);

      const sdkError = toError(wireError);
      expect(isVetKeysError(sdkError)).toBe(true);
      expect(sdkError).toMatchObject({ code });
      expect(Object.hasOwn(wireError, "stack")).toBe(false);
    }
  });

  test("redacts malformed closed-error payloads and backend exceptions", async () => {
    const endpoint = background();
    for (const backendFailure of [
      { err: { disabled: { private_state: "do not expose" } } },
      { err: { rate_limited: { retry_after_seconds: "01" } } },
      { err: { management_failure: "raw management reject" } },
      { err: { invented_backend_detail: null } },
    ]) {
      const { broker, endpoints } = makeBroker({
        backend: { publicKey: async () => backendFailure },
      });
      endpoints.set(endpoint.endpointId, endpoint);
      const error = await broker
        .publicKey({ slot: "mailbox", generation: "1" }, endpoint)
        .catch((caught: unknown) => caught);
      expect(serializeVetKeysActionError(error)).toEqual({
        name: "VetKeysError",
        message: "App-isolated key operation failed",
        code: "key_unavailable",
      });
    }

    const { broker, endpoints } = makeBroker({
      backend: {
        publicKey: async () => {
          throw new Error("management reject with local stack");
        },
      },
    });
    endpoints.set(endpoint.endpointId, endpoint);
    const thrown = await broker
      .publicKey({ slot: "mailbox", generation: "1" }, endpoint)
      .catch((caught: unknown) => caught);
    expect(serializeVetKeysActionError(thrown)).toEqual({
      name: "VetKeysError",
      message: "App-isolated key operation failed",
      code: "key_unavailable",
    });
  });

  test("redacts unexpected vetKeys failures to one closed error", () => {
    const wireError = serializeVetKeysActionError(
      new Error("Reject text and local stack must not cross the app boundary"),
    );
    expect(wireError).toEqual({
      name: "VetKeysError",
      message: "App-isolated key operation failed",
      code: "key_unavailable",
    });
    expect(Object.hasOwn(wireError, "stack")).toBe(false);
  });
});

type DeriveRequest = {
  slot: string;
  generation: string;
  transportPublicKey: number[];
  requestNonce: number[];
};

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
};

const BEGIN_CONTEXT = {
  delegated: false,
  agentActive: false,
} as const;

const APPROVAL_CONTEXT = {
  focused: true,
  userActivated: true,
  delegated: false,
  agentActive: false,
} as const;

function deriveRequest(
  overrides: Partial<DeriveRequest> = {},
): DeriveRequest {
  return {
    slot: "mailbox",
    generation: "1",
    transportPublicKey: new Array(48).fill(3),
    requestNonce: new Array(32).fill(4),
    ...overrides,
  };
}

function successfulDerivation(): Record<string, unknown> {
  return {
    ok: {
      encrypted_key: new Array(192).fill(5),
      public_info: rawPublicInfo(),
    },
  };
}

function captureSynchronousError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw");
}

async function beginChallenge(
  broker: VetKeysBrowserBroker,
  endpoint: RegisteredEndpoint,
  payload: DeriveRequest = deriveRequest(),
  context: { delegated: boolean; agentActive: boolean } = BEGIN_CONTEXT,
): Promise<{
  challengeId: string;
  expiresAt: string;
  completion: Promise<unknown>;
}> {
  let progress: { challengeId: string; expiresAt: string } | null = null;
  const completion = broker.begin(
    payload,
    endpoint,
    (value) => {
      progress = value as typeof progress;
    },
    context,
  );
  void completion.catch(() => undefined);
  await waitFor(() => progress !== null);
  const reported = progress as {
    challengeId: string;
    expiresAt: string;
  } | null;
  if (!reported) throw new Error("Missing vetKeys challenge progress");
  return {
    challengeId: reported.challengeId,
    expiresAt: reported.expiresAt,
    completion,
  };
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for broker progress");
}
