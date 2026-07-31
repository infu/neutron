import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  BACKEND_RESERVATION_SCOPE_DISCLOSURES,
  configInstallDisclosures,
  configPermissions,
  permissionKey,
  permissionLevel,
  type Permission,
} from "../src/lib/perm.ts";
import type { NeutronManifest } from "neutron-tools/src/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const kernelRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(kernelRoot, "../..");

async function readJson(file: string): Promise<NeutronManifest> {
  return JSON.parse(await fs.readFile(file, "utf8")) as NeutronManifest;
}

function factsOfKind<K extends Permission["kind"]>(
  permissions: readonly Permission[],
  kind: K,
): Extract<Permission, { kind: K }>[] {
  return permissions.filter(
    (permission): permission is Extract<Permission, { kind: K }> =>
      permission.kind === kind,
  );
}

test("hello app requests no exceptional permissions or explanations", async () => {
  const hello = await readJson(path.join(repoRoot, "apps/hello/neutron.json"));
  const disclosure = configInstallDisclosures(hello);

  expect(disclosure.permissions).toEqual([]);
  expect(disclosure.appExplanations).toEqual([]);
  expect(disclosure.planFingerprint).toMatch(/^[a-f0-9]{64}$/);
});

test("declaring an app-owned tray adds no install permission or explanation", () => {
  const resident: NeutronManifest = {
    format: 3,
    id: "mail",
    name: "Mail",
    version: 100,
    background: { path: "service.html" },
  };
  const withTray: NeutronManifest = {
    ...resident,
    tray: {
      title: "Mailbox",
      path: "tray.html",
      icon: "static/tray.svg",
    },
  };

  const residentDisclosure = configInstallDisclosures(resident);
  const trayDisclosure = configInstallDisclosures(withTray);
  expect(trayDisclosure.permissions).toEqual(residentDisclosure.permissions);
  expect(trayDisclosure.appExplanations).toEqual(
    residentDisclosure.appExplanations,
  );
  expect(trayDisclosure.planFingerprint).not.toBe(
    residentDisclosure.planFingerprint,
  );
});

test("bounded deferred timers add no install permission", () => {
  const baseline: NeutronManifest = {
    format: 3,
    id: "batcher",
    name: "Batcher",
    version: 100,
  };
  const withDeferredTimers: NeutronManifest = {
    ...baseline,
    backend: {
      capabilities: {
        deferred_timers: { api: 1 },
      },
    },
  };

  const baselineDisclosure = configInstallDisclosures(baseline);
  const timerDisclosure = configInstallDisclosures(withDeferredTimers);
  expect(timerDisclosure.permissions).toEqual([]);
  expect(timerDisclosure.appExplanations).toEqual([]);
  expect(timerDisclosure.planFingerprint).not.toBe(
    baselineDisclosure.planFingerprint,
  );
});

test("persistent background storage is a structured kernel fact", async () => {
  const gemma = await readJson(path.join(repoRoot, "apps/gemma/neutron.json"));

  expect(configPermissions(gemma)).toContainEqual({
    source: "kernel",
    kind: "persistent_background_storage",
  });
});

test("dedicated resident origin is a distinct structured kernel fact", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "ephemeral_resident",
    name: "Ephemeral Resident",
    version: 100,
    background: { path: "background.html" },
    capabilities: {
      dedicated_resident_origin: {
        api: 1,
        surface: "background",
        mode: "credentialless_ephemeral_v1",
      },
    },
  });
  const origins = factsOfKind(
    disclosure.permissions,
    "dedicated_resident_origin",
  );

  expect(origins).toEqual([
    {
      source: "kernel",
      kind: "dedicated_resident_origin",
    },
  ]);
  expect(permissionLevel(origins[0]!)).toBe(2);
  expect(permissionKey(origins[0]!)).toBe("dedicated_resident_origin");
  expect(disclosure.permissions).not.toContainEqual({
    source: "kernel",
    kind: "persistent_background_storage",
  });
  expect(disclosure.appExplanations).toEqual([]);
});

test("resident credentials and agent entrypoints retain machine-derived risk", async () => {
  const agent = await readJson(
    path.join(repoRoot, "apps/agent/neutron.json"),
  );
  const permissions = configPermissions(agent);

  const connection = factsOfKind(permissions, "connection").find(
    (fact) => fact.provider === "openrouter",
  );
  expect(connection).toEqual({
    source: "kernel",
    kind: "connection",
    provider: "openrouter",
    scopes: [],
  });
  expect(connection && permissionLevel(connection)).toBe(3);
  expect(permissions).toContainEqual({
    source: "kernel",
    kind: "agent_entrypoint",
    entrypoint: "agent_chat",
  });
  expect(permissions).toContainEqual({
    source: "kernel",
    kind: "background_ui_request",
    category: "frontend_tool",
  });
});

test("backend-call facts disclose normalized modes and concurrency without a target", async () => {
  const wallet = await readJson(path.join(repoRoot, "apps/wallet/neutron.json"));
  const disclosure = configInstallDisclosures(wallet);
  const backend = factsOfKind(disclosure.permissions, "backend_calls")[0];

  expect(backend).toMatchObject({
    source: "kernel",
    kind: "backend_calls",
    reservationScopes: ["exact", "principal"],
    maxConcurrency: 20,
    maxCyclesPerCall: 0,
    maxCyclesPerDay: 0,
  });
  expect(backend?.installReservations).toHaveLength(15);
  expect(backend && permissionLevel(backend)).toBe(3);
  const scheduled = factsOfKind(
    disclosure.permissions,
    "scheduled_task",
  );
  expect(scheduled).toEqual([
    {
      source: "kernel",
      kind: "scheduled_task",
      id: "ledger_history",
      method: "wallet_history_tick",
      intervalSeconds: 43_200,
      runOnStart: true,
      maxBackendCalls: 100,
    },
  ]);
  expect(permissionLevel(scheduled[0]!)).toBe(3);
  expect(BACKEND_RESERVATION_SCOPE_DISCLOSURES).toEqual({
    exact: {
      label: "Exact canister method",
      meaning: "One method on one canister",
      broad: false,
    },
    principal: {
      label: "Canister-wide",
      meaning: "Every current and future method on one canister",
      broad: true,
    },
    method: {
      label: "Method-wide",
      meaning: "One method name on any eligible non-system canister",
      broad: true,
    },
  });
});

test("randomness is a kernel permission without a temporal quota", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "dice_app",
    name: "Dice App",
    version: 100,
    capabilities: {
      randomness: { api: 1 },
    },
  });
  const randomness = factsOfKind(disclosure.permissions, "randomness")[0];

  expect(randomness).toEqual({
    source: "kernel",
    kind: "randomness",
  });
  expect(randomness && permissionLevel(randomness)).toBe(2);
  expect(randomness && permissionKey(randomness)).toBe("randomness");
  expect(disclosure.appExplanations).toEqual([]);
});

test("chain-key signing separates exact slot authority from unverified purpose", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "assertion_app",
    name: "Assertion App",
    version: 100,
    capabilities: {
      chain_key_signing: {
        api: 1,
        slots: [
          {
            id: "receipt",
            algorithm: "schnorr_ed25519",
            purpose: "App says this signs harmless receipts",
            max_assertion_bytes: 4096,
          },
          {
            id: "login_assertion",
            algorithm: "ecdsa_secp256k1",
            purpose: "App says this proves a login",
            max_assertion_bytes: 1024,
          },
        ],
      },
    },
  });
  const signing = factsOfKind(
    disclosure.permissions,
    "chain_key_signing",
  );

  expect(signing).toEqual([
    {
      source: "kernel",
      kind: "chain_key_signing",
      slots: [
        {
          id: "login_assertion",
          algorithm: "ecdsa_secp256k1",
          maxAssertionBytes: 1024,
        },
        {
          id: "receipt",
          algorithm: "schnorr_ed25519",
          maxAssertionBytes: 4096,
        },
      ],
    },
  ]);
  expect(permissionLevel(signing[0]!)).toBe(4);
  expect(permissionKey(signing[0]!)).toBe(
    'chain_key_signing:[["login_assertion","ecdsa_secp256k1",1024],["receipt","schnorr_ed25519",4096]]',
  );
  expect(disclosure.appExplanations).toEqual([
    {
      source: "app",
      kind: "chain_key_signing_slot_purpose",
      text: "login_assertion — App says this proves a login",
    },
    {
      source: "app",
      kind: "chain_key_signing_slot_purpose",
      text: "receipt — App says this signs harmless receipts",
    },
  ]);
});

test("stable stores separate exact schema and quotas from unverified purpose", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "notes_app",
    name: "Notes",
    version: 100,
    capabilities: {
      stable_store: {
        api: 1,
        stores: [
          {
            id: "scratch",
            purpose: "App says this is temporary scratch data",
            schema_version: 1,
            max_entries: 8,
            max_key_bytes: 16,
            max_value_bytes: 512,
            max_bytes: 4096,
          },
          {
            id: "notes",
            purpose: "App says this keeps private notes",
            schema_version: 2,
            max_entries: 64,
            max_key_bytes: 48,
            max_value_bytes: 4096,
            max_bytes: 65_536,
          },
        ],
      },
    },
  });
  const stores = factsOfKind(disclosure.permissions, "stable_store");

  expect(stores).toEqual([
    {
      source: "kernel",
      kind: "stable_store",
      stores: [
        {
          id: "notes",
          schemaVersion: 2,
          maxEntries: 64,
          maxKeyBytes: 48,
          maxValueBytes: 4096,
          maxBytes: 65_536,
        },
        {
          id: "scratch",
          schemaVersion: 1,
          maxEntries: 8,
          maxKeyBytes: 16,
          maxValueBytes: 512,
          maxBytes: 4096,
        },
      ],
    },
  ]);
  expect(permissionLevel(stores[0]!)).toBe(3);
  expect(permissionKey(stores[0]!)).toBe(
    'stable_store:[["notes",2,64,48,4096,65536],["scratch",1,8,16,512,4096]]',
  );
  expect(disclosure.appExplanations).toEqual([
    {
      source: "app",
      kind: "stable_store_purpose",
      text: "notes — App says this keeps private notes",
    },
    {
      source: "app",
      kind: "stable_store_purpose",
      text: "scratch — App says this is temporary scratch data",
    },
  ]);
});

test("HTTPS outcalls disclose one exact grouped transport authority", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "weather_app",
    name: "Weather",
    version: 100,
    capabilities: {
      https_outcalls: {
        api: 1,
        endpoints: [
          {
            id: "weather",
            url_prefix: "https://api.example.com/v1/",
            methods: ["post", "get"],
            request_headers: ["authorization", "accept"],
            max_request_bytes: 65_536,
            max_response_bytes: 32_768,
            transform: "strip_headers",
          },
          {
            id: "status",
            url_prefix: "https://status.example.com/",
            methods: ["head"],
            request_headers: [],
            max_request_bytes: 4096,
            max_response_bytes: 4096,
            transform: "strip_headers",
          },
        ],
      },
    },
  });
  const permissions = factsOfKind(disclosure.permissions, "https_outcalls");

  expect(permissions).toEqual([
    {
      source: "kernel",
      kind: "https_outcalls",
      endpoints: [
        {
          id: "status",
          urlPrefix: "https://status.example.com/",
          methods: ["head"],
          requestHeaders: [],
          maxRequestBytes: 4096,
          maxResponseBytes: 4096,
          transform: "strip_headers",
        },
        {
          id: "weather",
          urlPrefix: "https://api.example.com/v1/",
          methods: ["get", "post"],
          requestHeaders: ["accept", "authorization"],
          maxRequestBytes: 65_536,
          maxResponseBytes: 32_768,
          transform: "strip_headers",
        },
      ],
    },
  ]);
  expect(permissionLevel(permissions[0]!)).toBe(3);
  expect(permissionKey(permissions[0]!)).toBe(
    'https_outcalls:[["status","https://status.example.com/",["head"],[],4096,4096,"strip_headers"],["weather","https://api.example.com/v1/",["get","post"],["accept","authorization"],65536,32768,"strip_headers"]]',
  );
  expect(disclosure.appExplanations).toEqual([]);

  const readOnly: Extract<Permission, { kind: "https_outcalls" }> = {
    ...permissions[0]!,
    endpoints: permissions[0]!.endpoints.map((endpoint) => ({
      ...endpoint,
      methods: endpoint.methods.filter((method) => method !== "post"),
    })),
  };
  expect(permissionLevel(readOnly)).toBe(2);
});

test("public ingress discloses exact route authority and update admission", () => {
  const permissions = configPermissions({
    format: 3,
    id: "mail_peer",
    name: "Mail Peer",
    version: 100,
    capabilities: {
      public_ingress: {
        api: 1,
        routes: [
          {
            protocol: "mail_v1",
            id: "key",
            handler: "mail_public_key",
            mode: "query",
            caller: "any",
            max_request_bytes: 128,
            max_response_bytes: 4096,
          },
          {
            protocol: "mail_v1",
            id: "receive",
            handler: "mail_receive",
            mode: "update",
            caller: "canister",
            max_request_bytes: 39_199,
            max_response_bytes: 1024,
            max_calls_per_hour: 240,
            max_calls_per_caller_per_hour: 24,
            required_cycles: 250_000_000,
          },
        ],
      },
    },
    func: {
      mail_public_key: { type: "query" },
      mail_receive: { type: "update" },
    },
  });

  expect(factsOfKind(permissions, "public_ingress_route")).toEqual([
    {
      source: "kernel",
      kind: "public_ingress_route",
      protocol: "mail_v1",
      method: "key",
      handler: "mail_public_key",
      mode: "query",
      caller: "any",
      maxRequestBytes: 128,
      maxResponseBytes: 4096,
    },
    {
      source: "kernel",
      kind: "public_ingress_route",
      protocol: "mail_v1",
      method: "receive",
      handler: "mail_receive",
      mode: "update",
      caller: "canister",
      maxRequestBytes: 39_199,
      maxResponseBytes: 1024,
      maxCallsPerHour: 240,
      maxCallsPerCallerPerHour: 24,
      requiredCycles: 250_000_000,
    },
  ]);
  expect(permissionLevel(permissions[0]!)).toBe(2);
  expect(permissionLevel(permissions[1]!)).toBe(3);
  expect(permissionKey(permissions[1]!)).toBe(
    "public_ingress_route:mail_v1:receive:mail_receive:update:canister:39199:1024:240:250000000:caller:24",
  );
});

test("authenticated public updates disclose direct self-authenticating ingress without payment", () => {
  const permissions = configPermissions({
    format: 3,
    id: "cli_bridge",
    name: "CLI Bridge",
    version: 100,
    capabilities: {
      public_ingress: {
        api: 1,
        routes: [
          {
            protocol: "cli_v1",
            id: "commit",
            handler: "cli_commit",
            mode: "update",
            caller: "authenticated",
            max_request_bytes: 8192,
            max_response_bytes: 1024,
            max_calls_per_hour: 60,
          },
        ],
      },
    },
    func: {
      cli_commit: { type: "update", async: false },
    },
  });

  expect(factsOfKind(permissions, "public_ingress_route")).toEqual([
    {
      source: "kernel",
      kind: "public_ingress_route",
      protocol: "cli_v1",
      method: "commit",
      handler: "cli_commit",
      mode: "update",
      caller: "authenticated",
      maxRequestBytes: 8192,
      maxResponseBytes: 1024,
      maxCallsPerHour: 60,
    },
  ]);
  expect(permissionKey(permissions[0]!)).toBe(
    "public_ingress_route:cli_v1:commit:cli_commit:update:authenticated:8192:1024:60:direct_ingress",
  );
});

test("certified app routes disclose exact public mounts and storage quotas", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "public_app",
    name: "Public App",
    version: 100,
    backend: {
      capabilities: {
        certified_assets: { api: 2 },
      },
    },
    capabilities: {
      certified_assets: {
        api: 2,
        max_entries: 32,
        max_committed_bytes: 1_048_576,
        max_object_bytes: 65_536,
        max_pending_stages: 1,
        max_staged_bytes: 65_536,
        max_batch_operations: 1,
        max_batch_bytes: 65_536,
        max_idempotency_receipts: 64,
        collections: [
          {
            id: "shares",
            mount: "shares",
            kind: "publication",
          },
        ],
      },
    },
  });
  const route = factsOfKind(disclosure.permissions, "http_route")[0];
  const assets = factsOfKind(disclosure.permissions, "certified_assets")[0];

  expect(route).toEqual({
    source: "kernel",
    kind: "http_route",
    id: "shares",
    surface: "shared_app_path",
    publicPath: "/app/public_app/_route/shares",
    methods: ["GET", "HEAD"],
    mode: "certified_store",
    authorityMode: "exact_neutron_host_v1",
    store: "certified_assets",
    maxRequestBytes: 0,
  });
  expect(assets).toEqual({
    source: "kernel",
    kind: "certified_assets",
    maxEntries: 32,
    maxCommittedBytes: 1_048_576,
    maxObjectBytes: 65_536,
    maxPendingStages: 1,
    maxStagedBytes: 65_536,
    maxBatchOperations: 1,
    maxBatchBytes: 65_536,
    maxIdempotencyReceipts: 64,
    collections: [
      {
        id: "shares",
        mount: "shares",
        kind: "publication",
      },
    ],
  });
  expect(route && permissionLevel(route)).toBe(3);
  expect(assets && permissionLevel(assets)).toBe(3);
  expect(route && permissionKey(route)).toBe(
    "http_route:shared_app_path:certified_store:exact_neutron_host_v1:shares:/app/public_app/_route/shares:GET,HEAD:certified_assets:0",
  );
  expect(assets && permissionKey(assets)).toBe(
    'certified_assets:32:1048576:65536:1:65536:1:65536:64:[["shares","shares","publication",null,null,null]]',
  );
});

test("public POST routes disclose the exact handler and admission budget", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "hook_app",
    name: "Hook App",
    version: 100,
    func: {
      receive_hook: { type: "internal", async: false },
    },
    capabilities: {
      http_routes: {
        api: 1,
        mounts: [
          {
            id: "receive",
            surface: "app_host",
            prefix: "/hooks/receive",
            methods: ["POST"],
            mode: "http_post_update_handler",
            handler: "receive_hook",
            max_request_bytes: 32_768,
            max_response_bytes: 8_192,
            max_calls_per_hour: 60,
            forward_headers: ["authorization", "content-type"],
          },
        ],
      },
    },
  });
  const route = factsOfKind(disclosure.permissions, "http_route")[0];

  expect(route).toEqual({
    source: "kernel",
    kind: "http_route",
    id: "receive",
    surface: "app_host",
    publicPath: "/hooks/receive",
    methods: ["POST"],
    mode: "http_post_update_handler",
    handler: "receive_hook",
    maxRequestBytes: 32_768,
    maxResponseBytes: 8_192,
    maxCallsPerHour: 60,
    forwardHeaders: ["authorization", "content-type"],
  });
  expect(route && permissionLevel(route)).toBe(3);
  expect(route && permissionKey(route)).toBe(
    "http_route:app_host:http_post_update_handler:receive:/hooks/receive:POST:receive_hook:32768:8192:60:authorization,content-type",
  );
});

test("shared POST paths disclose their kernel-derived public bases and surface", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "shared_routes",
    name: "Shared Routes",
    version: 100,
    func: {
      submit: { type: "internal", async: false },
    },
    capabilities: {
      http_routes: {
        api: 1,
        mounts: [
          {
            id: "submit",
            surface: "shared_app_path",
            methods: ["POST"],
            mode: "http_post_update_handler",
            handler: "submit",
            max_request_bytes: 4096,
            max_response_bytes: 2048,
            max_calls_per_hour: 30,
            forward_headers: ["content-type"],
          },
        ],
      },
    },
  });
  const routes = factsOfKind(disclosure.permissions, "http_route");

  expect(routes).toEqual([
    {
      source: "kernel",
      kind: "http_route",
      id: "submit",
      surface: "shared_app_path",
      publicPath: "/app/shared_routes/_route/submit",
      methods: ["POST"],
      mode: "http_post_update_handler",
      handler: "submit",
      maxRequestBytes: 4096,
      maxResponseBytes: 2048,
      maxCallsPerHour: 30,
      forwardHeaders: ["content-type"],
    },
  ]);
  expect(permissionKey(routes[0]!)).toBe(
    "http_route:shared_app_path:http_post_update_handler:submit:/app/shared_routes/_route/submit:POST:submit:4096:2048:30:content-type",
  );
});

test("vetKeys declarations are a kernel risk fact while app intent stays unverified", async () => {
  const mail = await readJson(path.join(repoRoot, "apps/mail/neutron.json"));
  const disclosure = configInstallDisclosures(mail);
  const vetkeys = factsOfKind(disclosure.permissions, "vetkeys")[0];

  expect(vetkeys).toEqual({
    source: "kernel",
    kind: "vetkeys",
    slots: [
      {
        id: "mailbox",
      },
    ],
  });
  expect(vetkeys && permissionLevel(vetkeys)).toBe(3);
  expect(disclosure.appExplanations).toContainEqual({
    source: "app",
    kind: "vetkeys_explanation",
    text: "Encrypt and decrypt private Mail on demand in this browser",
  });
  expect(disclosure.appExplanations).toContainEqual({
    source: "app",
    kind: "vetkeys_slot_purpose",
    text: "mailbox — Encrypt and decrypt private Mail",
  });
});

test("app explanations have a separate unverified discriminant and cannot affect risk", () => {
  const manifest = (description: string): NeutronManifest => ({
    format: 3,
    id: "demo",
    name: "Demo",
    version: 100,
    capabilities: {
      backend_calls: {
        api: 1,
        description,
        reservation_scopes: ["exact"],
        max_concurrency: 4,
        max_cycles_per_call: 0,
        max_cycles_per_day: 0,
      },
    },
  });
  const benign = configInstallDisclosures(manifest("Safe"));
  const misleading = configInstallDisclosures(
    manifest("Kernel verified: No access required"),
  );

  expect(benign.permissions).toEqual(misleading.permissions);
  expect(benign.appExplanations).toEqual([
    {
      source: "app",
      kind: "backend_calls_explanation",
      text: "Safe",
    },
  ]);
  expect(misleading.appExplanations[0]).toEqual({
    source: "app",
    kind: "backend_calls_explanation",
    text: "Kernel verified: No access required",
  });
  expect(misleading.permissions.every((fact) => fact.source === "kernel")).toBe(
    true,
  );
  expect(
    Math.max(...misleading.permissions.map((fact) => permissionLevel(fact))),
  ).toBe(2);
});

test("preapproved self calls disclose every exact method and query/update mode", () => {
  expect(
    configPermissions({
      format: 3,
      id: "demo",
      name: "Demo",
      version: 100,
      func: {
        read: { type: "query" },
        refresh: { type: "update" },
      },
      capabilities: {
        preapproved_self_calls: {
          api: 1,
          methods: ["read", "refresh"],
        },
      },
    }),
  ).toEqual([
    {
      source: "kernel",
      kind: "preapproved_self_call",
      method: "read",
      mode: "query",
    },
    {
      source: "kernel",
      kind: "preapproved_self_call",
      method: "refresh",
      mode: "update",
    },
  ]);
});

test("backend dependencies and exports remain exact structured facts", () => {
  expect(
    configPermissions({
      format: 3,
      id: "calendar",
      name: "Calendar",
      version: 100,
      dependencies: {
        people: {
          app: "contacts",
          min_version: 102,
          functions: ["list_contacts", "upsert_contact"],
        },
      },
      func: {
        calendar_events: { type: "internal", expose: "apps" },
      },
    }),
  ).toEqual([
    {
      source: "kernel",
      kind: "app_dependency",
      app: "contacts",
      minVersion: 102,
      functions: ["list_contacts", "upsert_contact"],
    },
    {
      source: "kernel",
      kind: "internal_app_function",
      method: "calendar_events",
    },
  ]);
});

test("kernel permissions are explicit and deduplicated", async () => {
  const kernel = await readJson(path.join(kernelRoot, "neutron.json"));
  const permissions = configPermissions(kernel);

  expect(permissions).toContainEqual({
    source: "kernel",
    kind: "kernel_replacement",
  });
  expect(permissions).toContainEqual({
    source: "kernel",
    kind: "kernel_memory_replacement",
  });
  expect(factsOfKind(permissions, "function_resources")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        method: "kernel_check_authorized",
        resources: [{ kind: "caller" }],
      }),
      expect.objectContaining({
        method: "kernel_memory_snapshot",
        resources: [{ kind: "actor_self" }],
      }),
    ]),
  );
  // Kernel-owned physical endpoints are covered by kernel replacement rather
  // than being misrepresented as app public-ingress routes.
  expect(factsOfKind(permissions, "public_method")).toEqual([]);
  expect(new Set(permissions.map(permissionKey)).size).toBe(permissions.length);
});

test("ambiguous or internal allow metadata is rejected before disclosure", () => {
  expect(() => configPermissions({
    format: 3,
    id: "legacy_app",
    name: "Legacy App",
    version: 100,
    func: {
      legacy: { type: "query", allow: "any" },
      helper: { type: "internal", allow: "unauthorized" },
    },
  } as unknown as NeutronManifest)).toThrow();
});

test("canister principal injection is a level-one read-only fact", () => {
  const permissions = configPermissions({
    format: 3,
    id: "bound_app",
    name: "Bound App",
    version: 100,
    func: {
      bind: { type: "update", arg: ["canister_principal"] },
    },
  });
  expect(permissions).toEqual([
    {
      source: "kernel",
      kind: "function_resources",
      method: "bind",
      mode: "update",
      resources: [{ kind: "canister_principal" }],
    },
  ]);
  expect(permissionLevel(permissions[0]!)).toBe(1);
  expect(permissionKey(permissions[0]!)).toBe(
    "function_resources:bind:update:canister_principal",
  );
});

test("task capability permission identity includes its exact interface API", () => {
  const permissions = configPermissions({
    format: 3,
    id: "scheduled_app",
    name: "Scheduled App",
    version: 100,
    func: {
      refresh: { type: "internal", arg: ["task_capabilities"] },
    },
    capabilities: {
      backend_calls: {
        api: 1,
        description: "Refresh remote state",
        reservation_scopes: ["exact"],
        max_concurrency: 1,
        max_cycles_per_call: 0,
        max_cycles_per_day: 0,
      },
      scheduled_tasks: {
        api: 1,
        tasks: [
          {
            id: "refresh",
            method: "refresh",
            interval_seconds: 3_600,
            run_on_start: false,
            max_backend_calls: 1,
          },
        ],
      },
    },
  });
  const resourcePermission = factsOfKind(
    permissions,
    "function_resources",
  )[0]!;

  expect(resourcePermission.resources).toEqual([
    {
      kind: "task_capabilities",
      interfaces: [{ id: "backend_calls", api: 1 }],
    },
  ]);
  expect(permissionKey(resourcePermission)).toBe(
    "function_resources:refresh:internal:task_capabilities:backend_calls@1",
  );
});

test("memory retirement requires destructive approval", () => {
  const fact = configPermissions({
    format: 3,
    id: "test_app",
    name: "Test App",
    version: 101,
    memory: {
      state: {
        version: 1,
        retired: true,
        schemas: { "1": { entry: "1".repeat(64) } },
      },
    },
  })[0];

  expect(fact).toEqual({
    source: "kernel",
    kind: "memory_retirement",
    memoryId: "state",
    consolidation: false,
  });
  expect(fact && permissionLevel(fact)).toBe(4);
});

test("consumed memory is machine-marked as consolidation", () => {
  const permissions = configPermissions({
    format: 3,
    id: "test_app",
    name: "Test App",
    version: 101,
    memory: {
      state: {
        version: 2,
        schemas: {
          "1": { entry: "1".repeat(64) },
          "2": { entry: "2".repeat(64) },
        },
        migrations: [
          {
            from: 1,
            to: 2,
            consume: ["state_aux"],
            entry: "3".repeat(64),
          },
        ],
      },
      state_aux: {
        version: 1,
        retired: true,
        schemas: { "1": { entry: "4".repeat(64) } },
      },
    },
  });

  expect(permissions).toContainEqual({
    source: "kernel",
    kind: "memory_retirement",
    memoryId: "state_aux",
    consolidation: true,
  });
});

test("current Chess disclosure includes backend policy, eight self calls, and a bounded public exchange route", async () => {
  const chess = await readJson(path.join(repoRoot, "apps/chess/neutron.json"));
  const disclosure = configInstallDisclosures(chess);
  const backend = factsOfKind(disclosure.permissions, "backend_calls")[0];
  const preapproved = factsOfKind(
    disclosure.permissions,
    "preapproved_self_call",
  );
  const publicRoutes = factsOfKind(
    disclosure.permissions,
    "public_ingress_route",
  );

  expect(backend).toEqual({
    source: "kernel",
    kind: "backend_calls",
    reservationScopes: ["exact"],
    maxConcurrency: 8,
    maxCyclesPerCall: 400_000_000,
    maxCyclesPerDay: 2_304_000_000_000,
  });
  expect(backend && permissionLevel(backend)).toBe(3);
  expect(preapproved).toHaveLength(8);
  expect(preapproved.map(({ method, mode }) => ({ method, mode }))).toEqual([
    { method: "chess_action", mode: "update" },
    { method: "chess_create_game", mode: "update" },
    { method: "chess_get_game", mode: "query" },
    { method: "chess_join_game", mode: "update" },
    { method: "chess_move", mode: "update" },
    { method: "chess_remote_push_target", mode: "query" },
    { method: "chess_sync_game", mode: "update" },
    { method: "chess_undo", mode: "update" },
  ]);
  expect(publicRoutes).toContainEqual({
    source: "kernel",
    kind: "public_ingress_route",
    protocol: "chess_v1",
    method: "exchange",
    handler: "chess_remote_exchange_v1",
    mode: "update",
    caller: "canister",
    maxRequestBytes: 65_536,
    maxResponseBytes: 32768,
    maxCallsPerHour: 240,
    requiredCycles: 400_000_000,
  });
  expect(disclosure.appExplanations).toEqual([
    {
      source: "app",
      kind: "backend_calls_explanation",
      text: "Send paid Chess commands and pushed state to an owner-approved peer Neutron",
    },
  ]);
});

test("authoritative policy changes produce different install disclosures", () => {
  const manifest = (
    reservationScopes: ("exact" | "principal" | "method")[],
    maxConcurrency: number,
    maxCyclesPerCall = 0,
    maxCyclesPerDay = 0,
  ): NeutronManifest => ({
    format: 3,
    id: "demo",
    name: "Demo",
    version: 100,
    capabilities: {
      backend_calls: {
        api: 1,
        description: "Same optional rationale",
        reservation_scopes: reservationScopes,
        max_concurrency: maxConcurrency,
        max_cycles_per_call: maxCyclesPerCall,
        max_cycles_per_day: maxCyclesPerDay,
      },
    },
  });

  const exact = configPermissions(manifest(["exact"], 4));
  expect(configPermissions(manifest(["exact"], 8))).not.toEqual(exact);
  expect(configPermissions(manifest(["principal"], 4))).not.toEqual(exact);
  expect(configPermissions(manifest(["exact"], 4, 10, 100))).not.toEqual(exact);

  const selfCallManifest = (type: "query" | "update"): NeutronManifest => ({
    format: 3,
    id: "demo",
    name: "Demo",
    version: 100,
    func: { inspect: { type } },
    capabilities: {
      preapproved_self_calls: { api: 1, methods: ["inspect"] },
    },
  });
  expect(configPermissions(selfCallManifest("update"))).not.toEqual(
    configPermissions(selfCallManifest("query")),
  );
});

test("install approval uses a deeply copied immutable disclosure snapshot", async () => {
  const { snapshotAppInstallRequest } = await import(
    "../src/reducer/apps.ts"
  );
  const reservationScopes: ("exact" | "principal" | "method")[] = ["exact"];
  const permission: Extract<Permission, { kind: "backend_calls" }> = {
    source: "kernel",
    kind: "backend_calls",
    reservationScopes,
    maxConcurrency: 3,
    maxCyclesPerCall: 10,
    maxCyclesPerDay: 100,
  };
  const explanation = {
    source: "app" as const,
    kind: "backend_calls_explanation" as const,
    text: "Original rationale",
  };
  const snapshot = snapshotAppInstallRequest({
    id: "demo",
    packageName: "Demo",
    packageVersion: 100,
    packageDigest: "0".repeat(64),
    size: 10,
    capabilityPlanFingerprint: "a".repeat(64),
    capabilityDisclosures: [],
    permissions: [permission],
    appExplanations: [explanation],
  });

  reservationScopes[0] = "principal";
  explanation.text = "Changed after prompt";

  expect(snapshot.permissions[0]).toEqual({
    source: "kernel",
    kind: "backend_calls",
    reservationScopes: ["exact"],
    maxConcurrency: 3,
    maxCyclesPerCall: 10,
    maxCyclesPerDay: 100,
  });
  expect(snapshot.operation).toBe("install");
  expect(snapshot.appExplanations[0]?.text).toBe("Original rationale");
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.permissions)).toBe(true);
  expect(
    Object.isFrozen(
      (snapshot.permissions[0] as Extract<
        Permission,
        { kind: "backend_calls" }
      >).reservationScopes,
    ),
  ).toBe(true);
});
