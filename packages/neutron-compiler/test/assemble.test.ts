import { expect, test } from "bun:test";
import {
  appPhysicalStem,
  physicalAppMethodName,
  physicalPublicIngressMethodName,
  scopedPhysicalStem,
} from "neutron-tools/src/physical_names.js";
import { buildCapabilityPlan } from "neutron-tools/src/capabilities/plan.js";
import { projectRuntimeCapabilityRegistrationsV1 } from "neutron-tools/src/capabilities/runtime.js";
import {
  BACKEND_CALLS_MAX_INSTALL_RESERVATIONS_GLOBAL,
  CONNECTIONS_MAX_PROVIDERS_GLOBAL,
  VETKEYS_MAX_SLOTS_GLOBAL,
  publicIngressResourceId,
} from "neutron-tools/src/capabilities/catalog.js";
import {
  ASSEMBLER_ID,
  BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID,
  assemble,
  assembleLegacyV25,
  LEGACY_V25_ASSEMBLER_ID,
  NEUTRON_INSTALLED_APP_LIMIT,
  NEUTRON_RESIDENT_BACKGROUND_LIMIT,
  NEUTRON_SCHEDULED_TASK_LIMIT,
  supportsBrowserSurfaceOrigins,
} from "../src/assemble.ts";
import type { AssemblyManifest } from "../src/assemble.ts";
import { trustedInstallationContextFromRootKey } from "../src/installation_context.ts";

const kernelConfig: AssemblyManifest = {
  format: 3,
  id: "kernel",
  name: "Kernel",
  version: 100,
  src: "main.mo",
  entry: "kernel",
  init_arg: ["memory_kernel"],
  func: {
    is_authorized: { type: "internal", async: false },
    kernel_install_code: { type: "update", async: true, arg: ["this"] },
    kernel_install_commit: {
      type: "update",
      async: false,
      arg: ["caller"],
    },
    kernel_install_reservations_prepare: {
      type: "update",
      async: false,
      arg: ["caller"],
    },
    kernel_connections_begin: {
      type: "update",
      async: "async*",
      arg: ["caller", "this"],
    },
    kernel_https_outcall_transform: {
      type: "query",
      async: false,
      arg: ["caller"],
      allow: "unauthorized",
    },
  },
  memory: {
    kernel: {
      version: 1,
      schemas: { "1": { src: "memory/kernel.mo" } },
      migrations: [],
    },
  },
};

test("browser surface origins require the v26 assembler", () => {
  expect(ASSEMBLER_ID).toBe(BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID);
  expect(
    supportsBrowserSurfaceOrigins(BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID),
  ).toBe(true);
  expect(supportsBrowserSurfaceOrigins("neutron_actor_v25")).toBe(false);
  expect(supportsBrowserSurfaceOrigins("neutron_actor_unknown")).toBe(false);
  const source = assemble({ kernel: kernelConfig });
  expect(source).not.toContain(
    "configure_app_browser_surfaces",
  );
  expect(source).toContain("capability_authority_revision : ?Nat64");
  expect(source).toContain("capability_authority_revision = null");
  expect(source).not.toContain(
    `${initName("kernel")}.capability_authority_revision()`,
  );
  const revisionSource = assemble({
    kernel: {
      ...kernelConfig,
      func: {
        ...kernelConfig.func,
        capability_authority_revision: {
          type: "internal",
          async: false,
        },
      },
    },
  });
  expect(revisionSource).toContain(
    `capability_authority_revision = ?${initName("kernel")}.capability_authority_revision()`,
  );
});

test("exact v25 compatibility assembly cannot configure browser origins", () => {
  const source = assembleLegacyV25({ kernel: kernelConfig });
  expect(source).toContain(
    `assembler_id = "${LEGACY_V25_ASSEMBLER_ID}"`,
  );
  expect(source).not.toContain("configure_app_browser_surfaces");
  expect(source).not.toContain("capability_authority_revision");

  expect(() =>
    assembleLegacyV25({
      kernel: kernelConfig,
      media: {
        format: 3,
        id: "media",
        name: "Media",
        version: 100,
        entry: "media",
        tiles: [{ id: "call", title: "Call" }],
        capabilities: {
          browser_permissions: {
            api: 1,
            tiles: [{ id: "call", features: ["camera"] }],
          },
        },
      },
    }),
  ).toThrow(
    `App media declares browser_permissions, which requires Kernel 316 or newer with assembler ${BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID}`,
  );
});

const helloConfig: AssemblyManifest = {
  format: 3,
  id: "hello",
  name: "Hello",
  version: 100,
  src: "main.mo",
  entry: "hello",
  func: {
    hello_world: { type: "update", async: false },
  },
  memory: {
    hello: {
      version: 1,
      schemas: { "1": { src: "memory/hello.mo" } },
      migrations: [],
    },
  },
};

const privateFunctionName = (appId: string, method: string) =>
  `NeutronAppFunction_${scopedPhysicalStem(appId, method)}`;
const memoryStoreName = (appId: string, memoryId: string) =>
  `NeutronMemoryStore_${scopedPhysicalStem(appId, memoryId)}`;
const retiredMemoryStoreName = (appId: string, memoryId: string) =>
  `NeutronRetiredMemoryStore_${scopedPhysicalStem(appId, memoryId)}`;
const memoryBindingName = (appId: string, memoryId: string) =>
  `NeutronMemory_${scopedPhysicalStem(appId, memoryId)}`;
const moduleName = (appId: string) =>
  `NeutronModule_${appPhysicalStem(appId)}`;
const initName = (appId: string) =>
  appId === "kernel" ? "NeutronKernel" : `NeutronAppInit_${appPhysicalStem(appId)}`;
const scopeName = (appId: string) =>
  `NeutronAppScope_${appPhysicalStem(appId)}`;
const environmentName = (appId: string) =>
  `NeutronAppEnvironment_${appPhysicalStem(appId)}`;
const httpPostUpdateHandlerName = (appId: string, mountId: string) =>
  physicalAppMethodName(appId, `http_post_update_${mountId}`);
const regexEscape = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function ingressLimitApp(
  appId: string,
  mode: "query" | "update",
  routeCount: number,
  callsPerRoute = 0,
): AssemblyManifest {
  return {
    format: 3,
    id: appId,
    name: `Ingress ${appId}`,
    version: 100,
    src: "main.mo",
    entry: appId,
    func: {
      ingress_handler: { type: mode, async: false },
    },
    capabilities: {
      public_ingress: {
        api: 1,
        routes:
          mode === "update"
            ? Array.from({ length: routeCount }, (_, index) => ({
                protocol: "rpc",
                id: `route_${index}`,
                handler: "ingress_handler",
                mode: "update" as const,
                caller: "canister" as const,
                max_request_bytes: 16,
                max_response_bytes: 16,
                max_calls_per_hour: callsPerRoute,
                required_cycles: 1,
              }))
            : Array.from({ length: routeCount }, (_, index) => ({
                protocol: "rpc",
                id: `route_${index}`,
                handler: "ingress_handler",
                mode: "query" as const,
                caller: "canister" as const,
                max_request_bytes: 16,
                max_response_bytes: 16,
              })),
      },
    },
  };
}

function registryLimitApp(
  appId: string,
  withTasks: boolean,
  resident: boolean,
  withConnections: boolean,
  withExtraIngress: boolean,
): AssemblyManifest {
  return {
    format: 3,
    id: appId,
    name: `Registry ${appId}`,
    version: 100,
    src: "main.mo",
    entry: appId,
    ...(resident
      ? { background: { path: "service.html" } }
      : {
          tiles: [
            {
              id: "main",
              title: "Main",
              path: "index.html",
            },
          ],
        }),
    func: {
      registry_http_post: {
        type: "internal",
        async: false,
      },
      registry_public_query: {
        type: "query",
        async: false,
      },
      ...(withTasks
        ? {
          task_first: {
            type: "internal",
            async: "async*",
            arg: ["task_capabilities"],
          },
          task_second: {
            type: "internal",
            async: "async*",
            arg: ["task_capabilities"],
          },
        }
        : {}),
    },
    capabilities: {
      backend_calls: {
        api: 1,
        description: "Exact test calls",
        reservation_scopes: ["exact"],
        max_concurrency: 1,
        max_cycles_per_call: 0,
        max_cycles_per_day: 0,
      },
      randomness: { api: 1 },
      ...(resident
        ? {
            vetkeys: {
              api: 1 as const,
              description: "Bounded test slots",
              slots: Array.from({ length: 4 }, (_, index) => ({
                id: `slot_${index}`,
                purpose: `Slot ${index}`,
              })),
            },
          }
        : {}),
      chain_key_signing: {
        api: 1,
        slots: Array.from({ length: 4 }, (_, index) => ({
          id: `assertion_${index}`,
          algorithm: "schnorr_ed25519" as const,
          purpose: `Assertion ${index}`,
          max_assertion_bytes: 1,
        })),
      },
      stable_store: {
        api: 1,
        stores: Array.from({ length: 8 }, (_, index) => ({
          id: `store_${index}`,
          purpose: `Store ${index}`,
          schema_version: 1,
          max_entries: 1,
          max_key_bytes: 1,
          max_value_bytes: 1,
          max_bytes: 2,
        })),
      },
      https_outcalls: {
        api: 1,
        endpoints: Array.from({ length: 5 }, (_, index) => ({
            id: `registry_${index}`,
            url_prefix:
              `https://${appId.replaceAll("_", "-")}.example.com/v${index}/`,
            methods: ["get"],
            request_headers: [],
            max_request_bytes: 128,
            max_response_bytes: 1,
            transform: "strip_headers",
          })),
      },
      ...(withConnections
        ? {
            connections: {
              api: 1 as const,
              providers: Array.from({ length: 8 }, (_, index) => ({
                provider: `provider_${index}`,
                scopes: [],
              })),
            },
          }
        : {}),
      ...(resident
        ? {
            persistent_browser_storage: {
              api: 1 as const,
              surface: "background" as const,
            },
          }
        : {}),
      http_routes: {
        api: 1,
        mounts: Array.from({ length: 4 }, (_, index) => ({
          id: `mount_${index}`,
          surface: "app_host" as const,
          prefix: `/mount-${index}`,
          methods: ["POST" as const],
          mode: "http_post_update_handler" as const,
          handler: "registry_http_post",
          max_request_bytes: 1,
          max_response_bytes: 16,
          max_calls_per_hour: 1,
          forward_headers: [],
        })),
      },
      public_ingress: {
        api: 1,
        routes: Array.from({ length: withExtraIngress ? 9 : 8 }, (_, index) => ({
            protocol: "registry",
            id: `probe_${index}`,
            handler: "registry_public_query",
            mode: "query" as const,
            caller: "canister" as const,
            max_request_bytes: 1,
            max_response_bytes: 1,
          })),
      },
      ...(withTasks
        ? {
            scheduled_tasks: {
              api: 1 as const,
              tasks: ["first", "second"].map((id) => ({
                id,
                method: `task_${id}`,
                interval_seconds: 3_600,
                run_on_start: false,
                max_backend_calls: 1,
              })),
            },
          }
        : {}),
    },
  };
}

function httpsLimitApp(
  appId: string,
  endpointCount: number,
  _callsPerEndpoint: number,
  _maxCyclesPerHour: number,
): AssemblyManifest {
  return {
    format: 3,
    id: appId,
    name: `HTTPS ${appId}`,
    version: 100,
    src: "main.mo",
    entry: appId,
    capabilities: {
      https_outcalls: {
        api: 1,
        endpoints: Array.from({ length: endpointCount }, (_, index) => ({
          id: `endpoint_${index}`,
          url_prefix: `https://api-${appId.replaceAll("_", "-")}.example.com/v1/`,
          methods: ["get" as const],
          request_headers: [],
          max_request_bytes: 4096,
          max_response_bytes: 4096,
          transform: "strip_headers" as const,
        })),
      },
    },
  };
}

function chainKeySigningLimitApp(
  appId: string,
  slotCount: number,
  _assertionsPerSlot: number,
  _maxCyclesPerHour: number,
): AssemblyManifest {
  return {
    format: 3,
    id: appId,
    name: `Assertion ${appId}`,
    version: 100,
    src: "main.mo",
    entry: appId,
    capabilities: {
      chain_key_signing: {
        api: 1,
        slots: Array.from({ length: slotCount }, (_, index) => ({
          id: `assertion_${index}`,
          algorithm: "schnorr_ed25519" as const,
          purpose: `Assertion slot ${index}`,
          max_assertion_bytes: 4096,
        })),
      },
    },
  };
}

function vetKeysLimitApp(
  appId: string,
  slotCount: number,
): AssemblyManifest {
  return {
    format: 3,
    id: appId,
    name: `VetKeys ${appId}`,
    version: 100,
    src: "main.mo",
    entry: appId,
    capabilities: {
      vetkeys: {
        api: 1,
        description: "Private application keys",
        slots: Array.from({ length: slotCount }, (_, index) => ({
          id: `slot_${index}`,
          purpose: `Use private key slot ${index}`,
        })),
      },
    },
  };
}

function backendCallReservationLimitApp(
  appId: string,
  reservationCount: number,
  sharedMethod?: string,
): AssemblyManifest {
  return {
    format: 3,
    id: appId,
    name: `Backend calls ${appId}`,
    version: 100,
    src: "main.mo",
    entry: appId,
    capabilities: {
      backend_calls: {
        api: 1,
        description: "Compiler-owned install defaults",
        reservation_scopes: ["method"],
        install_reservations: Array.from(
          { length: reservationCount },
          (_, index) => ({
            kind: "method" as const,
            method:
              sharedMethod ?? `app_${appId}__reserved_method_${index}`,
          }),
        ),
        max_concurrency: 1,
        max_cycles_per_call: 0,
        max_cycles_per_day: 0,
      },
    },
  };
}

function stableStoreLimitApp(
  appId: string,
  storeCount: number,
  maxEntries: number,
  maxBytes: number,
): AssemblyManifest {
  return {
    format: 3,
    id: appId,
    name: `Store ${appId}`,
    version: 100,
    src: "main.mo",
    entry: appId,
    capabilities: {
      stable_store: {
        api: 1,
        stores: Array.from({ length: storeCount }, (_, index) => ({
          id: `store_${index}`,
          purpose: `Store ${index}`,
          schema_version: 1,
          max_entries: maxEntries,
          max_key_bytes: 1,
          max_value_bytes: 1,
          max_bytes: maxBytes,
        })),
      },
    },
  };
}

function certifiedAssetsExtentApp(
  appId: string,
  entries: number,
): AssemblyManifest {
  return {
    format: 3,
    id: appId,
    name: `Certified ${appId}`,
    version: 100,
    src: "main.mo",
    entry: appId,
    backend: { capabilities: { certified_assets: { api: 2 } } },
    capabilities: {
      certified_assets: {
        api: 2,
        max_entries: entries,
        max_committed_bytes: entries,
        max_object_bytes: 1,
        max_pending_stages: 1,
        max_staged_bytes: 1,
        max_batch_operations: 1,
        max_batch_bytes: 1,
        max_idempotency_receipts: 2,
        collections: [
          {
            id: "state",
            mount: "state",
            kind: "mutable_blob",
            exact_path: "/current",
          },
        ],
      },
    },
  };
}

function requiredSingletonApp(
  appId: string,
  requiredSingletons: number,
  selectBackend = true,
): AssemblyManifest {
  return {
    format: 3,
    id: appId,
    name: `Singleton ${appId}`,
    version: 100,
    src: "main.mo",
    entry: appId,
    ...(selectBackend
      ? { backend: { capabilities: { certified_assets: { api: 2 } } } }
      : {}),
    capabilities: {
      certified_assets: {
        api: 2,
        max_entries: requiredSingletons,
        max_committed_bytes: 8_192,
        max_object_bytes: 4_096,
        max_pending_stages: 1,
        max_staged_bytes: 4_096,
        max_batch_operations: requiredSingletons,
        max_batch_bytes: 4_096,
        max_idempotency_receipts: Math.max(2, requiredSingletons),
        collections: Array.from(
          { length: requiredSingletons },
          (_, index) => ({
            id: `profile_${index}`,
            mount: "protocol",
            exact_path: `/v1/profile-${index}`,
            kind: "mutable_blob" as const,
            max_object_bytes: 4_096,
          }),
        ),
      },
    },
  };
}

test("assembler emits modern persistent Motoko actor shape", () => {
  const source = assemble({ kernel: kernelConfig, hello: helloConfig });

  expect(source).toMatch(
    /persistent actor class Class<system>\(\) = NeutronActor/,
  );
  expect(source).toContain(`let ${memoryStoreName("kernel", "kernel")}`);
  expect(source).toContain(
    `transient let #v1(${memoryBindingName("kernel", "kernel")})`,
  );
  expect(source).toContain(
    `transient let ${initName("kernel")} = ${moduleName("kernel")}.Init(${memoryBindingName("kernel", "kernel")})`,
  );
  const activeInventory = source.match(
    /transient let NeutronActiveAppInstanceInventory = \[(.*?)\];/s,
  )?.[1];
  expect(activeInventory).toBeDefined();
  expect(activeInventory!.indexOf('app_id = "hello"')).toBeLessThan(
    activeInventory!.indexOf('app_id = "kernel"'),
  );
  const fingerprints = [
    ...activeInventory!.matchAll(
      /app_id = "([^"]+)"; version = 100; capability_plan_fingerprint = "([a-f0-9]{64})"/g,
    ),
  ];
  expect(fingerprints.map((match) => match[1])).toEqual(["hello", "kernel"]);
  expect(source).toContain(
    `apps = ${initName("kernel")}.runtime_app_instances("development")`,
  );
  expect(source).not.toContain("installation_origin_nonce");
  expect(source).toContain(
    `transient let ${scopeName("hello")} = ${initName("kernel")}.app_scope("hello", "development")`,
  );
  expect(source).toContain(
    `transient let ${scopeName("kernel")} = ${initName("kernel")}.app_scope("kernel", "development")`,
  );
  expect(source).not.toMatch(/stable let NeutronMemoryStore_/);
  expect(source).toContain(
    `${initName("kernel")}.configure_app_capabilities([], {`,
  );
  expect(source).toContain("vetkeys_environment = #production");
  expect(source).toContain('ecdsa_secp256k1 = ?"key_1"');
  expect(source).toContain('schnorr_bip340secp256k1 = ?"key_1"');
  expect(source).toContain('schnorr_ed25519 = ?"key_1"');
  expect(source).toContain(
    `${initName("kernel")}.configure_capability_registry([], NeutronActor)`,
  );
  expect(source).toContain('assembler_id = "neutron_actor_v26"');
  expect(source).toContain(
    "let NeutronTrustedInstallationNetworkIdV1 : Blob = \"\\6c\\77",
  );
  expect(source).toContain(
    "assert(NeutronTrustedInstallationNetworkIdV1.size() == 32)",
  );
  expect(source).toMatch(
    /public query\(\{ caller = NeutronCaller \}\) func kernel_https_outcall_transform[\s\S]*?NeutronKernel\.kernel_https_outcall_transform\(NeutronRequest ,NeutronCaller\)/,
  );
  expect(source).toContain(
    `${moduleName("hello")}.Init(${environmentName("hello")})`,
  );
  expect(source).toMatch(
    new RegExp(
      `${environmentName("hello")} = \\{[\\s\\S]*?installation = NeutronTrustedInstallationContextV1;[\\s\\S]*?stable_memory = \\{[\\s\\S]*?hello = ${memoryBindingName("hello", "hello")};`,
    ),
  );
  expect(source).toMatch(
    /public query\(\{ caller = NeutronCaller \}\) func kernel_runtime_info[\s\S]*?assert\(NeutronKernel\.is_authorized\(NeutronCaller\)\)/,
  );
  expect(source).toMatch(
    /func app_hello__hello_world[\s\S]*?assert\(NeutronKernel\.scope_active\(NeutronAppScope_a5_hello\)\);[\s\S]*?assert\(NeutronKernel\.is_authorized\(NeutronCaller\)\);[\s\S]*?NeutronAppInit_a5_hello\.hello_world/,
  );
  expect(source).toMatch(
    /func app_hello__hello_world[\s\S]*?app_usage_instruction_begin\(NeutronAppScope_a5_hello, 1_200_000\)[\s\S]*?NeutronAppInit_a5_hello\.hello_world[\s\S]*?app_usage_instruction_finish\(NeutronAppUsageMeasurement\)/,
  );
  expect(source).not.toContain("NeutronAppMethod_");
  expect(source).not.toContain(
    `${initName("kernel")}.app_usage_instruction_begin(${scopeName("kernel")})`,
  );
  const kernelInternal = source.slice(
    source.indexOf(`private func ${privateFunctionName("kernel", "is_authorized")}`),
    source.indexOf(
      "};",
      source.indexOf(
        `private func ${privateFunctionName("kernel", "is_authorized")}`,
      ),
    ),
  );
  expect(kernelInternal).not.toContain(`scope_active(${scopeName("kernel")})`);
  expect(source).not.toContain('import NeutronPrim "mo:prim"');
  expect(source).toContain(
    `${initName("kernel")}.kernel_install_commit<system>(NeutronRequest ,NeutronCaller,NeutronCommitManagedMemoryRetirements)`,
  );
});

test("assembler enforces one 256-app ceiling including Kernel", () => {
  const appEntries = Array.from(
    { length: NEUTRON_INSTALLED_APP_LIMIT },
    (_, index) => {
      if (index === 0) return ["kernel", kernelConfig] as const;
      const id = `app_${index}`;
      return [
        id,
        {
          format: 3,
          id,
          name: `App ${index}`,
          version: 100,
          entry: id,
        } satisfies AssemblyManifest,
      ] as const;
    },
  );
  const atLimit = Object.fromEntries(appEntries);
  const source = assemble(atLimit);
  expect(source).toContain(
    "configure_frontend_surface_counts({\n      app_instances = 256;\n      resident_frames = 0;",
  );

  const overLimit = {
    ...atLimit,
    app_over_limit: {
      format: 3,
      id: "app_over_limit",
      name: "Over limit",
      version: 100,
      entry: "app_over_limit",
    },
  } satisfies Record<string, AssemblyManifest>;
  expect(() => assemble(overLimit)).toThrow(
    `maximum is ${NEUTRON_INSTALLED_APP_LIMIT} including Kernel`,
  );
});

test("assembler admits at most 32 resident app backgrounds", () => {
  const residents = Object.fromEntries(
    Array.from(
      { length: NEUTRON_RESIDENT_BACKGROUND_LIMIT },
      (_, index) => {
        const id = `resident_${index}`;
        return [
          id,
          {
            format: 3,
            id,
            name: `Resident ${index}`,
            version: 100,
            entry: id,
            background: { path: "service.html" },
          } satisfies AssemblyManifest,
        ];
      },
    ),
  );
  const source = assemble({ kernel: kernelConfig, ...residents });
  expect(source).toContain(
    "configure_frontend_surface_counts({\n      app_instances = 33;\n      resident_frames = 32;",
  );
  for (let index = 0; index < NEUTRON_RESIDENT_BACKGROUND_LIMIT; index += 1) {
    expect(source).toContain(
      `resident_background_path = ?"/app/resident_${index}/service.html"`,
    );
  }
  expect(() =>
    assemble({
      kernel: kernelConfig,
      ...residents,
      resident_over_limit: {
        format: 3,
        id: "resident_over_limit",
        name: "Resident over limit",
        version: 100,
        entry: "resident_over_limit",
        background: { path: "service.html" },
      },
    }),
  ).toThrow(
    `maximum is ${NEUTRON_RESIDENT_BACKGROUND_LIMIT}`,
  );
});

test("assembler gives only the current commit its system retirement edge", () => {
  const source = assemble({ kernel: kernelConfig });

  expect(source).toContain(
    `${initName("kernel")}.kernel_install_commit<system>(NeutronRequest ,NeutronCaller,NeutronCommitManagedMemoryRetirements)`,
  );
  expect(source).not.toContain("kernel_install_commit_checked");
});

test("assembler snapshots fresh identity context and preserves it on upgrades", () => {
  const context = trustedInstallationContextFromRootKey(
    new Uint8Array(133).fill(0x3c),
  );
  expect(() =>
    assemble(
      { kernel: kernelConfig, hello: helloConfig },
      { vetKeysEnvironment: "production", installationContext: context },
    ),
  ).toThrow("derives only the compiled IC mainnet installation context");
  const fresh = assemble(
    { kernel: kernelConfig, hello: helloConfig },
    { vetKeysEnvironment: "local", installationContext: context },
  );
  const literal = context.networkId
    .map((byte) => `\\${byte.toString(16).padStart(2, "0")}`)
    .join("");

  expect(fresh).toContain(
    `let NeutronTrustedInstallationNetworkIdV1 : Blob = "${literal}"`,
  );
  expect(fresh).toContain(
    `transient let NeutronCompiledInstallationNetworkIdV1 : Blob = "${literal}"`,
  );
  expect(fresh).toContain(
    "NeutronRetainedInstallationNetworkIdByteV1 ==",
  );
  expect(fresh).toContain(
    "installation = NeutronTrustedInstallationContextV1;",
  );

  const preserving = assemble(
    { kernel: kernelConfig, hello: helloConfig },
    { vetKeysEnvironment: "local", installationContext: null },
  );
  expect(preserving).toContain(
    'let NeutronTrustedInstallationNetworkIdV1 : Blob = ""',
  );
  expect(preserving).toContain(
    'transient let NeutronCompiledInstallationNetworkIdV1 : Blob = ""',
  );
});

test("assembler meters app updates but not queries, kernel methods, or internal dependencies", () => {
  const source = assemble({
    kernel: kernelConfig,
    hello: {
      ...helloConfig,
      func: {
        mutate: { type: "update", async: "async*" },
        inspect: { type: "query", async: false },
        dependency_leaf: {
          type: "internal",
          async: "async*",
          expose: "apps",
        },
      },
    },
  });
  const begin = `${initName("kernel")}.app_usage_instruction_begin(${scopeName("hello")}, 1_200_000)`;
  const finish = `${initName("kernel")}.app_usage_instruction_finish(NeutronAppUsageMeasurement)`;

  expect(source.split(begin)).toHaveLength(2);
  expect(source.split(finish)).toHaveLength(3);
  expect(source).toMatch(
    new RegExp(
      `func ${physicalAppMethodName("hello", "mutate")}[\\s\\S]*?${regexEscape(begin)}[\\s\\S]*?try \\{[\\s\\S]*?await\\* ${initName("hello")}\\.mutate[\\s\\S]*?${regexEscape(finish)}[\\s\\S]*?catch \\(NeutronAppError\\)[\\s\\S]*?${regexEscape(finish)}[\\s\\S]*?throw NeutronAppError`,
    ),
  );
  const queryStart = source.indexOf(
    `func ${physicalAppMethodName("hello", "inspect")}`,
  );
  const internalStart = source.indexOf(
    `private func ${privateFunctionName("hello", "dependency_leaf")}`,
  );
  expect(queryStart).toBeGreaterThan(-1);
  expect(internalStart).toBeGreaterThan(queryStart);
  expect(source.slice(queryStart, internalStart)).not.toContain(
    "app_usage_instruction_",
  );
  expect(source.slice(internalStart, source.indexOf("};", internalStart))).not.toContain(
    "app_usage_instruction_",
  );
});

test("assembler emits scoped public ingress protocol dispatchers and exact handlers", () => {
  const ingressConfig: AssemblyManifest = {
    ...helloConfig,
    func: {
      ingress_status: {
        type: "query",
        async: false,
        arg: ["caller"],
      },
      ingress_commit: {
        type: "update",
        async: false,
        arg: ["caller", "public_ingress_cycles"],
      },
      ingress_direct: {
        type: "update",
        async: false,
        arg: ["caller"],
      },
    },
    capabilities: {
      public_ingress: {
        api: 1,
        routes: [
          {
            protocol: "hello_v1",
            id: "status",
            handler: "ingress_status",
            mode: "query",
            caller: "any",
            max_request_bytes: 128,
            max_response_bytes: 256,
          },
          {
            protocol: "hello_v1",
            id: "commit",
            handler: "ingress_commit",
            mode: "update",
            caller: "canister",
            max_request_bytes: 512,
            max_response_bytes: 1024,
            max_calls_per_hour: 60,
            max_calls_per_caller_per_hour: 6,
            required_cycles: 10_000_000,
          },
          {
            protocol: "hello_v1",
            id: "direct",
            handler: "ingress_direct",
            mode: "update",
            caller: "authenticated",
            max_request_bytes: 512,
            max_response_bytes: 1024,
            max_calls_per_hour: 60,
            max_calls_per_caller_per_hour: 4,
          },
        ],
      },
    },
  };
  const source = assemble({
    kernel: kernelConfig,
    hello: ingressConfig,
  });
  const commitRegistration = projectRuntimeCapabilityRegistrationsV1(
    buildCapabilityPlan(ingressConfig),
  ).find(
    (registration) =>
      registration.kind === "public_ingress" &&
      registration.resource_id === publicIngressResourceId("hello_v1", "commit"),
  );
  expect(commitRegistration).toBeDefined();

  expect(source).toContain(
    `func ${physicalPublicIngressMethodName("hello", "hello_v1", "query")}`,
  );
  expect(source).toContain(
    `func ${physicalPublicIngressMethodName("hello", "hello_v1", "update")}`,
  );
  expect(source).not.toContain("NeutronPublicIngress_a");
  expect(source).toContain(
    `${initName("kernel")}.public_ingress_query(${scopeName("hello")}, "hello_v1", NeutronIngressCaller, NeutronIngressRequest)`,
  );
  expect(source).toContain(
    `await* ${initName("kernel")}.public_ingress_update<system>(${scopeName("hello")}, "hello_v1", NeutronIngressCaller, NeutronIngressRequest)`,
  );
  expect(source).toContain(
    `handler = #query_(func (NeutronIngressRequest : ${moduleName("kernel")}.PublicIngressHandlerRequestV1) : Blob`,
  );
  expect(source).toContain(
    `let NeutronDecodedIngressRequest : ?${moduleName("hello")}.ingress_status_Input = from_candid NeutronIngressRequest.payload`,
  );
  expect(source).toContain(
    `${initName("hello")}.ingress_status(NeutronIngressAppRequest,NeutronIngressRequest.caller)`,
  );
  expect(source).toContain(
    "func NeutronPublicIngressUpdateHandlerV1",
  );
  expect(source).toContain(
    `assert(NeutronIngressDispatchCaller == NeutronPrim.principalOfActor(NeutronActor))`,
  );
  expect(source).toContain(
    `NeutronDispatch.app_scope == ${scopeName("hello")} and NeutronDispatch.protocol == "hello_v1" and NeutronDispatch.method == "commit"`,
  );
  expect(source).toContain(
    `${initName("kernel")}.public_ingress_dispatch_begin(${scopeName("hello")}, "hello_v1", "commit", NeutronDispatch)`,
  );
  expect(source).toContain(
    `${initName("hello")}.ingress_commit(NeutronIngressAppRequest,NeutronDispatch.request.caller,${initName("kernel")}.public_ingress_cycles_capability(${scopeName("hello")}))`,
  );
  expect(source).not.toContain(
    `func ${physicalAppMethodName("hello", "ingress_commit")}`,
  );
  expect(source).toMatch(
    new RegExp(
      `public_ingress_dispatch_begin\\(${scopeName("hello")}, "hello_v1", "commit", NeutronDispatch\\)[\\s\\S]*?app_usage_instruction_begin\\(${scopeName("hello")}, 260_000\\)[\\s\\S]*?try \\{[\\s\\S]*?${initName("hello")}\\.ingress_commit[\\s\\S]*?catch \\(NeutronHandlerError\\) \\{[\\s\\S]*?app_usage_instruction_finish\\(NeutronAppUsageMeasurement\\)[\\s\\S]*?throw NeutronHandlerError[\\s\\S]*?app_usage_instruction_finish\\(NeutronAppUsageMeasurement\\)[\\s\\S]*?public_ingress_dispatch_finish`,
    ),
  );
  expect(source).toContain(
    `${initName("kernel")}.public_ingress_dispatch_finish(${scopeName("hello")}, "hello_v1", "commit", NeutronDispatch, NeutronIngressResponse)`,
  );
  expect(source).toMatch(
    new RegExp(
      `public_ingress_dispatch_begin\\(${scopeName("hello")}, "hello_v1", "direct", NeutronDispatch\\)[\\s\\S]*?app_usage_instruction_begin\\(${scopeName("hello")}, 260_000\\)[\\s\\S]*?${initName("hello")}\\.ingress_direct`,
    ),
  );
  expect(source).toContain(
    `${initName("hello")}.ingress_direct(NeutronIngressAppRequest,NeutronDispatch.request.caller)`,
  );
  expect(source).toContain(
    `${initName("kernel")}.configure_public_ingress_handlers([`,
  );
  expect(source).not.toContain("public_ingress_cycles =");
  expect(source).not.toMatch(
    /import\s+\w*Cycles\w*\s+"mo:(?:core\/Cycles|base\/ExperimentalCycles)"/,
  );
  expect(source).not.toMatch(/\bCycles\.(?:available|accept|add|balance)\b/);
  expect(source).toMatch(
    /public_ingress = \?\{[\s\S]*protocol = "hello_v1"; id = "commit"; handler = "ingress_commit"; mode = #update_; caller = #canister;[\s\S]*max_calls_per_hour = \?60; max_calls_per_caller_per_hour = \?6; required_cycles = \?10000000; fingerprint = "[a-f0-9]{64}"/,
  );
  expect(source).toMatch(
    /protocol = "hello_v1"; id = "status"; handler = "ingress_status"; mode = #query_; caller = #any;[\s\S]*max_calls_per_hour = null; max_calls_per_caller_per_hour = null; required_cycles = null;/,
  );
  expect(source).toMatch(
    /protocol = "hello_v1"; id = "direct"; handler = "ingress_direct"; mode = #update_; caller = #authenticated;[\s\S]*max_calls_per_hour = \?60; max_calls_per_caller_per_hour = \?4; required_cycles = null;/,
  );
  expect(source).toContain(
    `fingerprint = "${commitRegistration!.declaration_fingerprint}"`,
  );
});

test("assembler injects public ingress cycles only into an explicit paid handler", () => {
  const explicitApp = ingressLimitApp("paid_receiver", "update", 2, 60);
  explicitApp.func!.ingress_handler!.arg = [
    "caller",
    "public_ingress_cycles",
  ];
  const explicitSource = assemble({
    kernel: kernelConfig,
    paid_receiver: explicitApp,
  });
  expect(explicitSource).toContain(
    `${initName("paid_receiver")}.ingress_handler(NeutronIngressAppRequest,NeutronDispatch.request.caller,${initName("kernel")}.public_ingress_cycles_capability(${scopeName("paid_receiver")}))`,
  );
  expect(explicitSource).not.toContain(
    `func ${physicalAppMethodName("paid_receiver", "ingress_handler")}`,
  );
  expect(explicitSource).not.toContain("public_ingress_cycles =");
  expect(explicitSource).not.toContain(environmentName("paid_receiver"));
  expect(explicitSource).toContain(
    `${moduleName("paid_receiver")}.Init()`,
  );

  const omittedApp = ingressLimitApp("paid_without_request", "update", 1, 60);
  const omittedSource = assemble({
    kernel: kernelConfig,
    paid_without_request: omittedApp,
  });
  expect(omittedSource).not.toContain("public_ingress_cycles_capability");
  expect(omittedSource).not.toContain(environmentName("paid_without_request"));
  expect(omittedSource).toContain(
    `${moduleName("paid_without_request")}.Init()`,
  );
});

test("assembler rejects public ingress cycles outside exact paid handlers", () => {
  const restriction =
    /may request public_ingress_cycles only when every route using that handler is a synchronous caller:"canister" public-ingress update route/;

  expect(() =>
    assemble({
      kernel: kernelConfig,
      hello: {
        ...helloConfig,
        func: {
          hello_world: {
            type: "update",
            async: false,
            arg: ["public_ingress_cycles"],
          },
        },
      },
    }),
  ).toThrow(restriction);

  const queryApp = ingressLimitApp("free_reader", "query", 1);
  queryApp.func!.ingress_handler!.arg = [
    "caller",
    "public_ingress_cycles",
  ];
  expect(() =>
    assemble({ kernel: kernelConfig, free_reader: queryApp }),
  ).toThrow(restriction);

  const authenticatedApp: AssemblyManifest = {
    ...helloConfig,
    id: "direct_receiver",
    entry: "direct_receiver",
    func: {
      ingress_direct: {
        type: "update",
        async: false,
        arg: ["caller", "public_ingress_cycles"],
      },
    },
    capabilities: {
      public_ingress: {
        api: 1,
        routes: [
          {
            protocol: "direct_v1",
            id: "submit",
            handler: "ingress_direct",
            mode: "update",
            caller: "authenticated",
            max_request_bytes: 512,
            max_response_bytes: 1024,
            max_calls_per_hour: 60,
          },
        ],
      },
    },
  };
  expect(() =>
    assemble({
      kernel: kernelConfig,
      direct_receiver: authenticatedApp,
    }),
  ).toThrow(restriction);

  const sharedApp = ingressLimitApp("shared_receiver", "update", 1, 60);
  sharedApp.func!.ingress_handler!.arg = [
    "caller",
    "public_ingress_cycles",
  ];
  sharedApp.capabilities!.public_ingress!.routes.push({
    protocol: "rpc",
    id: "direct",
    handler: "ingress_handler",
    mode: "update",
    caller: "authenticated",
    max_request_bytes: 16,
    max_response_bytes: 16,
    max_calls_per_hour: 60,
  });
  expect(() =>
    assemble({
      kernel: kernelConfig,
      shared_receiver: sharedApp,
    }),
  ).toThrow(restriction);
});

test("assembler rejects an ordinary method colliding with public ingress", () => {
  const physical = physicalPublicIngressMethodName(
    "hello",
    "hello_v1",
    "update",
  );
  expect(physical).toBe(
    physicalAppMethodName("hello", "hello_v1_update"),
  );

  expect(() =>
    assemble({
      kernel: kernelConfig,
      hello: {
        ...helloConfig,
        func: {
          hello_v1_update: { type: "update", async: false },
          ingress_commit: { type: "update", async: false },
        },
        capabilities: {
          public_ingress: {
            api: 1,
            routes: [
              {
                protocol: "hello_v1",
                id: "commit",
                handler: "ingress_commit",
                mode: "update",
                caller: "canister",
                max_request_bytes: 128,
                max_response_bytes: 128,
                max_calls_per_hour: 60,
                required_cycles: 10_000_000,
              },
            ],
          },
        },
      },
    }),
  ).toThrow(`Duplicate physical public function '${physical}'`);
});

test("assembler preflights public ingress global route and update-rate limits", () => {
  const routeApps = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => {
      const routeCount = index === 64 ? 1 : 32;
      const app = ingressLimitApp(`ingress_${index}`, "query", routeCount);
      return [app.id, app];
    }),
  );
  expect(() => assemble({ kernel: kernelConfig, ...routeApps })).toThrow(
    "Assembly public ingress declarations exceed global limits: 2049 routes (maximum 2048) and 0 update calls/hour (maximum 16384)",
  );

  const rateApps = Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => {
      const app = ingressLimitApp(`rate_${index}`, "update", 1, 3_600);
      return [app.id, app];
    }),
  );
  expect(() => assemble({ kernel: kernelConfig, ...rateApps })).toThrow(
    "Assembly public ingress declarations exceed global limits: 5 routes (maximum 2048) and 18000 update calls/hour (maximum 16384)",
  );
});

test("assembler and runtime share tuple ordering for public ingress routes", () => {
  const source = assemble({
    kernel: kernelConfig,
    prefix_routes: {
      format: 3,
      id: "prefix_routes",
      name: "Prefix routes",
      version: 100,
      src: "main.mo",
      entry: "prefix_routes",
      func: {
        query_route: { type: "query", async: false },
      },
      capabilities: {
        public_ingress: {
          api: 1,
          routes: ["a0", "a"].map((protocol) => ({
            protocol,
            id: "x",
            handler: "query_route",
            mode: "query" as const,
            caller: "any" as const,
            max_request_bytes: 1,
            max_response_bytes: 1,
          })),
        },
      },
    },
  });
  const shorterProtocol = source.indexOf('protocol = "a"; id = "x"');
  const longerProtocol = source.indexOf('protocol = "a0"; id = "x"');
  expect(shorterProtocol).toBeGreaterThanOrEqual(0);
  expect(longerProtocol).toBeGreaterThan(shorterProtocol);
});

test("assembler preflights the kernel registry's global resource bound", () => {
  // This composition stays within every narrower capability ceiling while
  // projecting 8,386 brokered resources, so the aggregate registry bound is
  // independently reachable before actor source construction.
  const apps = Object.fromEntries(
    Array.from({ length: 255 }, (_, index) => {
      const app = registryLimitApp(
        `registry_${index}`,
        index < 32,
        index < NEUTRON_RESIDENT_BACKGROUND_LIMIT,
        index < CONNECTIONS_MAX_PROVIDERS_GLOBAL / 8,
        index === 0,
      );
      return [app.id, app];
    }),
  );
  expect(() => assemble({ kernel: kernelConfig, ...apps })).toThrow(
    "Assembly projects 8386 runtime capability resources; global maximum is 8192",
  );
});

test("assembler injects the compile-time deployment id only into the kernel", () => {
  const source = assemble(
    {
      kernel: {
        ...kernelConfig,
        init_arg: [
          "memory_kernel",
          "deployment_id",
          "active_app_instance_inventory",
          "canister_principal",
        ],
      },
      hello: helloConfig,
    },
    { deploymentId: "deploy_abc123" },
  );

  expect(source).toContain(
    `transient let ${initName("kernel")} = ${moduleName("kernel")}.Init(${memoryBindingName("kernel", "kernel")},"deploy_abc123",NeutronActiveAppInstanceInventory,NeutronPrim.principalOfActor(NeutronActor))`,
  );
  expect(source).toContain('import NeutronPrim "mo:prim";');
  expect(() =>
    assemble({
      kernel: {
        ...kernelConfig,
        init_arg: ["memory_kernel", "active_capability_plan_fingerprints"],
      },
      hello: helloConfig,
    }),
  ).toThrow(
    "Kernel requested unknown init resource 'active_capability_plan_fingerprints'",
  );
  expect(() =>
    assemble({
      kernel: kernelConfig,
      hello: { ...helloConfig, init_arg: ["deployment_id"] },
    }),
  ).toThrow("App hello cannot use init_arg");
  expect(() =>
    assemble({
      kernel: kernelConfig,
      hello: {
        ...helloConfig,
        init_arg: ["active_app_instance_inventory"],
      },
    }),
  ).toThrow("App hello cannot use init_arg");
});

test("assembler emits one exact backend environment", () => {
  const source = assemble({
    kernel: kernelConfig,
    wallet: {
      format: 3,
      id: "wallet",
      name: "Wallet",
      version: 100,
      src: "main.mo",
      entry: "wallet",
      memory: {
        wallet: {
          version: 1,
          schemas: { "1": { src: "memory/wallet.mo" } },
          migrations: [],
        },
      },
      capabilities: {
        backend_calls: {
          api: 1,
          description: "Call approved ledgers",
          reservation_scopes: ["principal", "method", "exact"],
          install_reservations: [
            {
              kind: "principal",
              principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
            },
            {
              kind: "method",
              method: "app_mail__mail_v1_update",
            },
            {
              kind: "exact",
              principal: "r7inp-6aaaa-aaaaa-aaabq-cai",
              method: "icrc1_balance_of",
            },
          ],
          max_concurrency: 20,
          max_cycles_per_call: 0,
          max_cycles_per_day: 0,
        },
      },
      backend: {
        capabilities: { backend_calls: { api: 1 } },
      },
    },
  });

  expect(source).toContain(`${initName("kernel")}.configure_app_capabilities`);
  expect(source).toContain(`${initName("kernel")}.configure_capability_registry`);
  expect(source).toContain("kind = #backend_calls");
  expect(source).toContain('resource_id = "default"');
  expect(source).toMatch(/declaration_fingerprint = "[a-f0-9]{64}"/);
  expect(source).toContain(`app_scope = ${scopeName("wallet")}`);
  expect(source).toContain(
    'reservation_scopes = ["exact", "method", "principal"]',
  );
  expect(source).toContain('import NeutronPrim "mo:prim"');
  expect(source).toContain(
    'install_reservations = [#exact({ principal = NeutronPrim.principalOfActor(actor ("r7inp-6aaaa-aaaaa-aaabq-cai")); method = "icrc1_balance_of" }), #method("app_mail__mail_v1_update"), #principal(NeutronPrim.principalOfActor(actor ("ryjl3-tyaaa-aaaaa-aaaba-cai")))]',
  );
  expect(source).not.toContain(
    "configure_backend_call_install_reservations",
  );
  expect(source).toContain(
    `${initName("kernel")}.backend_calls_capability(${scopeName("wallet")}, NeutronActor)`,
  );
  expect(source).toContain(
    `${moduleName("wallet")}.Init(${environmentName("wallet")})`,
  );
  expect(source).toMatch(
    new RegExp(
      `${environmentName("wallet")} = \\{[\\s\\S]*?stable_memory = \\{[\\s\\S]*?wallet = ${memoryBindingName("wallet", "wallet")};[\\s\\S]*?capabilities = \\{[\\s\\S]*?backend_calls = ${initName("kernel")}\\.backend_calls_capability`,
    ),
  );
  expect(source).toContain("vetkeys = null");
  expect(source).toContain("randomness = null");
  expect(source).toContain("chain_key_signing = null");
  expect(source).toContain("connections = null");
  expect(source).toContain(
    "resident_frame_security = #credentialless_opaque_v1",
  );
  expect(source).toContain("http_routes_v1 = null");
  expect(source).not.toContain("http_routes_v2");
  expect(source).toContain("certified_assets = null");
  expect(source).toContain("vetkeys_environment = #production");
});

test("assembler configures and injects exact certified app routes", () => {
  const source = assemble({
    kernel: kernelConfig,
    publisher: {
      format: 3,
      id: "publisher",
      name: "Publisher",
      version: 100,
      entry: "publisher",
      capabilities: {
        certified_assets: {
          api: 2,
          max_entries: 64,
          max_committed_bytes: 2_097_152,
          max_object_bytes: 65_536,
          max_pending_stages: 1,
          max_staged_bytes: 65_536,
          max_batch_operations: 16,
          max_batch_bytes: 65_536,
          max_idempotency_receipts: 64,
          collections: [
            {
              id: "files",
              mount: "files",
              kind: "publication",
            },
          ],
        },
      },
      backend: { capabilities: { certified_assets: { api: 2 } } },
    },
  });

  expect(source).toContain("http_routes_v1 = null");
  expect(source).not.toContain("http_routes_v2");
  expect(source).toContain(
    "max_committed_bytes = 2097152",
  );
  expect(source).toContain(
    'id = "files";\n            mount = "files";\n            kind = "publication";\n            path_prefix = null;\n            exact_path = null',
  );
  expect(source).toContain("kind = #certified_assets");
  expect(source).toContain("kind = #certified_read_routes");
  expect(source).toMatch(
    /kind = #certified_assets;\s*resource_id = "default";\s*api = 2;/,
  );
  expect(source).toMatch(
    /kind = #certified_read_routes;\s*resource_id = "files";\s*api = 1;/,
  );
  expect(source).toContain('resource_id = "default"');
  expect(source).toContain('resource_id = "files"');
  expect(source).toContain(
    `certified_assets = ${initName("kernel")}.certified_assets_capability(${scopeName("publisher")})`,
  );
  expect(source).toContain(
    `${moduleName("publisher")}.Init(${environmentName("publisher")})`,
  );
});

test("assembler gives exact mutable collections the ordinary app capability", () => {
  const source = assemble({
    kernel: kernelConfig,
    wagyu: requiredSingletonApp("wagyu", 1),
  });

  expect(source).toContain(
    `${moduleName("wagyu")}.Init(${environmentName("wagyu")})`,
  );
  expect(source).toContain(
    `certified_assets = ${initName("kernel")}.certified_assets_capability(${scopeName("wagyu")})`,
  );
  expect(source).not.toContain("certified_assets_initializing_capability");
  expect(() =>
    assemble({
      kernel: kernelConfig,
      wagyu: requiredSingletonApp("wagyu", 2),
    }),
  ).not.toThrow();
  expect(() =>
    assemble({
      kernel: kernelConfig,
      wagyu: requiredSingletonApp("wagyu", 1, false),
    }),
  ).toThrow(/certified_assets.*backend|backend.*certified_assets/i);
});

test("assembler wires exact bounded http_post_update_handler mounts through self calls", () => {
  const source = assemble({
    kernel: kernelConfig,
    webhook: {
      format: 3,
      id: "webhook",
      name: "Webhook",
      version: 100,
      entry: "webhook",
      func: {
        accept_event: { type: "internal", async: false },
      },
      capabilities: {
        http_routes: {
          api: 1,
          mounts: [
            {
              id: "events",
              surface: "app_host",
              prefix: "/api/events",
              methods: ["POST"],
              mode: "http_post_update_handler",
              handler: "accept_event",
              max_request_bytes: 32_768,
              max_response_bytes: 16_384,
              max_calls_per_hour: 40,
              forward_headers: ["content-type", "authorization"],
            },
            {
              id: "shared_events",
              surface: "shared_app_path",
              methods: ["POST"],
              mode: "http_post_update_handler",
              handler: "accept_event",
              max_request_bytes: 4096,
              max_response_bytes: 2048,
              max_calls_per_hour: 20,
              forward_headers: [],
            },
          ],
        },
      },
    },
  });

  const wrapper = httpPostUpdateHandlerName("webhook", "events");
  expect(source).toContain('import NeutronPrim "mo:prim"');
  expect(source).toContain(
    'id = "events"; surface = "app_host"; prefix = ?"/api/events"; methods = ["POST"]; mode = "http_post_update_handler"; max_request_bytes = 32768; max_response_bytes = 16384; handler = ?"accept_event"; max_calls_per_hour = ?40; forward_headers = ["authorization", "content-type"]',
  );
  expect(source).toContain(
    'id = "shared_events"; surface = "shared_app_path"; prefix = null; methods = ["POST"]; mode = "http_post_update_handler"; max_request_bytes = 4096; max_response_bytes = 2048; handler = ?"accept_event"; max_calls_per_hour = ?20; forward_headers = []',
  );
  expect(source).toContain(
    `public shared({ caller = NeutronHttpPostUpdateHandlerCaller }) func ${wrapper}(NeutronDispatch : ${moduleName("kernel")}.HttpPostUpdateHandlerDispatchV1) : async ${moduleName("kernel")}.HttpPostUpdateHandlerResponseV1`,
  );
  expect(source).toContain(
    "assert(NeutronHttpPostUpdateHandlerCaller == NeutronPrim.principalOfActor(NeutronActor))",
  );
  expect(source).toContain(
    `${initName("kernel")}.http_post_update_handler_dispatch_begin(${scopeName("webhook")}, "events", NeutronDispatch)`,
  );
  expect(source).toMatch(
    new RegExp(
      `http_post_update_handler_dispatch_begin\\(${scopeName("webhook")}, "events", NeutronDispatch\\)[\\s\\S]*?app_usage_instruction_begin\\(${scopeName("webhook")}, 260_000\\)[\\s\\S]*?try \\{[\\s\\S]*?${privateFunctionName("webhook", "accept_event")}\\(NeutronDispatch\\.request\\)[\\s\\S]*?catch \\(NeutronHandlerError\\) \\{[\\s\\S]*?app_usage_instruction_finish\\(NeutronAppUsageMeasurement\\)[\\s\\S]*?throw NeutronHandlerError[\\s\\S]*?app_usage_instruction_finish\\(NeutronAppUsageMeasurement\\)[\\s\\S]*?http_post_update_handler_dispatch_finish`,
    ),
  );
  expect(source).toContain(
    `${privateFunctionName("webhook", "accept_event")}(NeutronDispatch.request)`,
  );
  expect(source).toContain(
    `${initName("kernel")}.http_post_update_handler_dispatch_finish(${scopeName("webhook")}, "events", NeutronDispatch, NeutronHttpPostUpdateHandlerResponse)`,
  );
  expect(source).toContain(
    `app_scope = ${scopeName("webhook")};\n        mount_id = "events";\n        handler = NeutronActor.${wrapper};`,
  );
  const sharedWrapper = httpPostUpdateHandlerName("webhook", "shared_events");
  expect(source).toContain(
    `app_scope = ${scopeName("webhook")};\n        mount_id = "shared_events";\n        handler = NeutronActor.${sharedWrapper};`,
  );
  expect(source.indexOf(`${moduleName("webhook")}.Init()`)).toBeLessThan(
    source.indexOf(`func ${wrapper}`),
  );
  expect(source.indexOf(`func ${wrapper}`)).toBeLessThan(
    source.indexOf(`${initName("kernel")}.configure_http_post_update_handlers`),
  );
});

test("assembler rejects http_post_update_handler declarations above global limits", () => {
  const apps = Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => {
      const id = `webhook_${index}`;
      return [
        id,
        {
          format: 3,
          id,
          name: `Webhook ${index}`,
          version: 100,
          entry: id,
          func: { accept_event: { type: "internal", async: false } },
          capabilities: {
            http_routes: {
              api: 1,
              mounts: [
                {
                  id: "events",
                  surface: "app_host",
                  prefix: "/api/events",
                  methods: ["POST"],
                  mode: "http_post_update_handler",
                  handler: "accept_event",
                  max_request_bytes: 1,
                  max_response_bytes: 1,
                  max_calls_per_hour: 240,
                  forward_headers: [],
                },
              ],
            },
          },
        } satisfies AssemblyManifest,
      ];
    }),
  );

  expect(() => assemble({ kernel: kernelConfig, ...apps })).toThrow(
    "Assembly http_post_update_handler declarations exceed global limits: 1200 calls/hour (maximum 1024) and 1200 replay bytes/hour (maximum 67108864)",
  );
});

test("assembler rejects non-exact http_post_update_handler targets", () => {
  const targetCases: Array<{
    label: string;
    target?: NonNullable<AssemblyManifest["func"]>[string];
  }> = [
    { label: "missing" },
    { label: "public", target: { type: "update", async: false } },
    { label: "implicit async", target: { type: "internal" } },
    { label: "async", target: { type: "internal", async: true } },
    { label: "local async", target: { type: "internal", async: "async*" } },
    {
      label: "injected argument",
      target: { type: "internal", async: false, arg: ["caller"] },
    },
    {
      label: "app exposed",
      target: { type: "internal", async: false, expose: "apps" },
    },
  ];

  for (const { label, target } of targetCases) {
    expect(
      () =>
        assemble({
          kernel: kernelConfig,
          webhook: {
            format: 3,
            id: "webhook",
            name: "Webhook",
            version: 100,
            entry: "webhook",
            func: target ? { accept_event: target } : {},
            capabilities: {
              http_routes: {
                api: 1,
                mounts: [
                  {
                    id: "events",
                    surface: "app_host",
                    prefix: "/api/events",
                    methods: ["POST"],
                    mode: "http_post_update_handler",
                    handler: "accept_event",
                    max_request_bytes: 1024,
                    max_response_bytes: 1024,
                    max_calls_per_hour: 10,
                    forward_headers: [],
                  },
                ],
              },
            },
          },
        }),
      label,
    ).toThrow(
      /must name a synchronous, unexposed internal manifest function|must target a same-app internal synchronous async:false function/,
    );
  }
});

test("assembler reserves compiler-owned http_post_update_handler wrapper names", () => {
  const generated = httpPostUpdateHandlerName("webhook", "events");
  expect(() =>
    assemble({
      kernel: {
        ...kernelConfig,
        func: {
          ...kernelConfig.func,
          [generated]: { type: "update", async: false },
        },
      },
      webhook: {
        format: 3,
        id: "webhook",
        name: "Webhook",
        version: 100,
        entry: "webhook",
        func: { accept_event: { type: "internal", async: false } },
        capabilities: {
          http_routes: {
            api: 1,
            mounts: [
              {
                id: "events",
                surface: "app_host",
                prefix: "/api/events",
                methods: ["POST"],
                mode: "http_post_update_handler",
                handler: "accept_event",
                max_request_bytes: 1024,
                max_response_bytes: 1024,
                max_calls_per_hour: 10,
                forward_headers: [],
              },
            ],
          },
        },
      },
    }),
  ).toThrow(/Duplicate physical public function/);
});

test("assembler injects only a declared randomness capability", () => {
  const randomApp: AssemblyManifest = {
    format: 3,
    id: "dice_app",
    name: "Dice App",
    version: 100,
    entry: "dice_app",
    capabilities: {
      randomness: {
        api: 1,
      },
    },
    backend: { capabilities: { randomness: { api: 1 } } },
  };
  const source = assemble({ kernel: kernelConfig, dice_app: randomApp });

  expect(source).toContain("randomness = ?{}");
  expect(source).toContain(
    `randomness = ${initName("kernel")}.randomness_capability(${scopeName("dice_app")})`,
  );
  expect(source).toContain(
    `${moduleName("dice_app")}.Init(${environmentName("dice_app")})`,
  );
  const { backend: _backend, ...unselectedRandomApp } = randomApp;
  const unselected = assemble({
    kernel: kernelConfig,
    dice_app: unselectedRandomApp,
  });
  expect(unselected).toContain(`${moduleName("dice_app")}.Init()`);
  expect(unselected).not.toContain(
    `randomness_capability(${scopeName("dice_app")})`,
  );
});

test("assembler emits exact assertion-signing slots and only the attenuated handle", () => {
  const app: AssemblyManifest = {
    format: 3,
    id: "receipt_app",
    name: "Receipt App",
    version: 100,
    entry: "receipt_app",
    capabilities: {
      chain_key_signing: {
        api: 1,
        slots: [
          {
            id: "receipts",
            algorithm: "schnorr_ed25519",
            purpose: 'Sign bounded "receipt" assertions',
            max_assertion_bytes: 4096,
          },
        ],
      },
    },
    backend: { capabilities: { chain_key_signing: { api: 1 } } },
  };
  const source = assemble({ kernel: kernelConfig, receipt_app: app });

  expect(source).toContain("chain_key_signing = ?{");
  expect(source).toContain('id = "receipts"');
  expect(source).toContain("algorithm = #schnorr_ed25519");
  expect(source).toContain('purpose = "Sign bounded \\"receipt\\" assertions"');
  expect(source).toContain("max_assertion_bytes = 4096");
  expect(source).toContain("kind = #chain_key_signing");
  expect(source).toContain('resource_id = "receipts"');
  const factory =
    `chain_key_signing = ${initName("kernel")}.chain_key_signing_capability(${scopeName("receipt_app")});`;
  expect(source).toContain(factory);
  expect(source).not.toContain(
    `chain_key_signing_capability(${scopeName("receipt_app")}, NeutronActor)`,
  );
  const environmentStart = source.indexOf(environmentName("receipt_app"));
  const environmentEnd = source.indexOf(
    `${moduleName("receipt_app")}.Init`,
    environmentStart,
  );
  const environment = source.slice(environmentStart, environmentEnd);
  expect(environment).toContain(factory);
  expect(environment).not.toMatch(
    /management|derivation|key_1|dfx_test_key|chain_code|aux|digest|cycles|path/,
  );

  const { backend: _backend, ...unselectedApp } = app;
  const unselected = assemble({
    kernel: kernelConfig,
    receipt_app: unselectedApp,
  });
  expect(unselected).toContain(`${moduleName("receipt_app")}.Init()`);
  expect(unselected).not.toContain(
    `chain_key_signing_capability(${scopeName("receipt_app")})`,
  );
});

test("assembler emits exact stable stores and only the scoped logical handle", () => {
  const app: AssemblyManifest = {
    format: 3,
    id: "store_app",
    name: "Store App",
    version: 100,
    entry: "store_app",
    capabilities: {
      stable_store: {
        api: 1,
        stores: [{
          id: "notes",
          purpose: 'Keep durable "notes"',
          schema_version: 2,
          max_entries: 64,
          max_key_bytes: 48,
          max_value_bytes: 4096,
          max_bytes: 65_536,
        }],
      },
    },
    backend: { capabilities: { stable_store: { api: 1 } } },
  };
  const source = assemble({ kernel: kernelConfig, store_app: app });
  expect(source).toContain("stable_store = ?{");
  expect(source).toContain('id = "notes"');
  expect(source).toContain('purpose = "Keep durable \\"notes\\""');
  expect(source).toContain("schema_version = 2");
  expect(source).toContain("max_entries = 64");
  expect(source).toContain("max_key_bytes = 48");
  expect(source).toContain("max_value_bytes = 4096");
  expect(source).toContain("max_bytes = 65536");
  expect(source).toContain("kind = #stable_store");
  expect(source).toContain('resource_id = "notes"');
  const factory =
    `stable_store = ${initName("kernel")}.stable_store_capability(${scopeName("store_app")});`;
  expect(source).toContain(factory);
  const environmentStart = source.indexOf(environmentName("store_app"));
  const environmentEnd = source.indexOf(
    `${moduleName("store_app")}.Init`,
    environmentStart,
  );
  const environment = source.slice(environmentStart, environmentEnd);
  expect(environment).toContain(factory);
  expect(environment).not.toMatch(
    /installation_uid|Region|StableMemory|namespace_uid|offset|pointer/,
  );

  const { backend: _backend, ...unselectedApp } = app;
  const unselected = assemble({ kernel: kernelConfig, store_app: unselectedApp });
  expect(unselected).toContain(`${moduleName("store_app")}.Init()`);
  expect(unselected).not.toContain(
    `stable_store_capability(${scopeName("store_app")})`,
  );
});

test("assembler emits exact HTTPS declarations and one attenuated handle", () => {
  const app: AssemblyManifest = {
    format: 3,
    id: "weather_app",
    name: "Weather",
    version: 100,
    entry: "weather_app",
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
        ],
      },
    },
    backend: { capabilities: { https_outcalls: { api: 1 } } },
  };
  const source = assemble({ kernel: kernelConfig, weather_app: app });

  expect(source).toContain("https_outcalls = ?{");
  expect(source).toContain('id = "weather"');
  expect(source).toContain('url_prefix = "https://api.example.com/v1/"');
  expect(source).toContain("methods = [#get, #post]");
  expect(source).toContain(
    'request_headers = ["accept", "authorization"]',
  );
  expect(source).toContain("max_request_bytes = 65536");
  expect(source).toContain("max_response_bytes = 32768");
  expect(source).toContain("transform = #strip_headers");
  expect(source).toContain("kind = #https_outcalls");
  expect(source).toContain('resource_id = "weather"');
  expect(source).toContain(
    `https_outcalls = ${initName("kernel")}.https_outcalls_capability(${scopeName("weather_app")})`,
  );
  expect(source).not.toContain(
    `https_outcalls_capability(${scopeName("weather_app")}, NeutronActor)`,
  );

  const { backend: _backend, ...unselectedApp } = app;
  const unselected = assemble({
    kernel: kernelConfig,
    weather_app: unselectedApp,
  });
  expect(unselected).toContain(`${moduleName("weather_app")}.Init()`);
  expect(unselected).not.toContain(
    `https_outcalls_capability(${scopeName("weather_app")})`,
  );
});

test("capability declarations stay canonical when dependencies reverse app order", () => {
  const provider: AssemblyManifest = {
    ...httpsLimitApp("zzzz", 1, 1, 250_000_000),
    func: {
      ping: { type: "internal", async: false, expose: "apps" },
    },
  };
  const consumer: AssemblyManifest = {
    ...httpsLimitApp("aaaa", 1, 1, 250_000_000),
    dependencies: {
      provider: {
        app: "zzzz",
        min_version: 100,
        functions: ["ping"],
      },
    },
  };

  const source = assemble({ kernel: kernelConfig, aaaa: consumer, zzzz: provider });
  const configurationStart = source.indexOf(
    `${initName("kernel")}.configure_app_capabilities([`,
  );
  const configurationEnd = source.indexOf(
    "\n    });",
    configurationStart,
  );
  const configuration = source.slice(configurationStart, configurationEnd);

  expect(configurationStart).toBeGreaterThanOrEqual(0);
  expect(configurationEnd).toBeGreaterThan(configurationStart);
  expect(configuration.indexOf(`app_scope = ${scopeName("aaaa")}`)).toBeLessThan(
    configuration.indexOf(`app_scope = ${scopeName("zzzz")}`),
  );
  expect(source.indexOf(initName("zzzz"))).toBeLessThan(
    source.indexOf(initName("aaaa")),
  );
});

test("the app ceiling keeps HTTPS endpoints within the global ceiling", () => {
  const endpoints = Object.fromEntries(
    Array.from({ length: 255 }, (_, index) => {
      const app = httpsLimitApp(`https_endpoints_${index}`, 8, 1, 250_000_000);
      return [app.id, app];
    }),
  );
  expect(() => assemble({ kernel: kernelConfig, ...endpoints })).not.toThrow();
});

test("the app ceiling keeps chain-key slots within the global ceiling", () => {
  const slots = Object.fromEntries(
    Array.from({ length: 255 }, (_, index) => {
      const app = chainKeySigningLimitApp(
        `assertion_slots_${index}`,
        4,
        1,
        50_000_000_000,
      );
      return [app.id, app];
    }),
  );
  expect(() => assemble({ kernel: kernelConfig, ...slots })).not.toThrow();
});

test("assembler preflights the global vetKeys declaration limit", () => {
  const atLimit = Object.fromEntries(
    Array.from({ length: VETKEYS_MAX_SLOTS_GLOBAL / 4 }, (_, index) => {
      const app = vetKeysLimitApp(`vetkeys_${index}`, 4);
      return [app.id, app];
    }),
  );
  expect(() => assemble({ kernel: kernelConfig, ...atLimit })).not.toThrow();

  const overLimit = vetKeysLimitApp("vetkeys_over_limit", 1);
  expect(() =>
    assemble({
      kernel: kernelConfig,
      ...atLimit,
      [overLimit.id]: overLimit,
    }),
  ).toThrow(
    `129 slots (maximum ${VETKEYS_MAX_SLOTS_GLOBAL})`,
  );
});

test("assembler preflights backend-call install defaults", () => {
  const reservationsPerApp = 64;
  const atLimit = Object.fromEntries(
    Array.from(
      {
        length:
          BACKEND_CALLS_MAX_INSTALL_RESERVATIONS_GLOBAL /
          reservationsPerApp,
      },
      (_, index) => {
        const app = backendCallReservationLimitApp(
          `reserved_calls_${index}`,
          reservationsPerApp,
        );
        return [app.id, app];
      },
    ),
  );
  expect(() => assemble({ kernel: kernelConfig, ...atLimit })).not.toThrow();

  const overLimit = backendCallReservationLimitApp(
    "reserved_calls_over_limit",
    1,
  );
  expect(() =>
    assemble({
      kernel: kernelConfig,
      ...atLimit,
      [overLimit.id]: overLimit,
    }),
  ).toThrow(
    `2049 reservations (maximum ${BACKEND_CALLS_MAX_INSTALL_RESERVATIONS_GLOBAL})`,
  );

  const first = backendCallReservationLimitApp(
    "reservation_owner_a",
    1,
    "shared_reserved_method",
  );
  const second = backendCallReservationLimitApp(
    "reservation_owner_b",
    1,
    "shared_reserved_method",
  );
  expect(() =>
    assemble({
      kernel: kernelConfig,
      [first.id]: first,
      [second.id]: second,
    }),
  ).toThrow(
    "Assembly backend_calls install reservation method::shared_reserved_method is declared by both reservation_owner_a and reservation_owner_b",
  );
});

test("assembler preflights stable_store global declaration ceilings", () => {
  const countApps = Object.fromEntries(
    Array.from({ length: 255 }, (_, index) => {
      const app = stableStoreLimitApp(`store_count_${index}`, 8, 1, 2);
      return [app.id, app];
    }),
  );
  expect(() => assemble({ kernel: kernelConfig, ...countApps })).not.toThrow();

  const entryApps = Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => {
      const app = stableStoreLimitApp(`store_entries_${index}`, 2, 4096, 2);
      return [app.id, app];
    }),
  );
  expect(() => assemble({ kernel: kernelConfig, ...entryApps })).toThrow(
    /73728 entries \(maximum 65536\)/,
  );

  const byteApps = Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => {
      const app = stableStoreLimitApp(
        `store_bytes_${index}`,
        2,
        1,
        16_777_216,
      );
      return [app.id, app];
    }),
  );
  expect(() => assemble({ kernel: kernelConfig, ...byteApps })).toThrow(
    /301989888 bytes \(maximum 268435456\)/,
  );
});

test("assembler preflights generic certified-assets physical admission", () => {
  const exactExtentTarget = {
    extent_a: certifiedAssetsExtentApp("extent_a", 100_000),
    extent_b: certifiedAssetsExtentApp("extent_b", 24_965),
  };
  expect(() =>
    assemble({ kernel: kernelConfig, ...exactExtentTarget }),
  ).not.toThrow();

  expect(() =>
    assemble({
      kernel: kernelConfig,
      ...exactExtentTarget,
      extent_b: certifiedAssetsExtentApp("extent_b", 24_966),
    }),
  ).toThrow(/125000 arena extents \(2x\+1 maximum 250000\)/);

  const individuallyValidButPhysicallyImpossible: AssemblyManifest = {
    ...certifiedAssetsExtentApp("physical_maximum", 100_000),
    capabilities: {
      certified_assets: {
        api: 2,
        max_entries: 100_000,
        max_committed_bytes: 1_073_741_824,
        max_object_bytes: 67_108_864,
        max_pending_stages: 1,
        max_staged_bytes: 67_108_864,
        max_batch_operations: 16,
        max_batch_bytes: 67_108_864,
        max_idempotency_receipts: 4_096,
        collections: [
          {
            id: "objects",
            mount: "objects",
            kind: "publication",
          },
        ],
      },
    },
  };
  expect(() =>
    assemble({
      kernel: kernelConfig,
      physical_maximum: individuallyValidButPhysicallyImpossible,
    }),
  ).toThrow(/certified_assets declarations exceed physical admission/);
});

test("assembler binds resident frame security to each exact app scope", () => {
  const source = assemble({
    kernel: kernelConfig,
    gemma: {
      format: 3,
      id: "gemma",
      name: "Gemma",
      version: 100,
      entry: "gemma",
      background: { path: "service.html" },
      capabilities: {
        persistent_browser_storage: {
          api: 1,
          surface: "background",
        },
      },
    },
    isolated: {
      format: 3,
      id: "isolated",
      name: "Isolated",
      version: 100,
      entry: "isolated",
      background: { path: "resident.html" },
      capabilities: {
        dedicated_resident_origin: {
          api: 1,
          surface: "background",
          mode: "credentialless_ephemeral_v1",
        },
      },
    },
  });

  expect(source).toMatch(
    new RegExp(
      `app_scope = ${scopeName("gemma")};[\\s\\S]*?resident_frame_security = #persistent_dedicated_v1;[\\s\\S]*?resident_background_path = \\?"/app/gemma/service.html"`,
    ),
  );
  expect(source).toMatch(
    new RegExp(
      `app_scope = ${scopeName("isolated")};[\\s\\S]*?resident_frame_security = #credentialless_ephemeral_dedicated_v1;[\\s\\S]*?resident_background_path = \\?"/app/isolated/resident.html"`,
    ),
  );
  expect(source).toContain(
    'app_id = "kernel"; version = 100; capability_plan_fingerprint =',
  );
  expect(source).toContain(
    "resident_frame_security = #credentialless_opaque_v1",
  );
  expect(source).toContain("backend_calls = null");
  expect(source).toContain("vetkeys = null");
  expect(source).toContain("connections = null");
  expect(source).not.toContain(environmentName("gemma"));
});

test("assembler projects every browser surface without frontend browser grants", () => {
  const source = assemble(
    {
      media: {
        format: 3,
        id: "media",
        name: "Media",
        version: 100,
        entry: "media",
        tiles: [
          { id: "zeta", title: "Zeta", path: "zeta.html" },
          { id: "alpha", title: "Alpha", path: "alpha.html" },
        ],
        tray: { title: "Media tray", path: "tray.html", icon: "tray.svg" },
        background: { path: "background.html" },
        capabilities: {
          browser_permissions: {
            api: 1,
            tiles: [
              { id: "zeta", features: ["microphone", "camera"] },
              { id: "alpha", features: ["camera"] },
            ],
          },
        },
      },
      kernel: kernelConfig,
      dedicated: {
        format: 3,
        id: "dedicated",
        name: "Dedicated",
        version: 100,
        entry: "dedicated",
        tiles: [{ id: "main", title: "Main", path: "index.html" }],
        background: { path: "resident.html" },
        capabilities: {
          dedicated_resident_origin: {
            api: 1,
            surface: "background",
            mode: "credentialless_ephemeral_v1",
          },
        },
      },
    },
    { browserSurfaceOriginAppIds: ["media"] },
  );
  const configuration = source.match(
    /configure_app_browser_surfaces\(\[(.*?)\]\);/s,
  )?.[1];
  expect(configuration).toBeDefined();
  expect(configuration!.indexOf(`app_scope = ${scopeName("dedicated")}`))
    .toBeLessThan(configuration!.indexOf(`app_scope = ${scopeName("kernel")}`));
  expect(configuration!.indexOf(`app_scope = ${scopeName("kernel")}`))
    .toBeLessThan(configuration!.indexOf(`app_scope = ${scopeName("media")}`));
  expect(configuration).toContain(`app_scope = ${scopeName("kernel")};\n        surface_origins = false;\n        tiles = [];\n        tray = false;\n        ordinary_background = false;`);
  expect(configuration).toContain(`app_scope = ${scopeName("dedicated")};\n        surface_origins = false;\n        tiles = [{\n          id = "main";\n        }];\n        tray = false;\n        ordinary_background = false;`);
  expect(configuration).toContain(`app_scope = ${scopeName("media")};\n        surface_origins = true;\n        tiles = [{\n          id = "alpha";\n        }, {\n          id = "zeta";\n        }];\n        tray = true;\n        ordinary_background = true;`);

  const backendConfiguration = source.match(
    /configure_app_capabilities\(\[(.*?)\], \{/s,
  )?.[1];
  expect(backendConfiguration).toBeDefined();
  expect(backendConfiguration).not.toContain("browser_permissions");
  expect(configuration).not.toContain("browser_permissions");
  expect(source).not.toContain("kind = #browser_permissions");
});

test("assembler emits exact declarations for connection-only apps", () => {
  const source = assemble({
    kernel: kernelConfig,
    agent: {
      format: 3,
      id: "agent",
      name: "Agent",
      version: 100,
      entry: "agent",
      background: { path: "service.html" },
      capabilities: {
        connections: {
          api: 1,
          providers: [
            {
              provider: "openrouter",
              scopes: [],
            },
          ],
        },
      },
    },
  });

  expect(source).toContain(`app_scope = ${scopeName("agent")}`);
  expect(source).toContain("connections = ?{");
  expect(source).toContain(
    'provider = "openrouter"; scopes = []',
  );
  expect(source).not.toContain("access =");
  expect(source).not.toContain(environmentName("agent"));
});

test("assembler preflights the aggregate resident connection-provider ceiling", () => {
  const connectionApp = (index: number): AssemblyManifest => {
    const id = `connection_${index}`;
    return {
      format: 3,
      id,
      name: `Connection ${index}`,
      version: 100,
      entry: id,
      background: { path: "service.html" },
      capabilities: {
        connections: {
          api: 1,
          providers: Array.from({ length: 8 }, (_, providerIndex) => ({
            provider: `provider_${providerIndex}`,
            scopes: [],
          })),
        },
      },
    };
  };
  const atLimit = Object.fromEntries(
    Array.from(
      { length: CONNECTIONS_MAX_PROVIDERS_GLOBAL / 8 },
      (_, index) => {
        const app = connectionApp(index);
        return [app.id, app];
      },
    ),
  );
  expect(() => assemble({ kernel: kernelConfig, ...atLimit })).not.toThrow();

  const overLimit = {
    ...connectionApp(CONNECTIONS_MAX_PROVIDERS_GLOBAL / 8),
    capabilities: {
      connections: {
        api: 1 as const,
        providers: [
          {
            provider: "provider_over_limit",
            scopes: [],
          },
        ],
      },
    },
  };
  expect(() =>
    assemble({ kernel: kernelConfig, ...atLimit, [overLimit.id]: overLimit }),
  ).toThrow(
    `${CONNECTIONS_MAX_PROVIDERS_GLOBAL + 1} providers (maximum ${CONNECTIONS_MAX_PROVIDERS_GLOBAL})`,
  );
});

test("assembler configures app-isolated vetKeys with trusted environment selection", () => {
  const mail: AssemblyManifest = {
    format: 3,
    id: "mail",
    name: "Mail",
    version: 100,
    entry: "mail",
    capabilities: {
      vetkeys: {
        api: 1,
        description: 'Recover the key for "private" Mail',
        slots: [
          {
            id: "mailbox",
            purpose: "Encrypt and decrypt private Mail",
          },
        ],
      },
    },
  };

  const frontendOnly = assemble(
    { kernel: kernelConfig, mail },
    {
      vetKeysEnvironment: "local",
    },
  );
  expect(frontendOnly).toContain("vetkeys_environment = #local");
  expect(frontendOnly).toContain('ecdsa_secp256k1 = ?"dfx_test_key"');
  expect(frontendOnly).toContain("schnorr_bip340secp256k1 = null");
  expect(frontendOnly).toContain("schnorr_ed25519 = null");
  expect(frontendOnly).toContain('app_id = "mail"');
  expect(frontendOnly).toContain("backend_calls = null");
  expect(frontendOnly).toContain(
    'description = "Recover the key for \\"private\\" Mail"',
  );
  expect(frontendOnly).toContain(
    '{ id = "mailbox"; purpose = "Encrypt and decrypt private Mail" }',
  );
  expect(frontendOnly).not.toContain(environmentName("mail"));
  expect(frontendOnly).not.toContain("vetkeys_public_capability");

  const backendConsumer = assemble({
    kernel: kernelConfig,
    mail: {
      ...mail,
      backend: { capabilities: { vetkeys_public: { api: 1 } } },
    },
  });
  expect(backendConsumer).toContain(
    `vetkeys_public = ${initName("kernel")}.vetkeys_public_capability(${scopeName("mail")}, NeutronActor)`,
  );
  expect(backendConsumer).toContain(
    `${moduleName("mail")}.Init(${environmentName("mail")})`,
  );
  expect(backendConsumer).toContain("vetkeys_environment = #production");
  expect(backendConsumer).toContain('ecdsa_secp256k1 = ?"key_1"');
});

test("backend-call-only apps do not consume the independent vetKeys slot budget", () => {
  const backendOnly = Object.fromEntries(
    Array.from({ length: 129 }, (_, index) => {
      const id = `backend_${index}`;
      return [
        id,
        {
          format: 3,
          id,
          name: id,
          version: 100,
          entry: id,
          capabilities: {
            backend_calls: {
              api: 1,
              description: "Call an approved backend",
              reservation_scopes: ["exact" as const],
              max_concurrency: 1,
              max_cycles_per_call: 0,
              max_cycles_per_day: 0,
            },
          },
          backend: {
            capabilities: { backend_calls: { api: 1 } },
          },
        } satisfies AssemblyManifest,
      ];
    }),
  );
  const source = assemble({
    kernel: kernelConfig,
    ...backendOnly,
    mail: {
      format: 3,
      id: "mail",
      name: "Mail",
      version: 100,
      entry: "mail",
      capabilities: {
        vetkeys: {
          api: 1,
          description: "Private Mail",
          slots: [{ id: "mailbox", purpose: "Decrypt Mail" }],
        },
      },
    },
  });

  expect(source).toContain('app_id = "backend_128"');
  expect(source).toContain('app_id = "mail"');
  expect(source).toContain('{ id = "mailbox"; purpose = "Decrypt Mail" }');
});

test("assembler wires static scheduled tasks through the kernel", () => {
  const source = assemble({
    kernel: kernelConfig,
    wallet: {
      format: 3,
      id: "wallet",
      name: "Wallet",
      version: 100,
      entry: "wallet",
      func: {
        wallet_history_tick: { type: "internal", async: "async*" },
      },
      capabilities: {
        scheduled_tasks: {
          api: 1,
          tasks: [
            {
              id: "ledger_history",
              method: "wallet_history_tick",
              interval_seconds: 43_200,
              run_on_start: true,
              max_backend_calls: 100,
            },
          ],
        },
      },
    },
  });

  expect(source).toContain(
    `${initName("kernel")}.configure_scheduled_tasks<system>`,
  );
  expect(source).toContain("kind = #scheduled_tasks");
  expect(source).toContain('resource_id = "ledger_history"');
  expect(source).toContain('id = "ledger_history"');
  expect(source).toContain(
    `await* ${privateFunctionName("wallet", "wallet_history_tick")}(())`,
  );
  expect(source).toMatch(
    new RegExp(
      `app_usage_instruction_begin\\(${scopeName("wallet")}, 260_000\\)[\\s\\S]*?await\\* ${privateFunctionName("wallet", "wallet_history_tick")}\\(\\(\\)\\)[\\s\\S]*?app_usage_instruction_finish\\(NeutronAppUsageMeasurement\\)[\\s\\S]*?catch \\(NeutronTaskError\\)[\\s\\S]*?app_usage_instruction_finish\\(NeutronAppUsageMeasurement\\)[\\s\\S]*?throw NeutronTaskError`,
    ),
  );
});

test("assembler admits at most 64 scheduled tasks", () => {
  const taskApp = (index: number, taskCount: number): AssemblyManifest => {
    const id = `task_app_${index}`;
    const taskIds = Array.from(
      { length: taskCount },
      (_, taskIndex) => `task_${taskIndex}`,
    );
    return {
      format: 3,
      id,
      name: `Task app ${index}`,
      version: 100,
      entry: id,
      func: Object.fromEntries(
        taskIds.map((taskId) => [
          taskId,
          { type: "internal" as const, async: "async*" as const },
        ]),
      ),
      capabilities: {
        scheduled_tasks: {
          api: 1,
          tasks: taskIds.map((taskId) => ({
            id: taskId,
            method: taskId,
            interval_seconds: 3_600,
            run_on_start: false,
            max_backend_calls: 1,
          })),
        },
      },
    };
  };
  const atLimit = Object.fromEntries(
    Array.from({ length: NEUTRON_SCHEDULED_TASK_LIMIT / 2 }, (_, index) => {
      const app = taskApp(index, 2);
      return [app.id, app];
    }),
  );
  expect(() => assemble({ kernel: kernelConfig, ...atLimit })).not.toThrow();

  const overLimit = taskApp(NEUTRON_SCHEDULED_TASK_LIMIT / 2, 1);
  expect(() =>
    assemble({ kernel: kernelConfig, ...atLimit, [overLimit.id]: overLimit }),
  ).toThrow(
    `Assembly declares ${NEUTRON_SCHEDULED_TASK_LIMIT + 1} scheduled tasks; maximum is ${NEUTRON_SCHEDULED_TASK_LIMIT}`,
  );
});

test("assembler injects the bounded declaration-free deferred timer handle", () => {
  const source = assemble({
    kernel: kernelConfig,
    wagyu: {
      format: 3,
      id: "wagyu",
      name: "Wagyu",
      version: 101,
      entry: "wagyu",
      backend: {
        capabilities: {
          deferred_timers: { api: 1 },
        },
      },
    },
  });

  expect(source).toContain(
    `deferred_timers = ${initName("kernel")}.deferred_timers_capability(${scopeName("wagyu")})`,
  );
  expect(source).not.toContain("kind = #deferred_timers");
});

test("assembler gives each scheduled task its own backend-call capability", () => {
  const source = assemble({
    kernel: kernelConfig,
    wallet: {
      format: 3,
      id: "wallet",
      name: "Wallet",
      version: 100,
      entry: "wallet",
      func: {
        task_a: {
          type: "internal",
          async: "async*",
          arg: ["task_capabilities"],
        },
        task_b: {
          type: "internal",
          async: "async*",
          arg: ["task_capabilities"],
        },
      },
      capabilities: {
        backend_calls: {
          api: 1,
          description: "Call approved ledgers",
          reservation_scopes: ["principal"],
          max_concurrency: 2,
          max_cycles_per_call: 0,
          max_cycles_per_day: 0,
        },
        scheduled_tasks: {
          api: 1,
          tasks: [
            {
              id: "first",
              method: "task_a",
              interval_seconds: 3_600,
              run_on_start: true,
              max_backend_calls: 2,
            },
            {
              id: "second",
              method: "task_b",
              interval_seconds: 3_600,
              run_on_start: true,
              max_backend_calls: 1,
            },
          ],
        },
      },
    },
  });

  expect(source.match(/task_backend_calls_capability/g)).toHaveLength(2);
  expect(source).toContain(
    `${scopeName("wallet")},\n              "first",\n              2`,
  );
  expect(source).toContain(
    `${scopeName("wallet")},\n              "second",\n              1`,
  );
  expect(source).toContain(
    `${privateFunctionName("wallet", "task_a")}((), NeutronTaskCapabilities)`,
  );
  expect(source).toContain(
    `${privateFunctionName("wallet", "task_b")}((), NeutronTaskCapabilities)`,
  );
  expect(source).not.toContain(
    `${initName("kernel")}.backend_calls_capability(${scopeName("wallet")}, NeutronActor)`,
  );
});

test("assembler rejects invalid scheduled task targets", () => {
  expect(() =>
    assemble({
      kernel: kernelConfig,
      wallet: {
        format: 3,
        id: "wallet",
        name: "Wallet",
        version: 100,
        entry: "wallet",
        func: {
          wallet_history_tick: { type: "update", async: "async*" },
        },
        capabilities: {
          scheduled_tasks: {
            api: 1,
            tasks: [
              {
                id: "ledger_history",
                method: "wallet_history_tick",
                interval_seconds: 43_200,
                run_on_start: true,
                max_backend_calls: 100,
              },
            ],
          },
        },
      },
    }),
  ).toThrow(
    /must name an internal manifest function|same-app internal async\*/,
  );
});

test("assembler rejects guessed constructor resources", () => {
  expect(() =>
    assemble({
      kernel: kernelConfig,
      hello: { ...helloConfig, init_arg: ["memory_kernel"] },
    }),
  ).toThrow("App hello cannot use init_arg");

  expect(() =>
    assemble({
      kernel: kernelConfig,
      hello: { ...helloConfig, init_arg: ["app_capabilities"] },
    }),
  ).toThrow("App hello cannot use init_arg");
});

test("assembler injects only declared app dependency functions", () => {
  const contacts: AssemblyManifest = {
    format: 3,
    id: "contacts",
    name: "Contacts",
    version: 102,
    entry: "contacts",
    func: {
      list_contacts: {
        type: "internal",
        async: "async*",
        expose: "apps",
      },
      private_helper: { type: "internal", async: false },
    },
  };
  const calendar: AssemblyManifest = {
    format: 3,
    id: "calendar",
    name: "Calendar",
    version: 100,
    entry: "calendar",
    dependencies: {
      people: {
        app: "contacts",
        min_version: 102,
        functions: ["list_contacts"],
      },
    },
  };

  const source = assemble({ kernel: kernelConfig, calendar, contacts });
  const contactsList = privateFunctionName("contacts", "list_contacts");
  expect(source).toContain(
    `people = {\n        list_contacts = ${contactsList};`,
  );
  expect(source).toContain(
    `${moduleName("calendar")}.Init(${environmentName("calendar")})`,
  );
  expect(source.indexOf(contactsList)).toBeLessThan(
    source.indexOf(environmentName("calendar")),
  );
  const contactsWrapper = source.slice(
    source.indexOf(`private func ${contactsList}`),
    source.indexOf("};", source.indexOf(`private func ${contactsList}`)),
  );
  expect(contactsWrapper).toContain(
    `assert(${initName("kernel")}.scope_active(${scopeName("contacts")}));`,
  );
  expect(contactsWrapper).toContain(`${initName("contacts")}.list_contacts`);
  const dependencyHandle = source.slice(
    source.indexOf(environmentName("calendar")),
    source.indexOf(initName("calendar")),
  );
  expect(dependencyHandle).not.toContain("private_helper");
});

test("assembler supports dependency and capability handles together", () => {
  const contacts: AssemblyManifest = {
    format: 3,
    id: "contacts",
    name: "Contacts",
    version: 100,
    entry: "contacts",
    func: {
      list_contacts: {
        type: "internal",
        expose: "apps",
      },
    },
  };
  const wallet: AssemblyManifest = {
    format: 3,
    id: "wallet",
    name: "Wallet",
    version: 100,
    entry: "wallet",
    dependencies: {
      people: {
        app: "contacts",
        min_version: 100,
        functions: ["list_contacts"],
      },
    },
    capabilities: {
      backend_calls: {
        api: 1,
        description: "Call approved canisters",
        reservation_scopes: ["principal"],
        max_concurrency: 2,
        max_cycles_per_call: 0,
        max_cycles_per_day: 0,
      },
    },
    backend: {
      capabilities: { backend_calls: { api: 1 } },
    },
  };
  const source = assemble({ kernel: kernelConfig, contacts, wallet });
  expect(source).toContain(
    `${moduleName("wallet")}.Init(${environmentName("wallet")})`,
  );
  const environment = source.slice(
    source.indexOf(environmentName("wallet")),
    source.indexOf(initName("wallet")),
  );
  expect(environment).toContain("app_calls = {");
  expect(environment).toContain("capabilities = {");
});

test("assembler rejects raw privileged injections in ordinary apps", () => {
  for (const argument of [
    "module_contacts_list_contacts",
    "this",
    "this.owner",
    "memory_kernel",
    "app_caller",
    "contacts_init",
    "kernel_init",
    "contacts_app_dependencies",
  ]) {
    expect(() =>
      assemble({
        kernel: kernelConfig,
        hello: {
          ...helloConfig,
          func: {
            hello_world: {
              type: "update",
              arg: [argument],
            },
          },
        },
      }),
    ).toThrow();
  }
});

test("assembler permits caller and owned memory function resources", () => {
  const source = assemble({
    kernel: kernelConfig,
    hello: {
      ...helloConfig,
      func: {
        hello_world: {
          type: "update",
          arg: ["caller", "memory_hello"],
        },
      },
    },
  });
  expect(source).toContain(
    `${initName("hello")}.hello_world(NeutronRequest ,NeutronCaller,${memoryBindingName("hello", "hello")})`,
  );
});

test("assembler injects only the read-only canister principal into apps", () => {
  const source = assemble({
    kernel: kernelConfig,
    hello: {
      ...helloConfig,
      func: {
        hello_world: {
          type: "update",
          arg: ["caller", "canister_principal"],
        },
      },
    },
  });
  expect(source).toContain('import NeutronPrim "mo:prim"');
  expect(source).toContain(
    `${initName("hello")}.hello_world(NeutronRequest ,NeutronCaller,NeutronPrim.principalOfActor(NeutronActor))`,
  );
  expect(source).not.toContain(
    `${initName("hello")}.hello_world(NeutronRequest ,NeutronCaller,NeutronActor)`,
  );
});

test("assembler initializes a module once after all memory namespaces", () => {
  const source = assemble({
    kernel: {
      ...kernelConfig,
      init_arg: ["memory_kernel", "memory_kernel_connections"],
      memory: {
        kernel: {
          version: 1,
          schemas: { "1": { src: "memory/kernel.mo" } },
          migrations: [],
        },
        kernel_connections: {
          version: 1,
          schemas: { "1": { src: "memory/kernel_connections.mo" } },
          migrations: [],
        },
      },
    },
    hello: helloConfig,
  });

  expect(source).toContain(`let ${memoryStoreName("kernel", "kernel")}:`);
  expect(source).toContain(
    `let ${memoryStoreName("kernel", "kernel_connections")}:`,
  );
  expect(source).toContain(
    `${moduleName("kernel")}.Init(${memoryBindingName("kernel", "kernel")},${memoryBindingName("kernel", "kernel_connections")})`,
  );
  expect(source.match(/transient let NeutronKernel/g)).toHaveLength(1);
  expect(
    source.indexOf(memoryStoreName("kernel", "kernel_connections")),
  ).toBeLessThan(source.indexOf("transient let NeutronKernel"));
});

test("assembler physically namespaces equal app-local managed-memory ids", () => {
  const source = assemble({
    kernel: kernelConfig,
    alpha: {
      ...helloConfig,
      id: "alpha",
      name: "Alpha",
      entry: "alpha",
      memory: {
        state: {
          version: 1,
          schemas: { "1": { src: "memory/alpha_state.mo" } },
          migrations: [],
        },
      },
    },
    beta_app: {
      ...helloConfig,
      id: "beta_app",
      name: "Beta",
      entry: "beta_app",
      memory: {
        state: {
          version: 1,
          schemas: { "1": { src: "memory/beta_state.mo" } },
          migrations: [],
        },
      },
    },
  });

  const alphaStore = memoryStoreName("alpha", "state");
  const betaStore = memoryStoreName("beta_app", "state");
  expect(alphaStore).not.toBe(betaStore);
  expect(source).toContain(`let ${alphaStore}:`);
  expect(source).toContain(`let ${betaStore}:`);
  expect(source).toContain(
    `state = ${memoryBindingName("alpha", "state")};`,
  );
  expect(source).toContain(
    `state = ${memoryBindingName("beta_app", "state")};`,
  );
  expect(source).toContain('{ id = "state"; owner = "alpha";');
  expect(source).toContain('{ id = "state"; owner = "beta_app";');
  expect(source).not.toContain("NeutronMemoryStore_state");
});

test("assembler keeps public kernel install wrapper awaited", () => {
  const source = assemble({ kernel: kernelConfig, hello: helloConfig });

  expect(source).toMatch(
    /public shared\(\{ caller = NeutronCaller \}\) func kernel_install_code[\s\S]*await\s+NeutronKernel\.kernel_install_code\(NeutronRequest ,NeutronActor\)/,
  );
  expect(source).not.toMatch(/fire_and_forget/);
  expect(source).not.toMatch(/ignore\s+NeutronKernel\.kernel_install_code/);
});

test("assembler runs local async computations without a synthetic await", () => {
  const source = assemble({ kernel: kernelConfig, hello: helloConfig });

  expect(source).toMatch(
    /public shared\(\{ caller = NeutronCaller \}\) func kernel_connections_begin[\s\S]*await\*\s+NeutronKernel\.kernel_connections_begin\(NeutronRequest ,NeutronCaller,NeutronActor\)/,
  );
  expect(source).not.toMatch(/await\s+NeutronKernel\.kernel_connections_begin/);
});

test("assembler rejects injectable manifest values", () => {
  expect(() =>
    assemble({
      kernel: {
        ...kernelConfig,
        id: "kernel;Debug.print",
      },
    }),
  ).toThrow(/Invalid neutron\.json value/);
});

test("assembler ignores display-only tile metadata during injection checks", () => {
  const source = assemble({
    kernel: kernelConfig,
    hello: {
      ...helloConfig,
      tiles: [
        {
          id: "tools",
          title: "Tools Panel",
          path: "tools/index.html",
          icon: "static/tools.png",
        },
      ],
    },
  });

  expect(source).toContain(`import ${moduleName("hello")} "hello"`);
});

test("assembler keeps untrusted app ids out of compiler-owned identifiers", () => {
  const hostileIds = [
    "kernel_init",
    "hello_init",
    "hello_app_scope",
    "task_capabilities",
    "active_app_instance_inventory",
  ];
  const source = assemble([
    kernelConfig,
    ...hostileIds.map(
      (id): AssemblyManifest => ({
        format: 3,
        id,
        name: id,
        version: 100,
        entry: id,
      }),
    ),
  ]);

  for (const appId of hostileIds) {
    expect(source).toContain(`import ${moduleName(appId)} "${appId}"`);
    expect(source).toContain(`transient let ${initName(appId)}`);
    expect(source).toContain(`transient let ${scopeName(appId)}`);
    expect(source).not.toContain(`import ${appId} "${appId}"`);
    expect(source).not.toContain(`transient let ${appId}_init`);
    expect(source).not.toContain(`transient let ${appId}_app_scope`);
  }
});

test("assembler namespaces equal local public method names by app", () => {
  const source = assemble({
    kernel: kernelConfig,
    hello: {
      ...helloConfig,
      func: {
        kernel_install_code: { type: "update", async: false },
      },
    },
    world: {
      format: 3,
      id: "world",
      name: "World",
      version: 100,
      entry: "world",
      func: {
        kernel_install_code: { type: "update", async: false },
      },
    },
  });

  expect(source).toContain("func kernel_install_code");
  expect(source).toContain(
    `func ${physicalAppMethodName("hello", "kernel_install_code")}`,
  );
  expect(source).toContain(
    `func ${physicalAppMethodName("world", "kernel_install_code")}`,
  );
});

test("assembler keeps underscore-heavy app and method pairs collision-free", () => {
  const source = assemble({
    kernel: kernelConfig,
    aaaa_b: {
      format: 3,
      id: "aaaa_b",
      name: "One",
      version: 100,
      entry: "one",
      func: { c: { type: "query" } },
    },
    aaaa: {
      format: 3,
      id: "aaaa",
      name: "Two",
      version: 100,
      entry: "two",
      func: { b_c: { type: "query" } },
    },
  });

  expect(source).toContain(`func ${physicalAppMethodName("aaaa_b", "c")}`);
  expect(source).toContain(`func ${physicalAppMethodName("aaaa", "b_c")}`);
});

test("assembler length-delimits private app dependency wrappers", () => {
  const source = assemble({
    kernel: kernelConfig,
    aaaa_b: {
      format: 3,
      id: "aaaa_b",
      name: "One",
      version: 100,
      entry: "one",
      func: { c: { type: "internal", expose: "apps" } },
    },
    aaaa: {
      format: 3,
      id: "aaaa",
      name: "Two",
      version: 100,
      entry: "two",
      func: { b_c: { type: "internal", expose: "apps" } },
    },
  });

  const first = privateFunctionName("aaaa_b", "c");
  const second = privateFunctionName("aaaa", "b_c");
  expect(first).not.toBe(second);
  expect(source).toContain(`private func ${first}`);
  expect(source).toContain(`private func ${second}`);
});

test("assembler rejects a kernel method colliding with a physical app wrapper", () => {
  expect(() =>
    assemble({
      kernel: {
        ...kernelConfig,
        func: {
          ...kernelConfig.func,
          [physicalAppMethodName("hello", "read")]: {
            type: "query",
            async: false,
          },
        },
      },
      hello: {
        ...helloConfig,
        func: { read: { type: "query", async: false } },
      },
    }),
  ).toThrow(
    `Duplicate physical public function '${physicalAppMethodName("hello", "read")}'`,
  );
});

test("assembler rejects duplicate module ids", () => {
  expect(() =>
    assemble([kernelConfig, { ...helloConfig, id: "kernel" }]),
  ).toThrow(/Duplicate module id 'kernel'/);
});

test("assembler requires the kernel module config", () => {
  expect(() => assemble({ hello: helloConfig })).toThrow(
    /kernel module config is required/,
  );
});

test("assembler composes managed migration edges into one native expression", () => {
  const schema1 = "1".repeat(64);
  const schema2 = "2".repeat(64);
  const edge = "3".repeat(64);
  const schema2Hash = "4".repeat(64);
  const source = assemble(
    {
      kernel: kernelConfig,
      hello: {
        ...helloConfig,
        format: 3,
        version: 101,
        memory: {
          hello: {
            version: 2,
            schemas: {
              "1": { entry: schema1, hash: schema1 },
              "2": { entry: schema2, hash: schema2Hash },
            },
            migrations: [{ from: 1, to: 2, entry: edge }],
          },
        },
      },
    },
    {
      deploymentId: "abc123",
      compilerId: "moc_123",
      migrationPlan: {
        removedApps: [],
        destructiveMemoryRoots: [],
        upgrades: [
          {
            kind: "migrate",
            owner: "hello",
            memoryId: "hello",
            from: 1,
            to: 2,
            oldSchemaEntry: schema1,
            path: [{ from: 1, to: 2, entry: edge }],
          },
        ],
      },
    },
  );

  expect(source).toContain("with migration = func");
  expect(source).toContain(
    `import NeutronMemorySchema_${scopedPhysicalStem("hello", "hello")}_v1 \"${schema1}\"`,
  );
  expect(source).toContain(
    `import NeutronMemoryMigration_${scopedPhysicalStem("hello", "hello")}_v1_to_v2 \"${edge}\"`,
  );
  expect(source).toContain(`${memoryStoreName("hello", "hello")} = #v2(`);
  expect(source).toContain('deployment_id = "abc123"');
  expect(source).toContain(
    `import NeutronMemorySchema_${scopedPhysicalStem("hello", "hello")}_v2 \"${schema2}\"`,
  );
  expect(source).toContain(`schema = \"${schema2Hash}\"`);
});

test("assembler stages consumed roots and wires commit-atomic retirement", () => {
  const schema1 = "1".repeat(64);
  const schema2 = "2".repeat(64);
  const auxSchema = "3".repeat(64);
  const edge = "4".repeat(64);
  const source = assemble(
    {
        kernel: kernelConfig,
        hello: {
          ...helloConfig,
          format: 3,
          version: 101,
          memory: {
            hello: {
              version: 2,
              schemas: {
                "1": { entry: schema1, hash: schema1 },
                "2": { entry: schema2, hash: schema2 },
              },
              migrations: [
                {
                  from: 1,
                  to: 2,
                  consume: ["hello_aux"],
                  entry: edge,
                },
              ],
            },
            hello_aux: {
              version: 1,
              schemas: { "1": { entry: auxSchema, hash: auxSchema } },
              migrations: [],
              retired: true,
            },
          },
        },
    },
    {
        migrationPlan: {
          removedApps: [],
          destructiveMemoryRoots: [
            { owner: "hello", memoryId: "hello_aux" },
          ],
          upgrades: [
            {
              kind: "migrate",
              owner: "hello",
              memoryId: "hello",
              from: 1,
              to: 2,
              oldSchemaEntry: schema1,
              path: [
                {
                  from: 1,
                  to: 2,
                  consume: ["hello_aux"],
                  entry: edge,
                },
              ],
            },
            {
              kind: "retire",
              reason: "memory-retirement",
              owner: "hello",
              memoryId: "hello_aux",
              from: 1,
              oldSchemaEntry: auxSchema,
            },
          ],
        },
    },
  );

  const auxStore = memoryStoreName("hello", "hello_aux");
  const retiredAuxStore = retiredMemoryStoreName("hello", "hello_aux");
  expect(source).toContain(`NeutronOld.${auxStore}`);
  expect(source).toContain(`${retiredAuxStore} = ?NeutronOld.${auxStore}`);
  expect(source).toContain(`var ${retiredAuxStore}`);
  expect(source).toContain(`${retiredAuxStore} := null`);
  expect(source).toContain(
    `${initName("kernel")}.kernel_install_commit<system>(NeutronRequest ,NeutronCaller,NeutronCommitManagedMemoryRetirements)`,
  );
});

test("assembler traps rather than finalize a non-null committed retirement", () => {
  const schema = "5".repeat(64);
  const source = assemble(
    { kernel: kernelConfig },
    {
      committedRetirements: [
        {
          memoryId: "hello",
          owner: "hello",
          version: 3,
          schemaEntry: schema,
        },
      ],
    },
  );

  expect(source).toContain(
    `switch (NeutronOld.${retiredMemoryStoreName("hello", "hello")}) {
    case (null) {};
    case (?_) assert false;
  };`,
  );
  expect(source).not.toContain(
    `stable var ${retiredMemoryStoreName("hello", "hello")}`,
  );
});
