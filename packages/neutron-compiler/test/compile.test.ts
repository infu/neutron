import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  assertBackendCallInstallReservationsTarget,
  assertCertifiedAssetsTransitions,
  assertStableStoreSchemaTransitions,
  compile,
  extractImports,
  fixedBackendCallInstallReservationTargetPrincipals,
  persistenceModeFromCompilerId,
  reachableMotokoFiles,
} from "../src/compile.ts";
import { assemble } from "../src/assemble.ts";
import type { PackagedNeutronManifest } from "neutron-tools/src/schema.js";
import type { NeutronBackendCallReservation } from "neutron-tools/src/capabilities/catalog.js";
import {
  assertSupportedCertificateVersions,
  SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
  wasmCustomSections,
  withSupportedCertificateVersions,
} from "neutron-tools/src/wasm_metadata.js";
import {
  managedMemoryStoreName,
  retiredManagedMemoryStoreName,
} from "../src/memory_physical_names.ts";
import {
  physicalAppMethodName,
  physicalPublicIngressMethodName,
} from "neutron-tools/src/physical_names.js";
import { trustedInstallationContextFromRootKey } from "../src/installation_context.ts";
import { hashContent } from "neutron-tools/src/hash.js";

const moduleHash = (digit: string): string => digit.repeat(64);
const schema = (entry: string) => ({ entry, hash: entry });

test("compiler rejects backend-call install reservations for the target actor", () => {
  const target = "r7inp-6aaaa-aaaaa-aaabq-cai";
  const ledger = "ryjl3-tyaaa-aaaaa-aaaba-cai";
  const app = (
    installReservations: NeutronBackendCallReservation[],
  ): PackagedNeutronManifest => ({
    format: 3,
    id: "caller",
    name: "Caller",
    version: 100,
    entry: moduleHash("f"),
    capabilities: {
      backend_calls: {
        api: 1,
        description: "Call approved services",
        reservation_scopes: ["exact", "method", "principal"],
        install_reservations: installReservations,
        max_concurrency: 1,
        max_cycles_per_call: 0,
        max_cycles_per_day: 0,
      },
    },
  });

  for (const reservation of [
    { kind: "principal" as const, principal: target },
    { kind: "exact" as const, principal: target, method: "ping" },
  ]) {
    expect(() =>
      assertBackendCallInstallReservationsTarget(
        { caller: app([reservation]) },
        target,
      ),
    ).toThrow(
      "App caller backend_calls install reservation cannot target the Neutron canister itself",
    );
  }
  expect(() =>
    assertBackendCallInstallReservationsTarget(
      {
        caller: app([
          { kind: "method", method: "ping" },
          {
            kind: "principal",
            principal: ledger,
          },
        ]),
      },
      target,
    ),
  ).not.toThrow();
  expect(
    fixedBackendCallInstallReservationTargetPrincipals({
      caller: app([
        { kind: "method", method: "ping" },
        { kind: "principal", principal: ledger },
        { kind: "exact", principal: target, method: "read" },
        { kind: "principal", principal: target },
      ]),
    }),
  ).toEqual([target, ledger]);
});

test("compiler preflights stable-store schema monotonicity", () => {
  const kernel: PackagedNeutronManifest = {
    format: 3,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: moduleHash("a"),
  };
  const app = (
    version: number,
    schemaVersion?: number,
  ): PackagedNeutronManifest => ({
    format: 3,
    id: "documents",
    name: "Documents",
    version,
    entry: moduleHash("b"),
    ...(schemaVersion === undefined
      ? {}
      : {
          capabilities: {
            stable_store: {
              api: 1 as const,
              stores: [
                {
                  id: "index",
                  purpose: "Document index",
                  schema_version: schemaVersion,
                  max_entries: 16,
                  max_key_bytes: 32,
                  max_value_bytes: 256,
                  max_bytes: 4_096,
                },
              ],
            },
          },
        }),
  });
  const previous = { kernel, documents: app(100, 2) };

  expect(() =>
    assertStableStoreSchemaTransitions(previous, {
      kernel,
      documents: app(101, 1),
    }),
  ).toThrow(
    "App documents stable_store index cannot lower schema_version from 2 to 1",
  );
  expect(() =>
    assertStableStoreSchemaTransitions(previous, {
      kernel,
      documents: app(101, 2),
    }),
  ).not.toThrow();
  expect(() =>
    assertStableStoreSchemaTransitions(previous, {
      kernel,
      documents: app(101, 3),
    }),
  ).not.toThrow();
  expect(() =>
    assertStableStoreSchemaTransitions(previous, {
      kernel,
      documents: app(101),
    }),
  ).not.toThrow();
  expect(() =>
    assertStableStoreSchemaTransitions(previous, { kernel }),
  ).not.toThrow();
});

test("compiler permits only monotonic certified-assets scope transitions", () => {
  const kernel: PackagedNeutronManifest = {
    format: 3,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: moduleHash("c"),
  };
  const app = (version: number): PackagedNeutronManifest => ({
    format: 3,
    id: "archive",
    name: "Archive",
    version,
    entry: moduleHash("d"),
    backend: { capabilities: { certified_assets: { api: 2 } } },
    capabilities: {
      certified_assets: {
        api: 2,
        max_entries: 8,
        max_committed_bytes: 4_096,
        max_object_bytes: 1_024,
        max_pending_stages: 1,
        max_staged_bytes: 1_024,
        max_batch_operations: 2,
        max_batch_bytes: 2_048,
        max_idempotency_receipts: 4,
        collections: [
          {
            id: "objects",
            mount: "objects",
            kind: "immutable_blob",
            path_prefix: "/sha/",
            max_object_bytes: 512,
          },
        ],
      },
    },
  });
  const previous = { kernel, archive: app(100) };

  expect(() =>
    assertCertifiedAssetsTransitions(previous, {
      kernel,
      archive: app(101),
    }),
  ).not.toThrow();

  const widened = app(101);
  const widenedAssets = widened.capabilities!.certified_assets!;
  widenedAssets.max_entries = 9;
  widenedAssets.max_committed_bytes = 8_192;
  widenedAssets.max_object_bytes = 2_048;
  widenedAssets.max_staged_bytes = 2_048;
  widenedAssets.max_batch_bytes = 4_096;
  widenedAssets.max_idempotency_receipts = 5;
  widenedAssets.collections[0]!.max_object_bytes = 1_024;
  expect(() =>
    assertCertifiedAssetsTransitions(previous, {
      kernel,
      archive: widened,
    }),
  ).not.toThrow();

  const narrowed = app(101);
  narrowed.capabilities!.certified_assets!.max_entries = 7;
  expect(() =>
    assertCertifiedAssetsTransitions(previous, {
      kernel,
      archive: narrowed,
    }),
  ).toThrow(
    "App archive certified_assets max_entries cannot decrease from 8 to 7",
  );

  const narrowedCollection = app(101);
  narrowedCollection.capabilities!.certified_assets!.collections[0]!
    .max_object_bytes = 256;
  expect(() =>
    assertCertifiedAssetsTransitions(previous, {
      kernel,
      archive: narrowedCollection,
    }),
  ).toThrow(/collection objects max_object_bytes cannot decrease/);

  const changedCollection = app(101);
  const changed =
    changedCollection.capabilities!.certified_assets!.collections[0]!;
  if (changed.kind !== "immutable_blob") throw new Error("fixture");
  changed.path_prefix = "/objects/";
  expect(() =>
    assertCertifiedAssetsTransitions(previous, {
      kernel,
      archive: changedCollection,
    }),
  ).toThrow(/cannot change certified_assets collection objects semantics/);

  const plain: PackagedNeutronManifest = {
    format: 3,
    id: "archive",
    name: "Archive",
    version: 101,
    entry: moduleHash("d"),
  };
  expect(() =>
    assertCertifiedAssetsTransitions(previous, { kernel, archive: plain }),
  ).toThrow(/cannot add or remove certified_assets/);
  expect(() =>
    assertCertifiedAssetsTransitions(
      { kernel, archive: plain },
      { kernel, archive: app(102) },
    ),
  ).toThrow(/cannot add or remove certified_assets/);
  expect(() =>
    assertCertifiedAssetsTransitions(previous, { kernel }),
  ).not.toThrow();
});
const motokoCapabilitiesSource = await readFile(
  new URL("../../neutron-motoko-capabilities/src/lib.mo", import.meta.url),
  "utf8",
);
const kernelHttpPostUpdateHandlerModuleTypes = `
  public type HttpPostUpdateHandlerRequestV1 = {
    path : Text;
    headers : [(Text, Text)];
    body : Blob;
    request_id_hash : Blob;
  };
  public type HttpPostUpdateHandlerStatusV1 = {
    #ok; #created; #accepted; #bad_request; #unauthorized; #forbidden;
    #not_found; #conflict; #unprocessable_content;
  };
  public type HttpPostUpdateHandlerResponseV1 = {
    status : HttpPostUpdateHandlerStatusV1;
    content_type : Text;
    body : Blob;
  };
  public type HttpPostUpdateHandlerDispatchV1 = {
    request : HttpPostUpdateHandlerRequestV1;
    key_hash : Blob;
    request_hash : Blob;
    mount_fingerprint : Text;
    authority_epoch : Nat64;
  };
`;
const kernelPublicIngressModuleTypes = `
  public type AppScope = { app_id : Text; installation_uid : Nat64 };
  public type PublicIngressRequestV1 = { method : Text; payload : Blob };
  public type PublicIngressErrorV1 = {
    #bad_request;
    #not_found;
    #too_large;
    #unauthorized;
    #rate_limited;
    #busy;
    #low_cycles;
    #revoked;
    #revoked_after_dispatch;
    #handler_failed;
  };
  public type PublicIngressResultV1 = {
    #ok : Blob;
    #err : PublicIngressErrorV1;
  };
  public type PublicIngressHandlerRequestV1 = {
    caller : Principal;
    payload : Blob;
  };
  public type PublicIngressDispatchV1 = {
    dispatch_id : Nat64;
    app_scope : AppScope;
    protocol : Text;
    method : Text;
    request : PublicIngressHandlerRequestV1;
    request_hash : Blob;
    route_fingerprint : Text;
    authority_epoch : Nat64;
  };
`;
const kernelCapabilityConfigurationMethod = `
  public type AppScope = { app_id : Text; installation_uid : Nat64 };
  public type HttpPostUpdateHandlerRequestV1 = {
    path : Text;
    headers : [(Text, Text)];
    body : Blob;
    request_id_hash : Blob;
  };
  public type HttpPostUpdateHandlerStatusV1 = {
    #ok; #created; #accepted; #bad_request; #unauthorized; #forbidden;
    #not_found; #conflict; #unprocessable_content;
  };
  public type HttpPostUpdateHandlerResponseV1 = {
    status : HttpPostUpdateHandlerStatusV1;
    content_type : Text;
    body : Blob;
  };
  public type HttpPostUpdateHandlerDispatchV1 = {
    request : HttpPostUpdateHandlerRequestV1;
    key_hash : Blob;
    request_hash : Blob;
    mount_fingerprint : Text;
    authority_epoch : Nat64;
  };
  public type HttpPostUpdateHandlerV1 = shared HttpPostUpdateHandlerDispatchV1 -> async HttpPostUpdateHandlerResponseV1;
  public type PublicIngressRequestV1 = { method : Text; payload : Blob };
  public type PublicIngressErrorV1 = {
    #bad_request;
    #not_found;
    #too_large;
    #unauthorized;
    #rate_limited;
    #busy;
    #low_cycles;
    #revoked;
    #revoked_after_dispatch;
    #handler_failed;
  };
  public type PublicIngressResultV1 = { #ok : Blob; #err : PublicIngressErrorV1 };
  public type PublicIngressHandlerRequestV1 = { caller : Principal; payload : Blob };
  public type PublicIngressDispatchV1 = {
    dispatch_id : Nat64;
    app_scope : AppScope;
    protocol : Text;
    method : Text;
    request : PublicIngressHandlerRequestV1;
    request_hash : Blob;
    route_fingerprint : Text;
    authority_epoch : Nat64;
  };
  public type PublicIngressHandlerRegistrationV1 = {
    app_scope : AppScope;
    protocol : Text;
    method : Text;
    handler : {
      #query_ : PublicIngressHandlerRequestV1 -> Blob;
      #update_ : shared PublicIngressDispatchV1 -> async Blob;
    };
  };
  public type AppInstance = {
    scope : AppScope;
    version : Nat;
    deployment_id : Text;
    capability_plan_fingerprint : Text;
    resident_frame_security : {
      #credentialless_opaque_v1;
      #credentialless_ephemeral_dedicated_v1;
      #persistent_dedicated_v1;
    };
    browser_origin_nonce : Text;
    browser_origin_authority_epoch : Nat64;
  };
  public func app_scope(appId : Text, _deploymentId : Text) : AppScope {
    { app_id = appId; installation_uid = 1 }
  };
  public func runtime_app_instances(_deploymentId : Text) : [AppInstance] { [] };
  public func scope_active(_scope : AppScope) : Bool { true };
  public type PublicIngressCyclesCapability = {
    available : () -> Nat;
    request : Nat -> ();
  };
  public func public_ingress_cycles_capability(
    _scope : AppScope,
  ) : PublicIngressCyclesCapability {
    {
      available = func() : Nat { 0 };
      request = func(_amount : Nat) : () {};
    }
  };
  public func configure_app_capabilities<T>(
    _declarations : [T],
    _configuration : {
      vetkeys_environment : { #production; #local };
      chain_key_signing_keys : {
        ecdsa_secp256k1 : ?Text;
        schnorr_bip340secp256k1 : ?Text;
        schnorr_ed25519 : ?Text;
      };
    },
  ) {};
  public func configure_frontend_surface_counts(
    _counts : { app_instances : Nat; resident_frames : Nat },
  ) {};
  public type CapabilityKind = {
    #backend_calls;
    #randomness;
    #chain_key_signing;
    #stable_store;
    #https_outcalls;
    #vetkeys;
    #scheduled_tasks;
    #connections;
    #persistent_browser_storage;
    #public_ingress;
    #http_routes;
    #certified_read_routes;
    #certified_assets;
  };
  public type CapabilityRegistration = {
    scope : AppScope;
    plan_fingerprint : Text;
    kind : CapabilityKind;
    resource_id : Text;
    api : Nat;
    declaration_fingerprint : Text;
    grant : { #declaration; #owner_runtime_grant };
    toggleable : Bool;
  };
  public func configure_capability_registry(
    _registrations : [CapabilityRegistration],
    _self : actor {},
  ) {};
  public func configure_http_post_update_handlers(
    _handlers : [{
      app_scope : AppScope;
      mount_id : Text;
      handler : HttpPostUpdateHandlerV1;
    }],
  ) {};
  public func http_post_update_handler_dispatch_begin(
    _scope : AppScope,
    _mountId : Text,
    _dispatch : HttpPostUpdateHandlerDispatchV1,
  ) {};
  public func http_post_update_handler_dispatch_finish(
    _scope : AppScope,
    _mountId : Text,
    _dispatch : HttpPostUpdateHandlerDispatchV1,
    _response : HttpPostUpdateHandlerResponseV1,
  ) {};
  public func configure_public_ingress_handlers(
    _registrations : [PublicIngressHandlerRegistrationV1],
  ) {};
  public func public_ingress_query(
    _scope : AppScope,
    _protocol : Text,
    _caller : Principal,
    _request : PublicIngressRequestV1,
  ) : PublicIngressResultV1 { #err(#not_found) };
  public func public_ingress_update<system>(
    _scope : AppScope,
    _protocol : Text,
    _caller : Principal,
    _request : PublicIngressRequestV1,
  ) : async* PublicIngressResultV1 { #err(#not_found) };
  public func public_ingress_dispatch_begin(
    _scope : AppScope,
    _protocol : Text,
    _method : Text,
    _dispatch : PublicIngressDispatchV1,
  ) {};
  public func public_ingress_dispatch_finish(
    _scope : AppScope,
    _protocol : Text,
    _method : Text,
    _dispatch : PublicIngressDispatchV1,
    _response : Blob,
  ) {};
  public type AppUsageInstructionMeasurement = {
    scope : AppScope;
    started_at : Nat64;
  };
  public func app_usage_instruction_begin(
    scope : AppScope,
    _fixed_message_cycles : Nat,
  ) : AppUsageInstructionMeasurement {
    { scope; started_at = 0 }
  };
  public func app_usage_instruction_finish(
    _measurement : AppUsageInstructionMeasurement,
  ) {};
  public type RandomnessError = {
    #busy;
    #low_cycles;
    #management_failure;
    #source_gone;
  };
  public type RandomnessCapability = {
    fresh_bytes : () -> async* { #ok : Blob; #err : RandomnessError };
  };
  public func randomness_capability(_scope : AppScope) : RandomnessCapability {
    {
      fresh_bytes = func() : async* { #ok : Blob; #err : RandomnessError } {
        #err(#source_gone)
      };
    }
  };
  public type ChainKeyAlgorithm = {
    #ecdsa_secp256k1;
    #schnorr_bip340secp256k1;
    #schnorr_ed25519;
  };
  public type ChainKeyMessageFormat = { #neutron_app_assertion_v1 };
  public type ChainKeyError = {
    #invalid_request; #not_declared; #disabled;
    #busy;
    #cost_too_high;
    #low_cycles; #key_unavailable; #management_failure; #outcome_unknown;
    #source_gone; #revoked_after_dispatch;
  };
  public type ChainKeyPublicKey = {
    slot : Text;
    algorithm : ChainKeyAlgorithm;
    public_key : Blob;
    key_fingerprint : Blob;
    signing_domain : Blob;
    namespace_version : Nat;
    message_format : ChainKeyMessageFormat;
  };
  public type ChainKeySignature = {
    slot : Text;
    algorithm : ChainKeyAlgorithm;
    digest : Blob;
    signature : Blob;
    signing_domain : Blob;
    message_format : ChainKeyMessageFormat;
  };
  public type ChainKeySigningCapability = {
    public_key : Text -> async* { #ok : ChainKeyPublicKey; #err : ChainKeyError };
    sign_assertion : { slot : Text; assertion : Blob } -> async* {
      #ok : ChainKeySignature;
      #err : ChainKeyError;
    };
  };
  public func chain_key_signing_capability(
    _scope : AppScope,
  ) : ChainKeySigningCapability {
    {
      public_key = func(_slot : Text) : async* {
        #ok : ChainKeyPublicKey;
        #err : ChainKeyError;
      } { #err(#source_gone) };
      sign_assertion = func(_request : { slot : Text; assertion : Blob }) : async* {
        #ok : ChainKeySignature;
        #err : ChainKeyError;
      } { #err(#source_gone) };
    }
  };
  public type StableStoreCondition = {
    #unconditional; #if_absent; #if_revision : Nat64;
  };
  public type StableStoreCursor = {
    namespace_uid : Nat64; prefix : Blob; after : Blob;
  };
  public type StableStoreEntry = {
    key : Blob; value : Blob; revision : Nat64; schema_version : Nat;
  };
  public type StableStoreUsage = {
    store : Text; schema_version : Nat; entries : Nat; bytes : Nat;
    max_entries : Nat; max_bytes : Nat; over_quota : Bool;
  };
  public type StableStoreError = {
    #source_gone; #not_declared; #disabled; #invalid_request; #too_large;
    #quota_exceeded; #not_found;
    #conflict : { current_revision : ?Nat64 };
    #low_cycles; #not_replicated; #revision_exhausted; #cursor_stale;
  };
  public type StableStoreCapability = {
    get : { store : Text; key : Blob } -> {
      #ok : ?StableStoreEntry; #err : StableStoreError
    };
    put : {
      store : Text; key : Blob; value : Blob; condition : StableStoreCondition
    } -> {
      #ok : { revision : Nat64; schema_version : Nat; usage : StableStoreUsage };
      #err : StableStoreError;
    };
    delete : { store : Text; key : Blob; expected_revision : ?Nat64 } -> {
      #ok : StableStoreUsage; #err : StableStoreError
    };
    list : {
      store : Text; prefix : Blob; cursor : ?StableStoreCursor; limit : Nat
    } -> {
      #ok : {
        entries : [StableStoreEntry]; next : ?StableStoreCursor;
        observed_revision : Nat64;
      };
      #err : StableStoreError;
    };
    usage : Text -> { #ok : StableStoreUsage; #err : StableStoreError };
    clear_page : { store : Text; prefix : Blob; limit : Nat } -> {
      #ok : {
        removed_entries : Nat; removed_bytes : Nat; more : Bool;
        usage : StableStoreUsage;
      };
      #err : StableStoreError;
    };
  };
  public func stable_store_capability(_scope : AppScope) : StableStoreCapability {
    let error = #err(#source_gone);
    {
      get = func(_) { error };
      put = func(_) { error };
      delete = func(_) { error };
      list = func(_) { error };
      usage = func(_) { error };
      clear_page = func(_) { error };
    }
  };
  public type HttpsOutcallMethod = { #get; #head; #post };
  public type HttpsOutcallRequest = {
    endpoint : Text;
    method : HttpsOutcallMethod;
    path : Text;
    query_params : [(Text, Text)];
    headers : [{ name : Text; value : Text }];
    body : Blob;
    idempotency_key : ?Text;
  };
  public type HttpsOutcallError = {
    #invalid_request; #not_declared; #disabled;
    #busy;
    #cost_too_high;
    #low_cycles; #redirected; #management_failure; #source_gone;
    #revoked_after_dispatch;
  };
  public type HttpsOutcallsCapability = {
    request : HttpsOutcallRequest -> async* {
      #ok : { status : Nat; body : Blob };
      #err : HttpsOutcallError;
    };
  };
  public func https_outcalls_capability(_scope : AppScope) : HttpsOutcallsCapability {
    {
      request = func(_request : HttpsOutcallRequest) : async* {
        #ok : { status : Nat; body : Blob };
        #err : HttpsOutcallError;
      } { #err(#source_gone) };
    }
  };
  public func certified_assets_capability<T>(_scope : AppScope) : T {
    loop {};
  };
`;

test("extractImports returns Motoko imports excluding compiler internals", () => {
  const ast = {
    name: "Root",
    args: [
      { name: "ImportE", args: ["mo:core/Array"] },
      { name: "ImportE", args: ["mo:prim"] },
      {
        name: "Nested",
        args: [{ name: "ImportE", args: ["mo:pkg/Lib"] }],
      },
    ],
  };

  expect(extractImports(ast)).toEqual(["mo:core/Array", "mo:pkg/Lib"]);
});

test("compile rejects modules outside the current compile input", async () => {
  await expect(
    compile({
      mofiles: [
        {
          path: "kernel.mo",
          content: 'import Stale "stale"; module {}',
        },
      ],
      configs: {
        kernel: {
          format: 3,
          id: "kernel",
          name: "Kernel",
          version: 100,
          entry: "kernel",
        },
      },
    }),
  ).rejects.toThrow(/not in the current compile input/);
});

test("compile clears stale Motoko files before each compile", async () => {
  await expect(
    compile({
      mofiles: [],
      configs: {
        kernel: {
          format: 3,
          id: "kernel",
          name: "Kernel",
          version: 100,
          entry: "stale",
        },
      },
    }),
  ).rejects.toThrow(/stale\.mo is not in the current compile input/);
});

test("concurrent compiles isolate identical Motoko module paths", async () => {
  const entry = moduleHash("f");
  const input = (method: "alpha_ping" | "beta_ping", value: number) => ({
    configs: {
      kernel: {
        format: 3 as const,
        id: "kernel",
        name: "Kernel",
        version: 100,
        entry,
        func: { [method]: { type: "query" as const } },
      },
    },
    mofiles: [
      {
        path: `${entry}.mo`,
        content: `module {
          public type ${method}_Input = ();
          public type ${method}_Output = Nat;
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
            public func ${method}(_request : ()) : Nat { ${value} };
          };
        }`,
      },
    ],
  });

  const [alpha, beta] = await Promise.all([
    compile(input("alpha_ping", 1)),
    compile(input("beta_ping", 2)),
  ]);
  expect(alpha.candid).toContain("alpha_ping");
  expect(alpha.candid).not.toContain("beta_ping");
  expect(beta.candid).toContain("beta_ping");
  expect(beta.candid).not.toContain("alpha_ping");
  expect(alpha.generatedSource).toBeUndefined();
  expect(beta.generatedSource).toBeUndefined();
});

test("compile retains exact assembled source only for explicit qualification", async () => {
  const entry = moduleHash("e");
  const configs = {
    kernel: {
      format: 3 as const,
      id: "kernel",
      name: "Kernel",
      version: 100,
      entry,
      func: { qualification_source_ping: { type: "query" as const } },
    },
  };
  const result = await compile({
    configs,
    includeGeneratedSource: true,
    mofiles: [
      {
        path: `${entry}.mo`,
        content: `module {
          public type qualification_source_ping_Input = ();
          public type qualification_source_ping_Output = Nat;
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
            public func qualification_source_ping(_request : ()) : Nat { 1 };
          };
        }`,
      },
    ],
  });

  expect(result.generatedSource).toBe(
    assemble(configs, {
      migrationPlan: result.migrationPlan,
      committedRetirements: result.managedMemoryRetirements,
      dependencyPlan: result.dependencyPlan,
      deploymentId: result.deploymentId,
      compilerId: result.compilerId,
      vetKeysEnvironment: "production",
    }),
  );
  expect(
    wasmCustomSections(
      result.wasm,
      "icp:private enhanced-orthogonal-persistence",
    ),
  ).toHaveLength(0);
});

test("compiler binds enhanced persistence into the Wasm and compiler identity", async () => {
  const entry = moduleHash("f");
  const result = await compile({
    configs: {
      kernel: {
        format: 3,
        id: "kernel",
        name: "Kernel",
        version: 101,
        entry,
      },
    },
    persistenceMode: "enhanced",
    mofiles: [
      {
        path: `${entry}.mo`,
        content: `module {
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
          };
        }`,
      },
    ],
  });

  expect(result.persistenceMode).toBe("enhanced");
  expect(result.compilerId).toStartWith("moc_enhanced_");
  expect(persistenceModeFromCompilerId(result.compilerId)).toBe("enhanced");
  expect(
    wasmCustomSections(
      result.wasm,
      "icp:private enhanced-orthogonal-persistence",
    ),
  ).toHaveLength(1);
  expect(persistenceModeFromCompilerId("moc_6921f895690abfd3")).toBe(
    "enhanced",
  );
  expect(persistenceModeFromCompilerId("moc_b95fce3642e89f40")).toBe(
    "classical",
  );
});

test("reachableMotokoFiles keeps only modules imported from configured entries", async () => {
  const reachable = await reachableMotokoFiles({
    configs: {
      kernel: {
        format: 3,
        id: "kernel",
        name: "Kernel",
        version: 100,
        entry: "kernel",
      },
    },
    mofilesByPath: new Map([
      ["kernel.mo", ['import Used "used";', "module {}"].join("\n")],
      ["used.mo", "module {}"],
      ["unused.mo", "module {}"],
    ]),
  });

  expect(reachable.map(({ path }) => path)).toEqual(["kernel.mo", "used.mo"]);
});

test("compiler defaults vetKeys to production and binds explicit local selection", async () => {
  const kernelEntry = moduleHash("e");
  const input = {
    configs: {
      kernel: {
        format: 3,
        id: "kernel",
        name: "Kernel",
        version: 100,
        entry: kernelEntry,
      },
    },
    mofiles: [
      {
        path: `${kernelEntry}.mo`,
        content: `module {
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
          };
        }`,
      },
    ],
  } satisfies Parameters<typeof compile>[0];

  const production = await compile(input);
  const explicitProduction = await compile({
    ...input,
    vetKeysEnvironment: "production",
  });
  await expect(
    compile({ ...input, vetKeysEnvironment: "local" }),
  ).rejects.toThrow("requires trusted PocketIC root-key context");
  const local = await compile({
    ...input,
    vetKeysEnvironment: "local",
    freshInstallationContext: trustedInstallationContextFromRootKey(
      new Uint8Array(133).fill(0x5a),
    ),
  });
  const firstAttempt = await compile({
    ...input,
    deploymentNonce: "00".repeat(16),
  });
  const secondAttempt = await compile({
    ...input,
    deploymentNonce: "01".repeat(16),
  });

  expect(production.appInstanceInventory).toEqual([
    {
      app_id: "kernel",
      version: 100,
      capability_plan_fingerprint:
        production.capabilityPlans.kernel!.fingerprint,
      resident_frame_security: "credentialless_opaque_v1",
    },
  ]);
  expect(explicitProduction.deploymentId).toBe(production.deploymentId);
  expect(local.deploymentId).not.toBe(production.deploymentId);
  expect(firstAttempt.deploymentId).not.toBe(secondAttempt.deploymentId);
  expect(firstAttempt.deploymentId).not.toBe(production.deploymentId);
  expect(production.deploymentNonce).toBeNull();
  expect(production.vetKeysEnvironment).toBe("production");
  expect(local.deploymentNonce).toBeNull();
  expect(local.vetKeysEnvironment).toBe("local");
  expect(firstAttempt.deploymentNonce).toBe("00".repeat(16));
  expect(firstAttempt.vetKeysEnvironment).toBe("production");
  expect(production.previousManagedMemoryInventory).toEqual([]);
  expect(production.previousStableSignatureSha256).toBeNull();
  expect(withSupportedCertificateVersions(production.wasm)).toBe(
    production.wasm,
  );
  expect(assertSupportedCertificateVersions(production.wasm)).toEqual(
    SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
  );
  await expect(
    compile({ ...input, deploymentNonce: "not-a-nonce" }),
  ).rejects.toThrow("deploymentNonce must be 16 bytes");
  await expect(
    compile({ ...input, vetKeysEnvironment: "test_key_1" } as any),
  ).rejects.toThrow("vetKeys environment must be production or local");
  await expect(
    compile({
      ...input,
      vetKeysEnvironment: "production",
      freshInstallationContext: trustedInstallationContextFromRootKey(
        new Uint8Array(133).fill(0x5a),
      ),
    }),
  ).rejects.toThrow("only the compiled IC mainnet root key");
});

test("compiler accepts only current-format state-preserving upgrades", async () => {
  const kernelEntry = moduleHash("d");
  const input = {
    configs: {
      kernel: {
        format: 3 as const,
        id: "kernel",
        name: "Kernel",
        version: 100,
        entry: kernelEntry,
      },
    },
    mofiles: [
      {
        path: `${kernelEntry}.mo`,
        content: `module {
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
          };
        }`,
      },
    ],
  } satisfies Parameters<typeof compile>[0];

  const current = await compile(input);
  expect(current.stable).toMatch(
    /^\s*stable NeutronTrustedInstallationNetworkIdV1 : Blob;?$/mu,
  );
  const predecessor = current.stable.replace(
    /^\s*stable NeutronTrustedInstallationNetworkIdV1 : Blob;?\n/mu,
    "",
  );
  expect(predecessor).not.toBe(current.stable);

  await expect(
    compile({
      ...input,
      previousConfigs: input.configs,
      previousStable: predecessor,
    }),
  ).rejects.toThrow(/not the current assembler format.*clean reinstall/i);

  const upgraded = await compile({
    ...input,
    previousConfigs: input.configs,
    previousStable: current.stable,
  });
  expect(upgraded.compatibilityDiagnostics).toEqual([]);
  expect(upgraded.previousStableSignatureSha256).toBe(
    hashContent(current.stable),
  );
  expect(upgraded.previousManagedMemoryInventory).toEqual([]);

  const localContext = trustedInstallationContextFromRootKey(
    new Uint8Array(133).fill(0x6b),
  );
  const localV25 = await compile({
    ...input,
    vetKeysEnvironment: "local",
    freshInstallationContext: localContext,
  });
  const localUpgrade = await compile({
    ...input,
    previousConfigs: input.configs,
    previousStable: localV25.stable,
    vetKeysEnvironment: "local",
  });
  expect(localUpgrade.compatibilityDiagnostics).toEqual([]);
  await expect(
    compile({
      ...input,
      previousConfigs: input.configs,
      previousStable: localV25.stable,
      vetKeysEnvironment: "local",
      freshInstallationContext: localContext,
    }),
  ).rejects.toThrow("cannot replace the trusted installation context");
});

test("compiler typechecks a connection-only app declaration", async () => {
  const kernelEntry = moduleHash("6");
  const appEntry = moduleHash("7");
  const input = {
    configs: {
      kernel: {
        format: 3,
        id: "kernel",
        name: "Kernel",
        version: 100,
        entry: kernelEntry,
      },
      agent: {
        format: 3,
        id: "agent",
        name: "Agent",
        version: 100,
        entry: appEntry,
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
    },
    mofiles: [
      {
        path: `${kernelEntry}.mo`,
        content: `module {
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
          };
        }`,
      },
      {
        path: `${appEntry}.mo`,
        content: "module { public class Init() {} }",
      },
    ],
  } satisfies Parameters<typeof compile>[0];

  await expect(
    compile({
      ...input,
      connectionProviderSupport: {
        schema: "neutron.connection-provider-support.v1",
        providers: [],
      },
    }),
  ).rejects.toThrow(
    "Unsupported connection provider 'openrouter' for App agent",
  );
  const result = await compile({
    ...input,
    connectionProviderSupport: {
      schema: "neutron.connection-provider-support.v1",
      providers: [{ provider: "openrouter", scopes: [] }],
    },
  });

  expect(result.wasm.byteLength).toBeGreaterThan(0);
  expect(result.capabilityPlans.agent?.plan.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "connections" }),
    ]),
  );
});

test("compiler typechecks equal app-local managed-memory ids", async () => {
  const kernelEntry = moduleHash("5");
  const alphaEntry = moduleHash("6");
  const betaEntry = moduleHash("7");
  const alphaSchema = moduleHash("8");
  const betaSchema = moduleHash("9");
  const memory = (entry: string) => ({
    state: {
      version: 1,
      schemas: { "1": schema(entry) },
      migrations: [],
    },
  });

  const result = await compile({
    configs: {
      kernel: {
        format: 3,
        id: "kernel",
        name: "Kernel",
        version: 100,
        entry: kernelEntry,
      },
      alpha: {
        format: 3,
        id: "alpha",
        name: "Alpha",
        version: 100,
        entry: alphaEntry,
        memory: memory(alphaSchema),
      },
      beta_app: {
        format: 3,
        id: "beta_app",
        name: "Beta",
        version: 100,
        entry: betaEntry,
        memory: memory(betaSchema),
      },
    },
    mofiles: [
      {
        path: `${kernelEntry}.mo`,
        content: `module {
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
          };
        }`,
      },
      {
        path: `${alphaSchema}.mo`,
        content:
          "module { public type Mem = { var alpha : Nat }; public func init() : Mem { { var alpha = 1 } } }",
      },
      {
        path: `${betaSchema}.mo`,
        content:
          "module { public type Mem = { var beta : Text }; public func init() : Mem { { var beta = \"\" } } }",
      },
      {
        path: `${alphaEntry}.mo`,
        content: `import State "${alphaSchema}"; module {
          public type Environment = { stable_memory : { state : State.Mem } };
          public class Init(_environment : Environment) {};
        }`,
      },
      {
        path: `${betaEntry}.mo`,
        content: `import State "${betaSchema}"; module {
          public type Environment = { stable_memory : { state : State.Mem } };
          public class Init(_environment : Environment) {};
        }`,
      },
    ],
  });

  expect(result.wasm.byteLength).toBeGreaterThan(0);
  expect(result.stable).toContain(managedMemoryStoreName("alpha", "state"));
  expect(result.stable).toContain(
    managedMemoryStoreName("beta_app", "state"),
  );
  expect(result.managedMemoryInventory).toEqual([
    { owner: "alpha", id: "state", version: 1, schema: alphaSchema },
    { owner: "beta_app", id: "state", version: 1, schema: betaSchema },
  ]);
});

test("compiler typechecks a structurally narrowed randomness capability", async () => {
  const kernelEntry = moduleHash("a");
  const appEntry = moduleHash("b");
  const result = await compile({
    configs: {
      kernel: {
        format: 3,
        id: "kernel",
        name: "Kernel",
        version: 100,
        entry: kernelEntry,
      },
      dice_app: {
        format: 3,
        id: "dice_app",
        name: "Dice App",
        version: 100,
        entry: appEntry,
        backend: {
          capabilities: { randomness: { api: 1 } },
        },
        capabilities: {
          randomness: {
            api: 1,
          },
        },
      },
    },
    mofiles: [
      {
        path: `${kernelEntry}.mo`,
        content: `module {
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
          };
        }`,
      },
      {
        path: `${appEntry}.mo`,
        content: `module {
          public type Randomness = {
            fresh_bytes : () -> async* {
              #ok : Blob;
              #err : {
                #busy;
                #low_cycles;
                #management_failure;
                #source_gone;
              };
            };
          };
          public type Environment = {
            capabilities : { randomness : Randomness };
          };
          public class Init(environment : Environment) {
            public func roll() : async* Nat {
              switch (await* environment.capabilities.randomness.fresh_bytes()) {
                case (#ok(bytes)) bytes.size();
                case (#err(_)) 0;
              }
            };
          };
        }`,
      },
    ],
  });

  expect(result.wasm.byteLength).toBeGreaterThan(0);
  expect(result.capabilityPlans.dice_app?.plan.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "randomness" }),
      expect.objectContaining({
        id: "backend_environment",
        config: { interfaces: [{ id: "randomness", api: 1 }] },
      }),
    ]),
  );
});

test("compiler typechecks the closed assertion-signing backend handle", async () => {
  const kernelEntry = moduleHash("c");
  const appEntry = moduleHash("d");
  const result = await compile({
    configs: {
      kernel: {
        format: 3,
        id: "kernel",
        name: "Kernel",
        version: 100,
        entry: kernelEntry,
      },
      receipt_app: {
        format: 3,
        id: "receipt_app",
        name: "Receipt App",
        version: 100,
        entry: appEntry,
        backend: {
          capabilities: { chain_key_signing: { api: 1 } },
        },
        capabilities: {
          chain_key_signing: {
            api: 1,
            slots: [{
              id: "receipts",
              algorithm: "schnorr_ed25519",
              purpose: "Sign receipt assertions",
              max_assertion_bytes: 4096,
            }],
          },
        },
      },
    },
    mofiles: [
      {
        path: `${kernelEntry}.mo`,
        content: `module {
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
          };
        }`,
      },
      {
        path: `${appEntry}.mo`,
        content: `module {
          public type Algorithm = {
            #ecdsa_secp256k1;
            #schnorr_bip340secp256k1;
            #schnorr_ed25519;
          };
          public type MessageFormat = { #neutron_app_assertion_v1 };
          public type Error = {
            #invalid_request; #not_declared; #disabled;
            #busy;
            #cost_too_high;
            #low_cycles; #key_unavailable; #management_failure;
            #outcome_unknown; #source_gone; #revoked_after_dispatch;
          };
          public type PublicKey = {
            slot : Text;
            algorithm : Algorithm;
            public_key : Blob;
            key_fingerprint : Blob;
            signing_domain : Blob;
            namespace_version : Nat;
            message_format : MessageFormat;
          };
          public type Signature = {
            slot : Text;
            algorithm : Algorithm;
            digest : Blob;
            signature : Blob;
            signing_domain : Blob;
            message_format : MessageFormat;
          };
          public type Signing = {
            public_key : Text -> async* { #ok : PublicKey; #err : Error };
            sign_assertion : { slot : Text; assertion : Blob } -> async* {
              #ok : Signature;
              #err : Error;
            };
          };
          public type Environment = {
            capabilities : { chain_key_signing : Signing };
          };
          public class Init(environment : Environment) {
            public func exercise() : async* Nat {
              let keySize = switch (
                await* environment.capabilities.chain_key_signing.public_key(
                  "receipts"
                )
              ) {
                case (#ok(key)) key.public_key.size();
                case (#err(_)) 0;
              };
              switch (
                await* environment.capabilities.chain_key_signing.sign_assertion({
                  slot = "receipts";
                  assertion = "receipt";
                })
              ) {
                case (#ok(signed)) keySize + signed.signature.size();
                case (#err(_)) keySize;
              }
            };
          };
        }`,
      },
    ],
  });

  expect(result.wasm.byteLength).toBeGreaterThan(0);
  expect(result.capabilityPlans.receipt_app?.plan.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "chain_key_signing" }),
      expect.objectContaining({
        id: "backend_environment",
        config: { interfaces: [{ id: "chain_key_signing", api: 1 }] },
      }),
    ]),
  );
});

test("compiler typechecks the app-isolated stable_store handle", async () => {
  const kernelEntry = moduleHash("7");
  const appEntry = moduleHash("8");
  const result = await compile({
    configs: {
      kernel: {
        format: 3,
        id: "kernel",
        name: "Kernel",
        version: 100,
        entry: kernelEntry,
      },
      store_app: {
        format: 3,
        id: "store_app",
        name: "Store App",
        version: 100,
        entry: appEntry,
        backend: { capabilities: { stable_store: { api: 1 } } },
        capabilities: {
          stable_store: {
            api: 1,
            stores: [{
              id: "notes",
              purpose: "Keep notes",
              schema_version: 1,
              max_entries: 64,
              max_key_bytes: 64,
              max_value_bytes: 4096,
              max_bytes: 65_536,
            }],
          },
        },
      },
    },
    mofiles: [
      {
        path: `${kernelEntry}.mo`,
        content: `module {
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
          };
        }`,
      },
      {
        path: `${appEntry}.mo`,
        content: `module {
          public type Entry = {
            key : Blob; value : Blob; revision : Nat64; schema_version : Nat;
          };
          public type Usage = {
            store : Text; schema_version : Nat; entries : Nat; bytes : Nat;
            max_entries : Nat; max_bytes : Nat; over_quota : Bool;
          };
          public type Error = {
            #source_gone; #not_declared; #disabled; #invalid_request;
            #too_large; #quota_exceeded; #not_found;
            #conflict : { current_revision : ?Nat64 };
            #low_cycles; #not_replicated; #revision_exhausted; #cursor_stale;
          };
          public type Store = {
            get : { store : Text; key : Blob } -> { #ok : ?Entry; #err : Error };
            put : {
              store : Text; key : Blob; value : Blob;
              condition : { #unconditional; #if_absent; #if_revision : Nat64 };
            } -> {
              #ok : { revision : Nat64; schema_version : Nat; usage : Usage };
              #err : Error;
            };
          };
          public type Environment = { capabilities : { stable_store : Store } };
          public class Init(environment : Environment) {
            public func exercise() : Nat64 {
              let current = switch (environment.capabilities.stable_store.get({
                store = "notes"; key = "welcome";
              })) {
                case (#ok(?entry)) entry.revision;
                case (_) (0 : Nat64);
              };
              switch (environment.capabilities.stable_store.put({
                store = "notes";
                key = "welcome";
                value = "hello";
                condition = if (current == 0) #if_absent else #if_revision(current);
              })) {
                case (#ok(receipt)) receipt.revision;
                case (#err(_)) current;
              }
            };
          };
        }`,
      },
    ],
  });

  expect(result.wasm.byteLength).toBeGreaterThan(0);
  expect(result.capabilityPlans.store_app?.plan.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "stable_store" }),
      expect.objectContaining({
        id: "backend_environment",
        config: { interfaces: [{ id: "stable_store", api: 1 }] },
      }),
    ]),
  );
});

test("compiler typechecks a structurally narrowed HTTPS outcall capability", async () => {
  const kernelEntry = moduleHash("e");
  const appEntry = moduleHash("f");
  const result = await compile({
    configs: {
      kernel: {
        format: 3,
        id: "kernel",
        name: "Kernel",
        version: 100,
        entry: kernelEntry,
      },
      weather_app: {
        format: 3,
        id: "weather_app",
        name: "Weather",
        version: 100,
        entry: appEntry,
        backend: {
          capabilities: { https_outcalls: { api: 1 } },
        },
        capabilities: {
          https_outcalls: {
            api: 1,
            endpoints: [{
              id: "weather",
              url_prefix: "https://api.example.com/v1/",
              methods: ["get", "head"],
              request_headers: ["accept"],
              max_request_bytes: 4096,
              max_response_bytes: 32_768,
              transform: "strip_headers",
            }],
          },
        },
      },
    },
    mofiles: [
      {
        path: `${kernelEntry}.mo`,
        content: `module {
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
          };
        }`,
      },
      {
        path: `${appEntry}.mo`,
        content: `module {
          public type Method = { #get; #head; #post };
          public type Error = {
            #invalid_request; #not_declared; #disabled;
            #busy;
            #cost_too_high;
            #low_cycles; #redirected; #management_failure; #source_gone;
            #revoked_after_dispatch;
          };
          public type Request = {
            endpoint : Text;
            method : Method;
            path : Text;
            query_params : [(Text, Text)];
            headers : [{ name : Text; value : Text }];
            body : Blob;
            idempotency_key : ?Text;
          };
          public type Https = {
            request : Request -> async* {
              #ok : { status : Nat; body : Blob };
              #err : Error;
            };
          };
          public type Environment = { capabilities : { https_outcalls : Https } };
          public class Init(environment : Environment) {
            public func status() : async* Nat {
              switch (await* environment.capabilities.https_outcalls.request({
                endpoint = "weather";
                method = #get;
                path = "current";
                query_params = [("units", "metric")];
                headers = [{ name = "accept"; value = "application/json" }];
                body = "";
                idempotency_key = null;
              })) {
                case (#ok(response)) response.status;
                case (#err(_)) 0;
              }
            };
          };
        }`,
      },
    ],
  });

  expect(result.wasm.byteLength).toBeGreaterThan(0);
  expect(result.capabilityPlans.weather_app?.plan.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "https_outcalls" }),
      expect.objectContaining({
        id: "backend_environment",
        config: { interfaces: [{ id: "https_outcalls", api: 1 }] },
      }),
    ]),
  );
});

test("compiler typechecks an exact certified-assets publishing capability", async () => {
  const kernelEntry = moduleHash("c");
  const appEntry = moduleHash("d");
  const capabilitiesEntry = moduleHash("e");
  const result = await compile({
    configs: {
      kernel: {
        format: 3,
        id: "kernel",
        name: "Kernel",
        version: 100,
        entry: kernelEntry,
      },
      publisher: {
        format: 3,
        id: "publisher",
        name: "Publisher",
        version: 100,
        entry: appEntry,
        backend: {
          capabilities: { certified_assets: { api: 2 } },
        },
        capabilities: {
          certified_assets: {
            api: 2,
            max_entries: 8,
            max_committed_bytes: 32_768,
            max_object_bytes: 4_096,
            max_pending_stages: 1,
            max_staged_bytes: 4_096,
            max_batch_operations: 8,
            max_batch_bytes: 4_096,
            max_idempotency_receipts: 8,
            collections: [
              {
                id: "status",
                mount: "status",
                exact_path: "/v1/status",
                kind: "mutable_blob",
                max_object_bytes: 4_096,
              },
            ],
          },
        },
      },
    },
    mofiles: [
      {
        path: `${kernelEntry}.mo`,
        content: `module {
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
          };
        }`,
      },
      {
        path: `${appEntry}.mo`,
        content: `import Capabilities "${capabilitiesEntry}";
        module {
          public type Environment = {
            capabilities : {
              certified_assets : Capabilities.CertifiedAssetsV2;
            };
          };
          public class Init(
            environment : Environment,
          ) {
            public func usage() : Capabilities.UsageResult {
              environment.capabilities.certified_assets.usage();
            };
          };
        }`,
      },
      {
        path: `${capabilitiesEntry}.mo`,
        content: motokoCapabilitiesSource,
      },
    ],
  });

  expect(result.wasm.byteLength).toBeGreaterThan(0);
  expect(result.capabilityPlans.publisher?.plan.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "certified_read_routes", api: 1 }),
      expect.objectContaining({ id: "certified_assets", api: 2 }),
      expect.objectContaining({
        id: "backend_environment",
        config: { interfaces: [{ id: "certified_assets", api: 2 }] },
      }),
    ]),
  );
  const routePlan = result.capabilityPlans.publisher?.plan.entries.find(
    (entry) => entry.id === "certified_read_routes",
  );
  expect(routePlan?.config).toEqual(
    expect.objectContaining({
      mounts: [
        expect.objectContaining({
          id: "status",
          surface: "shared_app_path",
          authority_mode: "canister_gateway_v1",
          methods: ["GET"],
          store: "certified_assets",
        }),
      ],
    }),
  );
  const assetsPlan = result.capabilityPlans.publisher?.plan.entries.find(
    (entry) => entry.id === "certified_assets",
  );
  expect(assetsPlan?.config).toEqual(
    expect.objectContaining({
      api: 2,
      collections: [
        expect.objectContaining({
          id: "status",
          kind: "mutable_blob",
        }),
      ],
    }),
  );
});

test("compiler preserves API-1 self-call records with nested and repeated blobs", async () => {
  const kernelEntry = moduleHash("a");
  const appEntry = moduleHash("b");
  const result = await compile({
    configs: {
      kernel: {
        format: 3,
        id: "kernel",
        name: "Kernel",
        version: 100,
        entry: kernelEntry,
      },
      files: {
        format: 3,
        id: "files",
        name: "Files",
        version: 100,
        entry: appEntry,
        func: {
          not_preapproved: { type: "query", async: false },
          read_post: { type: "query", async: false },
          write_post: { type: "update", async: false },
        },
        capabilities: {
          preapproved_self_calls: {
            api: 1,
            methods: ["read_post", "write_post"],
          },
        },
      },
    },
    mofiles: [
      {
        path: `${kernelEntry}.mo`,
        content: `module {
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
          };
        }`,
      },
      {
        path: `${appEntry}.mo`,
        content: `module {
          public type not_preapproved_Input = { id : Nat64 };
          public type not_preapproved_Output = { found : Bool };
          public type Media = {
            original : Blob;
            thumbnails : [Blob];
          };
          public type write_post_Input = {
            id : Nat64;
            media : [Media];
          };
          public type write_post_Output = {
            accepted : Bool;
            proofs : [Blob];
          };
          public type read_post_Input = { id : Nat64 };
          public type read_post_Output = {
            value : {
              found : Bool;
              previews : [?Blob];
            };
            body : Blob;
          };
          public class Init() {
            public func not_preapproved(
              request : not_preapproved_Input,
            ) : not_preapproved_Output {
              { found = request.id > 0 }
            };
            public func read_post(
              request : read_post_Input,
            ) : read_post_Output {
              {
                value = {
                  found = request.id > 0;
                  previews = [];
                };
                body = "";
              }
            };
            public func write_post(
              request : write_post_Input,
            ) : write_post_Output {
              {
                accepted = request.media.size() > 0;
                proofs = [];
              }
            };
          };
        }`,
      },
    ],
  });

  expect(result.wasm.byteLength).toBeGreaterThan(0);
  expect(result.candid).toContain(
    physicalAppMethodName("files", "write_post"),
  );
  expect(result.candid).toContain(
    physicalAppMethodName("files", "read_post"),
  );
  const preapproved = result.capabilityPlans.files?.plan.entries.find(
    (entry) => entry.id === "preapproved_self_calls",
  );
  expect(preapproved?.config).toEqual({
    api: 1,
    methods: [
      { method: "read_post", mode: "query" },
      { method: "write_post", mode: "update" },
    ],
  });
});

test("compiler typechecks an exact synchronous http_post_update_handler", async () => {
  const kernelEntry = moduleHash("2");
  const appEntry = moduleHash("3");
  const result = await compile({
    configs: {
      kernel: {
        format: 3,
        id: "kernel",
        name: "Kernel",
        version: 100,
        entry: kernelEntry,
      },
      webhook: {
        format: 3,
        id: "webhook",
        name: "Webhook",
        version: 100,
        entry: appEntry,
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
                max_request_bytes: 8192,
                max_response_bytes: 4096,
                max_calls_per_hour: 24,
                forward_headers: ["authorization", "content-type"],
              },
              {
                id: "shared_events",
                surface: "shared_app_path",
                methods: ["POST"],
                mode: "http_post_update_handler",
                handler: "accept_event",
                max_request_bytes: 4096,
                max_response_bytes: 2048,
                max_calls_per_hour: 12,
                forward_headers: [],
              },
            ],
          },
        },
      },
    },
    mofiles: [
      {
        path: `${kernelEntry}.mo`,
        content: `module {
          ${kernelHttpPostUpdateHandlerModuleTypes}
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
          };
        }`,
      },
      {
        path: `${appEntry}.mo`,
        content: `module {
          public type accept_event_Input = {
            path : Text;
            headers : [(Text, Text)];
            body : Blob;
            request_id_hash : Blob;
          };
          public type accept_event_Output = {
            status : {
              #ok; #created; #accepted; #bad_request; #unauthorized;
              #forbidden; #not_found; #conflict; #unprocessable_content;
            };
            content_type : Text;
            body : Blob;
          };
          public class Init() {
            public func accept_event(request : accept_event_Input) : accept_event_Output {
              {
                status = #accepted;
                content_type = "application/octet-stream";
                body = request.body;
              }
            };
          };
        }`,
      },
    ],
  });

  expect(result.wasm.byteLength).toBeGreaterThan(0);
  expect(result.candid).toContain("app_webhook__http_post_update_shared_events");
  expect(result.capabilityPlans.webhook?.plan.entries).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "http_routes" })]),
  );
  const routePlan = result.capabilityPlans.webhook?.plan.entries.find(
    (entry) => entry.id === "http_routes",
  );
  expect(routePlan?.config).toEqual(
    expect.objectContaining({
      mounts: expect.arrayContaining([
        expect.objectContaining({
          id: "shared_events",
          surface: "shared_app_path",
        }),
      ]),
    }),
  );
});

test("compiler typechecks scoped public ingress query and update handlers", async () => {
  const kernelEntry = moduleHash("4");
  const appEntry = moduleHash("5");
  const result = await compile({
    configs: {
      kernel: {
        format: 3,
        id: "kernel",
        name: "Kernel",
        version: 100,
        entry: kernelEntry,
      },
      mailbox: {
        format: 3,
        id: "mailbox",
        name: "Mailbox",
        version: 100,
        entry: appEntry,
        func: {
          ingress_status: {
            type: "query",
            async: false,
            arg: ["caller"],
          },
          ingress_deliver: {
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
                protocol: "mail_v1",
                id: "status",
                handler: "ingress_status",
                mode: "query",
                caller: "any",
                max_request_bytes: 256,
                max_response_bytes: 1024,
              },
              {
                protocol: "mail_v1",
                id: "deliver",
                handler: "ingress_deliver",
                mode: "update",
                caller: "canister",
                max_request_bytes: 4096,
                max_response_bytes: 1024,
                max_calls_per_hour: 120,
                max_calls_per_caller_per_hour: 12,
                required_cycles: 10_000_000,
              },
            ],
          },
        },
      },
    },
    mofiles: [
      {
        path: `${kernelEntry}.mo`,
        content: `module {
          ${kernelPublicIngressModuleTypes}
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
          };
        }`,
      },
      {
        path: `${appEntry}.mo`,
        content: `module {
          public type PublicIngressCycles = {
            available : () -> Nat;
            request : Nat -> ();
          };
          public type ingress_status_Input = { key : Text };
          public type ingress_status_Output = Text;
          public type ingress_deliver_Input = { message : Blob };
          public type ingress_deliver_Output = Nat;
          public class Init() {
            public func ingress_status(
              request : ingress_status_Input,
              _caller : Principal,
            ) : ingress_status_Output {
              request.key
            };
            public func ingress_deliver(
              request : ingress_deliver_Input,
              _caller : Principal,
              public_ingress_cycles : PublicIngressCycles,
            ) : ingress_deliver_Output {
              let available = public_ingress_cycles.available();
              public_ingress_cycles.request(available);
              request.message.size()
            };
          };
        }`,
      },
    ],
  });

  expect(result.wasm.byteLength).toBeGreaterThan(0);
  expect(result.candid).toContain(
    physicalPublicIngressMethodName("mailbox", "mail_v1", "query"),
  );
  expect(result.candid).toContain(
    physicalPublicIngressMethodName("mailbox", "mail_v1", "update"),
  );
  expect(result.candid).not.toContain(
    physicalAppMethodName("mailbox", "ingress_deliver"),
  );
  expect(result.capabilityPlans.mailbox?.plan.entries).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "public_ingress" })]),
  );
  const ingressPlan = result.capabilityPlans.mailbox?.plan.entries.find(
    (entry) => entry.id === "public_ingress",
  );
  expect(ingressPlan?.config.routes).toHaveLength(2);
  expect(
    ingressPlan?.config.routes.find((route) => route.id === "deliver"),
  ).toMatchObject({ max_calls_per_caller_per_hour: 12 });
  expect(
    result.capabilityPlans.mailbox?.plan.entries.find(
      (entry) => entry.id === "function_resources",
    )?.config,
  ).toEqual({
    functions: [
      {
        method: "ingress_deliver",
        mode: "update",
        resources: [
          { kind: "caller" },
          { kind: "public_ingress_cycles" },
        ],
      },
      {
        method: "ingress_status",
        mode: "query",
        resources: [{ kind: "caller" }],
      },
    ],
  });
});

test("compiler physically omits a declared but unselected backend interface", async () => {
  const kernelEntry = moduleHash("a");
  const appEntry = moduleHash("b");
  await expect(
    compile({
      configs: {
        kernel: {
          format: 3,
          id: "kernel",
          name: "Kernel",
          version: 100,
          entry: kernelEntry,
        },
        dice_app: {
          format: 3,
          id: "dice_app",
          name: "Dice App",
          version: 100,
          entry: appEntry,
          backend: {
            capabilities: { randomness: { api: 1 } },
          },
          capabilities: {
            randomness: { api: 1 },
            backend_calls: {
              api: 1,
              description: "Scheduled calls only",
              reservation_scopes: ["exact"],
              install_reservations: [
                {
                  kind: "exact",
                  principal: "r7inp-6aaaa-aaaaa-aaabq-cai",
                  method: "scheduled_tick",
                },
              ],
              max_concurrency: 1,
              max_cycles_per_call: 0,
              max_cycles_per_day: 0,
            },
          },
        },
      },
      mofiles: [
        {
          path: `${kernelEntry}.mo`,
          content: `module {
            public class Init() {
              ${kernelCapabilityConfigurationMethod}
              public func kernel_authorized_add(_caller : Principal) {};
              public func is_authorized(_caller : Principal) : Bool { true };
            };
          }`,
        },
        {
          path: `${appEntry}.mo`,
          content: `module {
            public type Randomness = {
              fresh_bytes : () -> async* {
                #ok : Blob;
                #err : {
                  #busy;
                  #low_cycles;
                  #management_failure;
                  #source_gone;
                };
              };
            };
            public type Environment = {
              capabilities : {
                randomness : Randomness;
                backend_calls : { canister_principal : Principal };
              };
            };
            public class Init(_environment : Environment) {};
          }`,
        },
      ],
    }),
  ).rejects.toThrow();
});

test("compiler typechecks the scalar canister principal injection", async () => {
  const kernelEntry = moduleHash("8");
  const appEntry = moduleHash("9");
  const result = await compile({
    configs: {
      kernel: {
        format: 3,
        id: "kernel",
        name: "Kernel",
        version: 100,
        entry: kernelEntry,
      },
      hello: {
        format: 3,
        id: "hello",
        name: "Hello",
        version: 100,
        entry: appEntry,
        func: {
          hello_canister_principal: {
            type: "query",
            async: false,
            arg: ["canister_principal"],
          },
        },
      },
    },
    mofiles: [
      {
        path: `${kernelEntry}.mo`,
        content: `module {
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
          };
        }`,
      },
      {
        path: `${appEntry}.mo`,
        content: `module {
          public type hello_canister_principal_Input = (());
          public type hello_canister_principal_Output = Principal;
          public class Init() {
            public func hello_canister_principal(
              (),
              canister_principal : Principal,
            ) : Principal { canister_principal };
          };
        }`,
      },
    ],
  });

  expect(result.wasm.byteLength).toBeGreaterThan(0);
  expect(result.candid).toContain("hello_canister_principal");
});

test("compiler typechecks nested async app dependency handles", async () => {
  const kernelEntry = moduleHash("a");
  const contactsEntry = moduleHash("b");
  const calendarEntry = moduleHash("c");
  const kernel: PackagedNeutronManifest = {
    format: 3,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: kernelEntry,
  };
  const contacts: PackagedNeutronManifest = {
    format: 3,
    id: "contacts",
    name: "Contacts",
    version: 102,
    entry: contactsEntry,
    func: {
      list_contacts: {
        type: "internal",
        async: "async*",
        expose: "apps",
      },
    },
  };
  const calendar: PackagedNeutronManifest = {
    format: 3,
    id: "calendar",
    name: "Calendar",
    version: 100,
    entry: calendarEntry,
    dependencies: {
      people: {
        app: "contacts",
        min_version: 102,
        functions: ["list_contacts"],
      },
    },
    func: {
      calendar_people: { type: "update", async: "async*" },
    },
  };
  const mofiles = [
    {
      path: `${kernelEntry}.mo`,
      content: `module {
          public class Init() {
            ${kernelCapabilityConfigurationMethod}
            public func kernel_authorized_add(_caller : Principal) {};
            public func is_authorized(_caller : Principal) : Bool { true };
          };
        }`,
    },
    {
      path: `${contactsEntry}.mo`,
      content: `module {
          public type list_contacts_Input = ();
          public type list_contacts_Output = [Text];
          public class Init() {
            public func list_contacts(_request : ()) : async* [Text] { ["Ada"] };
          };
        }`,
    },
    {
      path: `${calendarEntry}.mo`,
      content: `module {
          public type AppDependencies = {
            people : {
              list_contacts : (()) -> async* [Text];
            };
          };
          public type calendar_people_Input = ();
          public type calendar_people_Output = [Text];
          public type Environment = { app_calls : AppDependencies };
          public class Init(environment : Environment) {
            public func calendar_people(_request : ()) : async* [Text] {
              await* environment.app_calls.people.list_contacts(())
            };
          };
        }`,
    },
  ];
  const result = await compile({
    configs: { calendar, contacts, kernel },
    mofiles,
  });

  expect(result.dependencyPlan.order).toEqual([
    "kernel",
    "contacts",
    "calendar",
  ]);
  expect(result.candid).toContain("calendar_people");

  const incompatibleEntry = moduleHash("d");
  await expect(
    compile({
      configs: {
        kernel,
        contacts: {
          ...contacts,
          version: 103,
          entry: incompatibleEntry,
        },
        calendar,
      },
      mofiles: [
        ...mofiles,
        {
          path: `${incompatibleEntry}.mo`,
          content: `module {
            public type list_contacts_Input = ();
            public type list_contacts_Output = Nat;
            public class Init() {
              public func list_contacts(_request : ()) : async* Nat { 1 };
            };
          }`,
        },
      ],
    }),
  ).rejects.toThrow();
}, 60_000);

test("compiler stages live-root uninstall and permits immediate same-id reinstall", async () => {
  const kernelEntry = moduleHash("a");
  const appV1Entry = moduleHash("b");
  const appV3Entry = moduleHash("c");
  const schema1 = moduleHash("1");
  const schema2 = moduleHash("2");
  const schema3 = moduleHash("3");
  const edge12 = moduleHash("4");
  const edge23 = moduleHash("5");
  const reinstalledSchema = moduleHash("6");
  const reinstalledEntry = moduleHash("7");
  const kernel: PackagedNeutronManifest = {
    format: 3,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: kernelEntry,
  };
  const app = (memoryVersion: 1 | 3): PackagedNeutronManifest => ({
    format: 3,
    id: "hello",
    name: "Hello",
    version: memoryVersion === 1 ? 100 : 102,
    entry: memoryVersion === 1 ? appV1Entry : appV3Entry,
    memory: {
      hello: {
        version: memoryVersion,
        schemas:
          memoryVersion === 1
            ? { "1": schema(schema1) }
            : {
                "1": schema(schema1),
                "2": schema(schema2),
                "3": schema(schema3),
              },
        migrations:
          memoryVersion === 1
            ? []
            : [
                { from: 1, to: 2, entry: edge12 },
                { from: 2, to: 3, entry: edge23 },
              ],
      },
    },
  });
  const initialApp: PackagedNeutronManifest = {
    format: 3,
    id: "hello",
    name: "Hello",
    version: 100,
    entry: appV1Entry,
    memory: {
      hello: {
        version: 1,
        schemas: { "1": schema(schema1) },
        migrations: [],
      },
    },
  };
  const mofiles = [
    {
      path: `${kernelEntry}.mo`,
      content: `module {
        public class Init() {
          ${kernelCapabilityConfigurationMethod}
          public func kernel_authorized_add(_caller : Principal) {};
          public func is_authorized(_caller : Principal) : Bool { true };
        };
      }`,
    },
    {
      path: `${schema1}.mo`,
      content: `module {
        public type Mem = { var value : Nat };
        public func init() : Mem { { var value = 1 } };
      }`,
    },
    {
      path: `${schema2}.mo`,
      content: `module {
        public type Mem = { var value : Nat; var title : Text };
        public func init() : Mem { { var value = 1; var title = "" } };
      }`,
    },
    {
      path: `${schema3}.mo`,
      content: `module {
        public type Mem = { var value : Nat; var title : Text; var count : Nat };
        public func init() : Mem { { var value = 1; var title = ""; var count = 0 } };
      }`,
    },
    {
      path: `${appV1Entry}.mo`,
      content: `module {
        public type Memory_hello = { var value : Nat };
        public func memory_hello() : Memory_hello { { var value = 1 } };
        public type Environment = { stable_memory : { hello : Memory_hello } };
        public class Init(_environment : Environment) {}
      }`,
    },
    {
      path: `${appV3Entry}.mo`,
      content: `import Memory "${schema3}";
        module {
          public type Environment = { stable_memory : { hello : Memory.Mem } };
          public class Init(_environment : Environment) {}
        }`,
    },
    {
      path: `${edge12}.mo`,
      content: `import V1 "${schema1}"; import V2 "${schema2}";
        module { public func migrate(old : V1.Mem) : V2.Mem {
          { var value = old.value; var title = "migrated" }
        } }`,
    },
    {
      path: `${edge23}.mo`,
      content: `import V2 "${schema2}"; import V3 "${schema3}";
        module { public func migrate(old : V2.Mem) : V3.Mem {
          { var value = old.value; var title = old.title; var count = 3 }
        } }`,
    },
    {
      path: `${reinstalledSchema}.mo`,
      content: `module {
        public type Mem = { var replacement : Text };
        public func init() : Mem { { var replacement = "fresh" } };
      }`,
    },
    {
      path: `${reinstalledEntry}.mo`,
      content: `import Memory "${reinstalledSchema}";
        module {
          public type Environment = { stable_memory : { hello : Memory.Mem } };
          public class Init(_environment : Environment) {}
        }`,
    },
  ];

  const v1 = await compile({
    mofiles,
    configs: { kernel, hello: initialApp },
  });
  const v3 = await compile({
    mofiles,
    previousConfigs: { kernel, hello: initialApp },
    previousStable: v1.stable,
    configs: { kernel, hello: app(3) },
  });
  expect(v3.migrationPlan.upgrades[0]).toMatchObject({
    kind: "migrate",
    from: 1,
    to: 3,
  });
  expect(v3.compatibilityDiagnostics).toEqual([]);

  const uninstalled = await compile({
    mofiles,
    previousConfigs: { kernel, hello: app(3) },
    previousStable: v3.stable,
    configs: { kernel },
  });
  expect(uninstalled.migrationPlan.destructiveMemoryRoots).toEqual([
    { owner: "hello", memoryId: "hello" },
  ]);
  expect(uninstalled.managedMemoryRetirements).toEqual([
    {
      memoryId: "hello",
      owner: "hello",
      version: 3,
      schemaEntry: schema3,
    },
  ]);
  expect(uninstalled.stable).toContain(
    retiredManagedMemoryStoreName("hello", "hello"),
  );

  const reinstalled: PackagedNeutronManifest = {
    format: 3,
    id: "hello",
    name: "Hello",
    version: 103,
    entry: reinstalledEntry,
    memory: {
      hello: {
        // Deliberately reuse the old memory id and version with a different
        // schema entry. The old null retirement uses a distinct import alias.
        version: 3,
        schemas: { "3": schema(reinstalledSchema) },
        migrations: [],
      },
    },
  };
  const replaced = await compile({
    mofiles,
    previousConfigs: { kernel },
    previousStable: uninstalled.stable,
    configs: { kernel, hello: reinstalled },
  });
  expect(replaced.managedMemoryRetirements).toEqual([]);
  expect(replaced.stable).toContain(
    `stable ${managedMemoryStoreName("hello", "hello")}`,
  );
  expect(replaced.stable).toContain(
    `in ${retiredManagedMemoryStoreName("hello", "hello")}`,
  );
  expect(replaced.stable).not.toContain(
    `stable var ${retiredManagedMemoryStoreName("hello", "hello")}`,
  );
  expect(replaced.stable).not.toContain(
    "@neutron-managed-memory-retirements-v2 [{",
  );
  expect(replaced.compatibilityDiagnostics).toEqual([]);
});

test("compiler keeps uninstall available for apps without managed memory", async () => {
  const kernelEntry = moduleHash("a");
  const appEntry = moduleHash("b");
  const kernel: PackagedNeutronManifest = {
    format: 3,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: kernelEntry,
  };
  const hello: PackagedNeutronManifest = {
    format: 3,
    id: "hello",
    name: "Hello",
    version: 100,
    entry: appEntry,
  };
  const mofiles = [
    {
      path: `${kernelEntry}.mo`,
      content: `module {
        public class Init() {
          ${kernelCapabilityConfigurationMethod}
          public func kernel_authorized_add(_caller : Principal) {};
          public func is_authorized(_caller : Principal) : Bool { true };
        };
      }`,
    },
    {
      path: `${appEntry}.mo`,
      content: "module { public class Init() {} }",
    },
  ];
  const installed = await compile({
    mofiles,
    configs: { kernel, hello },
  });
  const uninstalled = await compile({
    mofiles,
    previousConfigs: { kernel, hello },
    previousStable: installed.stable,
    configs: { kernel },
  });

  expect(uninstalled.migrationPlan.removedApps).toEqual(["hello"]);
  expect(uninstalled.migrationPlan.destructiveMemoryRoots).toEqual([]);
  expect(uninstalled.candid).toContain("kernel_runtime_info");
});

test("compiler stages consolidation inputs and finalizes them after commit", async () => {
  const kernelEntry = moduleHash("a");
  const appV1Entry = moduleHash("b");
  const appV2Entry = moduleHash("c");
  const schema1 = moduleHash("1");
  const schema2 = moduleHash("2");
  const auxSchema = moduleHash("3");
  const edge = moduleHash("4");
  const kernel: PackagedNeutronManifest = {
    format: 3,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: kernelEntry,
  };
  const oldApp: PackagedNeutronManifest = {
    format: 3,
    id: "hello",
    name: "Hello",
    version: 100,
    entry: appV1Entry,
    memory: {
      hello: {
        version: 1,
        schemas: { "1": schema(schema1) },
        migrations: [],
      },
      hello_aux: {
        version: 1,
        schemas: { "1": schema(auxSchema) },
        migrations: [],
      },
    },
  };
  const nextApp: PackagedNeutronManifest = {
    format: 3,
    id: "hello",
    name: "Hello",
    version: 101,
    entry: appV2Entry,
    memory: {
      hello: {
        version: 2,
        schemas: {
          "1": schema(schema1),
          "2": schema(schema2),
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
        schemas: { "1": schema(auxSchema) },
        migrations: [],
        retired: true,
      },
    },
  };
  const mofiles = [
    {
      path: `${kernelEntry}.mo`,
      content: `module {
        public class Init() {
          ${kernelCapabilityConfigurationMethod}
          public func kernel_authorized_add(_caller : Principal) {};
          public func is_authorized(_caller : Principal) : Bool { true };
        };
      }`,
    },
    {
      path: `${schema1}.mo`,
      content: `module {
        public type Mem = { var value : Nat };
        public func init() : Mem { { var value = 1 } };
      }`,
    },
    {
      path: `${auxSchema}.mo`,
      content: `module {
        public type Mem = { var title : Text };
        public func init() : Mem { { var title = "aux" } };
      }`,
    },
    {
      path: `${schema2}.mo`,
      content: `module {
        public type Mem = { var value : Nat; var title : Text };
        public func init() : Mem { { var value = 1; var title = "" } };
      }`,
    },
    {
      path: `${appV1Entry}.mo`,
      content: `import Main "${schema1}"; import Aux "${auxSchema}";
        module {
          public type Environment = {
            stable_memory : { hello : Main.Mem; hello_aux : Aux.Mem };
          };
          public class Init(_environment : Environment) {}
        }`,
    },
    {
      path: `${appV2Entry}.mo`,
      content: `import Main "${schema2}";
        module {
          public type Environment = { stable_memory : { hello : Main.Mem } };
          public class Init(_environment : Environment) {}
        }`,
    },
    {
      path: `${edge}.mo`,
      content: `import V1 "${schema1}"; import V2 "${schema2}"; import Aux "${auxSchema}";
        module { public func migrate(old : V1.Mem, aux : Aux.Mem) : V2.Mem {
          { var value = old.value; var title = aux.title }
        } }`,
    },
  ];

  const v1 = await compile({
    mofiles,
    configs: { kernel, hello: oldApp },
  });
  const v2 = await compile({
    mofiles,
    previousConfigs: { kernel, hello: oldApp },
    previousStable: v1.stable,
    configs: { kernel, hello: nextApp },
  });
  expect(v2.managedMemoryRetirements).toEqual([
    {
      memoryId: "hello_aux",
      owner: "hello",
      version: 1,
      schemaEntry: auxSchema,
    },
  ]);
  expect(v2.stable).toContain(
    retiredManagedMemoryStoreName("hello", "hello_aux"),
  );

  const finalized = await compile({
    mofiles,
    previousConfigs: { kernel, hello: nextApp },
    previousStable: v2.stable,
    configs: { kernel, hello: nextApp },
  });
  expect(finalized.managedMemoryRetirements).toEqual([]);
  expect(finalized.stable).toContain(
    `in ${retiredManagedMemoryStoreName("hello", "hello_aux")}`,
  );
  expect(finalized.stable).not.toContain(
    `stable var ${retiredManagedMemoryStoreName("hello", "hello_aux")}`,
  );
  expect(finalized.compatibilityDiagnostics).toEqual([]);
});
