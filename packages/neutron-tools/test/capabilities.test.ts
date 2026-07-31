import { expect, test } from "bun:test";
import {
  BACKEND_CAPABILITY_INTERFACES,
  CAPABILITY_CATALOG,
  CAPABILITY_IDS,
  CERTIFIED_ASSETS_MAX_BATCH_BYTES,
  CERTIFIED_ASSETS_MAX_BATCH_OPERATIONS,
  CERTIFIED_ASSETS_MAX_COMMITTED_BYTES,
  CERTIFIED_ASSETS_MAX_ENTRIES,
  CERTIFIED_ASSETS_MAX_IDEMPOTENCY_RECEIPTS,
  CERTIFIED_ASSETS_MAX_OBJECT_BYTES,
  CERTIFIED_ASSETS_MAX_PENDING_STAGES,
  CERTIFIED_ASSETS_MAX_STAGED_BYTES,
  CERTIFIED_ASSETS_PORTABLE_BLOB_BODY_BYTES_MAX,
  certifiedAssetsPhysicalReservation,
  CERTIFIED_HTTP_PATH_SEGMENTS_MAX_V2,
  PUBLIC_INGRESS_MAX_CALLS_PER_ROUTE_PER_HOUR,
  PUBLIC_INGRESS_MAX_REQUEST_BYTES,
  PUBLIC_INGRESS_MAX_REQUIRED_CYCLES,
  PUBLIC_INGRESS_MAX_ROUTES_PER_APP,
  publicIngressResourceId,
} from "../src/capabilities/catalog.ts";
import {
  buildCapabilityPlan,
  type CapabilityPlan,
} from "../src/capabilities/plan.ts";
import {
  assertCapabilityPlanFingerprint,
  diffCapabilityPlans,
  fingerprintCapabilityPlanWireV1,
  getCapabilityPlanEntry,
  parseCapabilityPlanWireV1,
  projectCapabilityInstallDisclosures,
  projectCapabilitySettingsWireV1,
  serializeCapabilityPlanWireV1,
  toCapabilityPlanWireV1,
  verifyCapabilityPlanFingerprint,
} from "../src/capabilities/wire.ts";
import { projectRuntimeCapabilityRegistrationsV1 } from "../src/capabilities/runtime.ts";
import type {
  NeutronManifest,
  NeutronHttpPostUpdateHandlerRouteMountConfig,
} from "../src/schema.ts";

function kitchenSinkManifest(): NeutronManifest {
  return {
    format: 3,
    id: "capability_test",
    name: "Capability Test",
    version: 106,
    background: { path: "service.html" },
    tray: {
      title: "Capability Test",
      path: "tray.html",
      icon: "static/tray.svg",
    },
    tiles: [
      { id: "secondary", title: "Secondary", path: "second.html" },
      { id: "main", title: "Main", path: "index.html" },
    ],
    memory: {
      retired: {
        version: 1,
        schemas: { "1": { src: "memory/retired.mo" } },
        migrations: [],
        retired: true,
      },
      state: {
        version: 2,
        schemas: {
          "1": { src: "memory/state_v1.mo" },
          "2": { src: "memory/state_v2.mo" },
        },
        migrations: [],
      },
    },
    dependencies: {
      contacts: {
        app: "contacts",
        min_version: 101,
        functions: ["contacts_write", "contacts_read"],
      },
    },
    backend: {
      capabilities: {
        vetkeys_public: { api: 1 },
        randomness: { api: 1 },
        chain_key_signing: { api: 1 },
        stable_store: { api: 1 },
        https_outcalls: { api: 1 },
        backend_calls: { api: 1 },
        certified_assets: { api: 2 },
      },
    },
    func: {
      public_status: {
        type: "query",
        async: false,
      },
      public_submit: { type: "update", async: false },
      app_export: {
        type: "internal",
        expose: "apps",
      },
      receive_webhook: { type: "internal", async: false },
      self_update: { type: "update", arg: ["caller"] },
      task_tick: { type: "internal", arg: ["task_capabilities"] },
    },
    capabilities: {
      backend_calls: {
        api: 1,
        description: "Call approved peers",
        reservation_scopes: ["principal", "exact", "method"],
        install_reservations: [
          { kind: "method", method: "app_capability_test__peer_update" },
        ],
        max_concurrency: 4,
        max_cycles_per_call: 10_000,
        max_cycles_per_day: 100_000,
      },
      randomness: {
        api: 1,
      },
      chain_key_signing: {
        api: 1,
        slots: [
          {
            id: "z_receipts",
            algorithm: "schnorr_ed25519",
            purpose: "Sign receipt assertions",
            max_assertion_bytes: 4096,
          },
          {
            id: "a_identity",
            algorithm: "ecdsa_secp256k1",
            purpose: "Sign identity assertions",
            max_assertion_bytes: 1024,
          },
        ],
      },
      stable_store: {
        api: 1,
        stores: [
          {
            id: "z_cache",
            purpose: "Cache opaque results",
            schema_version: 2,
            max_entries: 32,
            max_key_bytes: 64,
            max_value_bytes: 4096,
            max_bytes: 65_536,
          },
          {
            id: "a_notes",
            purpose: "Keep durable notes",
            schema_version: 1,
            max_entries: 16,
            max_key_bytes: 32,
            max_value_bytes: 2048,
            max_bytes: 32_768,
          },
        ],
      },
      https_outcalls: {
        api: 1,
        endpoints: [
          {
            id: "example",
            url_prefix: "https://example.com/v1/",
            methods: ["post", "get"],
            request_headers: ["authorization", "accept"],
            max_request_bytes: 65_536,
            max_response_bytes: 32_768,
            transform: "strip_headers",
          },
        ],
      },
      vetkeys: {
        api: 1,
        description: "Recover private state",
        slots: [
          { id: "z_slot", purpose: "Second slot" },
          { id: "a_slot", purpose: "First slot" },
        ],
      },
      scheduled_tasks: {
        api: 1,
        tasks: [
          {
            id: "refresh",
            method: "task_tick",
            interval_seconds: 3_600,
            run_on_start: false,
            max_backend_calls: 2,
          },
        ],
      },
      preapproved_self_calls: {
        api: 1,
        methods: ["self_update"],
      },
      agent_entrypoints: {
        api: 1,
        entrypoints: ["tools.search", "tools.read"],
      },
      background_ui_requests: {
        api: 1,
        categories: ["signed_canister_call", "frontend_tool"],
      },
      ethereum_provider: {
        api: 1,
        chains: [10, 1],
        methods: ["eth_requestAccounts", "eth_chainId"],
      },
      connections: {
        api: 1,
        providers: [
          {
            provider: "openrouter",
            scopes: ["models:read", "chat:write"],
          },
        ],
      },
      persistent_browser_storage: { api: 1, surface: "background" },
      public_ingress: {
        api: 1,
        routes: [
          {
            protocol: "demo_v1",
            id: "submit",
            handler: "public_submit",
            mode: "update",
            caller: "canister",
            max_request_bytes: 4096,
            max_response_bytes: 2048,
            max_calls_per_hour: 60,
            required_cycles: 5_000_000,
          },
          {
            protocol: "demo_v1",
            id: "status",
            handler: "public_status",
            mode: "query",
            caller: "any",
            max_request_bytes: 16,
            max_response_bytes: 1024,
          },
        ],
      },
      http_routes: {
        api: 1,
        mounts: [
          {
            id: "webhook",
            surface: "shared_app_path",
            methods: ["POST"],
            mode: "http_post_update_handler",
            handler: "receive_webhook",
            max_request_bytes: 32_768,
            max_response_bytes: 8_192,
            max_calls_per_hour: 120,
            forward_headers: ["x-signature", "content-type"],
          },
        ],
      },
      certified_assets: {
        api: 2,
        max_entries: 128,
        max_committed_bytes: 4_194_304,
        max_object_bytes: 1_048_576,
        max_pending_stages: 1,
        max_staged_bytes: 1_048_576,
        max_batch_operations: 16,
        max_batch_bytes: 1_048_576,
        max_idempotency_receipts: 1024,
        collections: [
          {
            id: "status",
            mount: "protocol",
            exact_path: "/current",
            kind: "mutable_blob",
            max_object_bytes: 65_536,
          },
          {
            id: "reports",
            mount: "protocol",
            path_prefix: "/items/sha256/",
            kind: "immutable_blob",
          },
          {
            id: "shares",
            mount: "shares",
            kind: "publication",
          },
        ],
      },
    },
  };
}

function updateRouteManifest(): NeutronManifest {
  return {
    format: 3,
    id: "webhook_app",
    name: "Webhook App",
    version: 100,
    func: {
      receive_webhook: { type: "internal", async: false },
    },
    capabilities: {
      http_routes: {
        api: 1,
        mounts: [
          {
            id: "webhook",
            surface: "app_host",
            prefix: "/api/webhook",
            methods: ["POST"],
            mode: "http_post_update_handler",
            handler: "receive_webhook",
            max_request_bytes: 32_768,
            max_response_bytes: 8_192,
            max_calls_per_hour: 120,
            forward_headers: ["x-signature", "authorization", "content-type"],
          },
        ],
      },
    },
  };
}

function publicIngressManifest(): NeutronManifest {
  return {
    format: 3,
    id: "protocol_app",
    name: "Protocol App",
    version: 100,
    func: {
      probe: { type: "query", async: false },
      deliver: { type: "update", async: false },
    },
    capabilities: {
      public_ingress: {
        api: 1,
        routes: [
          {
            protocol: "mail_v1",
            id: "deliver",
            handler: "deliver",
            mode: "update",
            caller: "canister",
            max_request_bytes: 1_048_576,
            max_response_bytes: 65_536,
            max_calls_per_hour: 3_600,
            required_cycles: 25_000_000,
          },
          {
            protocol: "mail_v1",
            id: "probe",
            handler: "probe",
            mode: "query",
            caller: "any",
            max_request_bytes: 1,
            max_response_bytes: 4096,
          },
        ],
      },
    },
  };
}

function genericCertifiedAssetsManifest(): NeutronManifest {
  return {
    format: 3,
    id: "certified_plan",
    name: "Certified Plan",
    version: 100,
    backend: {
      capabilities: {
        certified_assets: { api: 2 },
      },
    },
    func: {
      receive_webhook: { type: "internal", async: false },
    },
    capabilities: {
      http_routes: {
        api: 1,
        mounts: [
          {
            id: "webhook",
            surface: "shared_app_path",
            methods: ["POST"],
            mode: "http_post_update_handler",
            handler: "receive_webhook",
            max_request_bytes: 32_768,
            max_response_bytes: 8_192,
            max_calls_per_hour: 120,
            forward_headers: ["content-type"],
          },
        ],
      },
      certified_assets: {
        api: 2,
        max_entries: 128,
        max_committed_bytes: 4_194_304,
        max_object_bytes: 1_048_576,
        max_pending_stages: 1,
        max_staged_bytes: 1_048_576,
        max_batch_operations: 16,
        max_batch_bytes: 1_048_576,
        max_idempotency_receipts: 1024,
        collections: [
          {
            id: "status",
            mount: "protocol",
            exact_path: "/current",
            kind: "mutable_blob",
            max_object_bytes: 65_536,
          },
          {
            id: "reports",
            mount: "protocol",
            path_prefix: "/items/sha256/",
            kind: "immutable_blob",
          },
          {
            id: "shares",
            mount: "shares",
            kind: "publication",
          },
        ],
      },
    },
  };
}

test("catalogue is closed, complete, versioned, and owns presentation policy", () => {
  expect(Object.keys(CAPABILITY_CATALOG).sort()).toEqual(
    [...CAPABILITY_IDS].sort(),
  );
  for (const id of CAPABILITY_IDS) {
    const entry = CAPABILITY_CATALOG[id];
    expect(entry.id).toBe(id);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.delivery)).toBe(true);
    expect(entry.api).toEqual(
      id === "certified_assets" ? [2] : [1],
    );
    expect(entry.title.length).toBeGreaterThan(0);
    expect(entry.summary.length).toBeGreaterThan(0);
    expect(entry.delivery.length).toBeGreaterThan(0);
    expect(entry.namespace).toBe("app_installation");
    expect(entry.authored !== undefined).toBe(entry.provenance === "declared");
    expect(entry.reconciliation).toEqual({
      commit: "activate_staged",
      abort: "discard_staged",
      removal: "revoke_or_remove",
      uninstall: "purge_scope",
    });
  }
  for (const definition of Object.values(BACKEND_CAPABILITY_INTERFACES)) {
    if (definition.declaration === null) continue;
    expect(
      CAPABILITY_CATALOG[definition.declaration].delivery,
    ).toContain("backend_environment");
  }
});

test("buildCapabilityPlan produces one exact declared and derived inventory", () => {
  const plan = buildCapabilityPlan(kitchenSinkManifest());
  expect(plan.version).toBe(1);
  expect(plan.app).toEqual({ id: "capability_test", version: 106 });
  expect(plan.entries.map(({ id }) => id)).toEqual(
    CAPABILITY_IDS.filter((id) => id !== "dedicated_resident_origin"),
  );

  expect(getCapabilityPlanEntry(plan, "backend_calls")?.config).toEqual({
    api: 1,
    description: "Call approved peers",
    reservation_scopes: ["exact", "method", "principal"],
    install_reservations: [
      { kind: "method", method: "app_capability_test__peer_update" },
    ],
    max_concurrency: 4,
    max_cycles_per_call: 10_000,
    max_cycles_per_day: 100_000,
  });
  expect(getCapabilityPlanEntry(plan, "randomness")?.config).toEqual({
    api: 1,
  });
  expect(getCapabilityPlanEntry(plan, "chain_key_signing")?.config).toEqual({
    api: 1,
    slots: [
      {
        id: "a_identity",
        algorithm: "ecdsa_secp256k1",
        purpose: "Sign identity assertions",
        max_assertion_bytes: 1024,
      },
      {
        id: "z_receipts",
        algorithm: "schnorr_ed25519",
        purpose: "Sign receipt assertions",
        max_assertion_bytes: 4096,
      },
    ],
  });
  expect(getCapabilityPlanEntry(plan, "stable_store")?.config).toEqual({
    api: 1,
    stores: [
      {
        id: "a_notes",
        purpose: "Keep durable notes",
        schema_version: 1,
        max_entries: 16,
        max_key_bytes: 32,
        max_value_bytes: 2048,
        max_bytes: 32_768,
      },
      {
        id: "z_cache",
        purpose: "Cache opaque results",
        schema_version: 2,
        max_entries: 32,
        max_key_bytes: 64,
        max_value_bytes: 4096,
        max_bytes: 65_536,
      },
    ],
  });
  expect(getCapabilityPlanEntry(plan, "https_outcalls")?.config).toEqual({
    api: 1,
    endpoints: [
      {
        id: "example",
        url_prefix: "https://example.com/v1/",
        methods: ["get", "post"],
        request_headers: ["accept", "authorization"],
        max_request_bytes: 65_536,
        max_response_bytes: 32_768,
        transform: "strip_headers",
      },
    ],
  });
  expect(getCapabilityPlanEntry(plan, "stable_memory")?.config).toEqual({
    resources: [{ id: "state", version: 2 }],
  });
  expect(getCapabilityPlanEntry(plan, "memory_lifecycle")?.config).toEqual({
    retirements: [{ id: "retired" }],
    consumptions: [],
  });
  expect(getCapabilityPlanEntry(plan, "app_calls")?.config).toEqual({
    dependencies: [
      {
        alias: "contacts",
        app: "contacts",
        min_version: 101,
        methods: ["contacts_read", "contacts_write"],
      },
    ],
  });
  expect(getCapabilityPlanEntry(plan, "backend_environment")?.config).toEqual({
    interfaces: [
      { id: "backend_calls", api: 1 },
      { id: "certified_assets", api: 2 },
      { id: "chain_key_signing", api: 1 },
      { id: "https_outcalls", api: 1 },
      { id: "randomness", api: 1 },
      { id: "stable_store", api: 1 },
      { id: "vetkeys_public", api: 1 },
    ],
  });
  expect(getCapabilityPlanEntry(plan, "http_routes")?.config).toEqual({
    api: 1,
    mounts: [
      {
        id: "webhook",
        surface: "shared_app_path",
        methods: ["POST"],
        mode: "http_post_update_handler",
        handler: "receive_webhook",
        max_request_bytes: 32_768,
        max_response_bytes: 8_192,
        max_calls_per_hour: 120,
        forward_headers: ["content-type", "x-signature"],
      },
    ],
  });
  expect(getCapabilityPlanEntry(plan, "certified_assets")?.config).toEqual({
    api: 2,
    max_entries: 128,
    max_committed_bytes: 4_194_304,
    max_object_bytes: 1_048_576,
    max_pending_stages: 1,
    max_staged_bytes: 1_048_576,
    max_batch_operations: 16,
    max_batch_bytes: 1_048_576,
    max_idempotency_receipts: 1024,
    collections: [
      {
        id: "reports",
        mount: "protocol",
        kind: "immutable_blob",
        path_prefix: "/items/sha256/",
      },
      {
        id: "shares",
        mount: "shares",
        kind: "publication",
      },
      {
        id: "status",
        mount: "protocol",
        kind: "mutable_blob",
        exact_path: "/current",
        max_object_bytes: 65_536,
      },
    ],
  });
  expect(
    certifiedAssetsPhysicalReservation(
      getCapabilityPlanEntry(plan, "certified_assets")!.config,
      plan.app.id,
    ),
  ).toEqual({
    arenaBytes: 9_480_384n,
    arenaExtents: 160n,
    chargedBytes: 12_417_621n,
  });
  // Exact cross-language fixture mirrored by the Motoko service test.
  expect(
    certifiedAssetsPhysicalReservation(
      {
        api: 2,
        max_entries: 32,
        max_committed_bytes: 65_536,
        max_object_bytes: 4_096,
        max_pending_stages: 1,
        max_staged_bytes: 4_096,
        max_batch_operations: 4,
        max_batch_bytes: 16_384,
        max_idempotency_receipts: 64,
        collections: [
          {
            id: "immutable",
            mount: "objects",
            kind: "immutable_blob",
            path_prefix: "/immutable/",
            max_object_bytes: 4_096,
          },
          {
            id: "mutable_exact",
            mount: "records",
            kind: "mutable_blob",
            exact_path: "/current",
            max_object_bytes: 4_096,
          },
          {
            id: "mutable_key",
            mount: "records",
            kind: "mutable_blob",
            path_prefix: "/key/",
            max_object_bytes: 4_096,
          },
          {
            id: "publication",
            mount: "downloads",
            kind: "publication",
            max_object_bytes: 4_096,
          },
        ],
      },
      "sample",
    ),
  ).toEqual({
    arenaBytes: 161_496n,
    arenaExtents: 52n,
    chargedBytes: 756_649n,
  });
  expect(getCapabilityPlanEntry(plan, "certified_read_routes")?.config).toEqual({
    mounts: [
      {
        id: "protocol",
        surface: "shared_app_path",
        authority_mode: "canister_gateway_v1",
        methods: ["GET"],
        mode: "certified_store",
        store: "certified_assets",
        max_request_bytes: 0,
      },
      {
        id: "shares",
        surface: "shared_app_path",
        authority_mode: "exact_neutron_host_v1",
        methods: ["GET", "HEAD"],
        mode: "certified_store",
        store: "certified_assets",
        max_request_bytes: 0,
      },
    ],
  });
  expect(getCapabilityPlanEntry(plan, "function_resources")?.config).toEqual({
    functions: [
      {
        method: "self_update",
        mode: "update",
        resources: [{ kind: "caller" }],
      },
      {
        method: "task_tick",
        mode: "internal",
        resources: [
          {
            kind: "task_capabilities",
            interfaces: [{ id: "backend_calls", api: 1 }],
          },
        ],
      },
    ],
  });
  expect(getCapabilityPlanEntry(plan, "public_ingress")?.config).toEqual({
    api: 1,
    routes: [
      {
        protocol: "demo_v1",
        id: "status",
        handler: "public_status",
        mode: "query",
        caller: "any",
        max_request_bytes: 16,
        max_response_bytes: 1024,
      },
      {
        protocol: "demo_v1",
        id: "submit",
        handler: "public_submit",
        mode: "update",
        caller: "canister",
        max_request_bytes: 4096,
        max_response_bytes: 2048,
        max_calls_per_hour: 60,
        required_cycles: 5_000_000,
      },
    ],
  });
  expect(getCapabilityPlanEntry(plan, "app_exports")?.config).toEqual({
    methods: [{ method: "app_export", mode: "update" }],
  });
  expect(getCapabilityPlanEntry(plan, "tile_endpoints")?.config).toEqual({
    endpoints: [
      { id: "main", path: "index.html" },
      { id: "secondary", path: "second.html" },
    ],
  });
  expect(
    getCapabilityPlanEntry(plan, "preapproved_self_calls")?.config,
  ).toEqual({
    api: 1,
    methods: [{ method: "self_update", mode: "update" }],
  });
});

test("API-2 self-call declarations and wire plans are rejected", () => {
  const manifest = {
    format: 3,
    id: "attachment_calls",
    name: "Attachment Calls",
    version: 100,
    func: {
      write_body: { type: "update" },
    },
    capabilities: {
      preapproved_self_calls: {
        api: 2,
        methods: [
          {
            method: "write_body",
            mode: "update",
            attachments: {
              input: { max_bytes: 1_900_000 },
              output: "none",
            },
          },
        ],
      },
    },
  };

  expect(() =>
    buildCapabilityPlan(manifest as unknown as NeutronManifest),
  ).toThrow(/Unsupported preapproved_self_calls capability API/);

  const api1Wire = toCapabilityPlanWireV1(buildCapabilityPlan(kitchenSinkManifest()));
  const selfCallEntry = getCapabilityPlanEntry(
    api1Wire,
    "preapproved_self_calls",
  )!;
  const api2Wire = structuredClone(api1Wire);
  api2Wire.entries = api2Wire.entries.map((entry) =>
    entry.id === "preapproved_self_calls"
      ? ({ ...selfCallEntry, api: 2, config: { ...selfCallEntry.config, api: 2 } } as any)
      : entry,
  );
  expect(() => parseCapabilityPlanWireV1(api2Wire)).toThrow(
    /Invalid preapproved_self_calls plan config/,
  );
});

test("resident frame security is explicit and dedicated modes are exclusive", () => {
  const base: NeutronManifest = {
    format: 3,
    id: "resident_mode",
    name: "Resident Mode",
    version: 100,
    background: { path: "service.html" },
  };
  const opaque = toCapabilityPlanWireV1(buildCapabilityPlan(base));
  expect(
    getCapabilityPlanEntry(opaque, "background_endpoint")?.config,
  ).toEqual({
    path: "service.html",
    frame_security: "credentialless_opaque_v1",
  });

  const persistent = structuredClone(base);
  persistent.capabilities = {
    persistent_browser_storage: { api: 1, surface: "background" },
  };
  const persistentWire = toCapabilityPlanWireV1(
    buildCapabilityPlan(persistent),
  );
  expect(
    getCapabilityPlanEntry(persistentWire, "background_endpoint")?.config
      .frame_security,
  ).toBe("persistent_dedicated_v1");

  const ephemeral = structuredClone(base);
  ephemeral.capabilities = {
    dedicated_resident_origin: {
      api: 1,
      surface: "background",
      mode: "credentialless_ephemeral_v1",
    },
  };
  const ephemeralWire = toCapabilityPlanWireV1(buildCapabilityPlan(ephemeral));
  expect(
    getCapabilityPlanEntry(ephemeralWire, "background_endpoint")?.config
      .frame_security,
  ).toBe("credentialless_ephemeral_dedicated_v1");
  expect(fingerprintCapabilityPlanWireV1(ephemeralWire)).not.toBe(
    fingerprintCapabilityPlanWireV1(persistentWire),
  );

  const both = structuredClone(ephemeral) as any;
  both.capabilities.persistent_browser_storage = {
    api: 1,
    surface: "background",
  };
  expect(() => buildCapabilityPlan(both)).toThrow(/mutually exclusive/);

  const noBackground = structuredClone(ephemeral);
  delete noBackground.background;
  expect(() => buildCapabilityPlan(noBackground)).toThrow(
    /dedicated_resident_origin/,
  );

  const forged = structuredClone(ephemeralWire) as any;
  forged.entries.find(
    ({ id }: { id: string }) => id === "background_endpoint",
  ).config.frame_security = "persistent_dedicated_v1";
  expect(() => parseCapabilityPlanWireV1(forged)).toThrow(
    /inconsistent with resident capabilities/,
  );
});

test("public ingress is closed, bounded, handler-bound, and wire-stable", () => {
  const manifest = publicIngressManifest();
  const plan = buildCapabilityPlan(manifest);
  expect(getCapabilityPlanEntry(plan, "public_ingress")?.config).toEqual({
    api: 1,
    routes: [
      {
        protocol: "mail_v1",
        id: "deliver",
        handler: "deliver",
        mode: "update",
        caller: "canister",
        max_request_bytes: 1_048_576,
        max_response_bytes: 65_536,
        max_calls_per_hour: 3_600,
        required_cycles: 25_000_000,
      },
      {
        protocol: "mail_v1",
        id: "probe",
        handler: "probe",
        mode: "query",
        caller: "any",
        max_request_bytes: 1,
        max_response_bytes: 4096,
      },
    ],
  });
  expect(publicIngressResourceId("mail_v1", "deliver")).toBe(
    "mail_v1:deliver",
  );
  const wire = toCapabilityPlanWireV1(plan);
  expect(parseCapabilityPlanWireV1(structuredClone(wire))).toEqual(wire);

  const callerBound = structuredClone(manifest) as any;
  callerBound.capabilities.public_ingress.routes[0]
    .max_calls_per_caller_per_hour = 120;
  const callerBoundPlan = buildCapabilityPlan(callerBound);
  expect(
    getCapabilityPlanEntry(callerBoundPlan, "public_ingress")?.config.routes[0],
  ).toMatchObject({ max_calls_per_caller_per_hour: 120 });
  const ingressFingerprint = (candidate: ReturnType<typeof buildCapabilityPlan>) =>
    projectRuntimeCapabilityRegistrationsV1(candidate).find(
      (registration) =>
        registration.kind === "public_ingress" &&
        registration.resource_id === "mail_v1:deliver",
    )?.declaration_fingerprint;
  expect(ingressFingerprint(callerBoundPlan)).not.toBe(ingressFingerprint(plan));

  const scopedCycles = structuredClone(manifest);
  scopedCycles.func!.deliver!.arg = [
    "caller",
    "public_ingress_cycles",
  ];
  const scopedCyclesWire = toCapabilityPlanWireV1(
    buildCapabilityPlan(scopedCycles),
  );
  expect(
    getCapabilityPlanEntry(scopedCyclesWire, "function_resources")?.config,
  ).toEqual({
    functions: [
      {
        method: "deliver",
        mode: "update",
        resources: [
          { kind: "caller" },
          { kind: "public_ingress_cycles" },
        ],
      },
    ],
  });
  expect(parseCapabilityPlanWireV1(structuredClone(scopedCyclesWire))).toEqual(
    scopedCyclesWire,
  );

  const queryRate = structuredClone(manifest) as any;
  queryRate.capabilities.public_ingress.routes[1].max_calls_per_hour = 1;
  expect(() => buildCapabilityPlan(queryRate)).toThrow(
    /Unknown public_ingress route field max_calls_per_hour/,
  );

  const queryCallerRate = structuredClone(manifest) as any;
  queryCallerRate.capabilities.public_ingress.routes[1]
    .max_calls_per_caller_per_hour = 1;
  expect(() => buildCapabilityPlan(queryCallerRate)).toThrow(
    /Unknown public_ingress route field max_calls_per_caller_per_hour/,
  );

  const excessiveCallerRate = structuredClone(manifest) as any;
  excessiveCallerRate.capabilities.public_ingress.routes[0]
    .max_calls_per_caller_per_hour = 3_601;
  expect(() => buildCapabilityPlan(excessiveCallerRate)).toThrow(
    /Invalid public_ingress update caller rate/,
  );

  const zeroCallerRate = structuredClone(manifest) as any;
  zeroCallerRate.capabilities.public_ingress.routes[0]
    .max_calls_per_caller_per_hour = 0;
  expect(() => buildCapabilityPlan(zeroCallerRate)).toThrow(
    /Invalid public_ingress update caller rate/,
  );

  const missingUpdateRate = structuredClone(manifest) as any;
  delete missingUpdateRate.capabilities.public_ingress.routes[0]
    .max_calls_per_hour;
  expect(() => buildCapabilityPlan(missingUpdateRate)).toThrow(
    /Invalid public_ingress update rate/,
  );

  const missingRequiredCycles = structuredClone(manifest) as any;
  delete missingRequiredCycles.capabilities.public_ingress.routes[0]
    .required_cycles;
  expect(() => buildCapabilityPlan(missingRequiredCycles)).toThrow(
    /Invalid public_ingress required cycles/,
  );

  const invalidRequiredCycles = structuredClone(manifest) as any;
  invalidRequiredCycles.capabilities.public_ingress.routes[0].required_cycles =
    PUBLIC_INGRESS_MAX_REQUIRED_CYCLES + 1;
  expect(() => buildCapabilityPlan(invalidRequiredCycles)).toThrow(
    /Invalid public_ingress required cycles/,
  );

  const authenticatedUpdate = structuredClone(manifest) as any;
  authenticatedUpdate.capabilities.public_ingress.routes[0].caller =
    "authenticated";
  delete authenticatedUpdate.capabilities.public_ingress.routes[0]
    .required_cycles;
  expect(
    getCapabilityPlanEntry(
      buildCapabilityPlan(authenticatedUpdate),
      "public_ingress",
    )?.config.routes[0],
  ).toEqual({
    protocol: "mail_v1",
    id: "deliver",
    handler: "deliver",
    mode: "update",
    caller: "authenticated",
    max_request_bytes: 1_048_576,
    max_response_bytes: 65_536,
    max_calls_per_hour: 3_600,
  });

  const paidAuthenticatedUpdate = structuredClone(manifest) as any;
  paidAuthenticatedUpdate.capabilities.public_ingress.routes[0].caller =
    "authenticated";
  expect(() => buildCapabilityPlan(paidAuthenticatedUpdate)).toThrow(
    /Unknown public_ingress route field required_cycles/,
  );

  const invalidCaller = structuredClone(manifest) as any;
  invalidCaller.capabilities.public_ingress.routes[0].caller = "any";
  delete invalidCaller.capabilities.public_ingress.routes[0].required_cycles;
  expect(() => buildCapabilityPlan(invalidCaller)).toThrow(
    /Invalid public_ingress update caller/,
  );

  const queryRequiredCycles = structuredClone(manifest) as any;
  queryRequiredCycles.capabilities.public_ingress.routes[1].required_cycles = 1;
  expect(() => buildCapabilityPlan(queryRequiredCycles)).toThrow(
    /Unknown public_ingress route field required_cycles/,
  );

  const oversizedRequest = structuredClone(manifest) as any;
  oversizedRequest.capabilities.public_ingress.routes[1].max_request_bytes =
    PUBLIC_INGRESS_MAX_REQUEST_BYTES + 1;
  expect(() => buildCapabilityPlan(oversizedRequest)).toThrow(
    /Invalid public_ingress route/,
  );

  const excessiveRate = structuredClone(manifest) as any;
  excessiveRate.capabilities.public_ingress.routes[0].max_calls_per_hour =
    PUBLIC_INGRESS_MAX_CALLS_PER_ROUTE_PER_HOUR + 1;
  expect(() => buildCapabilityPlan(excessiveRate)).toThrow(
    /Invalid public_ingress update rate/,
  );

  const excessiveAppRate = structuredClone(manifest) as any;
  excessiveAppRate.capabilities.public_ingress.routes.push({
    ...structuredClone(
      excessiveAppRate.capabilities.public_ingress.routes[0],
    ),
    id: "deliver_again",
    max_calls_per_hour: 1,
  });
  expect(() => buildCapabilityPlan(excessiveAppRate)).toThrow(
    /declare 3601 calls per hour; per-app maximum is 3600/,
  );

  const longResource = structuredClone(manifest) as any;
  longResource.capabilities.public_ingress.routes[0].protocol = "p".repeat(32);
  longResource.capabilities.public_ingress.routes[0].id = "r".repeat(32);
  expect(() => buildCapabilityPlan(longResource)).toThrow(
    /Invalid public_ingress protocol or route id/,
  );

  const duplicate = structuredClone(manifest) as any;
  duplicate.capabilities.public_ingress.routes.push(
    structuredClone(duplicate.capabilities.public_ingress.routes[0]),
  );
  expect(() => buildCapabilityPlan(duplicate)).toThrow(
    /Duplicate public_ingress route mail_v1:deliver/,
  );

  const tooMany = structuredClone(manifest) as any;
  const query = tooMany.capabilities.public_ingress.routes[1];
  tooMany.capabilities.public_ingress.routes = Array.from(
    { length: PUBLIC_INGRESS_MAX_ROUTES_PER_APP + 1 },
    (_, index) => ({ ...query, id: `route_${index}` }),
  );
  expect(() => buildCapabilityPlan(tooMany)).toThrow(
    /Invalid public_ingress routes/,
  );

  for (const [mutate, message] of [
    [
      (candidate: any) => {
        candidate.capabilities.public_ingress.routes[1].handler = "missing";
      },
      /must name a synchronous ordinary query/,
    ],
    [
      (candidate: any) => {
        candidate.func.probe.type = "update";
      },
      /must name a synchronous ordinary query/,
    ],
    [
      (candidate: any) => {
        candidate.func.probe.async = true;
      },
      /must name a synchronous ordinary query/,
    ],
    [
      (candidate: any) => {
        candidate.func.probe.type = "internal";
      },
      /must name a synchronous ordinary query/,
    ],
  ] as const) {
    const candidate = structuredClone(manifest) as any;
    mutate(candidate);
    expect(() => buildCapabilityPlan(candidate)).toThrow(message);
  }

  const kernel = structuredClone(manifest) as any;
  kernel.id = "kernel";
  expect(() => buildCapabilityPlan(kernel)).toThrow(
    /Kernel cannot declare ordinary app capabilities/,
  );
});

test("kernel plan does not invent an ordinary app tile endpoint", () => {
  const plan = buildCapabilityPlan({
    format: 3,
    id: "kernel",
    name: "Neutron",
    version: 100,
  });
  expect(plan.entries.some(({ id }) => id === "tile_endpoints")).toBe(false);

  for (const capabilities of [
    { randomness: { api: 1 } },
    {
      backend_calls: {
        api: 1,
        description: "Ignored install defaults",
        reservation_scopes: ["method"],
        install_reservations: [{ kind: "method", method: "ignored" }],
        max_concurrency: 1,
        max_cycles_per_call: 0,
        max_cycles_per_day: 0,
      },
    },
  ]) {
    expect(() =>
      buildCapabilityPlan({
        format: 3,
        id: "kernel",
        name: "Neutron",
        version: 100,
        capabilities,
      } as NeutronManifest),
    ).toThrow("Kernel cannot declare ordinary app capabilities");
  }
  expect(() =>
    buildCapabilityPlan({
      format: 3,
      id: "kernel",
      name: "Neutron",
      version: 100,
      backend: { capabilities: { randomness: { api: 1 } } },
    }),
  ).toThrow(
    "Kernel cannot declare an app backend environment",
  );
});

test("plan building fails closed on stale shapes and dangling method references", () => {
  const base = kitchenSinkManifest();
  for (const format of [undefined, 1, 2]) {
    expect(() =>
      buildCapabilityPlan({ ...base, format } as unknown as NeutronManifest),
    ).toThrow(/Unsupported package format/);
  }
  expect(() =>
    buildCapabilityPlan({
      ...base,
      connections: [],
    } as unknown as NeutronManifest),
  ).toThrow(/Top-level connections/);
  expect(() =>
    buildCapabilityPlan({
      ...base,
      background: { path: "service.html", storage: "persistent" },
    } as unknown as NeutronManifest),
  ).toThrow(/background.storage/);
  expect(() =>
    buildCapabilityPlan({
      ...base,
      init_arg: ["app_capabilities"],
    } as unknown as NeutronManifest),
  ).toThrow(/cannot declare init_arg/);

  const undeclaredBackend = kitchenSinkManifest();
  undeclaredBackend.backend!.capabilities = { randomness: { api: 1 } };
  delete undeclaredBackend.capabilities!.randomness;
  expect(() => buildCapabilityPlan(undeclaredBackend)).toThrow(
    /requires capabilities.randomness/,
  );

  const danglingSelf = kitchenSinkManifest();
  danglingSelf.capabilities!.preapproved_self_calls!.methods = ["missing"];
  expect(() => buildCapabilityPlan(danglingSelf)).toThrow(
    /must name an owner-authorized query or update/,
  );
  const publicTask = kitchenSinkManifest();
  publicTask.capabilities!.scheduled_tasks!.tasks[0]!.method = "self_update";
  expect(() => buildCapabilityPlan(publicTask)).toThrow(
    /must name an internal manifest function/,
  );
  const rawModule = kitchenSinkManifest();
  rawModule.func!.self_update!.arg = ["module_kernel"];
  expect(() => buildCapabilityPlan(rawModule)).toThrow(/raw module references/);
  const foreignMemory = kitchenSinkManifest();
  foreignMemory.func!.self_update!.arg = ["memory_foreign"];
  expect(() => buildCapabilityPlan(foreignMemory)).toThrow(/foreign memory/);
  const staleTaskResource = kitchenSinkManifest();
  staleTaskResource.func!.task_tick!.arg = ["scheduled_backend_calls"];
  expect(() => buildCapabilityPlan(staleTaskResource)).toThrow(
    /unknown function resource/,
  );
});

test("certified assets are generic, bounded, canonical, and derive read routes", () => {
  const manifest = genericCertifiedAssetsManifest();
  const wire = toCapabilityPlanWireV1(buildCapabilityPlan(manifest));
  expect(
    getCapabilityPlanEntry(wire, "certified_assets")?.config.collections,
  ).toEqual([
    {
      id: "reports",
      mount: "protocol",
      kind: "immutable_blob",
      path_prefix: "/items/sha256/",
    },
    {
      id: "shares",
      mount: "shares",
      kind: "publication",
    },
    {
      id: "status",
      mount: "protocol",
      kind: "mutable_blob",
      exact_path: "/current",
      max_object_bytes: 65_536,
    },
  ]);
  expect(getCapabilityPlanEntry(wire, "certified_read_routes")?.config).toEqual({
    mounts: [
      {
        id: "protocol",
        surface: "shared_app_path",
        authority_mode: "canister_gateway_v1",
        methods: ["GET"],
        mode: "certified_store",
        store: "certified_assets",
        max_request_bytes: 0,
      },
      {
        id: "shares",
        surface: "shared_app_path",
        authority_mode: "exact_neutron_host_v1",
        methods: ["GET", "HEAD"],
        mode: "certified_store",
        store: "certified_assets",
        max_request_bytes: 0,
      },
    ],
  });
  expect(fingerprintCapabilityPlanWireV1(wire)).toMatch(/^[a-f0-9]{64}$/u);

  const reordered = genericCertifiedAssetsManifest();
  reordered.capabilities!.certified_assets!.collections.reverse();
  expect(
    toCapabilityPlanWireV1(buildCapabilityPlan(reordered)),
  ).toEqual(wire);

  const missingBackendSelector = genericCertifiedAssetsManifest();
  delete missingBackendSelector.backend;
  expect(() => buildCapabilityPlan(missingBackendSelector)).toThrow(
    /certified_assets API 2 requires backend\.capabilities\.certified_assets API 2/,
  );

  const noPostRoutes = genericCertifiedAssetsManifest();
  delete noPostRoutes.capabilities!.http_routes;
  expect(
    getCapabilityPlanEntry(
      buildCapabilityPlan(noPostRoutes),
      "certified_read_routes",
    )?.config,
  ).toEqual(getCapabilityPlanEntry(wire, "certified_read_routes")?.config);

  const forgedReadPolicy = structuredClone(wire) as any;
  const forgedMount = forgedReadPolicy.entries
    .find(({ id }: { id: string }) => id === "certified_read_routes")
    .config.mounts.find(({ id }: { id: string }) => id === "protocol");
  forgedMount.authority_mode = "exact_neutron_host_v1";
  forgedMount.methods = ["GET", "HEAD"];
  expect(() => parseCapabilityPlanWireV1(forgedReadPolicy)).toThrow(
    /certified_read_routes does not match/,
  );

  const overlapping = genericCertifiedAssetsManifest();
  const collections = overlapping.capabilities!.certified_assets!.collections;
  const mutable = collections.find(({ id }) => id === "status")!;
  if (mutable.kind !== "mutable_blob") throw new Error("fixture");
  mutable.exact_path = "/items/sha256/current";
  expect(() => buildCapabilityPlan(overlapping)).toThrow(
    /Overlapping certified_assets collections/,
  );

  const duplicateCollection = genericCertifiedAssetsManifest();
  duplicateCollection.capabilities!.certified_assets!.collections[0]!.id =
    "reports";
  expect(() => buildCapabilityPlan(duplicateCollection)).toThrow(
    /Duplicate certified_assets collection reports/,
  );

  const collidingPostMount = genericCertifiedAssetsManifest();
  collidingPostMount.capabilities!.http_routes!.mounts[0]!.id = "protocol";
  expect(() => buildCapabilityPlan(collidingPostMount)).toThrow(
    /HTTP route mount protocol collides with a certified read mount/,
  );

  const routeLimit = genericCertifiedAssetsManifest();
  routeLimit.capabilities!.certified_assets!.collections = Array.from(
    { length: 15 },
    (_, index) => ({
      id: `object_${index}`,
      mount: `mount_${index}`,
      kind: "immutable_blob" as const,
      path_prefix: "/objects/",
    }),
  );
  expect(() => buildCapabilityPlan(routeLimit)).not.toThrow();
  routeLimit.capabilities!.certified_assets!.collections.push({
    id: "object_15",
    mount: "mount_15",
    kind: "immutable_blob",
    path_prefix: "/objects/",
  });
  expect(() => buildCapabilityPlan(routeLimit)).toThrow(
    /Aggregate HTTP route mount limit exceeded/,
  );

  for (const mutate of [
    (candidate: any) => {
      candidate.capabilities.certified_assets.collections.find(
        ({ kind }: { kind: string }) => kind === "publication",
      ).exact_path = "/forbidden";
    },
    (candidate: any) => {
      delete candidate.capabilities.certified_assets.collections.find(
        ({ kind }: { kind: string }) => kind === "immutable_blob",
      ).path_prefix;
    },
    (candidate: any) => {
      candidate.capabilities.certified_assets.collections.find(
        ({ kind }: { kind: string }) => kind === "mutable_blob",
      ).path_prefix = "/also-keyed/";
    },
    (candidate: any) => {
      delete candidate.capabilities.certified_assets.collections.find(
        ({ kind }: { kind: string }) => kind === "mutable_blob",
      ).exact_path;
    },
  ]) {
    const invalidLocator = genericCertifiedAssetsManifest() as any;
    mutate(invalidLocator);
    expect(() => buildCapabilityPlan(invalidLocator)).toThrow();
  }

  for (const pathPrefix of [
    "/",
    "api/",
    "/api//v1/",
    "/api/../",
    "/api%2fv1/",
    "/Api/v1/",
  ]) {
    const invalid = genericCertifiedAssetsManifest();
    const collection =
      invalid.capabilities!.certified_assets!.collections.find(
        ({ kind }) => kind === "immutable_blob",
      )!;
    if (collection.kind !== "immutable_blob") throw new Error("fixture");
    collection.path_prefix = pathPrefix;
    expect(() => buildCapabilityPlan(invalid)).toThrow(/path_prefix/);
  }

  for (const [field, maximum] of Object.entries({
    max_entries: CERTIFIED_ASSETS_MAX_ENTRIES,
    max_committed_bytes: CERTIFIED_ASSETS_MAX_COMMITTED_BYTES,
    max_object_bytes: CERTIFIED_ASSETS_MAX_OBJECT_BYTES,
    max_pending_stages: CERTIFIED_ASSETS_MAX_PENDING_STAGES,
    max_staged_bytes: CERTIFIED_ASSETS_MAX_STAGED_BYTES,
    max_batch_operations: CERTIFIED_ASSETS_MAX_BATCH_OPERATIONS,
    max_batch_bytes: CERTIFIED_ASSETS_MAX_BATCH_BYTES,
    max_idempotency_receipts: CERTIFIED_ASSETS_MAX_IDEMPOTENCY_RECEIPTS,
  })) {
    for (const invalid of [0, maximum + 1]) {
      const assetQuota = genericCertifiedAssetsManifest() as any;
      assetQuota.capabilities.certified_assets[field] = invalid;
      expect(() => buildCapabilityPlan(assetQuota)).toThrow(
        new RegExp(field),
      );
    }
  }

  const widenedCollection = genericCertifiedAssetsManifest();
  widenedCollection.capabilities!.certified_assets!.collections[0]!
    .max_object_bytes = 1_048_577;
  expect(() => buildCapabilityPlan(widenedCollection)).toThrow(
    /max_object_bytes/,
  );

  const inheritedPortableMaximum = genericCertifiedAssetsManifest();
  const inheritedConfig =
    inheritedPortableMaximum.capabilities!.certified_assets!;
  inheritedConfig.max_committed_bytes = CERTIFIED_ASSETS_MAX_OBJECT_BYTES;
  inheritedConfig.max_object_bytes = CERTIFIED_ASSETS_MAX_OBJECT_BYTES;
  inheritedConfig.max_staged_bytes = CERTIFIED_ASSETS_MAX_OBJECT_BYTES;
  inheritedConfig.max_batch_bytes = CERTIFIED_ASSETS_MAX_OBJECT_BYTES;
  expect(() => buildCapabilityPlan(inheritedPortableMaximum)).toThrow(
    /portable blob limit/,
  );

  const explicitPortableMaximum = genericCertifiedAssetsManifest();
  const explicitConfig =
    explicitPortableMaximum.capabilities!.certified_assets!;
  explicitConfig.max_committed_bytes = CERTIFIED_ASSETS_MAX_OBJECT_BYTES;
  explicitConfig.max_object_bytes = CERTIFIED_ASSETS_MAX_OBJECT_BYTES;
  explicitConfig.max_staged_bytes = CERTIFIED_ASSETS_MAX_OBJECT_BYTES;
  explicitConfig.max_batch_bytes = CERTIFIED_ASSETS_MAX_OBJECT_BYTES;
  const inheritedCollection = explicitConfig.collections.find(
    ({ kind }) => kind === "immutable_blob",
  )!;
  inheritedCollection.max_object_bytes =
    CERTIFIED_ASSETS_PORTABLE_BLOB_BODY_BYTES_MAX;
  expect(() => buildCapabilityPlan(explicitPortableMaximum)).not.toThrow();

  const api2Route = genericCertifiedAssetsManifest() as any;
  api2Route.capabilities.http_routes = {
    api: 2,
    mounts: [
      {
        id: "protocol",
        surface: "shared_app_path",
        authority_mode: "canister_gateway_v1",
        methods: ["GET"],
        mode: "certified_store",
        max_request_bytes: 0,
        store: "certified_assets",
      },
    ],
  };
  expect(() => buildCapabilityPlan(api2Route)).toThrow(
    /Unsupported http_routes capability API/,
  );

  for (const [field, value] of Object.entries({
    path_rule: "body_sha256_hex_v1",
    mutation_rule: "immutable_digest_v1",
    body_source: "inline_or_staged",
    response_profiles: ["public_candid_immutable_v1"],
  })) {
    const legacy = genericCertifiedAssetsManifest() as any;
    legacy.capabilities.certified_assets.collections[0][field] = value;
    expect(() => buildCapabilityPlan(legacy)).toThrow(
      new RegExp(`Unknown certified_assets collection field ${field}`),
    );
  }
  for (const [field, value] of Object.entries({
    lifecycle_group: "scope_v1",
    clear_mode: "lifecycle_group_only_v1",
  })) {
    const legacy = genericCertifiedAssetsManifest() as any;
    legacy.capabilities.certified_assets[field] = value;
    expect(() => buildCapabilityPlan(legacy)).toThrow(
      new RegExp(`Unknown certified_assets capability field ${field}`),
    );
  }
});

test("certified asset paths fit the fixed certified proof depth", () => {
  expect(CERTIFIED_HTTP_PATH_SEGMENTS_MAX_V2).toBe(14);
  const path = (segments: number, trailingSlash: boolean) =>
    `/${Array.from({ length: segments }, (_, index) => `s${index}`).join("/")}${
      trailingSlash ? "/" : ""
    }`;

  const prefixAtBoundary = genericCertifiedAssetsManifest();
  const prefixCollection =
    prefixAtBoundary.capabilities!.certified_assets!.collections.find(
      ({ kind }) => kind === "immutable_blob",
    )!;
  if (prefixCollection.kind !== "immutable_blob") throw new Error("fixture");
  prefixCollection.path_prefix = path(9, true);
  expect(() => buildCapabilityPlan(prefixAtBoundary)).not.toThrow();

  prefixCollection.path_prefix = path(10, true);
  expect(() => buildCapabilityPlan(prefixAtBoundary)).toThrow(/path_prefix/);

  const exactAtBoundary = genericCertifiedAssetsManifest();
  const mutableExact =
    exactAtBoundary.capabilities!.certified_assets!.collections.find(
      (collection) =>
        collection.kind === "mutable_blob" &&
        collection.exact_path !== undefined,
    )!;
  if (
    mutableExact.kind !== "mutable_blob" ||
    mutableExact.exact_path === undefined
  ) {
    throw new Error("fixture");
  }
  mutableExact.exact_path = path(10, false);
  expect(() => buildCapabilityPlan(exactAtBoundary)).not.toThrow();

  mutableExact.exact_path = path(11, false);
  expect(() => buildCapabilityPlan(exactAtBoundary)).toThrow(/exact_path/);
});

test("bounded POST routes are closed, canonical, handler-bound, and store-independent", () => {
  const manifest = updateRouteManifest();
  const plan = buildCapabilityPlan(manifest);
  expect(getCapabilityPlanEntry(plan, "http_routes")?.config).toEqual({
    api: 1,
    mounts: [
      {
        id: "webhook",
        surface: "app_host",
        prefix: "/api/webhook",
        methods: ["POST"],
        mode: "http_post_update_handler",
        handler: "receive_webhook",
        max_request_bytes: 32_768,
        max_response_bytes: 8_192,
        max_calls_per_hour: 120,
        forward_headers: ["authorization", "content-type", "x-signature"],
      },
    ],
  });
  expect(getCapabilityPlanEntry(plan, "certified_assets")).toBeUndefined();

  const wire = toCapabilityPlanWireV1(plan);
  expect(parseCapabilityPlanWireV1(structuredClone(wire))).toEqual(wire);

  const mixed = updateRouteManifest() as any;
  mixed.capabilities.http_routes.mounts.push({
    id: "read_api",
    surface: "shared_app_path",
    authority_mode: "canister_gateway_v1",
    methods: ["GET"],
    mode: "certified_store",
    store: "certified_assets",
    max_request_bytes: 0,
  });
  expect(() => buildCapabilityPlan(mixed)).toThrow(
    /Unknown HTTP route mount field authority_mode/,
  );

  const missingStore = updateRouteManifest() as any;
  missingStore.capabilities.certified_assets = {
    api: 2,
    max_entries: 4,
  };
  expect(() => buildCapabilityPlan(missingStore)).toThrow();

  for (const change of [
    (candidate: NeutronManifest) => {
      candidate.func!.receive_webhook!.type = "update";
    },
    (candidate: NeutronManifest) => {
      candidate.func!.receive_webhook!.async = true;
    },
    (candidate: NeutronManifest) => {
      delete candidate.func!.receive_webhook!.async;
    },
    (candidate: NeutronManifest) => {
      candidate.func!.receive_webhook!.arg = ["canister_principal"];
    },
    (candidate: NeutronManifest) => {
      candidate.func!.receive_webhook!.expose = "apps";
    },
    (candidate: NeutronManifest) => {
      delete candidate.func!.receive_webhook;
    },
  ]) {
    const candidate = updateRouteManifest();
    change(candidate);
    expect(() => buildCapabilityPlan(candidate)).toThrow(
      /synchronous, unexposed internal manifest function/,
    );
  }
});

test("shared-path route wire omits prefix and fingerprints its derived surface", () => {
  const appHostManifest = updateRouteManifest();
  const sharedManifest = structuredClone(appHostManifest) as any;
  const sharedMount = sharedManifest.capabilities.http_routes.mounts[0];
  sharedMount.surface = "shared_app_path";
  delete sharedMount.prefix;

  const appHostWire = toCapabilityPlanWireV1(
    buildCapabilityPlan(appHostManifest),
  );
  const sharedWire = toCapabilityPlanWireV1(buildCapabilityPlan(sharedManifest));
  expect(getCapabilityPlanEntry(sharedWire, "http_routes")?.config).toEqual({
    api: 1,
    mounts: [
      {
        id: "webhook",
        surface: "shared_app_path",
        methods: ["POST"],
        mode: "http_post_update_handler",
        handler: "receive_webhook",
        max_request_bytes: 32_768,
        max_response_bytes: 8_192,
        max_calls_per_hour: 120,
        forward_headers: ["authorization", "content-type", "x-signature"],
      },
    ],
  });
  expect(parseCapabilityPlanWireV1(structuredClone(sharedWire))).toEqual(
    sharedWire,
  );
  expect(fingerprintCapabilityPlanWireV1(sharedWire)).not.toBe(
    fingerprintCapabilityPlanWireV1(appHostWire),
  );

  const sharedWithPrefix = structuredClone(sharedWire) as any;
  sharedWithPrefix.entries.find(({ id }: { id: string }) => id === "http_routes")
    .config.mounts[0].prefix = "/forbidden";
  expect(() => parseCapabilityPlanWireV1(sharedWithPrefix)).toThrow(
    /Unknown HTTP route mount field prefix/,
  );

  const appHostWithoutPrefix = structuredClone(appHostWire) as any;
  delete appHostWithoutPrefix.entries.find(
    ({ id }: { id: string }) => id === "http_routes",
  ).config.mounts[0].prefix;
  expect(() => parseCapabilityPlanWireV1(appHostWithoutPrefix)).toThrow(
    /HTTP route prefix/,
  );
});

test("POST route body, response, rate, replay, and header ceilings fail closed", () => {
  const mount = (
    candidate: NeutronManifest,
  ): NeutronHttpPostUpdateHandlerRouteMountConfig => {
    const value = candidate.capabilities!.http_routes!.mounts[0]!;
    if (value.mode !== "http_post_update_handler") throw new Error("fixture");
    return value;
  };

  for (const invalidHeader of [
    "Host",
    "host",
    "content-length",
    "content-encoding",
    "cookie",
    "set-cookie",
    "connection",
    "transfer-encoding",
    "upgrade",
    "ic-certificate",
    "ic-certificateexpression",
    "idempotency-key",
    "keep-alive",
    "origin",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "x_bad",
    "ic-private",
    "proxy-private",
    "sec-fetch-site",
  ]) {
    const candidate = updateRouteManifest();
    mount(candidate).forward_headers = [invalidHeader];
    expect(() => buildCapabilityPlan(candidate)).toThrow(/forwarded headers/);
  }

  for (const mutate of [
    (candidate: NeutronManifest) => {
      mount(candidate).max_request_bytes = 0;
    },
    (candidate: NeutronManifest) => {
      mount(candidate).max_request_bytes = 65_537;
    },
    (candidate: NeutronManifest) => {
      mount(candidate).max_response_bytes = 65_537;
    },
    (candidate: NeutronManifest) => {
      mount(candidate).max_calls_per_hour = 241;
    },
    (candidate: NeutronManifest) => {
      mount(candidate).methods = ["GET"] as unknown as ["POST"];
    },
  ]) {
    const candidate = updateRouteManifest();
    mutate(candidate);
    expect(() => buildCapabilityPlan(candidate)).toThrow();
  }

  const aggregateCalls = updateRouteManifest();
  mount(aggregateCalls).max_response_bytes = 1024;
  mount(aggregateCalls).max_calls_per_hour = 121;
  const aggregateMount = mount(aggregateCalls);
  if (aggregateMount.surface !== "app_host") throw new Error("fixture");
  const aggregateRoutes = aggregateCalls.capabilities!.http_routes!;
  if (aggregateRoutes.api !== 1) throw new Error("fixture");
  aggregateRoutes.mounts.push({
    ...aggregateMount,
    id: "webhook_two",
    prefix: "/api/webhook-two",
  });
  expect(() => buildCapabilityPlan(aggregateCalls)).toThrow(/aggregate limits/);

  const replayBytes = updateRouteManifest();
  mount(replayBytes).max_response_bytes = 65_536;
  mount(replayBytes).max_calls_per_hour = 129;
  expect(() => buildCapabilityPlan(replayBytes)).toThrow(/aggregate limits/);
});

test("wire serialization and fingerprint are deterministic for normalized sets", () => {
  const left = kitchenSinkManifest();
  const right = kitchenSinkManifest();
  right.capabilities!.backend_calls!.reservation_scopes.reverse();
  right.capabilities!.chain_key_signing!.slots.reverse();
  right.capabilities!.stable_store!.stores.reverse();
  right.capabilities!.vetkeys!.slots.reverse();
  right.capabilities!.agent_entrypoints!.entrypoints.reverse();
  right.capabilities!.background_ui_requests!.categories.reverse();
  right.capabilities!.ethereum_provider!.chains.reverse();
  right.capabilities!.ethereum_provider!.methods.reverse();
  right.capabilities!.connections!.providers[0]!.scopes!.reverse();
  right.capabilities!.https_outcalls!.endpoints[0]!.methods.reverse();
  right.capabilities!.https_outcalls!.endpoints[0]!.request_headers.reverse();
  right.capabilities!.public_ingress!.routes.reverse();
  right.capabilities!.http_routes!.mounts.reverse();
  right.capabilities!.certified_assets!.collections.reverse();
  right.tiles!.reverse();
  right.backend!.capabilities = {
    backend_calls: { api: 1 },
    certified_assets: { api: 2 },
    chain_key_signing: { api: 1 },
    https_outcalls: { api: 1 },
    randomness: { api: 1 },
    stable_store: { api: 1 },
    vetkeys_public: { api: 1 },
  };

  const leftWire = toCapabilityPlanWireV1(buildCapabilityPlan(left));
  const rightWire = toCapabilityPlanWireV1(buildCapabilityPlan(right));
  expect(rightWire).toEqual(leftWire);
  expect(serializeCapabilityPlanWireV1(rightWire)).toBe(
    serializeCapabilityPlanWireV1(leftWire),
  );
  const fingerprint = fingerprintCapabilityPlanWireV1(leftWire);
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprintCapabilityPlanWireV1(rightWire)).toBe(fingerprint);
  expect(verifyCapabilityPlanFingerprint(leftWire, fingerprint)).toBe(true);
  expect(verifyCapabilityPlanFingerprint(leftWire, "0".repeat(64))).toBe(false);
  expect(() =>
    assertCapabilityPlanFingerprint(leftWire, "0".repeat(64)),
  ).toThrow(/fingerprint mismatch/);

  const query = kitchenSinkManifest();
  query.func!.self_update!.type = "query";
  const queryWire = toCapabilityPlanWireV1(buildCapabilityPlan(query));
  expect(
    getCapabilityPlanEntry(queryWire, "preapproved_self_calls")?.config,
  ).toEqual({
    api: 1,
    methods: [{ method: "self_update", mode: "query" }],
  });
  expect(fingerprintCapabilityPlanWireV1(queryWire)).not.toBe(fingerprint);

  const canisterPrincipal = kitchenSinkManifest();
  canisterPrincipal.func!.self_update!.arg = ["canister_principal"];
  expect(
    fingerprintCapabilityPlanWireV1(
      toCapabilityPlanWireV1(buildCapabilityPlan(canisterPrincipal)),
    ),
  ).not.toBe(fingerprint);

  const consolidated = kitchenSinkManifest();
  consolidated.memory!.state!.migrations = [
    { from: 1, to: 2, consume: ["retired"] },
  ];
  expect(
    fingerprintCapabilityPlanWireV1(
      toCapabilityPlanWireV1(buildCapabilityPlan(consolidated)),
    ),
  ).not.toBe(fingerprint);

  const narrowedBackend = kitchenSinkManifest();
  narrowedBackend.backend!.capabilities = {
    backend_calls: { api: 1 },
    certified_assets: { api: 2 },
    vetkeys_public: { api: 1 },
  };
  expect(
    fingerprintCapabilityPlanWireV1(
      toCapabilityPlanWireV1(buildCapabilityPlan(narrowedBackend)),
    ),
  ).not.toBe(fingerprint);
});

test("plan wire parser closes every boundary and rejects old wire formats", () => {
  const wire = toCapabilityPlanWireV1(buildCapabilityPlan(kitchenSinkManifest()));
  expect(parseCapabilityPlanWireV1(wire)).toEqual(wire);
  for (const candidate of [
    { ...wire, format: 0 },
    { ...wire, format: 2 },
    { ...wire, fingerprint: "a".repeat(64) },
    {
      ...wire,
      entries: [
        ...wire.entries,
        { id: "unknown", api: 1, provenance: "declared", config: {} },
      ],
    },
    {
      ...wire,
      entries: wire.entries.map((entry) =>
        entry.id === "backend_calls" ? { ...entry, api: 2 } : entry,
      ),
    },
    {
      ...wire,
      entries: wire.entries.map((entry) =>
        entry.id === "backend_calls"
          ? { ...entry, config: { ...entry.config, surprise: true } }
          : entry,
      ),
    },
    {
      ...wire,
      entries: wire.entries.map((entry) =>
        entry.id === "preapproved_self_calls"
          ? {
              ...entry,
              config: {
                api: 1,
                methods: [{ method: "1self_update", mode: "update" }],
              },
            }
          : entry,
      ),
    },
    {
      ...wire,
      entries: wire.entries.map((entry) =>
        entry.id === "preapproved_self_calls"
          ? {
              ...entry,
              config: { api: 1, methods: [{ method: "self_update" }] },
            }
          : entry,
      ),
    },
    {
      ...wire,
      entries: wire.entries.map((entry) =>
        entry.id === "function_resources"
          ? {
              ...entry,
              config: {
                functions: [
                  {
                    method: "self_update",
                    mode: "update",
                    resources: [{ kind: "actor_self" }],
                  },
                ],
              },
            }
          : entry,
      ),
    },
    {
      ...wire,
      entries: wire.entries.map((entry) =>
        entry.id === "function_resources"
          ? {
              ...entry,
              config: {
                functions: entry.config.functions.map((binding) =>
                  binding.method === "task_tick"
                    ? {
                        ...binding,
                        resources: [{ kind: "scheduled_backend_calls" }],
                      }
                    : binding,
                ),
              },
            }
          : entry,
      ),
    },
    {
      ...wire,
      entries: wire.entries.map((entry) =>
        entry.id === "memory_lifecycle"
          ? {
              ...entry,
              config: {
                retirements: [{ id: "state" }],
                consumptions: [],
              },
            }
          : entry,
      ),
    },
    {
      ...wire,
      entries: wire.entries.map((entry) =>
        entry.id === "memory_lifecycle"
          ? {
              ...entry,
              config: {
                retirements: [{ id: "retired" }],
                consumptions: [
                  {
                    memory: "state",
                    from: 2,
                    to: 3,
                    retired_resources: ["retired"],
                  },
                ],
              },
            }
          : entry,
      ),
    },
    {
      ...wire,
      entries: wire.entries.map((entry) =>
        entry.id === "app_calls"
          ? {
              ...entry,
              config: {
                dependencies: [
                  {
                    alias: "self",
                    app: "capability_test",
                    min_version: 100,
                    methods: ["read"],
                  },
                ],
              },
            }
          : entry,
      ),
    },
    {
      ...wire,
      entries: wire.entries.map((entry) =>
        entry.id === "backend_environment"
          ? {
              ...entry,
              config: {
                interfaces: [
                  { id: "backend_calls", api: 1 },
                  { id: "backend_calls", api: 1 },
                ],
              },
            }
          : entry,
      ),
    },
    {
      ...wire,
      entries: wire.entries.map((entry) =>
        entry.id === "backend_environment"
          ? {
              ...entry,
              config: {
                interfaces: [{ id: "management_actor", api: 1 }],
              },
            }
          : entry,
      ),
    },
    {
      ...wire,
      entries: wire.entries
        .filter((entry) => entry.id !== "vetkeys")
        .map((entry) =>
          entry.id === "backend_environment"
            ? {
                ...entry,
                config: {
                  interfaces: [{ id: "vetkeys_public", api: 1 }],
                },
              }
            : entry,
        ),
    },
    {
      ...wire,
      entries: wire.entries.filter((entry) => entry.id !== "certified_assets"),
    },
    {
      ...wire,
      entries: wire.entries.filter(
        (entry) => entry.id !== "certified_read_routes",
      ),
    },
  ]) {
    expect(() => parseCapabilityPlanWireV1(candidate)).toThrow();
  }
});

test("install and Settings projections carry the exact wire entry and fingerprint", () => {
  const plan: CapabilityPlan = buildCapabilityPlan(kitchenSinkManifest());
  const wire = toCapabilityPlanWireV1(plan);
  const fingerprint = fingerprintCapabilityPlanWireV1(wire);
  const disclosures = projectCapabilityInstallDisclosures(plan);
  const settings = projectCapabilitySettingsWireV1(wire);

  expect(disclosures.plan_fingerprint).toBe(fingerprint);
  expect(settings.plan_fingerprint).toBe(fingerprint);
  expect(settings.app).toEqual(plan.app);
  expect(disclosures.entries.map(({ entry }) => entry)).toEqual(wire.entries);
  expect(settings.entries.map(({ entry }) => entry)).toEqual(wire.entries);
  for (const entry of settings.entries) {
    const definition = CAPABILITY_CATALOG[entry.id];
    expect(entry.title).toBe(definition.title);
    expect(entry.delivery).toEqual(definition.delivery);
    expect(entry.grant).toBe(definition.grant);
    expect(entry.escalation).toBe(definition.escalation);
    expect(entry.disable).toBe(definition.disable);
    expect(entry.revocation).toBe(definition.revocation);
    expect(entry.quota).toBe(definition.quota);
    expect(entry.audit).toBe(definition.audit);
  }
});

test("capability plan diffs are exact, complete, and canonical", () => {
  const previousManifest: NeutronManifest = {
    format: 3,
    id: "diff_app",
    name: "Diff App",
    version: 100,
    capabilities: {
      backend_calls: {
        api: 1,
        description: "Reach one approved service",
        reservation_scopes: ["exact"],
        max_concurrency: 2,
        max_cycles_per_call: 0,
        max_cycles_per_day: 0,
      },
    },
  };
  const targetManifest: NeutronManifest = {
    format: 3,
    id: "diff_app",
    name: "Diff App",
    version: 101,
    capabilities: {
      vetkeys: {
        api: 1,
        description: "Recover private data",
        slots: [{ id: "private_data", purpose: "Private data" }],
      },
    },
  };
  const previous = toCapabilityPlanWireV1(
    buildCapabilityPlan(previousManifest),
  );
  const target = toCapabilityPlanWireV1(buildCapabilityPlan(targetManifest));
  const diff = diffCapabilityPlans(
    { ...previous, entries: [...previous.entries].reverse() },
    target,
  );

  expect(diff).toMatchObject({
    format: 1,
    app_id: "diff_app",
    previous: { version: 100 },
    target: { version: 101 },
  });
  expect(diff.previous.plan_fingerprint).toBe(
    fingerprintCapabilityPlanWireV1(previous),
  );
  expect(diff.target.plan_fingerprint).toBe(
    fingerprintCapabilityPlanWireV1(target),
  );
  expect(diff.entries.map(({ change, id }) => [change, id])).toEqual([
    ["removed", "backend_calls"],
    ["added", "vetkeys"],
  ]);
  expect(diff.entries[0]).toMatchObject({
    before: getCapabilityPlanEntry(previous, "backend_calls"),
    after: null,
  });
  expect(diff.entries[1]).toMatchObject({
    before: null,
    after: getCapabilityPlanEntry(target, "vetkeys"),
  });

  const versionOnly = diffCapabilityPlans(
    previous,
    toCapabilityPlanWireV1(
      buildCapabilityPlan({ ...previousManifest, version: 101 }),
    ),
  );
  expect(versionOnly.entries).toEqual([]);
  expect(versionOnly.previous.plan_fingerprint).not.toBe(
    versionOnly.target.plan_fingerprint,
  );
  expect(() =>
    diffCapabilityPlans(previous, {
      ...target,
      app: { ...target.app, id: "other_app" },
    }),
  ).toThrow("different apps");
});
