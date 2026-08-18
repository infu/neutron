import { describe, expect, test } from "bun:test";
import { gunzipSync } from "fflate";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  DEPLOYMENT_BUILD_RECORD_FORMAT,
  DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES,
  DEPLOYMENT_BUILD_RECORD_PATH,
  DEPLOYMENT_WASM_TRANSPORT_ENCODER,
  PACKAGE_INFORMATION_RECORD_PATH,
  assertWasmRecord,
  canonicalDeploymentBuildRecordJson,
  createCompleteDeploymentBuildRecord,
  deploymentBuildRecordSha256,
  parseDeploymentBuildRecord,
  parseDeploymentBuildRecordJson,
  prepareDeterministicWasmTransport,
  serializeDeploymentBuildRecord,
} from "../src/deployment_record.ts";

const sha = (byte: string): string => byte.repeat(64);
const deploymentId = (byte: string): string => byte.repeat(32);
const rawWasm = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0);

function completeRecord(): Record<string, unknown> {
  const { wasmRecord } = prepareDeterministicWasmTransport(rawWasm);
  return {
    format: DEPLOYMENT_BUILD_RECORD_FORMAT,
    state: "complete",
    deployment_id: deploymentId("a"),
    previous: {
      deployment_id: deploymentId("b"),
      stable_signature_sha256: sha("1"),
      apps: [app("kernel", 100, "2")],
      memories: [memory("kernel", "kernel", 1, "3")],
    },
    build: {
      compiler_id: "moc_deadbeef01234567",
      assembler_id: "neutron_actor_v25",
      environment: "production",
      deployment_nonce: deploymentId("c"),
      reachable_module_sha256: [sha("f"), sha("e")],
    },
    packages: [
      {
        app_id: "kernel",
        version: 200,
        archive: { state: "verified", sha256: sha("4"), bytes: 1_000 },
        package_information: { state: "verified", sha256: sha("5") },
        dependencies: [],
      },
      {
        app_id: "alpha",
        version: 300,
        archive: { state: "verified", sha256: sha("6"), bytes: 2_000 },
        package_information: { state: "not_supplied" },
        dependencies: [
          {
            alias: "kernel_api",
            provider_app_id: "kernel",
            minimum_version: 200,
            provider_version: 200,
            functions: ["write", "read"],
          },
        ],
      },
    ],
    target: {
      apps: [app("kernel", 200, "7"), app("alpha", 300, "8")],
      memories: [
        memory("kernel", "kernel", 1, "3"),
        memory("alpha", "data", 1, "9"),
      ],
    },
    warnings: {
      diagnostics: [diagnostic("warning", 2, "M0002")],
      compatibility_diagnostics: [diagnostic("compatibility", 1, "M0207")],
      memory_changes: [
        { kind: "keep", owner: "kernel", memory_id: "kernel", version: 1 },
        { kind: "initialize", owner: "alpha", memory_id: "data", to: 1 },
      ],
      removed_apps: [],
      destructive_memory_roots: [],
    },
    installation: {
      target_canister: "ryjl3-tyaaa-aaaaa-aaaba-cai",
      mode: "upgrade",
      argument: { sha256: sha("a"), bytes: 6 },
      wasm_memory_persistence: "keep",
    },
    wasm: wasmRecord,
  };
}

function legacyRecord(): Record<string, unknown> {
  return {
    format: DEPLOYMENT_BUILD_RECORD_FORMAT,
    state: "legacy_observed",
    observation: {
      target_canister: "ryjl3-tyaaa-aaaaa-aaaba-cai",
      deployment_id: "pre-record-deployment-v036",
      compiler_id: "moc_historical.1",
      assembler_id: "neutron_actor_v19",
      apps: [app("kernel", 100, "2"), app("alpha", 300, "8")],
      memories: [memory("kernel", "kernel", 1, "3")],
      installed_module: {
        sha256: sha("d"),
        representation: "ic_canister_status.module_hash",
        source: "ic_certified_read_state_v1",
      },
    },
    packages: [
      {
        app_id: "kernel",
        version: 100,
        outer_archive_sha256: sha("4"),
        package_information_sha256: null,
      },
      {
        app_id: "alpha",
        version: 300,
        outer_archive_sha256: null,
        package_information_sha256: null,
      },
    ],
    unavailable: [
      "source_and_license_record",
      "ordered_package_digests",
      "raw_compiler_output",
      "package_archive_bytes",
      "gzip_transport_details",
      "pre_dispatch_warnings",
      "installation_inputs",
      "prior_state",
    ],
  };
}

function app(id: string, version: number, fingerprintByte: string) {
  return {
    app_id: id,
    version,
    capability_plan_fingerprint: sha(fingerprintByte),
    resident_frame_security: "credentialless_opaque_v1" as const,
  };
}

function memory(
  owner: string,
  id: string,
  version: number,
  schemaByte: string,
) {
  return { owner, id, version, schema: sha(schemaByte) };
}

function diagnostic(message: string, line: number, code: string) {
  return {
    source: `${sha("e")}.mo`,
    range: {
      start: { line, character: 1 },
      end: { line, character: 4 },
    },
    severity: 2,
    code,
    category: "warning",
    message,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("deterministic deployment Wasm integrity", () => {
  test("binds raw compiler output and exact gzip install bytes", () => {
    const first = prepareDeterministicWasmTransport(rawWasm);
    const second = prepareDeterministicWasmTransport(rawWasm);

    expect(first.transportWasm).toEqual(second.transportWasm);
    expect(gunzipSync(first.transportWasm)).toEqual(rawWasm);
    expect(first.transportWasm.slice(4, 8)).toEqual(Uint8Array.of(0, 0, 0, 0));
    expect(first.wasmRecord.raw).toEqual({
      sha256: hashContent(rawWasm),
      bytes: rawWasm.byteLength,
      representation: "neutron_compile_result_wasm",
      content_encoding: "identity",
    });
    expect(first.wasmRecord.transport).toEqual({
      sha256: hashContent(first.transportWasm),
      bytes: first.transportWasm.byteLength,
      representation: "ic_install_wasm_payload",
      content_encoding: "gzip",
      encoder: DEPLOYMENT_WASM_TRANSPORT_ENCODER,
    });
    expect(Object.isFrozen(first.wasmRecord)).toBe(true);
    expect(
      assertWasmRecord(rawWasm, first.transportWasm, first.wasmRecord),
    ).toEqual(first.wasmRecord);
  });

  test("rejects invalid Wasm, separately encoded payloads, and false records", () => {
    expect(() => prepareDeterministicWasmTransport(new Uint8Array())).toThrow(
      /raw Wasm/,
    );
    expect(() =>
      prepareDeterministicWasmTransport(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)),
    ).toThrow(/magic header/);

    const prepared = prepareDeterministicWasmTransport(rawWasm);
    const changed = prepared.transportWasm.slice();
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    expect(() =>
      assertWasmRecord(rawWasm, changed, prepared.wasmRecord),
    ).toThrow(/not the deterministic gzip payload/);

    const falseRecord = clone(prepared.wasmRecord) as any;
    falseRecord.raw.sha256 = sha("0");
    expect(() =>
      assertWasmRecord(rawWasm, prepared.transportWasm, falseRecord),
    ).toThrow(/does not match/);
  });
});

describe("complete deployment records", () => {
  test("normalizes semantic sets while retaining exact package order", () => {
    const parsed = parseDeploymentBuildRecord(completeRecord());
    expect(parsed.state).toBe("complete");
    if (parsed.state !== "complete") throw new Error("unreachable");

    expect(parsed.packages.map(({ app_id }) => app_id)).toEqual([
      "kernel",
      "alpha",
    ]);
    expect(parsed.packages[1]!.dependencies[0]!.functions).toEqual([
      "read",
      "write",
    ]);
    expect(parsed.target.apps.map(({ app_id }) => app_id)).toEqual([
      "alpha",
      "kernel",
    ]);
    expect(parsed.target.memories.map(({ owner }) => owner)).toEqual([
      "alpha",
      "kernel",
    ]);
    expect(parsed.build.reachable_module_sha256).toEqual([sha("e"), sha("f")]);
    expect(parsed.warnings.memory_changes.map(({ owner }) => owner)).toEqual([
      "alpha",
      "kernel",
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.packages)).toBe(true);
  });

  test("has one deployment Wasm identity and distinct package archive identities", () => {
    const parsed = parseDeploymentBuildRecord(completeRecord());
    if (parsed.state !== "complete") throw new Error("unreachable");
    expect(parsed.packages).toHaveLength(2);
    expect(parsed.packages[0]!.archive).not.toEqual(
      parsed.packages[1]!.archive,
    );
    expect(Object.keys(parsed).filter((key) => key === "wasm")).toEqual([
      "wasm",
    ]);
    expect(parsed.packages.every((pkg) => !("wasm" in pkg))).toBe(true);
  });

  test("round-trips canonical UTF-8 JSON and produces a stable identity", () => {
    const input = completeRecord();
    const text = canonicalDeploymentBuildRecordJson(input);
    const bytes = serializeDeploymentBuildRecord(input);
    const fromText = parseDeploymentBuildRecordJson(text);
    const fromBytes = parseDeploymentBuildRecordJson(bytes);

    expect(new TextDecoder().decode(bytes)).toBe(text);
    expect(fromText).toEqual(fromBytes);
    expect(canonicalDeploymentBuildRecordJson(fromText)).toBe(text);
    expect(deploymentBuildRecordSha256(fromText)).toBe(
      deploymentBuildRecordSha256(fromBytes),
    );

    const reordered = clone(input) as any;
    reordered.target.apps.reverse();
    reordered.target.memories.reverse();
    reordered.build.reachable_module_sha256.reverse();
    reordered.warnings.memory_changes.reverse();
    expect(canonicalDeploymentBuildRecordJson(reordered)).toBe(text);
  });

  test("accepts honest digest-only, legacy, and not-supplied package facts", () => {
    const input = completeRecord() as any;
    input.packages[0].archive = {
      state: "outer_archive_digest_only",
      sha256: sha("4"),
    };
    input.packages[0].package_information = { state: "legacy_unavailable" };
    input.packages[1].package_information = { state: "not_supplied" };
    const parsed = parseDeploymentBuildRecord(input);
    if (parsed.state !== "complete") throw new Error("unreachable");
    expect(parsed.packages[0]!.archive.state).toBe("outer_archive_digest_only");
    expect(parsed.packages[0]!.package_information.state).toBe(
      "legacy_unavailable",
    );
    expect(parsed.packages[1]!.package_information.state).toBe("not_supplied");
  });

  test("builds exact record bytes and transport bytes from compiler facts", () => {
    const prepared = createCompleteDeploymentBuildRecord({
      compiled: {
        wasm: rawWasm,
        deploymentId: deploymentId("a"),
        deploymentNonce: deploymentId("c"),
        vetKeysEnvironment: "production",
        compilerId: "moc_deadbeef01234567",
        modulePaths: [`${sha("e")}.mo`, `${sha("f")}.mo`],
        appInstanceInventory: [app("kernel", 200, "7"), app("alpha", 300, "8")],
        managedMemoryInventory: [
          memory("kernel", "kernel", 1, "3"),
          memory("alpha", "data", 1, "9"),
        ],
        diagnostics: [diagnostic("warning", 2, "M0002")],
        compatibilityDiagnostics: [],
        dependencyPlan: {
          order: ["kernel", "alpha"],
          dependenciesByConsumer: {
            kernel: [],
            alpha: [
              {
                alias: "kernel_api",
                consumer: "alpha",
                provider: "kernel",
                minVersion: 200,
                providerVersion: 200,
                functions: ["read"],
              },
            ],
          },
          dependentsByProvider: {},
        },
        migrationPlan: {
          upgrades: [
            { kind: "keep", owner: "kernel", memoryId: "kernel", version: 1 },
            { kind: "initialize", owner: "alpha", memoryId: "data", to: 1 },
          ],
          removedApps: [],
          destructiveMemoryRoots: [],
        },
      },
      assembler_id: "neutron_actor_v25",
      previous: {
        deployment_id: deploymentId("b"),
        stable_signature: "actor { stable var value : Nat = 0 }",
        apps: [app("kernel", 100, "2")],
        memories: [memory("kernel", "kernel", 1, "3")],
      },
      packages: [
        {
          app_id: "alpha",
          version: 300,
          archive: { state: "verified", sha256: sha("6"), bytes: 2_000 },
          package_information: { state: "not_supplied" },
        },
        {
          app_id: "kernel",
          version: 200,
          archive: { state: "verified", sha256: sha("4"), bytes: 1_000 },
          package_information: { state: "verified", sha256: sha("5") },
        },
      ],
      installation: {
        target_canister: "ryjl3-tyaaa-aaaaa-aaaba-cai",
        mode: "upgrade",
        argument: Uint8Array.of(0x44, 0x49, 0x44, 0x4c, 0, 0),
        wasm_memory_persistence: "keep",
      },
    });

    expect(gunzipSync(prepared.transportWasm)).toEqual(rawWasm);
    expect(parseDeploymentBuildRecordJson(prepared.recordBytes)).toEqual(
      prepared.record,
    );
    expect(prepared.record.packages.map(({ app_id }) => app_id)).toEqual([
      "kernel",
      "alpha",
    ]);
    expect(prepared.record.previous.stable_signature_sha256).toBe(
      hashContent("actor { stable var value : Nat = 0 }"),
    );
  });
});

describe("strict deployment record rejection", () => {
  test("rejects unknown fields, malformed hashes, and credential material", () => {
    const topSecret = completeRecord() as any;
    topSecret.secret = "do-not-record";
    expect(() => parseDeploymentBuildRecord(topSecret)).toThrow(
      /unknown field 'secret'/,
    );

    const nestedSecret = completeRecord() as any;
    nestedSecret.installation.credential = "do-not-record";
    expect(() => parseDeploymentBuildRecord(nestedSecret)).toThrow(
      /unknown field 'credential'/,
    );

    const malformed = completeRecord() as any;
    malformed.packages[0].archive.sha256 = sha("A");
    expect(() => parseDeploymentBuildRecord(malformed)).toThrow(
      /lowercase SHA-256/,
    );

    const diagnosticSecret = completeRecord() as any;
    diagnosticSecret.warnings.diagnostics[0].message =
      "Bearer abcdefghijklmnopqrstuvwxyz";
    expect(() => parseDeploymentBuildRecord(diagnosticSecret)).toThrow(
      /credential or private-key material/,
    );
  });

  test("rejects ambiguous JSON, invalid UTF-8, sparse arrays, and excess data", () => {
    expect(() =>
      parseDeploymentBuildRecordJson('{"format":1,"format":1}'),
    ).toThrow(/unambiguous JSON/);
    expect(() =>
      parseDeploymentBuildRecordJson(Uint8Array.of(0xc3, 0x28)),
    ).toThrow(/valid UTF-8 JSON/);
    expect(() =>
      parseDeploymentBuildRecordJson(`${"[".repeat(65)}0${"]".repeat(65)}`),
    ).toThrow(/unambiguous JSON/);

    const sparse = completeRecord() as any;
    sparse.target.apps = new Array(2);
    sparse.target.apps[1] = app("kernel", 200, "7");
    expect(() => parseDeploymentBuildRecord(sparse)).toThrow(
      /dense plain array/,
    );

    expect(() =>
      parseDeploymentBuildRecordJson(
        " ".repeat(DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES + 1),
      ),
    ).toThrow(/exceeds its byte limit/);

    const modules = completeRecord() as any;
    modules.build.reachable_module_sha256 = Array.from({ length: 20_001 }, () =>
      sha("e"),
    );
    expect(() => parseDeploymentBuildRecord(modules)).toThrow(
      /between 0 and 20000 entries/,
    );

    const oversizedClaims = completeRecord() as any;
    oversizedClaims.packages[0].archive.bytes = 128 * 1024 * 1024 + 1;
    expect(() => parseDeploymentBuildRecord(oversizedClaims)).toThrow(
      /safe integer from 1 to 134217728/,
    );

    const sharedConsume = Array.from(
      { length: 16 },
      (_, index) => `retired_${index}`,
    );
    const sharedEdge = {
      from: 1,
      to: 2,
      entry_sha256: sha("a"),
      consume: sharedConsume,
    };
    const sharedPath = Array.from({ length: 256 }, () => sharedEdge);
    const amplified = completeRecord() as any;
    amplified.warnings.memory_changes = Array.from(
      { length: 256 },
      (_, index) => ({
        kind: "migrate",
        owner: "alpha",
        memory_id: `data_${index}`,
        from: 1,
        to: 2,
        old_schema_entry_sha256: sha("b"),
        path: sharedPath,
      }),
    );
    expect(() => parseDeploymentBuildRecord(amplified)).toThrow(
      /complexity budget|byte limit/,
    );
  });

  test("rejects accessors without evaluating them", () => {
    const input = completeRecord();
    let evaluated = false;
    Object.defineProperty(input, "state", {
      enumerable: true,
      configurable: true,
      get() {
        evaluated = true;
        return "complete";
      },
    });
    expect(() => parseDeploymentBuildRecord(input)).toThrow(
      /enumerable data field/,
    );
    expect(evaluated).toBe(false);
  });

  test("rejects package, dependency, inventory, and retirement inconsistencies", () => {
    const forwardDependency = completeRecord() as any;
    forwardDependency.packages[0].dependencies = [
      {
        alias: "alpha_api",
        provider_app_id: "alpha",
        minimum_version: 300,
        provider_version: 300,
        functions: ["call"],
      },
    ];
    expect(() => parseDeploymentBuildRecord(forwardDependency)).toThrow(
      /earlier provider/,
    );

    const versionMismatch = completeRecord() as any;
    versionMismatch.target.apps[1].version = 400;
    expect(() => parseDeploymentBuildRecord(versionMismatch)).toThrow(
      /exactly match/,
    );

    const falseDestruction = completeRecord() as any;
    falseDestruction.warnings.destructive_memory_roots = [
      { owner: "alpha", memory_id: "data" },
    ];
    expect(() => parseDeploymentBuildRecord(falseDestruction)).toThrow(
      /exactly match memory retirements/,
    );

    const inventedNewPackage = completeRecord() as any;
    inventedNewPackage.packages[1].archive = { state: "legacy_unavailable" };
    inventedNewPackage.packages[1].package_information = {
      state: "not_supplied",
    };
    expect(() => parseDeploymentBuildRecord(inventedNewPackage)).toThrow(
      /not_supplied requires a verified archive/,
    );

    const emptyFunctions = completeRecord() as any;
    emptyFunctions.packages[1].dependencies[0].functions = [];
    expect(() => parseDeploymentBuildRecord(emptyFunctions)).toThrow(
      /between 1 and 64 entries/,
    );

    const invalidFunction = completeRecord() as any;
    invalidFunction.packages[1].dependencies[0].functions = ["not valid"];
    expect(() => parseDeploymentBuildRecord(invalidFunction)).toThrow(
      /valid function name/,
    );

    const tooManyDependencies = completeRecord() as any;
    tooManyDependencies.packages[1].dependencies = Array.from(
      { length: 33 },
      () => ({
        alias: "provider",
        provider_app_id: "kernel",
        minimum_version: 200,
        provider_version: 200,
        functions: ["read"],
      }),
    );
    expect(() => parseDeploymentBuildRecord(tooManyDependencies)).toThrow(
      /between 0 and 32 entries/,
    );
  });

  test("rejects false retirement reasons and invalid consumed roots", () => {
    const removedApp = completeRecord() as any;
    removedApp.packages = [removedApp.packages[0]];
    removedApp.previous.apps.push(app("alpha", 300, "8"));
    removedApp.previous.memories.push(memory("alpha", "data", 1, "9"));
    removedApp.target.apps = [removedApp.target.apps[0]];
    removedApp.target.memories = [removedApp.target.memories[0]];
    removedApp.warnings = {
      diagnostics: [],
      compatibility_diagnostics: [],
      memory_changes: [
        { kind: "keep", owner: "kernel", memory_id: "kernel", version: 1 },
        {
          kind: "retire",
          reason: "app-uninstall",
          owner: "alpha",
          memory_id: "data",
          from: 1,
          old_schema_entry_sha256: sha("9"),
        },
      ],
      removed_apps: ["alpha"],
      destructive_memory_roots: [{ owner: "alpha", memory_id: "data" }],
    };
    expect(() => parseDeploymentBuildRecord(removedApp)).not.toThrow();

    const falseUninstallReason = clone(removedApp) as any;
    falseUninstallReason.warnings.memory_changes[1].reason =
      "memory-retirement";
    expect(() => parseDeploymentBuildRecord(falseUninstallReason)).toThrow(
      /inconsistent reason/,
    );

    const consolidation = completeRecord() as any;
    consolidation.previous.apps.push(app("alpha", 200, "8"));
    consolidation.previous.memories.push(
      memory("alpha", "data", 1, "9"),
      memory("alpha", "retired", 1, "a"),
    );
    consolidation.target.memories[1].version = 2;
    consolidation.target.memories[1].schema = sha("b");
    consolidation.warnings = {
      diagnostics: [],
      compatibility_diagnostics: [],
      memory_changes: [
        { kind: "keep", owner: "kernel", memory_id: "kernel", version: 1 },
        {
          kind: "migrate",
          owner: "alpha",
          memory_id: "data",
          from: 1,
          to: 2,
          old_schema_entry_sha256: sha("9"),
          path: [
            {
              from: 1,
              to: 2,
              entry_sha256: sha("c"),
              consume: ["retired"],
            },
          ],
        },
        {
          kind: "retire",
          reason: "memory-retirement",
          owner: "alpha",
          memory_id: "retired",
          from: 1,
          old_schema_entry_sha256: sha("a"),
        },
      ],
      removed_apps: [],
      destructive_memory_roots: [{ owner: "alpha", memory_id: "retired" }],
    };
    expect(() => parseDeploymentBuildRecord(consolidation)).not.toThrow();

    const nonexistentConsume = clone(consolidation) as any;
    nonexistentConsume.warnings.memory_changes[1].path[0].consume = ["missing"];
    expect(() => parseDeploymentBuildRecord(nonexistentConsume)).toThrow(
      /not retired by the same owner/,
    );

    const repeatedConsume = clone(consolidation) as any;
    repeatedConsume.target.memories[1].version = 3;
    repeatedConsume.warnings.memory_changes[1].to = 3;
    repeatedConsume.warnings.memory_changes[1].path.push({
      from: 2,
      to: 3,
      entry_sha256: sha("d"),
      consume: ["retired"],
    });
    expect(() => parseDeploymentBuildRecord(repeatedConsume)).toThrow(
      /consumed more than once/,
    );
  });
});

describe("legacy deployment observations", () => {
  test("preserves observed facts without inventing build facts", () => {
    const parsed = parseDeploymentBuildRecord(legacyRecord());
    expect(parsed.state).toBe("legacy_observed");
    if (parsed.state !== "legacy_observed") throw new Error("unreachable");
    expect(parsed.observation.deployment_id).toBe("pre-record-deployment-v036");
    expect(parsed.observation.installed_module.sha256).toBe(sha("d"));
    expect(parsed.packages[0]!.outer_archive_sha256).toBe(sha("4"));
    expect(parsed.packages[1]!.outer_archive_sha256).toBeNull();
    expect(parsed.unavailable).toEqual([
      "gzip_transport_details",
      "installation_inputs",
      "ordered_package_digests",
      "package_archive_bytes",
      "pre_dispatch_warnings",
      "prior_state",
      "raw_compiler_output",
      "source_and_license_record",
    ]);
    expect("wasm" in parsed).toBe(false);
  });

  test("requires conspicuous closed reasons for unavailable predecessor facts", () => {
    const missingDigestReason = legacyRecord() as any;
    missingDigestReason.unavailable = missingDigestReason.unavailable.filter(
      (code: string) => code !== "ordered_package_digests",
    );
    expect(() => parseDeploymentBuildRecord(missingDigestReason)).toThrow(
      /digest gaps must be declared/,
    );

    const unknownReason = legacyRecord() as any;
    unknownReason.unavailable[0] = "everything_else";
    expect(() => parseDeploymentBuildRecord(unknownReason)).toThrow(
      /is invalid/,
    );

    const fakeObservedHash = legacyRecord() as any;
    fakeObservedHash.observation.installed_module.sha256 = "not-a-hash";
    expect(() => parseDeploymentBuildRecord(fakeObservedHash)).toThrow(
      /lowercase SHA-256/,
    );
  });
});

test("exports stable interoperability paths", () => {
  expect(DEPLOYMENT_BUILD_RECORD_PATH).toBe(
    "/system/deployment-build-record.json",
  );
  expect(PACKAGE_INFORMATION_RECORD_PATH).toBe("legal/package-record.v1.json");
});
