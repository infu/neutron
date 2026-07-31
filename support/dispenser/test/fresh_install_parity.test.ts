import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  assemble,
  type AssemblyManifest,
  type AssembleOptions,
} from "neutron-compiler/src/assemble.js";
import { trustedInstallationContextFromRootKey } from "neutron-compiler/src/installation_context.js";
import { initializePublicationEntropy } from "neutron-provision/src/kernel.js";

const ENTROPY_INITIALIZER = "kernel_publication_entropy_initialize";
const RESERVATION_MUTATORS = [
  "kernel_install_reservations_prepare",
  "kernel_backend_reservations_apply",
  "configure_backend_call_install_reservations",
] as const;

test("fresh Local, IC, and Dispenser paths converge on compiled defaults and entropy readiness", async () => {
  const [
    provisionSource,
    localSource,
    dispenserSource,
    dispenserBinding,
    starterUploader,
    backendCallsSource,
    kernelDid,
  ] = await Promise.all([
    source("../../../packages/neutron-provision/src/provision.ts"),
    source("../../../packages/neutron-provision/src/local_deploy.ts"),
    source("../mo/main.mo"),
    source("../mo/lib/neutron.mo"),
    source("../starter_payload.ts"),
    source("../../../apps/kernel/backend/backend_calls/Service.mo"),
    source("../../../apps/kernel/dist/neutron.did"),
  ]);
  expect(kernelDid).toContain(
    "type kernel_publication_entropy_initialize_Input = null;",
  );
  expect(kernelDid).toMatch(
    /kernel_publication_entropy_initialize: \(NeutronRequest:\s+kernel_publication_entropy_initialize_Input\)/u,
  );
  expect(dispenserBinding).toContain(
    "kernel_publication_entropy_initialize : shared Null ->",
  );
  expect(dispenserSource).toContain(
    "await neutron.kernel_publication_entropy_initialize(null)",
  );
  expect(dispenserSource).not.toContain(
    "await neutron.kernel_publication_entropy_initialize()",
  );

  const seed = section(
    provisionSource,
    "export async function seedFreshKernel",
    "/** Complete final key set produced by `seedFreshKernel`. */",
  );
  expect(occurrences(seed, "initializePublicationEntropy(actor)")).toBe(1);
  expect(seed.indexOf("initializePublicationEntropy(actor)")).toBeLessThan(
    seed.indexOf('kernel_static({ clear: { prefix: "" } })'),
  );
  assertNoReservationMutation(seed);

  const lifecycles = [
    {
      name: "IC",
      source: section(
        provisionSource,
        "if (!active.wasmInstalledAt)",
        "if (!active.initialAccessVerifiedAt)",
      ),
      install: "await client.installChunkedWasm",
      installed: "active.wasmInstalledAt =",
      initialize: "dependencies.seed ?? seedFreshKernel",
    },
    {
      name: "Local",
      source: section(
        localSource,
        'const mode = installedModuleHash === null ? "install" : "reinstall";',
        'if (!phaseReached(progress.phase, "authorized"))',
      ),
      install:
        "await client.installDeployment({ canisterId, deployment, mode });",
      installed: 'recordLocalNodePhase(journal, index, "installed", now())',
      initialize: "dependencies.seed ?? seedFreshKernel",
    },
    {
      name: "Dispenser",
      source: section(
        dispenserSource,
        "case (#created(canisterId))",
        "case (#assets_seeded(canisterId))",
      ),
      install: "await ic.install_code",
      installed: "#installed(canisterId)",
      initialize: `await neutron.${ENTROPY_INITIALIZER}(null)`,
    },
  ] as const;

  for (const lifecycle of lifecycles) {
    const install = lifecycle.source.indexOf(lifecycle.install);
    const installed = lifecycle.source.indexOf(lifecycle.installed, install);
    const initialize = lifecycle.source.indexOf(
      lifecycle.initialize,
      installed,
    );
    expect(
      install,
      `${lifecycle.name} installs the compiled actor`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      installed,
      `${lifecycle.name} records or observes installation before initialization`,
    ).toBeGreaterThan(install);
    expect(
      initialize,
      `${lifecycle.name} initializes entropy only after installation`,
    ).toBeGreaterThan(installed);
    assertNoReservationMutation(lifecycle.source);
  }

  expect(occurrences(dispenserBinding, `${ENTROPY_INITIALIZER} : shared`)).toBe(
    1,
  );
  assertNoReservationMutation(dispenserBinding);
  expect(starterUploader).toContain("deployment.transportWasm");
  expect(starterUploader).toContain("deployment.compiled.stable");
  expect(lifecycles[0].source).toContain("chunks: deployment.chunks");
  expect(lifecycles[0].source).toContain(
    "transportWasmHash: sha256(deployment.transportWasm)",
  );
  expect(lifecycles[1].source).toContain(
    "client.installDeployment({ canisterId, deployment, mode })",
  );
  expect(lifecycles[2].source).toContain("wasm_module = starter.wasm");

  const fingerprints = [
    new Uint8Array(32).fill(0x11),
    new Uint8Array(32).fill(0x22),
    new Uint8Array(32).fill(0x33),
  ];
  for (const [index, fingerprint] of fingerprints.entries()) {
    const calls: unknown[] = [];
    const result = await initializePublicationEntropy({
      async kernel_publication_entropy_initialize(request: null) {
        calls.push(request);
        return { ok: { fingerprint } };
      },
    });
    expect(calls, `${lifecycles[index]!.name} initializer wire shape`).toEqual([
      null,
    ]);
    expect(result).toBe(Buffer.from(fingerprint).toString("hex"));
  }

  const declarations = freshReservationDeclarations();
  const assemblyContexts: Array<{
    name: string;
    options: AssembleOptions;
  }> = [
    { name: "IC", options: { deploymentId: "fresh_parity" } },
    {
      name: "Local",
      options: {
        deploymentId: "fresh_parity",
        vetKeysEnvironment: "local",
        installationContext: trustedInstallationContextFromRootKey(
          new Uint8Array(32).fill(0x44),
        ),
      },
    },
    { name: "Dispenser", options: { deploymentId: "fresh_parity" } },
  ];
  const compiledDefaults = assemblyContexts.map(({ name, options }) => {
    const actor = assemble(declarations, options);
    const defaults = actor.match(/install_reservations = \[[^\n]*\];/gu);
    expect(defaults, `${name} has one compiler-owned default table`).toEqual([
      'install_reservations = [#method("generic_remote_update")];',
    ]);
    expect(actor).not.toContain("configure_backend_call_install_reservations");
    return defaults![0]!;
  });
  expect(new Set(compiledDefaults).size).toBe(1);

  const configure = section(
    backendCallsSource,
    "public func configure(",
    "public func supportsScope",
  );
  expect(configure).toContain(
    "if (Memory.isPristine(mem) and everyScopeActive)",
  );
  expect(configure).toContain("Memory.finalizeInstallReservations(");
  expect(configure).toContain("List.toArray(freshPlans)");
});

function freshReservationDeclarations(): Record<string, AssemblyManifest> {
  return {
    kernel: {
      format: 3,
      id: "kernel",
      name: "Neutral Kernel",
      version: 100,
      src: "main.mo",
      entry: "kernel",
      init_arg: ["memory_kernel"],
      memory: {
        kernel: {
          version: 1,
          schemas: { "1": { src: "memory/kernel.mo" } },
          migrations: [],
        },
      },
    },
    neutral_app: {
      format: 3,
      id: "neutral_app",
      name: "Neutral App",
      version: 100,
      src: "main.mo",
      entry: "neutral_app",
      capabilities: {
        backend_calls: {
          api: 1,
          description: "Call one reviewed remote method",
          reservation_scopes: ["method"],
          install_reservations: [
            { kind: "method", method: "generic_remote_update" },
          ],
          max_concurrency: 1,
          max_cycles_per_call: 0,
          max_cycles_per_day: 0,
        },
      },
      backend: {
        capabilities: {
          backend_calls: { api: 1 },
        },
      },
    },
  };
}

function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

function section(sourceText: string, start: string, end: string): string {
  const startIndex = sourceText.indexOf(start);
  if (startIndex < 0) throw new Error(`Missing source boundary ${start}`);
  const endIndex = sourceText.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`Missing source boundary ${end}`);
  return sourceText.slice(startIndex, endIndex);
}

function assertNoReservationMutation(sourceText: string): void {
  for (const method of RESERVATION_MUTATORS) {
    expect(sourceText).not.toContain(method);
  }
}

function occurrences(sourceText: string, value: string): number {
  return sourceText.split(value).length - 1;
}
