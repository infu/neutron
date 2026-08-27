import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import type { PackagedNeutronManifest } from "neutron-tools/src/schema.js";

const moduleHash = (digit: string): string => digit.repeat(64);

test("compiler typechecks invocation-scoped scheduled backend capabilities", async () => {
  const kernelEntry = moduleHash("7");
  const walletEntry = moduleHash("8");
  const kernel: PackagedNeutronManifest = {
    format: 3,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: kernelEntry,
  };
  const wallet: PackagedNeutronManifest = {
    format: 3,
    id: "wallet",
    name: "Wallet",
    version: 100,
    entry: walletEntry,
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
  };

  const result = await compile({
    configs: { kernel, wallet },
    mofiles: [
      {
        path: `${kernelEntry}.mo`,
        content: kernelModule,
      },
      {
        path: `${walletEntry}.mo`,
        content: walletModule,
      },
    ],
  });

  expect(result.wasm.byteLength).toBeGreaterThan(0);
  expect(result.dependencyPlan.order).toEqual(["kernel", "wallet"]);
});

test("compiler physically omits undeclared task capability fields", async () => {
  const kernelEntry = moduleHash("9");
  const walletEntry = moduleHash("a");
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
        wallet: {
          format: 3,
          id: "wallet",
          name: "Wallet",
          version: 100,
          entry: walletEntry,
          func: {
            task_a: {
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
              max_concurrency: 1,
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
                  run_on_start: false,
                  max_backend_calls: 1,
                },
              ],
            },
          },
        },
      },
      mofiles: [
        { path: `${kernelEntry}.mo`, content: kernelModule },
        { path: `${walletEntry}.mo`, content: walletModuleGuessingExtraField },
      ],
    }),
  ).rejects.toThrow();
});

const capabilityTypes = `
  public type CallRequest = { canister : Principal; method : Text; args : Blob };
  public type CallResult = { #ok : Blob; #err : { code : Text; message : Text } };
  public type BackendCallsCapability = {
    canister_principal : Principal;
    can_call : (Principal, Text) -> Bool;
    call : CallRequest -> async* CallResult;
    call_batch : [CallRequest] -> async* [CallResult];
  };
`;

const kernelModule = `
import Prim "mo:prim";
module {
  ${capabilityTypes}
  type AppScope = { app_id : Text; installation_uid : Nat64 };
  type AppInstance = {
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
  type Task = {
    app_scope : AppScope;
    id : Text;
    method : Text;
    interval_seconds : Nat;
    run_on_start : Bool;
    max_backend_calls : Nat;
    callback : TaskInvocationLease -> async ();
  };
  public type TaskInvocationLease = { active : () -> Bool };
  public class Init() {
    public func app_scope(appId : Text, _deploymentId : Text) : AppScope {
      { app_id = appId; installation_uid = 1 }
    };
    public func runtime_app_instances(_deploymentId : Text) : [AppInstance] { [] };
    public func capability_authority_revision() : Nat64 { 0 };
    public func scope_active(_scope : AppScope) : Bool { true };
    public func configure_frontend_surface_counts(
      _counts : { app_instances : Nat; resident_frames : Nat },
    ) {};
    public func configure_app_capabilities<Declaration, Configuration>(
      _declarations : [Declaration],
      _configuration : Configuration,
    ) {};
    public func configure_app_browser_surfaces<Declaration>(
      _declarations : [Declaration],
    ) {};
    public type CapabilityKind = {
      #backend_calls;
      #randomness;
      #vetkeys;
      #scheduled_tasks;
      #connections;
      #persistent_browser_storage;
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
    public func backend_calls_capability(
      _scope : AppScope,
      self : actor {},
    ) : BackendCallsCapability { capability(self) };
    public func task_backend_calls_capability(
      _scope : AppScope,
      _taskId : Text,
      _limit : Nat,
      _lease : TaskInvocationLease,
      self : actor {},
    ) : BackendCallsCapability { capability(self) };
    public func configure_scheduled_tasks<system>(_tasks : [Task]) {};
    public func app_usage_instruction_begin(_scope : AppScope, _fixed_message_cycles : Nat) : Nat64 { 0 };
    public func app_usage_instruction_finish(_measurement : Nat64) {};
    public func kernel_authorized_add(_caller : Principal) {};
    public func is_authorized(_caller : Principal) : Bool { true };
  };
  func capability(self : actor {}) : BackendCallsCapability {
    {
      canister_principal = Prim.principalOfActor(self);
      can_call = func(_canister : Principal, _method : Text) : Bool { true };
      call = func(_request : CallRequest) : async* CallResult {
        #err({ code = "unused"; message = "unused" })
      };
      call_batch = func(_requests : [CallRequest]) : async* [CallResult] { [] };
    }
  };
}`;

const walletModule = `
module {
  ${capabilityTypes}
  public type task_a_Input = ();
  public type task_a_Output = ();
  public type task_b_Input = ();
  public type task_b_Output = ();
  type TaskCapabilities = { backend_calls : BackendCallsCapability };
  public class Init() {
    public func task_a(
      _request : (),
      taskCapabilities : TaskCapabilities,
    ) : async* () {
      ignore taskCapabilities.backend_calls.canister_principal
    };
    public func task_b(
      _request : (),
      taskCapabilities : TaskCapabilities,
    ) : async* () {
      ignore taskCapabilities.backend_calls.canister_principal
    };
  };
}`;

const walletModuleGuessingExtraField = `
module {
  ${capabilityTypes}
  public type task_a_Input = ();
  public type task_a_Output = ();
  type TaskCapabilities = {
    backend_calls : BackendCallsCapability;
    randomness : { fresh_bytes : () -> async* Blob };
  };
  public class Init() {
    public func task_a(
      _request : (),
      taskCapabilities : TaskCapabilities,
    ) : async* () {
      ignore taskCapabilities.backend_calls.canister_principal
    };
  };
}`;
