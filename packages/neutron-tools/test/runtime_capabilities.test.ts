import { expect, test } from "bun:test";
import { buildCapabilityPlan } from "../src/capabilities/plan.ts";
import {
  RUNTIME_CAPABILITY_MAX_PER_APP,
  projectRuntimeCapabilityRegistrationsV1,
  type RuntimeCapabilityRegistrationV1,
} from "../src/capabilities/runtime.ts";
import type { NeutronManifest } from "../src/schema.ts";

function manifest(): NeutronManifest {
  return {
    format: 3,
    id: "runtime_test",
    name: "Runtime Test",
    version: 100,
    background: { path: "service.html" },
    backend: {
      capabilities: {
        certified_assets: { api: 2 },
      },
    },
    func: {
      poll: { type: "internal", arg: ["task_capabilities"] },
      ingress_probe: { type: "query", async: false },
      ingress_deliver: { type: "update", async: false },
      receive_webhook: { type: "internal", async: false },
    },
    capabilities: {
      backend_calls: {
        api: 1,
        description: "Calls",
        reservation_scopes: ["method", "exact"],
        max_concurrency: 3,
        max_cycles_per_call: 10_000,
        max_cycles_per_day: 100_000,
      },
      randomness: { api: 1 },
      chain_key_signing: {
        api: 1,
        slots: [
          {
            id: "z_receipts",
            algorithm: "schnorr_ed25519",
            purpose: "Receipt assertions",
            max_assertion_bytes: 4096,
          },
          {
            id: "a_identity",
            algorithm: "ecdsa_secp256k1",
            purpose: "Identity assertions",
            max_assertion_bytes: 1024,
          },
        ],
      },
      https_outcalls: {
        api: 1,
        endpoints: [
          {
            id: "example",
            url_prefix: "https://example.com/",
            methods: ["head", "get"],
            request_headers: ["accept"],
            max_request_bytes: 4096,
            max_response_bytes: 32_768,
            transform: "strip_headers",
          },
        ],
      },
      vetkeys: {
        api: 1,
        description: "Keys",
        slots: [
          { id: "z_key", purpose: "Z" },
          { id: "a_key", purpose: "A" },
        ],
      },
      scheduled_tasks: {
        api: 1,
        tasks: [
          {
            id: "poll",
            method: "poll",
            interval_seconds: 3_600,
            run_on_start: false,
            max_backend_calls: 2,
          },
        ],
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
      media_sessions: {
        api: 1,
        entrypoint: "media.html",
        features: ["camera", "microphone"],
        max_duration_seconds: 7_200,
      },
      public_ingress: {
        api: 1,
        routes: [
          {
            protocol: "mail_v1",
            id: "probe",
            handler: "ingress_probe",
            mode: "query",
            caller: "any",
            max_request_bytes: 16,
            max_response_bytes: 4096,
          },
          {
            protocol: "mail_v1",
            id: "deliver",
            handler: "ingress_deliver",
            mode: "update",
            caller: "canister",
            max_request_bytes: 65_536,
            max_response_bytes: 1024,
            max_calls_per_hour: 120,
            required_cycles: 10_000_000,
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
            max_request_bytes: 8192,
            max_response_bytes: 2048,
            max_calls_per_hour: 60,
            forward_headers: ["content-type"],
          },
        ],
      },
      certified_assets: {
        api: 2,
        max_entries: 32,
        max_committed_bytes: 1_048_576,
        max_object_bytes: 65_536,
        max_pending_stages: 1,
        max_staged_bytes: 65_536,
        max_batch_operations: 16,
        max_batch_bytes: 65_536,
        max_idempotency_receipts: 32,
        collections: [
          {
            id: "status",
            mount: "protocol",
            exact_path: "/current",
            kind: "mutable_blob",
            max_object_bytes: 4096,
          },
          {
            id: "reports",
            mount: "protocol",
            path_prefix: "/items/",
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

function byKey(
  entries: RuntimeCapabilityRegistrationV1[],
  kind: RuntimeCapabilityRegistrationV1["kind"],
  resourceId: string,
) {
  return entries.find(
    (entry) => entry.kind === kind && entry.resource_id === resourceId,
  )!;
}

test("runtime projection contains only exact broker-enforced resources", () => {
  const entries = projectRuntimeCapabilityRegistrationsV1(
    buildCapabilityPlan(manifest()),
  );
  expect(entries.map(({ kind, resource_id }) => `${kind}/${resource_id}`)).toEqual([
    "backend_calls/default",
    "certified_assets/default",
    "certified_read_routes/protocol",
    "certified_read_routes/shares",
    "chain_key_signing/a_identity",
    "chain_key_signing/z_receipts",
    "connections/openrouter",
    "http_routes/webhook",
    "https_outcalls/example",
    "media_sessions/default",
    "persistent_browser_storage/background",
    "public_ingress/mail_v1:deliver",
    "public_ingress/mail_v1:probe",
    "randomness/default",
    "scheduled_tasks/poll",
    "vetkeys/a_key",
    "vetkeys/z_key",
  ]);
  expect(entries.every(({ format }) => format === 1)).toBe(true);
  expect(byKey(entries, "certified_assets", "default").api).toBe(2);
  expect(byKey(entries, "certified_read_routes", "protocol").api).toBe(1);
  expect(byKey(entries, "certified_read_routes", "shares").api).toBe(1);
  expect(byKey(entries, "http_routes", "webhook").api).toBe(1);
  expect(
    entries
      .filter(
        ({ kind }) => kind !== "certified_assets" && kind !== "http_routes",
      )
      .every(({ api }) => api === 1),
  ).toBe(true);
  expect(entries.every(({ declaration_fingerprint }) =>
    /^[a-f0-9]{64}$/u.test(declaration_fingerprint)
  )).toBe(true);
  expect(byKey(entries, "backend_calls", "default").grant).toBe(
    "owner_runtime_grant",
  );
  expect(byKey(entries, "media_sessions", "default")).toMatchObject({
    grant: "owner_runtime_grant",
    toggleable: true,
  });
  expect(byKey(entries, "randomness", "default").grant).toBe("declaration");
  expect(byKey(entries, "chain_key_signing", "a_identity")).toMatchObject({
    grant: "declaration",
    toggleable: true,
  });
  expect(byKey(entries, "https_outcalls", "example")).toMatchObject({
    grant: "declaration",
    toggleable: true,
  });
  expect(byKey(entries, "certified_assets", "default").grant).toBe(
    "declaration",
  );
  expect(
    byKey(entries, "certified_assets", "default").declaration_fingerprint,
  ).toMatch(/^[a-f0-9]{64}$/u);
  expect(byKey(entries, "certified_read_routes", "protocol").grant).toBe(
    "declaration",
  );
  expect(byKey(entries, "certified_read_routes", "shares").grant).toBe(
    "declaration",
  );
  expect(byKey(entries, "http_routes", "webhook").grant).toBe("declaration");
  expect(byKey(entries, "public_ingress", "mail_v1:deliver")).toMatchObject({
    grant: "declaration",
    toggleable: true,
  });
});

test("ephemeral dedicated residents project their exact frame-security authority", () => {
  const ephemeral = manifest();
  delete ephemeral.capabilities!.persistent_browser_storage;
  ephemeral.capabilities!.dedicated_resident_origin = {
    api: 1,
    surface: "background",
    mode: "credentialless_ephemeral_v1",
  };
  const entries = projectRuntimeCapabilityRegistrationsV1(
    buildCapabilityPlan(ephemeral),
  );
  expect(
    byKey(entries, "dedicated_resident_origin", "background"),
  ).toMatchObject({
    format: 1,
    api: 1,
    grant: "declaration",
    toggleable: true,
  });
  expect(
    entries.some(({ kind }) => kind === "persistent_browser_storage"),
  ).toBe(false);
  expect(
    byKey(entries, "dedicated_resident_origin", "background")
      .declaration_fingerprint,
  ).toMatch(/^[a-f0-9]{64}$/);
});

test("runtime projection preflights the kernel's per-app registry bound", () => {
  const candidate = manifest();
  candidate.func!.poll_second = {
    type: "internal",
    arg: ["task_capabilities"],
  };
  candidate.capabilities!.vetkeys!.slots = Array.from(
    { length: 4 },
    (_, index) => ({ id: `slot_${index}`, purpose: `Slot ${index}` }),
  );
  candidate.capabilities!.chain_key_signing!.slots = Array.from(
    { length: 4 },
    (_, index) => ({
      id: `assertion_${index}`,
      algorithm: "schnorr_ed25519" as const,
      purpose: `Assertion ${index}`,
      max_assertion_bytes: 16,
    }),
  );
  candidate.capabilities!.scheduled_tasks!.tasks = [
    {
      id: "poll_first",
      method: "poll",
      interval_seconds: 3_600,
      run_on_start: false,
      max_backend_calls: 1,
    },
    {
      id: "poll_second",
      method: "poll_second",
      interval_seconds: 3_600,
      run_on_start: false,
      max_backend_calls: 1,
    },
  ];
  candidate.capabilities!.connections!.providers = Array.from(
    { length: 8 },
    (_, index) => ({
      provider: `provider_${index}`,
      scopes: [],
    }),
  );
  candidate.capabilities!.public_ingress!.routes = Array.from(
    { length: 31 },
    (_, index) => ({
      protocol: "rpc",
      id: `route_${index}`,
      handler: "ingress_probe",
      mode: "query" as const,
      caller: "any" as const,
      max_request_bytes: 16,
      max_response_bytes: 16,
    }),
  );
  candidate.capabilities!.certified_assets!.collections = Array.from(
    { length: 8 },
    (_, index) => ({
      id: `mount_${index}`,
      mount: `mount_${index}`,
      path_prefix: `/cap-${index}/`,
      kind: "immutable_blob" as const,
    }),
  );

  // Every declaration is at or below its own supported maximum. Four root
  // resources (including the media lease), four private-key slots, four
  // assertion-key slots, two tasks, eight providers, 31 ingress routes, one
  // HTTPS endpoint, one POST route, and eight derived certified read routes
  // compose to the exact 64 bound.
  expect(
    projectRuntimeCapabilityRegistrationsV1(buildCapabilityPlan(candidate)),
  ).toHaveLength(RUNTIME_CAPABILITY_MAX_PER_APP);

  candidate.capabilities!.certified_assets!.collections.push(
    ...[8, 9].map((index) => ({
      id: `mount_${index}`,
      mount: `mount_${index}`,
      path_prefix: `/cap-${index}/`,
      kind: "immutable_blob" as const,
    })),
  );
  expect(() =>
    projectRuntimeCapabilityRegistrationsV1(buildCapabilityPlan(candidate))
  ).toThrow("projects 66 runtime resources; maximum is 64");
});

test("runtime projection rejects forged over-limit plans defensively", () => {
  const plan = structuredClone(buildCapabilityPlan(manifest())) as any;
  const ingress = plan.entries.find(
    (entry: { id: string }) => entry.id === "public_ingress",
  );
  ingress.config.routes = Array.from({ length: 55 }, (_, index) => ({
    protocol: "rpc",
    id: `route_${index}`,
    handler: "ingress_probe",
    mode: "query",
    caller: "any",
    max_request_bytes: 16,
    max_response_bytes: 16,
  }));
  expect(() => projectRuntimeCapabilityRegistrationsV1(plan)).toThrow(
    "projects 70 runtime resources; maximum is 64",
  );
});

test("resource fingerprints are deterministic and change only with authority", () => {
  const first = manifest();
  const second = manifest();
  second.capabilities!.backend_calls!.reservation_scopes.reverse();
  second.capabilities!.connections!.providers[0]!.scopes!.reverse();
  second.capabilities!.vetkeys!.slots.reverse();
  second.capabilities!.chain_key_signing!.slots.reverse();
  second.capabilities!.public_ingress!.routes.reverse();
  second.capabilities!.http_routes!.mounts.reverse();
  second.capabilities!.certified_assets!.collections.reverse();
  second.capabilities!.https_outcalls!.endpoints[0]!.methods.reverse();

  const left = projectRuntimeCapabilityRegistrationsV1(
    buildCapabilityPlan(first),
  );
  const right = projectRuntimeCapabilityRegistrationsV1(
    buildCapabilityPlan(second),
  );
  expect(right).toEqual(left);

  const presentationOnly = manifest();
  presentationOnly.capabilities!.backend_calls!.description = "New description";
  presentationOnly.capabilities!.vetkeys!.description = "New description";
  presentationOnly.capabilities!.vetkeys!.slots[0]!.purpose = "New purpose";
  presentationOnly.capabilities!.chain_key_signing!.slots[0]!.purpose =
    "New assertion purpose";
  const presentation = projectRuntimeCapabilityRegistrationsV1(
    buildCapabilityPlan(presentationOnly),
  );
  expect(
    byKey(presentation, "backend_calls", "default").declaration_fingerprint,
  ).toBe(byKey(left, "backend_calls", "default").declaration_fingerprint);
  expect(byKey(presentation, "vetkeys", "z_key").declaration_fingerprint).toBe(
    byKey(left, "vetkeys", "z_key").declaration_fingerprint,
  );
  expect(
    byKey(presentation, "chain_key_signing", "z_receipts")
      .declaration_fingerprint,
  ).toBe(
    byKey(left, "chain_key_signing", "z_receipts").declaration_fingerprint,
  );

  const narrowed = manifest();
  narrowed.capabilities!.backend_calls!.max_concurrency = 2;
  narrowed.capabilities!.connections!.providers[0]!.scopes = ["models:read"];
  narrowed.capabilities!.scheduled_tasks!.tasks[0]!.max_backend_calls = 1;
  narrowed.capabilities!.certified_assets!.max_entries = 16;
  narrowed.capabilities!.https_outcalls!.endpoints[0]!.max_response_bytes =
    16_384;
  narrowed.capabilities!.chain_key_signing!.slots[0]!.max_assertion_bytes = 512;
  narrowed.capabilities!.public_ingress!.routes.find(
    ({ id }) => id === "deliver",
  )!.required_cycles = 9_000_000;
  const changed = projectRuntimeCapabilityRegistrationsV1(
    buildCapabilityPlan(narrowed),
  );
  expect(byKey(changed, "backend_calls", "default").declaration_fingerprint)
    .not.toBe(byKey(left, "backend_calls", "default").declaration_fingerprint);
  expect(byKey(changed, "connections", "openrouter").declaration_fingerprint)
    .not.toBe(byKey(left, "connections", "openrouter").declaration_fingerprint);
  expect(byKey(changed, "scheduled_tasks", "poll").declaration_fingerprint)
    .not.toBe(byKey(left, "scheduled_tasks", "poll").declaration_fingerprint);
  expect(byKey(changed, "randomness", "default").declaration_fingerprint).toBe(
    byKey(left, "randomness", "default").declaration_fingerprint,
  );
  expect(byKey(changed, "https_outcalls", "example").declaration_fingerprint)
    .not.toBe(
      byKey(left, "https_outcalls", "example").declaration_fingerprint,
    );
  expect(
    byKey(changed, "chain_key_signing", "z_receipts")
      .declaration_fingerprint,
  ).not.toBe(
    byKey(left, "chain_key_signing", "z_receipts").declaration_fingerprint,
  );
  expect(
    byKey(changed, "chain_key_signing", "a_identity")
      .declaration_fingerprint,
  ).toBe(
    byKey(left, "chain_key_signing", "a_identity").declaration_fingerprint,
  );
  expect(
    byKey(changed, "certified_read_routes", "protocol")
      .declaration_fingerprint,
  ).toBe(
    byKey(left, "certified_read_routes", "protocol").declaration_fingerprint,
  );
  expect(
    byKey(changed, "certified_read_routes", "shares").declaration_fingerprint,
  ).toBe(
    byKey(left, "certified_read_routes", "shares").declaration_fingerprint,
  );
  expect(byKey(changed, "http_routes", "webhook").declaration_fingerprint).toBe(
    byKey(left, "http_routes", "webhook").declaration_fingerprint,
  );
  expect(byKey(changed, "certified_assets", "default").declaration_fingerprint)
    .not.toBe(
      byKey(left, "certified_assets", "default").declaration_fingerprint,
    );
  expect(
    byKey(changed, "public_ingress", "mail_v1:deliver")
      .declaration_fingerprint,
  ).not.toBe(
    byKey(left, "public_ingress", "mail_v1:deliver").declaration_fingerprint,
  );
  expect(
    byKey(changed, "public_ingress", "mail_v1:probe")
      .declaration_fingerprint,
  ).toBe(
    byKey(left, "public_ingress", "mail_v1:probe").declaration_fingerprint,
  );

  const changedAuthorityPlan = structuredClone(
    buildCapabilityPlan(manifest()),
  ) as any;
  changedAuthorityPlan.entries
    .find(({ id }: { id: string }) => id === "certified_read_routes")
    .config.mounts.find(
      ({ id }: { id: string }) => id === "protocol",
    ).authority_mode = "exact_neutron_host_v1";
  const changedAuthority = projectRuntimeCapabilityRegistrationsV1(
    changedAuthorityPlan,
  );
  expect(
    byKey(changedAuthority, "certified_read_routes", "protocol")
      .declaration_fingerprint,
  ).not.toBe(
    byKey(left, "certified_read_routes", "protocol").declaration_fingerprint,
  );
  expect(
    byKey(changedAuthority, "certified_read_routes", "shares")
      .declaration_fingerprint,
  ).toBe(
    byKey(left, "certified_read_routes", "shares").declaration_fingerprint,
  );
  expect(byKey(changedAuthority, "http_routes", "webhook").declaration_fingerprint).toBe(
    byKey(left, "http_routes", "webhook").declaration_fingerprint,
  );
});

test("http_post_update_handler registration fingerprints its exact bounded authority", () => {
  const updateManifest = (): NeutronManifest => ({
    format: 3,
    id: "hook_runtime",
    name: "Hook Runtime",
    version: 100,
    func: { receive: { type: "internal", async: false } },
    capabilities: {
      http_routes: {
        api: 1,
        mounts: [
          {
            id: "receive",
            surface: "app_host",
            prefix: "/hook",
            methods: ["POST"],
            mode: "http_post_update_handler",
            handler: "receive",
            max_request_bytes: 8192,
            max_response_bytes: 2048,
            max_calls_per_hour: 60,
            forward_headers: ["x-signature", "content-type"],
          },
        ],
      },
    },
  });

  const baseline = projectRuntimeCapabilityRegistrationsV1(
    buildCapabilityPlan(updateManifest()),
  );
  expect(baseline).toHaveLength(1);
  expect(baseline[0]).toMatchObject({
    kind: "http_routes",
    resource_id: "receive",
    api: 1,
    grant: "declaration",
    toggleable: true,
  });

  const reordered = updateManifest();
  const reorderedMount = reordered.capabilities!.http_routes!.mounts[0]!;
  if (reorderedMount.mode !== "http_post_update_handler") throw new Error("fixture");
  reorderedMount.forward_headers.reverse();
  expect(
    projectRuntimeCapabilityRegistrationsV1(buildCapabilityPlan(reordered)),
  ).toEqual(baseline);

  const narrowed = updateManifest();
  const narrowedMount = narrowed.capabilities!.http_routes!.mounts[0]!;
  if (narrowedMount.mode !== "http_post_update_handler") throw new Error("fixture");
  narrowedMount.max_calls_per_hour = 30;
  expect(
    projectRuntimeCapabilityRegistrationsV1(buildCapabilityPlan(narrowed))[0]!
      .declaration_fingerprint,
  ).not.toBe(baseline[0]!.declaration_fingerprint);
});

test("structural-only plans produce no runtime registry records", () => {
  const entries = projectRuntimeCapabilityRegistrationsV1(
    buildCapabilityPlan({
      format: 3,
      id: "plain_app",
      name: "Plain",
      version: 100,
      tiles: [{ id: "main", title: "Main", path: "index.html" }],
      memory: {
        plain: {
          version: 1,
          schemas: { "1": { src: "memory/v1.mo" } },
          migrations: [],
        },
      },
    }),
  );
  expect(entries).toEqual([]);
});

test("stable_store projects exact per-store authority without presentation metadata", () => {
  const stableManifest = (purpose: string, schemaVersion: number, maxBytes = 65_536): NeutronManifest => ({
    format: 3,
    id: "store_app",
    name: "Store App",
    version: 100,
    capabilities: {
      stable_store: {
        api: 1,
        stores: [{
          id: "notes",
          purpose,
          schema_version: schemaVersion,
          max_entries: 64,
          max_key_bytes: 64,
          max_value_bytes: 4096,
          max_bytes: maxBytes,
        }],
      },
    },
  });
  const baseline = projectRuntimeCapabilityRegistrationsV1(
    buildCapabilityPlan(stableManifest("Keep notes", 1)),
  );
  expect(baseline).toHaveLength(1);
  expect(baseline[0]).toMatchObject({
    kind: "stable_store",
    resource_id: "notes",
    grant: "declaration",
    toggleable: true,
  });
  expect(
    projectRuntimeCapabilityRegistrationsV1(
      buildCapabilityPlan(stableManifest("Different untrusted purpose", 2)),
    )[0]!.declaration_fingerprint,
  ).toBe(baseline[0]!.declaration_fingerprint);
  expect(
    projectRuntimeCapabilityRegistrationsV1(
      buildCapabilityPlan(stableManifest("Keep notes", 1, 32_768)),
    )[0]!.declaration_fingerprint,
  ).not.toBe(baseline[0]!.declaration_fingerprint);
});
