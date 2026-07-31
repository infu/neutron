import { expect, test } from "bun:test";
import type { Motoko } from "neutron-motoko-wasm";
import { compile, reachableMotokoFiles } from "../src/compile.ts";
import { whitelist } from "../whitelist.ts";

test("reachability inspects each shared Motoko module once", async () => {
  const calls: string[] = [];
  const imports = new Map<string, string[]>([
    ["a.mo", ["shared"]],
    ["b.mo", ["shared"]],
    ["shared.mo", []],
  ]);
  const mo = {
    async inspectMotoko(path: string) {
      calls.push(path);
      return {
        immediateImports: imports.get(path) ?? [],
        hasActorUrl: false,
        dotMembers: [],
      };
    },
  } as unknown as Motoko;

  const files = await reachableMotokoFiles({
    configs: {
      a: { format: 3, id: "a", name: "A", version: 100, entry: "a" },
      b: { format: 3, id: "b", name: "B", version: 100, entry: "b" },
    },
    mofilesByPath: new Map([
      ["a.mo", "module {}"],
      ["b.mo", "module {}"],
      ["shared.mo", "module {}"],
    ]),
    mo,
  });

  expect(files.map(({ path }) => path)).toEqual(["a.mo", "shared.mo", "b.mo"]);
  expect(calls).toEqual(["a.mo", "shared.mo", "b.mo"]);
});

test("reachability handles cycles without reinspecting modules", async () => {
  const calls: string[] = [];
  const mo = {
    async inspectMotoko(path: string) {
      calls.push(path);
      return {
        immediateImports: path === "a.mo" ? ["b"] : ["a"],
        hasActorUrl: false,
        dotMembers: [],
      };
    },
  } as unknown as Motoko;

  const files = await reachableMotokoFiles({
    configs: {
      a: { format: 3, id: "a", name: "A", version: 100, entry: "a" },
    },
    mofilesByPath: new Map([
      ["a.mo", "module {}"],
      ["b.mo", "module {}"],
    ]),
    mo,
  });

  expect(files.map(({ path }) => path)).toEqual(["a.mo", "b.mo"]);
  expect(calls).toEqual(["a.mo", "b.mo"]);
});

const manifest = (id: string, entry: string) => ({
  format: 3 as const,
  id,
  name: id,
  version: 100,
  entry,
});

const compilableKernel = `
  module {
    public type AppScope = { app_id : Text; installation_uid : Nat64 };
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
    public class Init() {
      public func app_scope(appId : Text, _deploymentId : Text) : AppScope {
        { app_id = appId; installation_uid = 1 }
      };
      public func runtime_app_instances(_deploymentId : Text) : [AppInstance] { [] };
      public func scope_active(_scope : AppScope) : Bool { true };
      public func configure_frontend_surface_counts(
        _counts : { app_instances : Nat; resident_frames : Nat },
      ) {};
      public func configure_app_capabilities<Declaration, Configuration>(
        _declarations : [Declaration],
        _configuration : Configuration,
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
      public func kernel_authorized_add(_caller : Principal) {};
      public func is_authorized(_caller : Principal) : Bool { true };
    };
  }
`;

test("shared findings retain deterministic per-app attribution", async () => {
  await expect(
    compile({
      configs: {
        kernel: manifest("kernel", "kernel"),
        alpha: manifest("alpha", "alpha"),
        beta: manifest("beta", "beta"),
      },
      mofiles: [
        { path: "kernel.mo", content: "module {}" },
        { path: "alpha.mo", content: 'import Shared "shared"; module {}' },
        { path: "beta.mo", content: 'import Shared "shared"; module {}' },
        {
          path: "shared.mo",
          content:
            'import Prim "mo:prim"; module { public func bad() { Prim.cyclesAdd(1) } }',
        },
      ],
    }),
  ).rejects.toThrow(
    "Disallowed Motoko code: alpha:shared (cyclesAdd); beta:shared (cyclesAdd)",
  );
});

test("global reachability crosses a whitelist boundary but app danger scanning stops there", async () => {
  const trustedEntry = Object.keys(whitelist)[0]!;
  try {
    await compile({
      configs: {
        kernel: manifest("kernel", "kernel"),
        trusted: manifest("trusted", trustedEntry),
        untrusted: manifest("untrusted", "untrusted"),
      },
      mofiles: [
        { path: "kernel.mo", content: "module {}" },
        {
          path: `${trustedEntry}.mo`,
          content: 'import Dangerous "dangerous"; module {}',
        },
        {
          path: "untrusted.mo",
          content: 'import Dangerous "dangerous"; module {}',
        },
        {
          path: "dangerous.mo",
          content:
            'import Prim "mo:prim"; module { public func bad() { Prim.cyclesAdd(1) } }',
        },
      ],
    });
    throw new Error("expected dangerous untrusted module to be rejected");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toBe(
      "Disallowed Motoko code: untrusted:dangerous (cyclesAdd)",
    );
  }
});

const firstSliceEscapes = [
  {
    name: "named actor conversion import",
    finding: "actorOfPrincipal",
    source:
      'import { actorOfPrincipal = convert } "mo:prim"; module { public let use = convert }',
  },
  {
    name: "caller supplied actor reference",
    finding: "actor",
    source:
      "module { public func use(value : actor { run : shared () -> async () }) : async () { await value.run() } }",
  },
  {
    name: "explicit cycles call context",
    finding: "cyclesTransfer",
    source:
      "module { func run() : async () {}; public func use() : async () { await (with cycles = 1) run() } }",
  },
  {
    name: "inherited cycles call context",
    finding: "cyclesTransfer",
    source:
      "module { func run() : async () {}; public func use() : async () { let context = { cycles = 1 }; await (context with) run() } }",
  },
  {
    name: "cycles system primitive",
    finding: "cyclesSystem",
    source:
      'import { cyclesBurn = burn } "mo:prim"; module { public let use = burn }',
  },
  {
    name: "stable memory growth",
    finding: "stableMemoryGrow",
    source:
      'import { stableMemoryGrow = grow } "mo:prim"; module { public let use = grow }',
  },
  {
    name: "region allocation",
    finding: "regionMemory",
    source:
      'import { regionNew = allocate } "mo:prim"; module { public let use = allocate }',
  },
  {
    name: "stable runtime accounting",
    finding: "stableRuntimeMemory",
    source:
      'import Prim "mo:prim"; module { public let use = Prim.rts_stable_memory_size }',
  },
  {
    name: "system timer capability",
    finding: "systemCapability, systemTimer",
    source:
      'import { setTimer = schedule } "mo:prim"; module { public func use<system>() { ignore schedule } }',
  },
  {
    name: "implicit system environment access",
    finding: "systemEnvironment",
    source:
      'import Prim "mo:prim"; module { public func use() : ?Text { Prim.envVar("NAME") } }',
  },
  {
    name: "implicit caller information system call",
    finding: "systemCallerInfo",
    source:
      'import Prim "mo:prim"; module { public func leak() : async* Blob { Prim.callerInfoData() } }',
  },
  {
    name: "implicit Candid limit system call",
    finding: "systemCandidLimits",
    source:
      'import Prim "mo:prim"; module { public func configure() : async* () { Prim.setCandidLimits({ numerator = 1; denominator = 1; bias = 0 }); Prim.setCandidTypeLimits({ scalar = 1; bias = 0 }) } }',
  },
  {
    name: "system capability with a type parameter",
    finding: "systemCapability",
    source:
      "module { public func use<system, Value>(value : Value) : Value { value } }",
  },
] as const;

for (const fixture of firstSliceEscapes) {
  test(`browser compilation rejects ${fixture.name}`, async () => {
    await expect(
      compile({
        configs: {
          kernel: manifest("kernel", "kernel"),
          ordinary: manifest("ordinary", "ordinary"),
        },
        mofiles: [
          { path: "kernel.mo", content: "module {}" },
          { path: "ordinary.mo", content: fixture.source },
        ],
      }),
    ).rejects.toThrow(
      `Disallowed Motoko code: ordinary:ordinary (${fixture.finding})`,
    );
  });
}

test("browser compilation allows exact privileged spellings without acquisition", async () => {
  const result = await compile({
    configs: {
      kernel: manifest("kernel", "kernel"),
      ordinary: manifest("ordinary", "ordinary"),
    },
    mofiles: [
      { path: "kernel.mo", content: compilableKernel },
      {
        path: "ordinary.mo",
        content: [
          "module {",
          "  public class Init() {",
          "    public let metrics : { cyclesBalance : Nat; regionSize : Nat } = { cyclesBalance = 0; regionSize = 0 };",
          "    public let toActor = 1;",
          '    public let sample = { call_raw = false; envVar = "local" };',
          "    public func createActor(setTimer : Text) : Text { setTimer };",
          "    public func setCandidLimits(value : Nat) : Nat { value };",
          "  };",
          "}",
        ].join("\n"),
      },
    ],
  });

  expect(result.danger.ordinary?.ordinary).toEqual([]);
});

test("browser compilation rejects a dangerous transitive helper", async () => {
  await expect(
    compile({
      configs: {
        kernel: manifest("kernel", "kernel"),
        ordinary: manifest("ordinary", "ordinary"),
      },
      mofiles: [
        { path: "kernel.mo", content: "module {}" },
        {
          path: "ordinary.mo",
          content:
            'import Helper "helper"; module { public let use = Helper.use }',
        },
        {
          path: "helper.mo",
          content:
            'import { regionGrow = grow } "mo:prim"; module { public let use = grow }',
        },
      ],
    }),
  ).rejects.toThrow("Disallowed Motoko code: ordinary:helper (regionMemory)");
});

test("browser compilation scans managed-memory schema roots", async () => {
  const schemaEntry = "1".repeat(64);
  await expect(
    compile({
      configs: {
        kernel: manifest("kernel", "kernel"),
        ordinary: {
          ...manifest("ordinary", "ordinary"),
          memory: {
            ordinary_data: {
              version: 1,
              schemas: {
                "1": { entry: schemaEntry, hash: schemaEntry },
              },
              migrations: [],
            },
          },
        },
      },
      mofiles: [
        { path: "kernel.mo", content: "module {}" },
        { path: "ordinary.mo", content: "module {}" },
        {
          path: `${schemaEntry}.mo`,
          content:
            "module { public type Mem = { remote : actor {} }; public func init() : Mem { loop {} } }",
        },
      ],
    }),
  ).rejects.toThrow(`Disallowed Motoko code: ordinary:${schemaEntry} (actor)`);
});

test("a whitelisted Principal facade does not hide an untrusted toActor acquisition", async () => {
  const principalEntry = Object.entries(whitelist).find(([, entry]) =>
    entry.path.includes("core#v2.6.0/src/Principal.mo"),
  )?.[0];
  expect(principalEntry).toBeDefined();

  await expect(
    compile({
      configs: {
        kernel: manifest("kernel", "kernel"),
        ordinary: manifest("ordinary", "ordinary"),
      },
      mofiles: [
        { path: "kernel.mo", content: "module {}" },
        {
          path: "ordinary.mo",
          content: `import { toActor = convert } "${principalEntry}"; module { public let use = convert }`,
        },
        {
          path: `${principalEntry}.mo`,
          content:
            "module { public let toActor = func (value : Principal) : actor {} { actor (Principal.toText(value)) } }",
        },
      ],
    }),
  ).rejects.toThrow("Disallowed Motoko code: ordinary:ordinary (toActor)");
});

test("a whitelisted Runtime facade does not hide untrusted environment access", async () => {
  const runtimeEntry = Object.entries(whitelist).find(([, entry]) =>
    entry.path.includes("core#v2.6.0/src/Runtime.mo"),
  )?.[0];
  expect(runtimeEntry).toBeDefined();

  await expect(
    compile({
      configs: {
        kernel: manifest("kernel", "kernel"),
        ordinary: manifest("ordinary", "ordinary"),
      },
      mofiles: [
        { path: "kernel.mo", content: "module {}" },
        {
          path: "ordinary.mo",
          content: `import Runtime "${runtimeEntry}"; module { public func use() : ?Text { Runtime.envVar("NAME") } }`,
        },
        {
          path: `${runtimeEntry}.mo`,
          content:
            "module { public func envVar<system>(name : Text) : ?Text { null } }",
        },
      ],
    }),
  ).rejects.toThrow(
    "Disallowed Motoko code: ordinary:ordinary (systemEnvironment)",
  );
});

test("a formerly whitelisted Base Random hash is scanned and rejected", async () => {
  const formerRandomHash =
    "80d2ee1cb0bf8b7e8b63871fe893585b4d3550d2caeed75f390a4164648c8b90";
  expect(whitelist[formerRandomHash]).toBeUndefined();

  await expect(
    compile({
      configs: {
        kernel: manifest("kernel", "kernel"),
        ordinary: manifest("ordinary", "ordinary"),
      },
      mofiles: [
        { path: "kernel.mo", content: "module {}" },
        {
          path: "ordinary.mo",
          content: `import Random "${formerRandomHash}"; module { public let blob = Random.blob }`,
        },
        {
          path: `${formerRandomHash}.mo`,
          content:
            'module { public let blob = (actor "aaaaa-aa" : actor { raw_rand : shared () -> async Blob }).raw_rand }',
        },
      ],
    }),
  ).rejects.toThrow(
    `Disallowed Motoko code: ordinary:${formerRandomHash} (actor)`,
  );
});
