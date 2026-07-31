import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConsentTechnicalDetails,
} from "../src/consent/ConsentPresentation.tsx";
import {
  PermissionConsequences,
  permissionConsequences,
} from "../src/consent/PermissionConsequences.tsx";
import type { Permission } from "../src/lib/perm.ts";
import { IDL } from "@dfinity/candid";
import { verifiedCallMode } from "../src/trusted_call_mode.ts";

test("developer mode expands the same technical details normal mode keeps optional", () => {
  const normal = renderToStaticMarkup(
    <ConsentTechnicalDetails mode="normal">
      <code>exact-app-id</code>
    </ConsentTechnicalDetails>,
  );
  const developer = renderToStaticMarkup(
    <ConsentTechnicalDetails mode="developer">
      <code>exact-app-id</code>
    </ConsentTechnicalDetails>,
  );

  expect(detailsTag(normal)).not.toContain(" open");
  expect(detailsTag(developer)).toContain('open=""');
  expect(normal).toContain("Technical details");
  expect(normal).toContain("exact-app-id");
  expect(developer).toContain("exact-app-id");
});

test("normal consent has a consequence for every verified permission kind", () => {
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
  expect(html).toContain("Control Neutron itself");
  expect(html).toContain("as often as 1 day");
  expect(html).toContain("Use verified backend request context");
  expect(html).not.toContain("raw_context_method");
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
