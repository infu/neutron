import { expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import type { AppRegistry } from "neutron-compiler/src/install.js";
import type { AppInstanceProjection } from "../src/app_scope.ts";
import { ResidentFrameSecurityMode } from "../src/capabilities/plan.ts";
import { runtimeCapabilityRegistrations } from "../src/capabilities/plan.ts";
import {
  CAPABILITY_REGISTRY_PAGE_LIMIT,
  capabilitySummaryKey,
  loadCapabilityRegistry,
  parseCapabilityPage,
  parseCapabilitySummary,
  reconcileCapabilityRegistry,
  replaceCapabilitySummary,
  setCapabilityRegistryEnabled,
  type CapabilityKindWire,
  type CapabilitySummary,
  type CapabilitySummaryWire,
} from "../src/settings/capability_registry.ts";
import { registryApp } from "./app_registry_fixture.ts";

const principal = Principal.fromText("aaaaa-aa");

function fixture() {
  const entry = registryApp({
    id: "runtime_app",
    name: "Runtime App",
    version: 102,
    backend: { capabilities: { certified_assets: { api: 2 } } },
    capabilities: {
      backend_calls: {
        api: 1,
        description: "Remote state",
        reservation_scopes: ["exact"],
        max_concurrency: 2,
        max_cycles_per_call: 0,
        max_cycles_per_day: 0,
      },
      randomness: { api: 1 },
      chain_key_signing: {
        api: 1,
        slots: [
          {
            id: "login_assertion",
            algorithm: "ecdsa_secp256k1",
            purpose: "Sign login assertions",
            max_assertion_bytes: 1024,
          },
          {
            id: "receipt",
            algorithm: "schnorr_ed25519",
            purpose: "Sign receipts",
            max_assertion_bytes: 4096,
          },
        ],
      },
      stable_store: {
        api: 1,
        stores: [{
          id: "notes",
          purpose: "Keep durable notes",
          schema_version: 2,
          max_entries: 64,
          max_key_bytes: 48,
          max_value_bytes: 4096,
          max_bytes: 65_536,
        }],
      },
      https_outcalls: {
        api: 1,
        endpoints: [{
          id: "status_api",
          url_prefix: "https://status.example.com/",
          methods: ["get"],
          request_headers: [],
          max_request_bytes: 4096,
          max_response_bytes: 4096,
          transform: "strip_headers",
        }],
      },
      vetkeys: {
        api: 1,
        description: "Private data",
        slots: [{ id: "private_data", purpose: "Private state" }],
      },
      public_ingress: {
        api: 1,
        routes: [{
          protocol: "runtime_v1",
          id: "status",
          handler: "runtime_status",
          mode: "query",
          caller: "authenticated",
          max_request_bytes: 128,
          max_response_bytes: 1024,
        }],
      },
      certified_assets: {
        api: 2,
        max_entries: 32,
        max_committed_bytes: 1_048_576,
        max_object_bytes: 1_048_576,
        max_pending_stages: 1,
        max_staged_bytes: 1_048_576,
        max_batch_operations: 1,
        max_batch_bytes: 1_048_576,
        max_idempotency_receipts: 32,
        collections: [
          {
            id: "public_data",
            mount: "public_data",
            kind: "publication",
          },
        ],
      },
    },
    func: { runtime_status: { type: "query" } },
  });
  const apps: AppRegistry = { runtime_app: entry };
  const instance: AppInstanceProjection = Object.freeze({
    scope: Object.freeze({ appId: "runtime_app", installationUid: "7" }),
    version: 102,
    deploymentId: "deployment",
    capabilityPlanFingerprint: entry.capability_plan_fingerprint,
    browserOriginNonce: "0".repeat(32),
    browserOriginAuthorityEpoch: "1",
    residentFrameSecurity:
      ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1,
  });
  const appInstances = Object.freeze({ runtime_app: instance });
  const registrations = runtimeCapabilityRegistrations(entry);
  const wire = registrations.map((registration, index) =>
    summaryWire({
      registration,
      planFingerprint: entry.capability_plan_fingerprint,
      timestamp: 1_700_000_000_000_000_000n + BigInt(index),
    }),
  );
  return { appInstances, apps, entry, instance, registrations, wire };
}

function summaryWire({
  enabled = true,
  planFingerprint,
  registration,
  timestamp = 1_700_000_000_000_000_000n,
}: {
  enabled?: boolean;
  planFingerprint: string;
  registration: ReturnType<typeof runtimeCapabilityRegistrations>[number];
  timestamp?: bigint;
}): CapabilitySummaryWire {
  return {
    scope: { app_id: "runtime_app", installation_uid: 7n },
    plan_fingerprint: planFingerprint,
    kind: { [registration.kind]: null } as CapabilityKindWire,
    resource_id: registration.resource_id,
    api: BigInt(registration.api),
    declaration_fingerprint: registration.declaration_fingerprint,
    grant: { [registration.grant]: null } as CapabilitySummaryWire["grant"],
    toggleable: registration.toggleable,
    enabled,
    created_at: timestamp,
    created_by: principal,
    updated_at: timestamp,
    updated_by: principal,
    usage: {
      total: 0n,
      succeeded: 0n,
      denied: 0n,
      failed: 0n,
      rate_limited: 0n,
      busy: 0n,
      revoked: 0n,
      last_at: [],
      last_operation: [],
      last_outcome: [],
    },
  };
}

test("capability summaries strictly parse closed Candid records and variants", () => {
  const { wire } = fixture();
  const parsed = parseCapabilitySummary(wire[0]);
  expect(parsed.appId).toBe("runtime_app");
  expect(parsed.installationUid).toBe("7");
  expect(parsed.createdBy).toBe("aaaaa-aa");
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.usage)).toBe(true);

  expect(() =>
    parseCapabilitySummary({ ...wire[0], unexpected: true }),
  ).toThrow("unknown or missing fields");
  expect(() =>
    parseCapabilitySummary({
      ...wire[0],
      kind: { backend_calls: null, randomness: null },
    }),
  ).toThrow("capability kind is invalid");
  expect(() =>
    parseCapabilitySummary({
      ...wire[0],
      grant: { declaration: "yes" },
    }),
  ).toThrow("capability grant is invalid");
  expect(() =>
    parseCapabilitySummary({
      ...wire[0],
      grant: { declaration: null },
    }),
  ).toThrow("grant does not match its kind");
  expect(() =>
    parseCapabilitySummary({ ...wire[0], resource_id: "not-default" }),
  ).toThrow("resource id does not match its kind");
  const certifiedRoute = wire.find(
    ({ kind }) => "certified_read_routes" in kind,
  )!;
  const postRoute = {
    ...certifiedRoute,
    kind: { http_routes: null },
  } satisfies CapabilitySummaryWire;
  const assets = wire.find(({ kind }) => "certified_assets" in kind)!;
  const publicIngress = wire.find(({ kind }) => "public_ingress" in kind)!;
  const httpsOutcall = wire.find(({ kind }) => "https_outcalls" in kind)!;
  const chainKeySlot = wire.find(
    ({ kind, resource_id }) =>
      "chain_key_signing" in kind && resource_id === "login_assertion",
  )!;
  const stableStore = wire.find(({ kind }) => "stable_store" in kind)!;
  const dedicatedOrigin = {
    ...wire[0]!,
    kind: { dedicated_resident_origin: null },
    resource_id: "background",
    grant: { declaration: null },
  } satisfies CapabilitySummaryWire;
  expect(parseCapabilitySummary(certifiedRoute).resourceId).toBe("public_data");
  expect(parseCapabilitySummary(certifiedRoute).api).toBe(1);
  expect(parseCapabilitySummary(postRoute).kind).toBe("http_routes");
  expect(parseCapabilitySummary(postRoute).api).toBe(1);
  expect(parseCapabilitySummary(assets).resourceId).toBe("default");
  expect(parseCapabilitySummary(assets).api).toBe(2);
  expect(parseCapabilitySummary(publicIngress).resourceId).toBe(
    "runtime_v1:status",
  );
  expect(parseCapabilitySummary(httpsOutcall).resourceId).toBe("status_api");
  expect(parseCapabilitySummary(chainKeySlot).resourceId).toBe(
    "login_assertion",
  );
  expect(parseCapabilitySummary(stableStore).resourceId).toBe("notes");
  expect(parseCapabilitySummary(dedicatedOrigin).resourceId).toBe("background");
  expect(() =>
    parseCapabilitySummary({ ...certifiedRoute, resource_id: "Bad-Mount" }),
  ).toThrow("resource id does not match its kind");
  expect(() =>
    parseCapabilitySummary({ ...assets, resource_id: "public_data" }),
  ).toThrow("resource id does not match its kind");
  expect(() =>
    parseCapabilitySummary({ ...assets, api: 1n }),
  ).toThrow("Capability registry API is unsupported");
  expect(() =>
    parseCapabilitySummary({ ...certifiedRoute, api: 2n }),
  ).toThrow("Capability registry API is unsupported");
  expect(() =>
    parseCapabilitySummary({ ...postRoute, api: 2n }),
  ).toThrow("Capability registry API is unsupported");
  expect(() =>
    parseCapabilitySummary({ ...wire[0], api: 2n }),
  ).toThrow("Capability registry API is unsupported");
  expect(() =>
    parseCapabilitySummary({ ...publicIngress, resource_id: "runtime_v1" }),
  ).toThrow("resource id does not match its kind");
  expect(() =>
    parseCapabilitySummary({ ...publicIngress, resource_id: "Runtime:status" }),
  ).toThrow("resource id does not match its kind");
  expect(() =>
    parseCapabilitySummary({ ...httpsOutcall, resource_id: "Bad-Endpoint" }),
  ).toThrow("resource id does not match its kind");
  expect(() =>
    parseCapabilitySummary({ ...chainKeySlot, resource_id: "Bad-Slot" }),
  ).toThrow("resource id does not match its kind");
  expect(() =>
    parseCapabilitySummary({ ...stableStore, resource_id: "Bad-Store" }),
  ).toThrow("resource id does not match its kind");
  expect(() =>
    parseCapabilitySummary({ ...dedicatedOrigin, resource_id: "other" }),
  ).toThrow("resource id does not match its kind");
  expect(() =>
    parseCapabilitySummary({
      ...wire[0],
      usage: {
        ...wire[0]!.usage,
        total: Number.MAX_SAFE_INTEGER + 1,
      },
    }),
  ).toThrow("not a safe Nat");
  expect(() =>
    parseCapabilitySummary({
      ...wire[0],
      scope: { ...wire[0]!.scope, installation_uid: 1n << 64n },
    }),
  ).toThrow("exceeds Nat64");
  expect(() =>
    parseCapabilitySummary({
      ...wire[0],
      usage: { ...wire[0]!.usage, last_at: [1n, 2n] },
    }),
  ).toThrow("option is invalid");
  expect(() =>
    parseCapabilitySummary({
      ...wire[0],
      usage: { ...wire[0]!.usage, total: 2n },
    }),
  ).toThrow("usage counters are invalid");
  expect(() =>
    parseCapabilitySummary({
      ...wire[0],
      usage: {
        ...wire[0]!.usage,
        total: 1n,
        succeeded: 1n,
        last_at: [1n],
        last_operation: ["call"],
        last_outcome: [{ mystery: null }],
      },
    }),
  ).toThrow("last outcome is invalid");
});

test("capability page parser rejects oversized pages and malformed cursors", () => {
  const { wire } = fixture();
  expect(parseCapabilityPage({ entries: wire, next: [] }).entries).toHaveLength(
    wire.length,
  );
  expect(() =>
    parseCapabilityPage({
      entries: Array.from({ length: 101 }, () => wire[0]),
      next: [],
    }),
  ).toThrow("exceeds its requested limit");
  expect(() => parseCapabilityPage({ entries: [], next: ["a", "b"] })).toThrow(
    "option is invalid",
  );
});

test("capability inventory loader follows bounded pagination and rejects repeats", async () => {
  const { wire } = fixture();
  const requests: unknown[] = [];
  const firstCursor = capabilitySummaryKey(parseCapabilitySummary(wire[0]));
  const pages = [
    { entries: wire.slice(0, 1), next: [firstCursor] },
    { entries: wire.slice(1), next: [] },
  ];
  const entries = await loadCapabilityRegistry({
    async kernel_capabilities_page(request) {
      requests.push(request);
      return pages.shift();
    },
  });
  expect(entries).toHaveLength(wire.length);
  expect(requests).toEqual([
    { after: [], limit: CAPABILITY_REGISTRY_PAGE_LIMIT },
    { after: [firstCursor], limit: CAPABILITY_REGISTRY_PAGE_LIMIT },
  ]);

  await expect(
    loadCapabilityRegistry({
      async kernel_capabilities_page() {
        return { entries: [wire[0], wire[0]], next: [] };
      },
    }),
  ).rejects.toThrow("Duplicate capability registry resource");

  await expect(
    loadCapabilityRegistry({
      async kernel_capabilities_page() {
        return {
          entries: [wire[0]],
          next: ["not-the-entry-key"],
        };
      },
    }),
  ).rejects.toThrow("cursor does not match its page");
});

test("capability inventory reconciles exact active app scopes and verified plans", () => {
  const { appInstances, apps, wire } = fixture();
  const parsed = wire.map(parseCapabilitySummary);
  const reconciled = reconcileCapabilityRegistry(apps, appInstances, parsed);
  expect(reconciled.entries).toHaveLength(10);
  expect(reconciled.byApp.runtime_app).toHaveLength(10);

  expect(() =>
    reconcileCapabilityRegistry(apps, appInstances, parsed.slice(1)),
  ).toThrow("Missing capability registry resource");
  expect(() =>
    reconcileCapabilityRegistry(apps, appInstances, [...parsed, parsed[0]!]),
  ).toThrow("Duplicate capability registry resource");
  expect(() =>
    reconcileCapabilityRegistry(apps, appInstances, [
      { ...parsed[0]!, resourceId: "undeclared" },
      ...parsed.slice(1),
    ]),
  ).toThrow("Unknown active capability resource");
  expect(() =>
    reconcileCapabilityRegistry(apps, appInstances, [
      { ...parsed[0]!, installationUid: "8" },
      ...parsed.slice(1),
    ]),
  ).toThrow("stale installation");
  expect(() =>
    reconcileCapabilityRegistry(apps, appInstances, [
      { ...parsed[0]!, planFingerprint: "f".repeat(64) },
      ...parsed.slice(1),
    ]),
  ).toThrow("mismatched plan fingerprint");
  expect(() =>
    reconcileCapabilityRegistry(apps, appInstances, [
      { ...parsed[0]!, declarationFingerprint: "f".repeat(64) },
      ...parsed.slice(1),
    ]),
  ).toThrow("does not match its verified plan");
  expect(() =>
    reconcileCapabilityRegistry(
      apps,
      {
        runtime_app: {
          ...appInstances.runtime_app!,
          version: 103,
        },
      },
      parsed,
    ),
  ).toThrow("version or identity is stale");
});

test("capability toggle accepts only the canister-returned matching resource", async () => {
  const { wire } = fixture();
  const current = parseCapabilitySummary(wire[0]);
  let request: unknown;
  const updated = await setCapabilityRegistryEnabled(
    {
      async kernel_capability_set_enabled(input) {
        request = input;
        return {
          ...wire[0],
          enabled: false,
          updated_at: wire[0]!.updated_at as bigint,
          usage: {
            ...wire[0]!.usage,
            total: 1n,
            succeeded: 1n,
            last_at: [wire[0]!.updated_at as bigint],
            last_operation: ["disable"],
            last_outcome: [{ ok: null }],
          },
        };
      },
    },
    current,
    false,
  );
  expect(request).toMatchObject({
    app_id: "runtime_app",
    installation_uid: 7n,
    enabled: false,
  });
  expect(updated.enabled).toBe(false);
  expect(replaceCapabilitySummary([current], updated)).toEqual([updated]);

  await expect(
    setCapabilityRegistryEnabled(
      {
        async kernel_capability_set_enabled() {
          return {
            ...wire[0],
            kind: { randomness: null },
            grant: { declaration: null },
            enabled: false,
          };
        },
      },
      current,
      false,
    ),
  ).rejects.toThrow("different resource");

  await expect(
    setCapabilityRegistryEnabled(
      {
        async kernel_capability_set_enabled() {
          throw new Error("must not call");
        },
      },
      { ...current, toggleable: false } as CapabilitySummary,
      false,
    ),
  ).rejects.toThrow("cannot be toggled");
});
