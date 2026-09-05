import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConsentTechnicalDetails,
} from "../src/consent/ConsentPresentation.tsx";
import {
  PermissionConsequences,
  permissionConsequences,
  getPermissionChangesForReview,
} from "../src/consent/PermissionConsequences.tsx";
import { compactPermissionConsequences } from "../src/consent/compact_permission_summary.ts";
import { CapabilityChangeSummary } from "../src/consent/CapabilityChangeSummary.tsx";
import { buildCapabilityPlan } from "neutron-tools/src/capabilities/plan.js";
import { diffCapabilityPlans } from "neutron-tools/src/capabilities/wire.js";
import type { Permission } from "../src/lib/perm.ts";
import { IDL } from "@dfinity/candid";
import { verifiedCallMode } from "../src/trusted_call_mode.ts";

test("developer mode expands technical details while omission starts collapsed", () => {
  const collapsed = renderToStaticMarkup(
    <ConsentTechnicalDetails>
      <code>exact-app-id</code>
    </ConsentTechnicalDetails>,
  );
  const developer = renderToStaticMarkup(
    <ConsentTechnicalDetails mode="developer">
      <code>exact-app-id</code>
    </ConsentTechnicalDetails>,
  );

  expect(detailsTag(collapsed)).not.toContain(" open");
  expect(detailsTag(developer)).toContain('open=""');
  expect(collapsed).toContain("Technical details");
  expect(collapsed).toContain("exact-app-id");
  expect(developer).toContain("exact-app-id");
});

test("detailed consent has a consequence for every verified permission kind", () => {
  for (const permission of Object.values(representativePermissions)) {
    const consequences = permissionConsequences([permission as Permission]);
    expect(consequences.length).toBeGreaterThan(0);
  }
});

test("material danger is shown first while technical identifiers stay out of the summary", () => {
  const permissions: Permission[] = [
    representativePermissions.function_resources,
    representativePermissions.scheduled_task,
    representativePermissions.backend_calls,
    representativePermissions.kernel_replacement,
  ];
  const consequences = permissionConsequences(permissions);
  const html = renderToStaticMarkup(
    <PermissionConsequences permissions={permissions} />,
  );

  expect(consequences[0]?.id).toBe("system");
  expect(consequences[0]?.level).toBe(4);
  expect(html).toContain("Full Neutron control");
  expect(html).toContain("Scheduled work can run even when Neutron is closed");
  expect(html).not.toContain("Use verified backend request context");
  expect(html).not.toContain("raw_context_method");
});

test("browser-device consequences disclose requestable access without claiming use", () => {
  const html = renderToStaticMarkup(
    <PermissionConsequences
      permissions={[representativePermissions.browser_permissions]}
    />,
  );
  expect(html).toContain("Camera and microphone");
  expect(html).toContain("Can ask your browser for access");
  expect(html).toContain("Installing does not turn a device on");
  expect(html).toContain("while the app view is open, even when hidden");
  expect(html).not.toContain("tile `call`");
  expect(html).not.toContain("currently active");
  expect(html).not.toContain("camera is active");

  const microphoneHtml = renderToStaticMarkup(
    <PermissionConsequences
      permissions={[
        {
          source: "kernel",
          kind: "browser_permissions",
          tiles: [{ id: "call", features: ["microphone"] }],
        },
      ]}
    />,
  );
  expect(microphoneHtml).toContain("Microphone");
  expect(microphoneHtml).not.toContain("Camera");

  const developerHtml = renderToStaticMarkup(<PermissionConsequences
    mode="developer" permissions={[representativePermissions.browser_permissions]}
  />);
  expect(developerHtml).toContain("Allow tile `call` to request access to cameras");
  expect(developerHtml).toContain("browser&#x27;s device indicator remains authoritative");
});

test("normal permission rows are shorter while retaining meaningful consequences", () => {
  const permissions = Object.values(representativePermissions);
  const normal = renderToStaticMarkup(<PermissionConsequences mode="normal" permissions={permissions} />);
  const developer = renderToStaticMarkup(<PermissionConsequences mode="developer" permissions={permissions} />);
  const wordCount = (html: string) => html.replace(/<[^>]*>/gu, " ").trim().split(/\s+/u).length;
  expect(wordCount(normal)).toBeLessThan(wordCount(developer) * 0.65);
  expect(normal).not.toContain("High impact");
  expect(normal).not.toContain("Reviewed interface");
  expect(normal).toContain("Can permanently delete stored app data");
  expect(normal).toContain("Published data is public and not encrypted");
  expect(normal).toContain("without asking each time");
  expect(normal).toContain("separate approval");
  expect(normal).toContain("disabling access cannot erase copies");
  expect(developer).toContain("Use verified backend request context");
});

test("normal review distinguishes future broad requests from grants created now", () => {
  const backend = { ...representativePermissions.backend_calls, reservationScopes: ["exact", "principal"] as const };
  const future = compactPermissionConsequences([backend]);
  expect(future[0]?.description).toContain("no destination is approved here");
  expect(future[0]?.description).not.toContain("Gets broad");
  const exact = compactPermissionConsequences([{ ...backend, installReservations: [{ kind: "exact", principal: "aaaaa-aa", method: "ping" }] }]);
  expect(exact[0]?.description).toContain("Gets specific ongoing access");
  expect(exact[0]?.description).not.toContain("Gets broad");
  const broad = compactPermissionConsequences([{ ...backend, installReservations: [{ kind: "principal", principal: "aaaaa-aa" }] }]);
  expect(broad[0]?.description).toContain("Gets broad ongoing access");
  expect(broad[0]?.description).toContain("until revoked");
});

test("update spotlight keeps system and deletion risks even without permission changes", () => {
  const previous = buildCapabilityPlan({ format: 3, id: "example", name: "Example", version: 100 });
  const target = buildCapabilityPlan({ format: 3, id: "example", name: "Example", version: 101 });
  const diff = diffCapabilityPlans(previous, target);
  const permissions = [representativePermissions.kernel_replacement, representativePermissions.memory_retirement, representativePermissions.stable_store];
  expect(getPermissionChangesForReview(permissions, diff)).toEqual(permissions.slice(0, 2));
  expect(getPermissionChangesForReview([representativePermissions.stable_store], diff)).toEqual([]);
  expect(getPermissionChangesForReview(permissions, undefined)).toBe(permissions);
  const normal = renderToStaticMarkup(<CapabilityChangeSummary diff={diff} mode="normal" />);
  expect(normal).toContain("Permissions unchanged.");
  expect(normal).not.toContain("structured permission plan");
});

test("signed-call consent derives read versus change only from live Candid", () => {
  const target = {
    $idlFactory: ({ IDL: FactoryIDL }: { IDL: typeof IDL }) =>
      FactoryIDL.Service({
        read_name: FactoryIDL.Func([], [FactoryIDL.Text], ["query"]),
        composite_read: FactoryIDL.Func(
          [],
          [FactoryIDL.Text],
          ["composite_query"],
        ),
        change_name: FactoryIDL.Func([FactoryIDL.Text], [], []),
      }),
  };

  expect(verifiedCallMode(target, "read_name")).toBe("query");
  expect(verifiedCallMode(target, "composite_read")).toBe("query");
  expect(verifiedCallMode(target, "change_name")).toBe("update");
  expect(verifiedCallMode(target, "missing")).toBeUndefined();
  expect(verifiedCallMode({}, "read_name")).toBeUndefined();
  expect(
    verifiedCallMode(
      {
        $idlFactory: () => {
          throw new Error("malformed live Candid");
        },
      },
      "read_name",
    ),
  ).toBeUndefined();
});

const representativePermissions = {
  kernel_replacement: {
    source: "kernel",
    kind: "kernel_replacement",
  },
  persistent_background_storage: {
    source: "kernel",
    kind: "persistent_background_storage",
  },
  dedicated_resident_origin: {
    source: "kernel",
    kind: "dedicated_resident_origin",
  },
  browser_permissions: {
    source: "kernel",
    kind: "browser_permissions",
    tiles: [{ id: "call", features: ["camera", "microphone"] }],
  },
  backend_calls: {
    source: "kernel",
    kind: "backend_calls",
    reservationScopes: ["exact"],
    maxConcurrency: 2,
    maxCyclesPerCall: 0,
    maxCyclesPerDay: 0,
  },
  randomness: {
    source: "kernel",
    kind: "randomness",
  },
  chain_key_signing: {
    source: "kernel",
    kind: "chain_key_signing",
    slots: [
      {
        id: "login",
        algorithm: "ed25519",
        maxAssertionBytes: 1_024,
      },
    ],
  },
  stable_store: {
    source: "kernel",
    kind: "stable_store",
    stores: [
      {
        id: "records",
        schemaVersion: 1,
        maxEntries: 10,
        maxKeyBytes: 64,
        maxValueBytes: 1_024,
        maxBytes: 10_240,
      },
    ],
  },
  https_outcalls: {
    source: "kernel",
    kind: "https_outcalls",
    endpoints: [
      {
        id: "service",
        urlPrefix: "https://api.example/v1/",
        methods: ["get"],
        requestHeaders: [],
        maxRequestBytes: 0,
        maxResponseBytes: 1_024,
        transform: "strip_headers",
      },
    ],
  },
  public_ingress_route: {
    source: "kernel",
    kind: "public_ingress_route",
    protocol: "example",
    method: "read",
    handler: "read_public",
    mode: "query",
    caller: "any",
    maxRequestBytes: 128,
    maxResponseBytes: 1_024,
  },
  http_route: {
    source: "kernel",
    kind: "http_route",
    id: "objects",
    surface: "shared_app_path",
    publicPath: "/app/example/_route/objects",
    methods: ["GET"],
    mode: "certified_store",
    authorityMode: "exact_neutron_host_v1",
    store: "certified_assets",
    maxRequestBytes: 0,
  },
  certified_assets: {
    source: "kernel",
    kind: "certified_assets",
    maxEntries: 10,
    maxCommittedBytes: 10_240,
    maxObjectBytes: 1_024,
    maxPendingStages: 1,
    maxStagedBytes: 1_024,
    maxBatchOperations: 2,
    maxBatchBytes: 2_048,
    maxIdempotencyReceipts: 16,
    collections: [],
  },
  vetkeys: {
    source: "kernel",
    kind: "vetkeys",
    slots: [{ id: "vault" }],
  },
  preapproved_self_call: {
    source: "kernel",
    kind: "preapproved_self_call",
    method: "read",
    mode: "query",
  },
  agent_entrypoint: {
    source: "kernel",
    kind: "agent_entrypoint",
    entrypoint: "assistant",
  },
  scheduled_task: {
    source: "kernel",
    kind: "scheduled_task",
    id: "daily",
    method: "run_daily",
    intervalSeconds: 86_400,
    runOnStart: false,
    maxBackendCalls: 1,
  },
  background_ui_request: {
    source: "kernel",
    kind: "background_ui_request",
    category: "frontend_tool",
  },
  ethereum_provider: {
    source: "kernel",
    kind: "ethereum_provider",
    chains: [1],
    methods: ["eth_chainId"],
  },
  app_dependency: {
    source: "kernel",
    kind: "app_dependency",
    app: "contacts",
    minVersion: 100,
    functions: ["search"],
  },
  connection: {
    source: "kernel",
    kind: "connection",
    provider: "openrouter",
    scopes: [],
  },
  internal_app_function: {
    source: "kernel",
    kind: "internal_app_function",
    method: "search",
  },
  function_resources: {
    source: "kernel",
    kind: "function_resources",
    method: "raw_context_method",
    mode: "query",
    resources: [{ kind: "caller" }],
  },
  public_method: {
    source: "kernel",
    kind: "public_method",
    method: "health",
    mode: "query",
    allow: "unauthorized",
  },
  kernel_memory_replacement: {
    source: "kernel",
    kind: "kernel_memory_replacement",
  },
  memory_retirement: {
    source: "kernel",
    kind: "memory_retirement",
    memoryId: "old",
    consolidation: false,
  },
} satisfies {
  [K in Permission["kind"]]: Extract<Permission, { kind: K }>;
};

function detailsTag(html: string): string {
  const match = html.match(/<details[^>]*>/u);
  if (!match) throw new Error("Missing details element");
  return match[0];
}
