import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Principal } from "@dfinity/principal";
import { ASSEMBLER_ID } from "neutron-compiler/src/assemble.js";
import {
  trustedInstallationContextFromRootKey,
} from "neutron-compiler/src/installation_context.js";
import {
  assertPreparedDeploymentTarget,
  prepareDeployment,
  type PreparedDeployment,
} from "neutron-provision/src/artifact.js";
import {
  compilerSourceFingerprint,
} from "neutron-provision/src/compiler_fingerprint.js";
import {
  createDirectPocketIcKernelActor,
  initializePublicationEntropy,
} from "neutron-provision/src/kernel.js";
import {
  CERTIFIED_ASSETS_QUALIFICATION_CASES,
  CERTIFIED_ASSETS_QUALIFICATION_CONTRACT,
  CERTIFIED_ASSETS_QUALIFICATION_CONTRACT_SHA256,
  type CertifiedAssetsMetricName,
  type CertifiedAssetsQualificationCaseId,
} from "neutron-tools/src/certified_assets_qualification.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import {
  bindCertifiedAssetsQualificationCandidate,
  validateCertifiedAssetsCandidateBindingInput,
  type CertifiedAssetsCandidateBindingInput,
} from "../certified_assets_candidate_binding.ts";
import {
  HOST_BOUND_CERTIFICATION_EXPRESSION,
  PORTABLE_CERTIFICATION_EXPRESSION,
  assertHostileRangeRejected,
  exactBytes,
  exactExpressionPath,
  portableAbsenceHeaders,
  portableHeaders,
  wildcardExpressionPath,
  type CertifiedHttpQueryRequest,
} from "./http_v2.ts";
import {
  CERTIFIED_ASSETS_MULTISCOPE_CASE_IDS,
  executeMultiscopeQualificationCase,
  type CertifiedAssetsMultiscopeCaseId,
  type QualificationScopeRuntime,
} from "./multiscope_cases.ts";
import {
  executeQualificationCase,
  type SingleScopeQualificationCaseId,
} from "./cases.ts";
import {
  QUALIFICATION_INITIAL_TIME_NS,
  launchIsolatedQualificationPocketIc,
  type IsolatedQualificationPocketIc,
  type QualificationWallClockNormalization,
} from "./environment.ts";
import {
  assertQualificationFixtureSetAdmission,
} from "./fixture_admission.ts";
import {
  buildQualificationFixtureArchives,
  buildQualificationKernelArchive,
} from "./fixture_package.ts";
import {
  CERTIFIED_ASSETS_QUALIFICATION_FIXTURES,
  type CertifiedAssetsQualificationFixtureId,
} from "./fixture_manifests.ts";
import {
  CERTIFIED_ASSETS_RECEIPT_RECONCILE_NS,
  CERTIFIED_ASSETS_MAINTENANCE_RECEIPTS_PER_PAGE,
  PHYSICAL_ABSENCE_WITNESS_CANDIDATES,
  PHYSICAL_POPULATION_APP_ID,
  PHYSICAL_POPULATION_BATCHES,
  PHYSICAL_POPULATION_COLLECTION_ID,
  PHYSICAL_POPULATION_ENTRIES,
  PHYSICAL_POPULATION_FINAL_USAGE,
  PHYSICAL_POPULATION_INITIAL_USAGE,
  PHYSICAL_POPULATION_MOUNT_ID,
  PHYSICAL_POPULATION_OVERFLOW_EXPECTATION,
  PHYSICAL_PRESENT_WITNESS_CANDIDATES,
  assertPhysicalWitnessCandidateDerivation,
  physicalPopulationBatches,
  physicalPopulationOverflowInput,
  physicalReceiptReclaimedChargedBytes,
  physicalPopulationReceiptRollovers,
  type PhysicalPopulationPut,
  type PhysicalPopulationUsageExpectation,
} from "./physical_population.ts";
import {
  CERTIFIED_ASSETS_HOSTILE_HTTP_GATE_SCHEMA,
  CERTIFIED_ASSETS_BOUNDED_PHYSICAL_OBSERVATION_SCHEMA,
  CERTIFIED_ASSETS_QUALIFICATION_GATES_SCHEMA,
  CERTIFIED_ASSETS_QUALIFICATION_RECEIPT_SCHEMA,
  CERTIFIED_ASSETS_QUALIFICATION_SAMPLE_SCHEMA,
  CERTIFIED_ASSETS_RAW_CANDID_OBSERVATION_SCHEMA,
  CERTIFIED_ASSETS_UPGRADE_GATE_SCHEMA,
  assertCertifiedAssetsQualificationReceipt,
  certifiedAssetsQualificationRunnerSourceSha256,
  qualificationPhysicalBatchTranscriptSha256,
  qualificationReceiptBytes,
  qualificationReceiptSha256,
  type CertifiedAssetsQualificationReceipt,
  type CertifiedHttpObservation,
  type HostileRawHttpGateObservation,
  type BoundedPhysicalObservation,
  type PhysicalMaintenancePageObservation,
  type PhysicalReceiptRolloverObservation,
  type PhysicalUsageSummary,
  type QualificationSample,
  type RawCandidObservation,
  type SameWasmUpgradeGateObservation,
} from "./receipt.ts";
import {
  runFocusedMotokoGates,
  runPhysicalOneOverManifestGate,
} from "./release_gates.ts";
import {
  createQualificationSampleRuntime,
  type QualificationSampleRuntime,
  type QualificationUsageDiagnosticsSnapshot,
} from "./sample_runtime.ts";
import {
  verifyPortableCorsInChromium,
  type CertifiedAssetsBrowserCorsEvidence,
} from "./browser_cors.ts";
import { formatQualificationFailure } from "./failure.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../../../..");
const RECEIPT_PATH = path.join(
  REPOSITORY_ROOT,
  "apps/kernel/certified-assets-qualification-receipt.json",
);
const BEHAVIOR_APP_ID = "ca_qualification_aux_1" as const;

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length !== 1 || args[0] !== "--release") {
    throw new Error(
      "Usage: bun apps/kernel/evidence/qualification/run.ts --release",
    );
  }
  await executeReleaseQualification();
}

async function executeReleaseQualification(): Promise<void> {
  const checkedBinding = await readCheckedBinding();
  assertQualificationFixtureSetAdmission();
  assertPhysicalWitnessCandidateDerivation();
  const focusedMotoko = await runFocusedMotokoGates(REPOSITORY_ROOT);
  const physicalOneOver =
    await runPhysicalOneOverManifestGate(REPOSITORY_ROOT);

  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "neutron-ca-release-"),
  );
  let environment: IsolatedQualificationPocketIc | undefined;
  let receiptToPublish: CertifiedAssetsQualificationReceipt | undefined;
  let qualificationFailure: Readonly<{ error: unknown }> | undefined;
  try {
    environment = await launchIsolatedQualificationPocketIc({
      repositoryRoot: REPOSITORY_ROOT,
    });
    const replicaTimeStart = await environment.readReplicaTimeNs();
    if (replicaTimeStart !== QUALIFICATION_INITIAL_TIME_NS.toString()) {
      throw new Error(
        `Qualification replica time must start at ${QUALIFICATION_INITIAL_TIME_NS}ns, found ${replicaTimeStart}ns`,
      );
    }
    const deployment = await debugBuildQualificationDeployment(
      temporaryRoot,
      environment.rootKeyBase64,
    );
    const compilerFingerprint =
      await compilerSourceFingerprint(REPOSITORY_ROOT);
    const candidate = bindCertifiedAssetsQualificationCandidate({
      binding_input: checkedBinding,
      qualified_raw_wasm: deployment.compiled.wasm,
      qualified_transport_wasm: deployment.transportWasm,
      compiler_source_fingerprint_sha256: compilerFingerprint,
      compiler_id: deployment.compiled.compilerId,
      assembler_id: ASSEMBLER_ID,
      repository_root: REPOSITORY_ROOT,
    });

    const {
      boundedPhysicalSample,
      wallNormalization,
    } = await runBoundedPhysicalSample({
      environment,
      deployment,
    });
    const { samples, browserCors } = await debugRunOperationalSamples({
      environment,
      deployment,
    });
    const { upgrade, hostile } = await runUpgradeAndHostileGates({
      environment,
      deployment,
    });
    const gatewayPhaseEnd = await environment.readReplicaTimeNs();
    const replicaTimeEnd = await environment.readReplicaTimeNs();

    const unsigned: Omit<
      CertifiedAssetsQualificationReceipt,
      "receipt_sha256"
    > = {
      schema: CERTIFIED_ASSETS_QUALIFICATION_RECEIPT_SCHEMA,
      status: "passed",
      candidate,
      environment: {
        profile: "minimal",
        isolation: "fresh_temporary_pocketic_v1",
        pocketic_version: environment.serverVersion,
        pocketic_binary_sha256: environment.binarySha256,
        instance_config_sha256: environment.instanceConfigSha256,
        topology_sha256: sha256Canonical(environment.topologySummary),
        root_key_sha256: sha256Bytes(
          canonicalBase64(environment.rootKeyBase64),
        ),
        replica_time_start_ns: replicaTimeStart,
        replica_time_end_ns: replicaTimeEnd,
        timeline: {
          historical_auto_progress: false,
          wall_normalization: {
            before_ns: wallNormalization.beforeNs,
            target_host_wall_ns:
              wallNormalization.targetHostWallNs,
            after_ns: wallNormalization.afterNs,
            auto_progress_before:
              wallNormalization.autoProgressBefore,
            auto_progress_after:
              wallNormalization.autoProgressAfter,
          },
          gateway_phase: {
            start_ns: wallNormalization.afterNs,
            end_ns: gatewayPhaseEnd,
          },
        },
      },
      runner: {
        contract_sha256: CERTIFIED_ASSETS_QUALIFICATION_CONTRACT_SHA256,
        source_sha256:
          certifiedAssetsQualificationRunnerSourceSha256(),
      },
      samples,
      bounded_physical_sample: boundedPhysicalSample,
      gates: {
        schema: CERTIFIED_ASSETS_QUALIFICATION_GATES_SCHEMA,
        focused_motoko: focusedMotoko,
        same_wasm_upgrade: upgrade,
        hostile_raw_http: hostile,
        physical_one_over: physicalOneOver,
        browser_cors: browserCors,
      },
    };
    const receipt: CertifiedAssetsQualificationReceipt = {
      ...unsigned,
      receipt_sha256: qualificationReceiptSha256(unsigned),
    };
    await assertCertifiedAssetsQualificationReceipt(receipt);
    receiptToPublish = receipt;
  } catch (error) {
    qualificationFailure = { error };
  } finally {
    const cleanupFailures: unknown[] = [];
    if (environment !== undefined) {
      try {
        await environment.stop();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (qualificationFailure !== undefined) {
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [qualificationFailure.error, ...cleanupFailures],
          "Certified Assets qualification and cleanup failed",
        );
      }
      throw qualificationFailure.error;
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        cleanupFailures,
        "Certified Assets qualification cleanup failed",
      );
    }
  }
  if (receiptToPublish === undefined) {
    throw new Error(
      "Certified Assets qualification completed without a receipt",
    );
  }
  // Close the source/check race across environment cleanup. This revalidates
  // the complete candidate and runner closure immediately before publication.
  await writeReceiptAtomically(
    await qualificationReceiptBytes(receiptToPublish),
  );
}

// The source-owned execution helpers below deliberately expose no driver,
// evidence-import, root-key, gateway, or repository override.

type InstalledQualificationCanister = Readonly<{
  canisterId: string;
  installedTransportWasmSha256: string;
}>;

type BracketedRuntime = Readonly<{
  appId: CertifiedAssetsQualificationFixtureId;
  runtime: QualificationSampleRuntime;
  before: QualificationUsageDiagnosticsSnapshot;
  after: QualificationUsageDiagnosticsSnapshot;
}>;

type QualificationRunnerScope = Readonly<{
  appId: CertifiedAssetsQualificationFixtureId;
  runtime: QualificationSampleRuntime;
}>;

async function readCheckedBinding():
  Promise<CertifiedAssetsCandidateBindingInput> {
  const bindingPath = path.join(
    REPOSITORY_ROOT,
    "apps/kernel/certified-assets-candidate-binding.json",
  );
  const value = JSON.parse(await readFile(bindingPath, "utf8")) as unknown;
  validateCertifiedAssetsCandidateBindingInput(value, REPOSITORY_ROOT);
  return value;
}

export async function debugBuildQualificationDeployment(
  temporaryRoot: string,
  rootKeyBase64: string,
): Promise<PreparedDeployment> {
  const [kernelArchive, fixtureArchives] = await Promise.all([
    buildQualificationKernelArchive({
      repositoryRoot: REPOSITORY_ROOT,
      temporaryRoot,
    }),
    buildQualificationFixtureArchives({
      repositoryRoot: REPOSITORY_ROOT,
      temporaryRoot,
    }),
  ]);
  const installationContext = trustedInstallationContextFromRootKey(
    canonicalBase64(rootKeyBase64),
  );
  const deployment = await prepareDeployment(
    [
      kernelArchive,
      ...fixtureArchives.map(({ archivePath }) => archivePath),
    ],
    {
      target: "local",
      freshInstallationContext: installationContext,
    },
  );
  const actualFixtureOrder = fixtureArchives.map(
    ({ fixture }) => fixture.app_id,
  );
  const expectedFixtureOrder = CERTIFIED_ASSETS_QUALIFICATION_FIXTURES.map(
    ({ app_id: appId }) => appId,
  );
  if (
    actualFixtureOrder.length !== expectedFixtureOrder.length ||
    actualFixtureOrder.some(
      (appId, index) => appId !== expectedFixtureOrder[index],
    )
  ) {
    throw new Error(
      "Qualification fixture packages are not in candidate-bound order",
    );
  }
  return deployment;
}

async function installFreshQualificationCanister(input: {
  environment: IsolatedQualificationPocketIc;
  deployment: PreparedDeployment;
}): Promise<InstalledQualificationCanister> {
  const canisterId = await input.environment.createCanister();
  await input.environment.ensureQualificationSelfController(canisterId);
  assertPreparedDeploymentTarget(input.deployment, canisterId);
  const installation = await input.environment.installTransportWasm(
    canisterId,
    input.deployment,
  );
  const actor = createDirectPocketIcKernelActor({
    controlUrl: input.environment.controlUrl,
    instanceId: input.environment.instanceId,
    canisterId,
    caller: Principal.fromText(input.environment.controllerPrincipal),
  });
  await input.environment.authorizeQualificationController(canisterId);
  await initializePublicationEntropy(actor);
  await input.environment.verifyQualificationController(canisterId);
  const runtime = await actor.kernel_runtime_info();
  assertRuntimeCandidate(runtime, input.deployment);
  assertQualificationFixtureScopes(
    runtime.apps,
    input.deployment,
  );
  return {
    canisterId,
    installedTransportWasmSha256:
      installation.installedTransportWasmSha256,
  };
}

function assertQualificationFixtureScopes(
  apps: readonly Readonly<{
    scope: { app_id: string };
    version: bigint | number;
    deployment_id: string;
    capability_plan_fingerprint: string;
  }>[],
  deployment: PreparedDeployment,
): void {
  const expectedApps = deployment.packages
    .map(({ manifest, capabilityPlanFingerprint }) => ({
      app_id: manifest.id,
      version: manifest.version,
      capability_plan_fingerprint: capabilityPlanFingerprint,
    }))
    .sort((left, right) =>
      compareCanonicalText(left.app_id, right.app_id)
    );
  if (
    apps.length !== expectedApps.length ||
    expectedApps.length !==
      CERTIFIED_ASSETS_QUALIFICATION_FIXTURES.length + 1
  ) {
    throw new Error(
      "Fresh qualification canister contains an unexpected app scope",
    );
  }
  const installedFixtures = new Map<string, number>();
  for (const [index, app] of apps.entries()) {
    const expected = expectedApps[index]!;
    if (
      app.scope.app_id !== expected.app_id ||
      BigInt(app.version) !== BigInt(expected.version) ||
      app.capability_plan_fingerprint !==
        expected.capability_plan_fingerprint ||
      app.deployment_id !== deployment.compiled.deploymentId
    ) {
      throw new Error(
        `Fresh qualification app scope ${index} is not in candidate-bound order`,
      );
    }
    installedFixtures.set(
      app.scope.app_id,
      (installedFixtures.get(app.scope.app_id) ?? 0) + 1,
    );
  }
  if (installedFixtures.get("kernel") !== 1) {
    throw new Error(
      "Fresh qualification canister does not contain exactly one Kernel scope",
    );
  }
  for (const fixture of CERTIFIED_ASSETS_QUALIFICATION_FIXTURES) {
    if (installedFixtures.get(fixture.app_id) !== 1) {
      throw new Error(
        `Fresh qualification canister does not contain exactly one ${fixture.app_id} scope`,
      );
    }
  }
}

function assertRuntimeCandidate(
  runtime: Readonly<{
    deployment_id: string;
    assembler_id: string;
    compiler_id: string;
  }>,
  deployment: PreparedDeployment,
): void {
  if (
    runtime.deployment_id !== deployment.compiled.deploymentId ||
    runtime.compiler_id !== deployment.compiled.compilerId ||
    runtime.assembler_id !== ASSEMBLER_ID
  ) {
    throw new Error(
      "Installed qualification runtime does not bind the compiled deployment, compiler, and assembler",
    );
  }
}

export async function debugRunOperationalSamples(input: {
  environment: IsolatedQualificationPocketIc;
  deployment: PreparedDeployment;
}): Promise<{
  samples: QualificationSample[];
  browserCors: CertifiedAssetsBrowserCorsEvidence;
}> {
  const samples: QualificationSample[] = [];
  let browserSource: CertifiedHttpObservation | undefined;
  for (const definition of CERTIFIED_ASSETS_QUALIFICATION_CASES) {
    for (
      let sampleIndex = 0;
      sampleIndex <
        CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.minimum_samples_per_case;
      sampleIndex += 1
    ) {
      const installed = await installFreshQualificationCanister(input);
      const verifyGateway =
        definition.id === "publication_lifecycle" ||
        definition.metrics.some(
          (metric) => metric === "proof_bytes",
        );
      const runtimes = qualificationCaseRuntimes({
        environment: input.environment,
        canisterId: installed.canisterId,
        caseId: definition.id,
        sample: sampleIndex,
        verifyGateway,
      });
      const before = await Promise.all(
        runtimes.map(({ runtime }) =>
          runtime.snapshotUsageAndDiagnostics()
        ),
      );
      const checkpoints = isMultiscopeCase(definition.id)
        ? await executeMultiscopeQualificationCase(
            runtimes,
            definition.id,
          )
        : await executeQualificationCase(
            runtimes[0]!.runtime,
            definition.id,
            BEHAVIOR_APP_ID,
          );
      const after = await Promise.all(
        runtimes.map(({ runtime }) =>
          runtime.snapshotUsageAndDiagnostics()
        ),
      );
      const bracketed = runtimes.map(
        ({ appId, runtime }, index): BracketedRuntime => ({
          appId,
          runtime,
          before: before[index]!,
          after: after[index]!,
        }),
      );
      const candid = bracketed.flatMap(
        ({ runtime }) => runtime.observations.candid,
      );
      const http = bracketed.flatMap(
        ({ runtime }) => runtime.observations.http,
      );
      const sample: QualificationSample = {
        schema: CERTIFIED_ASSETS_QUALIFICATION_SAMPLE_SCHEMA,
        case_id: definition.id,
        sample: sampleIndex,
        canister_id: installed.canisterId,
        installed_transport_wasm_sha256:
          installed.installedTransportWasmSha256,
        checkpoints,
        metrics: qualificationMetrics(
          definition.metrics,
          bracketed,
          candid,
          http,
        ),
        candid,
        http,
      };
      samples.push(sample);
      if (
        definition.id === "portable_certified_reads" &&
        sampleIndex === 0
      ) {
        const matching = http.filter(
          (observation) =>
            observation.boundary === "raw_query" &&
            observation.method === "GET" &&
            observation.status === 200,
        );
        if (matching.length !== 1) {
          throw new Error(
            "Portable sample zero did not produce exactly one raw certified 200 GET",
          );
        }
        browserSource = matching[0]!;
      }
    }
  }
  if (browserSource === undefined) {
    throw new Error(
      "Qualification did not retain portable sample zero for the browser gate",
    );
  }
  const responseHeaders = new Map(browserSource.response_headers);
  const browserCors = await verifyPortableCorsInChromium({
    url: browserSource.url,
    status: 200,
    body_bytes: browserSource.body.bytes,
    body_sha256: browserSource.body.sha256,
    content_digest: requiredMapValue(
      responseHeaders,
      "content-digest",
      "portable sample zero",
    ),
    etag: requiredMapValue(
      responseHeaders,
      "etag",
      "portable sample zero",
    ),
    certificate_expression: requiredMapValue(
      responseHeaders,
      "ic-certificateexpression",
      "portable sample zero",
    ),
  });
  return { samples, browserCors };
}

function qualificationCaseRuntimes(input: {
  environment: IsolatedQualificationPocketIc;
  canisterId: string;
  caseId: CertifiedAssetsQualificationCaseId;
  sample: number;
  verifyGateway: boolean;
}): QualificationRunnerScope[] {
  const appIds = isMultiscopeCase(input.caseId)
    ? CERTIFIED_ASSETS_QUALIFICATION_FIXTURES.map(
        ({ app_id: appId }) => appId,
      )
    : [BEHAVIOR_APP_ID];
  return appIds.map((appId) => ({
    appId,
    runtime: createQualificationSampleRuntime({
      ...input,
      appId,
    }),
  }));
}

function isMultiscopeCase(
  caseId: CertifiedAssetsQualificationCaseId,
): caseId is CertifiedAssetsMultiscopeCaseId {
  return (
    CERTIFIED_ASSETS_MULTISCOPE_CASE_IDS as readonly string[]
  ).includes(caseId);
}

function qualificationMetrics(
  names: readonly CertifiedAssetsMetricName[],
  bracketed: readonly BracketedRuntime[],
  candid: readonly RawCandidObservation[],
  http: readonly CertifiedHttpObservation[],
): Readonly<Partial<Record<CertifiedAssetsMetricName, string>>> {
  const metrics: Partial<Record<CertifiedAssetsMetricName, string>> = {};
  for (const name of names) {
    switch (name) {
      case "request_candid_bytes":
        metrics[name] = maximumExactBytes(
          candid.map(({ request }) => request.bytes),
          name,
        ).toString();
        break;
      case "reply_candid_bytes":
        metrics[name] = maximumExactBytes(
          candid.map(({ reply }) => reply.bytes),
          name,
        ).toString();
        break;
      case "proof_bytes":
        metrics[name] = maximumExactBytes(
          http.map(
            ({ certificate, witness, expression_path: expressionPath }) =>
              certificate.bytes + witness.bytes + expressionPath.bytes,
          ),
          name,
        ).toString();
        break;
      case "low_side_cycle_estimate":
        metrics[name] = lowSideCycleEstimate(bracketed).toString();
        break;
      case "allocator_high_water_growth_bytes":
        metrics[name] = allocatorHighWaterGrowth(bracketed).toString();
        break;
      default: {
        const unreachable: never = name;
        throw new Error(`Unknown qualification metric ${unreachable}`);
      }
    }
  }
  return metrics;
}

function maximumExactBytes(
  values: readonly number[],
  label: string,
): number {
  if (values.length === 0) {
    throw new Error(`Qualification metric ${label} has no observation`);
  }
  const maximum = Math.max(...values);
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new Error(`Qualification metric ${label} is not a safe byte count`);
  }
  return maximum;
}

export function lowSideCycleEstimate(
  bracketed: readonly BracketedRuntime[],
): bigint {
  assertBracketedRuntimeSet(bracketed);
  let maximum = 0n;
  let meteredUpdateCount = 0;
  for (const bracket of bracketed) {
    const observedUpdates = bracket.runtime.observations.candid.filter(
      ({ mode }) => mode === "update",
    );
    const meteredUpdates = bracket.runtime.updateUsageBrackets;
    meteredUpdateCount += meteredUpdates.length;
    if (meteredUpdates.length !== observedUpdates.length) {
      throw new Error(
        `Qualification per-update metering for ${bracket.appId} recorded ${meteredUpdates.length} brackets for ${observedUpdates.length} observed updates`,
      );
    }
    const outer = appUsageDelta(
      bracket.before.kernel_app_usage,
      bracket.after.kernel_app_usage,
      bracket.appId,
      `${bracket.appId} case bracket`,
    );
    if (
      outer.executions !== BigInt(observedUpdates.length) ||
      (observedUpdates.length > 0 && outer.instructions === 0n)
    ) {
      throw new Error(
        `Qualification metering for ${bracket.appId} does not match its ${observedUpdates.length} observed updates`,
      );
    }

    const summed: AppUsageDelta = {
      instructions: 0n,
      executions: 0n,
      outgoingCycles: 0n,
    };
    for (const [index, metered] of meteredUpdates.entries()) {
      const observed = observedUpdates[index]!;
      if (metered.method !== observed.method) {
        throw new Error(
          `Qualification per-update metering for ${bracket.appId} method ${metered.method} does not match observed update ${observed.method} at index ${index}`,
        );
      }
      const delta = appUsageDelta(
        metered.before,
        metered.after,
        bracket.appId,
        `${bracket.appId} update ${index} (${metered.method})`,
      );
      if (delta.executions !== 1n || delta.instructions === 0n) {
        throw new Error(
          `Qualification per-update metering for ${bracket.appId} update ${index} does not contain exactly one positive-instruction execution`,
        );
      }
      summed.instructions += delta.instructions;
      summed.executions += delta.executions;
      summed.outgoingCycles += delta.outgoingCycles;
      const estimate = lowSideCycles(delta);
      if (estimate > maximum) maximum = estimate;
    }

    if (
      summed.instructions !== outer.instructions ||
      summed.executions !== outer.executions ||
      summed.outgoingCycles !== outer.outgoingCycles
    ) {
      throw new Error(
        `Qualification per-update metering for ${bracket.appId} does not reconcile with its outer case bracket`,
      );
    }
  }
  if (meteredUpdateCount === 0) {
    throw new Error(
      "Qualification low-side cycle metric has no metered update",
    );
  }
  return maximum;
}

type AppUsageDelta = {
  instructions: bigint;
  executions: bigint;
  outgoingCycles: bigint;
};

function appUsageDelta(
  beforeValue: unknown,
  afterValue: unknown,
  appId: CertifiedAssetsQualificationFixtureId,
  label: string,
): AppUsageDelta {
  const before = appUsageFor(beforeValue, appId, `${label} before`);
  const after = appUsageFor(afterValue, appId, `${label} after`);
  if (before === null && after === null) {
    return { instructions: 0n, executions: 0n, outgoingCycles: 0n };
  }
  if (after === null) {
    throw new Error(
      `Qualification app usage row disappeared inside ${label}`,
    );
  }
  if (
    before !== null &&
    before.installationUid !== after.installationUid
  ) {
    throw new Error(
      `Qualification app usage changed installation UID inside ${label}`,
    );
  }
  return {
    instructions: nonnegativeDelta(
      before?.instructions ?? 0n,
      after.instructions,
      `${label} lifetime instructions`,
    ),
    executions: nonnegativeDelta(
      before?.executions ?? 0n,
      after.executions,
      `${label} lifetime executions`,
    ),
    outgoingCycles: nonnegativeDelta(
      before?.outgoingCycles ?? 0n,
      after.outgoingCycles,
      `${label} lifetime outgoing cycles`,
    ),
  };
}

function lowSideCycles(delta: AppUsageDelta): bigint {
  return (
    delta.instructions +
    5_000_000n * delta.executions +
    delta.outgoingCycles
  );
}

function allocatorHighWaterGrowth(
  bracketed: readonly BracketedRuntime[],
): bigint {
  assertBracketedRuntimeSet(bracketed);
  const before = bracketed.map(({ before, appId }) =>
    allocatorHighWater(
      before.kernel_diagnostics,
      `before ${appId}`,
    )
  );
  const after = bracketed.map(({ after, appId }) =>
    allocatorHighWater(
      after.kernel_diagnostics,
      `after ${appId}`,
    )
  );
  const lower = before.reduce(
    (minimum, value) => value < minimum ? value : minimum,
  );
  const upper = after.reduce(
    (maximum, value) => value > maximum ? value : maximum,
  );
  return nonnegativeDelta(
    lower,
    upper,
    "Certified Assets allocator committed high-water mark",
  );
}

function appUsageFor(
  value: unknown,
  appId: CertifiedAssetsQualificationFixtureId,
  label: string,
): {
  installationUid: bigint;
  instructions: bigint;
  executions: bigint;
  outgoingCycles: bigint;
} | null {
  const root = unknownRecord(value, `${label} app usage`);
  if (
    unknownNat(
      root.snapshot_version,
      `${label} app usage.snapshot_version`,
    ) !== 2n
  ) {
    throw new Error(`${label} app usage snapshot version is not 2`);
  }
  const apps = unknownArray(root.apps, `${label} app usage.apps`);
  const matches = apps.filter(
    (entry) =>
      unknownRecord(entry, `${label} app usage entry`).app_id === appId,
  );
  if (matches.length > 1) {
    throw new Error(
      `${label} app usage repeats ${appId}`,
    );
  }
  if (matches.length === 0) return null;
  const entry = unknownRecord(matches[0], `${label} ${appId} app usage`);
  const installationUid = unknownNat(
    entry.installation_uid,
    `${label} ${appId}.installation_uid`,
  );
  if (installationUid === 0n) {
    throw new Error(`${label} ${appId}.installation_uid must be positive`);
  }
  return {
    installationUid,
    instructions: unknownNat(
      entry.lifetime_instructions,
      `${label} ${appId}.lifetime_instructions`,
    ),
    executions: unknownNat(
      entry.lifetime_executions,
      `${label} ${appId}.lifetime_executions`,
    ),
    outgoingCycles: unknownNat(
      entry.lifetime_outgoing_cycles,
      `${label} ${appId}.lifetime_outgoing_cycles`,
    ),
  };
}

function allocatorHighWater(value: unknown, label: string): bigint {
  const diagnostics = unknownRecord(
    value,
    `${label} allocator diagnostics`,
  );
  const allocator = unknownRecord(
    diagnostics.allocator,
    `${label} allocator diagnostics.allocator`,
  );
  if (allocator.header_valid !== true) {
    throw new Error(`${label} allocator header is not valid`);
  }
  const forest = unknownRecord(
    diagnostics.authenticated_forest,
    `${label} authenticated forest`,
  );
  if (forest.healthy !== true || forest.dirty !== false) {
    throw new Error(`${label} authenticated forest is not settled and healthy`);
  }
  return unknownNat(
    allocator.committed_high_water_bytes,
    `${label} allocator committed_high_water_bytes`,
  );
}

function assertBracketedRuntimeSet(
  bracketed: readonly BracketedRuntime[],
): void {
  if (bracketed.length === 0) {
    throw new Error("Qualification metric has no runtime bracket");
  }
  const appIds = bracketed.map(({ appId }) => appId);
  if (new Set(appIds).size !== appIds.length) {
    throw new Error("Qualification metric repeats an app scope");
  }
  const canisterIds = new Set(
    bracketed.map(({ runtime }) => runtime.canisterId),
  );
  if (canisterIds.size !== 1) {
    throw new Error(
      "Qualification metric combines more than one canister",
    );
  }
}

function nonnegativeDelta(
  before: bigint,
  after: bigint,
  label: string,
): bigint {
  if (after < before) {
    throw new Error(`${label} decreased inside a qualification bracket`);
  }
  return after - before;
}

async function runBoundedPhysicalSample(input: {
  environment: IsolatedQualificationPocketIc;
  deployment: PreparedDeployment;
}): Promise<Readonly<{
  boundedPhysicalSample: BoundedPhysicalObservation;
  wallNormalization: QualificationWallClockNormalization;
}>> {
  const installed = await installFreshQualificationCanister(input);
  await probeAndResetPhysicalCanister(input, installed);
  const runtime = createQualificationSampleRuntime({
    environment: input.environment,
    canisterId: installed.canisterId,
    appId: PHYSICAL_POPULATION_APP_ID,
    caseId: "logical_quota_rejection",
    sample: 0,
    verifyGateway: true,
  });
  const generation = await runtime.generation(
    PHYSICAL_POPULATION_COLLECTION_ID,
  );
  if (generation <= 0n) {
    throw new Error(
      "Physical qualification collection generation is not positive",
    );
  }
  const populationClockStartNs =
    await input.environment.readReplicaTimeNs();

  const initial = await capturedRuntimeCall(
    runtime,
    "qualification_usage",
    [null],
  );
  decodePhysicalUsage(
    initial.value,
    PHYSICAL_POPULATION_INITIAL_USAGE,
    "initial physical usage",
  );

  const expectedRollovers = physicalPopulationReceiptRollovers();
  const receiptRollovers: PhysicalReceiptRolloverObservation[] = [];
  for (const batch of physicalPopulationBatches(generation)) {
    const result = await runtime.call(
      "qualification_commit_batch",
      [batch.input],
    );
    assertPhysicalBatchCommitted(
      result,
      batch.input.operations,
      `physical population batch ${batch.batch_index}`,
    );
    const afterBatchCount = batch.batch_index + 1;
    const expectedRollover = expectedRollovers.find(
      (rollover) => rollover.after_batch_count === afterBatchCount,
    );
    if (expectedRollover !== undefined) {
      const usageBefore = await capturedRuntimeCall(
        runtime,
        "qualification_usage",
        [null],
      );
      const usageBeforeDecoded = decodePhysicalUsage(
        usageBefore.value,
        expectedRollover.usage_before,
        `physical receipt rollover ${afterBatchCount} usage before`,
      );
      const advance = await input.environment.advanceTimeAndTick(
        expectedRollover.advance_time_ns,
      );
      if (
        advance.requestedDeltaNs !==
          expectedRollover.advance_time_ns.toString() ||
        BigInt(advance.afterNs) !==
          BigInt(advance.beforeNs) + expectedRollover.advance_time_ns
      ) {
        throw new Error(
          `Physical receipt rollover ${afterBatchCount} did not advance the exact expiry interval`,
        );
      }
      const maintenancePages: PhysicalMaintenancePageObservation[] = [];
      let reclaimedReceipts = 0n;
      for (
        let pageIndex = 0;
        pageIndex < expectedRollover.expected_maintenance_pages;
        pageIndex += 1
      ) {
        const captured = await capturedRuntimeCall(
          runtime,
          "qualification_maintenance_page",
          [null],
        );
        const decoded = decodePhysicalMaintenancePage(
          captured.value,
          pageIndex,
          expectedRollover.expected_maintenance_pages,
          expectedRollover.expected_receipts_reclaimed,
          `physical receipt rollover ${afterBatchCount} page ${pageIndex}`,
        );
        reclaimedReceipts += BigInt(decoded.reclaimed.receipts);
        maintenancePages.push({
          page_index: pageIndex,
          call: captured.observation,
          ...decoded,
        });
      }
      if (
        reclaimedReceipts !==
          BigInt(expectedRollover.expected_receipts_reclaimed)
      ) {
        throw new Error(
          `Physical receipt rollover ${afterBatchCount} reclaimed the wrong receipt total`,
        );
      }
      const usageAfter = await capturedRuntimeCall(
        runtime,
        "qualification_usage",
        [null],
      );
      const usageAfterDecoded = decodePhysicalUsage(
        usageAfter.value,
        expectedRollover.usage_after,
        `physical receipt rollover ${afterBatchCount} usage after`,
      );
      receiptRollovers.push({
        after_batch_count: afterBatchCount,
        clock: {
          before_ns: advance.beforeNs,
          requested_delta_ns: advance.requestedDeltaNs,
          after_ns: advance.afterNs,
        },
        usage_before: usageBefore.observation,
        usage_before_decoded: usageBeforeDecoded,
        maintenance_pages: maintenancePages,
        usage_after: usageAfter.observation,
        usage_after_decoded: usageAfterDecoded,
        reclaimed_receipts_total: reclaimedReceipts.toString(),
        checkpoint: "general_receipt_ceiling_reclaimed",
      });
    }
  }
  if (receiptRollovers.length !== expectedRollovers.length) {
    throw new Error(
      "Physical population did not execute every fixed receipt rollover",
    );
  }

  const usageBeforeOverflow = await capturedRuntimeCall(
    runtime,
    "qualification_usage",
    [null],
  );
  const usageBeforeOverflowDecoded = decodePhysicalUsage(
    usageBeforeOverflow.value,
    PHYSICAL_POPULATION_FINAL_USAGE,
    "physical usage before overflow",
  );
  if (
    PHYSICAL_POPULATION_OVERFLOW_EXPECTATION.attempted_entries !==
      BigInt(PHYSICAL_POPULATION_ENTRIES + 1) ||
    PHYSICAL_POPULATION_OVERFLOW_EXPECTATION.isolated_resource !==
      "entries"
  ) {
    throw new Error(
      "Physical overflow workload does not isolate the entry ceiling",
    );
  }
  const overflowInput = physicalPopulationOverflowInput(generation);
  const overflowTarget = overflowInput.operations[0]!.put.target;
  const recordBeforeOverflow = await capturedRuntimeCall(
    runtime,
    "qualification_record_status",
    [overflowTarget],
  );
  expectAbsentRecordStatus(
    recordBeforeOverflow.value,
    "physical overflow target before",
  );
  const diagnosticsBeforeOverflow = await capturedRuntimeCall(
    runtime,
    "kernel_diagnostics",
    [null],
  );
  const overflow = await capturedRuntimeCall(
    runtime,
    "qualification_commit_batch",
    [overflowInput],
  );
  expectDomainError(
    overflow.value,
    PHYSICAL_POPULATION_OVERFLOW_EXPECTATION.expected_error,
    "physical one-over commit",
  );
  const recordAfterOverflow = await capturedRuntimeCall(
    runtime,
    "qualification_record_status",
    [overflowTarget],
  );
  expectAbsentRecordStatus(
    recordAfterOverflow.value,
    "physical overflow target after",
  );
  const diagnosticsAfterOverflow = await capturedRuntimeCall(
    runtime,
    "kernel_diagnostics",
    [null],
  );
  const usageAfterOverflow = await capturedRuntimeCall(
    runtime,
    "qualification_usage",
    [null],
  );
  const usageAfterOverflowDecoded = decodePhysicalUsage(
    usageAfterOverflow.value,
    PHYSICAL_POPULATION_FINAL_USAGE,
    "physical usage after overflow",
  );
  if (
    usageBeforeOverflow.observation.request.bytes !==
      usageAfterOverflow.observation.request.bytes ||
    usageBeforeOverflow.observation.request.sha256 !==
      usageAfterOverflow.observation.request.sha256 ||
    usageBeforeOverflow.observation.reply.bytes !==
      usageAfterOverflow.observation.reply.bytes ||
    usageBeforeOverflow.observation.reply.sha256 !==
      usageAfterOverflow.observation.reply.sha256
  ) {
    throw new Error(
      "Physical one-over rejection changed the exact usage reply",
    );
  }
  if (
    !isDeepStrictEqual(
      recordBeforeOverflow.value,
      recordAfterOverflow.value,
    ) ||
    !isDeepStrictEqual(
      diagnosticsBeforeOverflow.value,
      diagnosticsAfterOverflow.value,
    ) ||
    recordBeforeOverflow.observation.request.sha256 !==
      recordAfterOverflow.observation.request.sha256 ||
    recordBeforeOverflow.observation.reply.sha256 !==
      recordAfterOverflow.observation.reply.sha256 ||
    diagnosticsBeforeOverflow.observation.request.sha256 !==
      diagnosticsAfterOverflow.observation.request.sha256 ||
    diagnosticsBeforeOverflow.observation.reply.sha256 !==
      diagnosticsAfterOverflow.observation.reply.sha256
  ) {
    throw new Error(
      "Physical one-over rejection changed record or authenticated allocator state",
    );
  }

  const wallNormalization =
    await input.environment.normalizeToWallAndStartAutoProgress();

  const presentCandidateObservations: CertifiedHttpObservation[] = [];
  for (const candidate of PHYSICAL_PRESENT_WITNESS_CANDIDATES) {
    presentCandidateObservations.push(await runtime.verifyHttp({
      canisterId: installed.canisterId,
      url: qualificationUrl(runtime, candidate.path),
      method: "GET",
      status: 200,
      authority: "portable",
      expressionPath: exactExpressionPath(candidate.path),
      headers: portableHeaders({
        kind: "mutable_blob",
        body: candidate.body,
      }),
      body: candidate.body,
    }));
  }
  const absenceCandidateObservations: CertifiedHttpObservation[] = [];
  const physicalMountPath =
    `/app/${PHYSICAL_POPULATION_APP_ID}/_route/` +
    PHYSICAL_POPULATION_MOUNT_ID;
  for (const candidate of PHYSICAL_ABSENCE_WITNESS_CANDIDATES) {
    absenceCandidateObservations.push(await runtime.verifyHttp({
      canisterId: installed.canisterId,
      url: qualificationUrl(runtime, candidate.path),
      method: "GET",
      status: 404,
      authority: "portable",
      expressionPath: wildcardExpressionPath(physicalMountPath),
      headers: portableAbsenceHeaders(),
      body: new Uint8Array(),
    }));
  }
  const physicalCandidateObservations = physicalGatewayCoverage(
    runtime.observations.http,
    [
      ...presentCandidateObservations,
      ...absenceCandidateObservations,
    ],
  );
  const presentPairedCandidateObservations =
    physicalCandidateObservations.slice(
      0,
      presentCandidateObservations.length * 2,
    );
  const absencePairedCandidateObservations =
    physicalCandidateObservations.slice(
      presentCandidateObservations.length * 2,
    );
  const present = largestProof(presentCandidateObservations);
  const absence = largestProof(absenceCandidateObservations);

  const commitMethod = physicalAppMethodName(
    PHYSICAL_POPULATION_APP_ID,
    "qualification_commit_batch",
  );
  const commitCalls = runtime.observations.candid.filter(
    ({ method }) => method === commitMethod,
  );
  if (commitCalls.length !== PHYSICAL_POPULATION_BATCHES + 1) {
    throw new Error(
      `Physical population emitted ${commitCalls.length} commit calls, expected ${PHYSICAL_POPULATION_BATCHES + 1}`,
    );
  }
  const populationCalls = commitCalls.slice(
    0,
    PHYSICAL_POPULATION_BATCHES,
  );
  const recordedOverflow = commitCalls.at(-1)!;
  if (
    recordedOverflow.request.sha256 !== overflow.observation.request.sha256 ||
    recordedOverflow.reply.sha256 !== overflow.observation.reply.sha256
  ) {
    throw new Error(
      "Physical overflow observation is not the terminal commit call",
    );
  }

  return {
    wallNormalization,
    boundedPhysicalSample: {
      schema: CERTIFIED_ASSETS_BOUNDED_PHYSICAL_OBSERVATION_SCHEMA,
      canister_id: installed.canisterId,
      installed_transport_wasm_sha256:
        installed.installedTransportWasmSha256,
      batch_count: PHYSICAL_POPULATION_BATCHES,
      batch_transcript_sha256:
        qualificationPhysicalBatchTranscriptSha256(populationCalls),
      final_entry_count: PHYSICAL_POPULATION_ENTRIES,
      population_clock_start_ns: populationClockStartNs,
      receipt_rollovers: receiptRollovers,
      usage_before_overflow: usageBeforeOverflow.observation,
      usage_before_overflow_decoded: usageBeforeOverflowDecoded,
      overflow_call: overflow.observation,
      usage_after_overflow: usageAfterOverflow.observation,
      usage_after_overflow_decoded: usageAfterOverflowDecoded,
      overflow_checkpoint: "entry_quota_rejected_without_state_drift",
      present_candidates_queried:
        presentCandidateObservations.length,
      present_candidate_observations:
        presentPairedCandidateObservations,
      present,
      present_proof_bytes: certifiedProofBytes(present).toString(),
      absence_candidates_queried:
        absenceCandidateObservations.length,
      absence_candidate_observations:
        absencePairedCandidateObservations,
      absence,
      absence_proof_bytes: certifiedProofBytes(absence).toString(),
    },
  };
}

async function probeAndResetPhysicalCanister(
  input: {
    environment: IsolatedQualificationPocketIc;
    deployment: PreparedDeployment;
  },
  installed: InstalledQualificationCanister,
): Promise<void> {
  const probe = createQualificationSampleRuntime({
    environment: input.environment,
    canisterId: installed.canisterId,
    appId: PHYSICAL_POPULATION_APP_ID,
    caseId: "global_stage_admission",
    sample: 0,
    verifyGateway: false,
  });
  const generation = await probe.generation("stage");
  const begun = unknownRecord(
    expectDomainOk(
      await probe.call("qualification_begin_stage", [{
        nonce: probe.deterministicBytes(
          990,
          CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.workload.nonce_bytes,
        ),
        target: {
          derive_body_sha256: {
            collection: "stage",
            collection_generation: generation,
          },
        },
        expected_bytes: 1n,
      }]),
      "physical pre-population stage probe",
    ),
    "physical pre-population stage probe.ok",
  );
  const stageId = unknownNat(
    begun.stage_id,
    "physical pre-population stage probe.stage_id",
  );
  expectDomainOk(
    await probe.call("qualification_abort_stage", [stageId]),
    "physical pre-population stage abort",
  );

  const reset = await input.environment.reinstallSameTransportWasm(
    installed.canisterId,
    input.deployment,
  );
  if (
    reset.installedTransportWasmSha256 !==
      installed.installedTransportWasmSha256
  ) {
    throw new Error(
      "Physical qualification reset installed a different module",
    );
  }
  await input.environment.authorizeQualificationController(
    installed.canisterId,
  );
  const actor = createDirectPocketIcKernelActor({
    controlUrl: input.environment.controlUrl,
    instanceId: input.environment.instanceId,
    canisterId: installed.canisterId,
    caller: Principal.fromText(input.environment.controllerPrincipal),
  });
  await initializePublicationEntropy(actor);
  await input.environment.verifyQualificationController(
    installed.canisterId,
  );
  const runtime = await actor.kernel_runtime_info();
  assertRuntimeCandidate(runtime, input.deployment);
  assertQualificationFixtureScopes(
    runtime.apps,
    input.deployment,
  );
}

async function capturedRuntimeCall(
  runtime: QualificationSampleRuntime,
  method: Parameters<QualificationSampleRuntime["call"]>[0],
  args: readonly unknown[],
): Promise<{
  value: unknown;
  observation: RawCandidObservation;
}> {
  const before = runtime.observations.candid.length;
  const value = await runtime.call(method, args);
  const after = runtime.observations.candid;
  if (after.length !== before + 1 || after[before] === undefined) {
    throw new Error(
      `Qualification runtime ${method} did not emit exactly one Candid observation`,
    );
  }
  return { value, observation: after[before]! };
}

function assertPhysicalBatchCommitted(
  value: unknown,
  operationsOrCount: readonly PhysicalPopulationPut[] | number,
  label: string,
): void {
  const expectedOperations = Array.isArray(operationsOrCount)
    ? operationsOrCount
    : undefined;
  const operationCount = expectedOperations?.length ?? operationsOrCount;
  if (
    typeof operationCount !== "number" ||
    !Number.isSafeInteger(operationCount) ||
    operationCount < 1
  ) {
    throw new Error(`${label} has an invalid expected operation count`);
  }
  const ok = expectDomainOk(value, label);
  const receipt = unknownRecord(ok, `${label}.ok`);
  const operations = unknownArray(
    receipt.operations,
    `${label}.ok.operations`,
  );
  if (operations.length !== operationCount) {
    throw new Error(`${label} returned the wrong operation count`);
  }
  for (const [index, operation] of operations.entries()) {
    const put = expectNamedVariant(
      operation,
      "put",
      `${label}.operations[${index}]`,
    );
    const putRecord = unknownRecord(
      put,
      `${label}.operations[${index}].put`,
    );
    if (
      unknownNat32(
        putRecord.request_index,
        `${label}.operations[${index}].request_index`,
      ) !== index
    ) {
      throw new Error(
        `${label}.operations[${index}] has the wrong request index`,
      );
    }
    const lifecycle = unknownRecord(
      putRecord.lifecycle,
      `${label}.operations[${index}].put.lifecycle`,
    );
    const identity = unknownRecord(
      lifecycle.committed,
      `${label}.operations[${index}].put.lifecycle.committed`,
    );
    const expected = expectedOperations?.[index];
    if (expected !== undefined) {
      if (
        !isDeepStrictEqual(identity.target, expected.put.target) ||
        unknownNat(
            identity.body_bytes,
            `${label}.operations[${index}].body_bytes`,
          ) !== 1n ||
        unknownNat(
            identity.kernel_revision,
            `${label}.operations[${index}].kernel_revision`,
          ) === 0n
      ) {
        throw new Error(
          `${label}.operations[${index}] committed the wrong identity`,
        );
      }
      const body = expected.put.body.inline;
      const digest = new Uint8Array(
        createHash("sha256").update(body).digest(),
      );
      if (
        !equalBytes(
          unknownBytes(
            identity.content_tag,
            `${label}.operations[${index}].content_tag`,
          ),
          digest,
        )
      ) {
        throw new Error(
          `${label}.operations[${index}] committed the wrong content tag`,
        );
      }
      const geometry = unknownRecord(
        identity.geometry,
        `${label}.operations[${index}].geometry`,
      );
      if (
        unknownNat(
            geometry.expected_bytes,
            `${label}.operations[${index}].geometry.expected_bytes`,
          ) !== 1n ||
        unknownNat32(
            geometry.block_count,
            `${label}.operations[${index}].geometry.block_count`,
          ) !== 1
      ) {
        throw new Error(
          `${label}.operations[${index}] committed invalid body geometry`,
        );
      }
      const blockHashes = unknownArray(
        identity.block_hashes,
        `${label}.operations[${index}].block_hashes`,
      );
      if (
        blockHashes.length !== 1 ||
        !equalBytes(
          unknownBytes(
            blockHashes[0],
            `${label}.operations[${index}].block_hashes[0]`,
          ),
          digest,
        )
      ) {
        throw new Error(
          `${label}.operations[${index}] committed invalid block hashes`,
        );
      }
    }
  }
}

const PHYSICAL_USAGE_KEYS = [
  "accepted_staged_bytes",
  "active_stages",
  "cleanup_jobs",
  "committed_body_bytes",
  "detached_charged_bytes",
  "filled_revocation_lanes",
  "general_receipt_lanes",
  "live_entries",
  "occupied_entry_slots",
  "receipt_expiry_indexes",
  "receipt_lanes",
  "receipt_nonce_indexes",
  "reserved_committed_body_bytes",
  "reserved_entry_slots",
  "reserved_general_receipt_lanes",
  "reserved_revocation_lanes",
  "reserved_staged_bytes",
] as const satisfies readonly (keyof PhysicalPopulationUsageExpectation)[];

function decodePhysicalUsage(
  value: unknown,
  expected: PhysicalPopulationUsageExpectation,
  label: string,
): PhysicalUsageSummary {
  const ok = unknownRecord(expectDomainOk(value, label), `${label}.ok`);
  const current = unknownRecord(ok.current, `${label}.ok.current`);
  const result = {} as Record<
    keyof PhysicalPopulationUsageExpectation,
    string
  >;
  for (const key of PHYSICAL_USAGE_KEYS) {
    const observed = unknownNat(current[key], `${label}.ok.current.${key}`);
    if (observed !== expected[key]) {
      throw new Error(
        `${label}.ok.current.${key} is ${observed}, expected ${expected[key]}`,
      );
    }
    result[key] = observed.toString();
  }
  return result;
}

function decodePhysicalMaintenancePage(
  value: unknown,
  pageIndex: number,
  pageCount: number,
  receiptCount: number,
  label: string,
): Omit<PhysicalMaintenancePageObservation, "page_index" | "call"> {
  const ok = unknownRecord(expectDomainOk(value, label), `${label}.ok`);
  const page = unknownRecord(ok.page, `${label}.ok.page`);
  const expectedHasMore = pageIndex + 1 < pageCount;
  const expectedReceipts = Math.min(
    CERTIFIED_ASSETS_MAINTENANCE_RECEIPTS_PER_PAGE,
    receiptCount -
      pageIndex * CERTIFIED_ASSETS_MAINTENANCE_RECEIPTS_PER_PAGE,
  );
  if (
    ok.has_more !== expectedHasMore ||
    unknownNat(ok.remaining_jobs, `${label}.ok.remaining_jobs`) !== 0n
  ) {
    throw new Error(`${label} returned an invalid continuation state`);
  }
  const expectedPage = {
    records: 0n,
    bodies: 0n,
    body_bytes: 0n,
    charged_bytes:
      physicalReceiptReclaimedChargedBytes(expectedReceipts),
    authenticated_nodes: 0n,
    receipts: BigInt(expectedReceipts),
  } as const;
  const reclaimed = {} as Record<
    keyof typeof expectedPage,
    string
  >;
  for (const key of Object.keys(expectedPage) as Array<
    keyof typeof expectedPage
  >) {
    const observed = unknownNat(page[key], `${label}.ok.page.${key}`);
    if (observed !== expectedPage[key]) {
      throw new Error(
        `${label}.ok.page.${key} is ${observed}, expected ${expectedPage[key]} for ${expectedReceipts} reclaimed receipts`,
      );
    }
    reclaimed[key] = observed.toString();
  }
  return {
    reclaimed,
    has_more: expectedHasMore,
    remaining_jobs: "0",
  };
}

function largestProof(
  observations: readonly CertifiedHttpObservation[],
): CertifiedHttpObservation {
  const first = observations[0];
  if (first === undefined) {
    throw new Error("Certified HTTP proof candidate set is empty");
  }
  let largest = first;
  for (const observation of observations.slice(1)) {
    if (certifiedProofBytes(observation) > certifiedProofBytes(largest)) {
      largest = observation;
    }
  }
  return largest;
}

function certifiedProofBytes(
  observation: CertifiedHttpObservation,
): number {
  return (
    observation.certificate.bytes +
    observation.witness.bytes +
    observation.expression_path.bytes
  );
}

function physicalGatewayCoverage(
  observations: readonly CertifiedHttpObservation[],
  rawCandidates: readonly CertifiedHttpObservation[],
): CertifiedHttpObservation[] {
  if (observations.length !== rawCandidates.length * 2) {
    throw new Error(
      "Physical witness candidates did not each cross raw and gateway boundaries",
    );
  }
  const paired: CertifiedHttpObservation[] = [];
  for (const raw of rawCandidates) {
    if (raw.boundary !== "raw_query") {
      throw new Error(
        "Physical witness candidate helper did not return its raw observation",
      );
    }
    const gateway = observations.filter(
      (candidate) =>
        candidate.boundary === "gateway" &&
        candidate.url === raw.url &&
        candidate.method === raw.method &&
        candidate.status === raw.status &&
        candidate.body.bytes === raw.body.bytes &&
        candidate.body.sha256 === raw.body.sha256 &&
        candidate.witness.bytes === raw.witness.bytes &&
        candidate.witness.sha256 === raw.witness.sha256,
    );
    if (gateway.length !== 1) {
      throw new Error(
        `Physical witness ${raw.url} lacks one exact gateway observation`,
      );
    }
    paired.push(raw, gateway[0]!);
  }
  return paired;
}

function qualificationUrl(
  runtime: QualificationSampleRuntime,
  pathname: string,
): string {
  const url = new URL(runtime.gatewayOrigin);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.href;
}

async function runUpgradeAndHostileGates(input: {
  environment: IsolatedQualificationPocketIc;
  deployment: PreparedDeployment;
}): Promise<{
  upgrade: SameWasmUpgradeGateObservation;
  hostile: HostileRawHttpGateObservation;
}> {
  const installed = await installFreshQualificationCanister(input);
  const runtime = createQualificationSampleRuntime({
    environment: input.environment,
    canisterId: installed.canisterId,
    appId: BEHAVIOR_APP_ID,
    caseId: "mutable_exact_cas",
    sample: 0,
    verifyGateway: false,
  });
  const generation = await runtime.generation("mutable_exact");
  const body = runtime.deterministicBytes(900, 1_024);
  const target = {
    collection: "mutable_exact",
    collection_generation: generation,
    locator: { exact_path: null },
  };
  const commit = await runtime.call("qualification_commit_batch", [{
    nonce: runtime.deterministicBytes(
      901,
      CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.workload.nonce_bytes,
    ),
    operations: [{
      put: {
        target,
        condition: { absent: null },
        body: { inline: body },
      },
    }],
    requires_present_after: [],
  }]);
  assertPhysicalBatchCommitted(commit, 1, "upgrade-gate record commit");

  const statusBefore = await capturedRuntimeCall(
    runtime,
    "qualification_record_status",
    [target],
  );
  expectPresentRecordStatus(
    statusBefore.value,
    "upgrade-gate record status before",
  );
  const recordPath =
    `/app/${BEHAVIOR_APP_ID}/_route/portable/profile`;
  const certifiedReadBefore = await runtime.verifyHttp({
    canisterId: installed.canisterId,
    url: qualificationUrl(runtime, recordPath),
    method: "GET",
    status: 200,
    authority: "portable",
    expressionPath: exactExpressionPath(recordPath),
    headers: portableHeaders({ kind: "mutable_blob", body }),
    body,
  });

  const actor = createDirectPocketIcKernelActor({
    controlUrl: input.environment.controlUrl,
    instanceId: input.environment.instanceId,
    canisterId: installed.canisterId,
    caller: Principal.fromText(input.environment.controllerPrincipal),
  });
  const runtimeBefore = await actor.kernel_runtime_info();
  assertRuntimeCandidate(runtimeBefore, input.deployment);
  const upgraded = await input.environment.upgradeSameTransportWasm(
    installed.canisterId,
    input.deployment,
  );
  const runtimeAfter = await actor.kernel_runtime_info();
  assertRuntimeCandidate(runtimeAfter, input.deployment);
  if (!isDeepStrictEqual(runtimeBefore, runtimeAfter)) {
    throw new Error(
      "Same-Wasm upgrade changed the exact Kernel runtime inventory",
    );
  }

  const statusAfter = await capturedRuntimeCall(
    runtime,
    "qualification_record_status",
    [target],
  );
  expectPresentRecordStatus(
    statusAfter.value,
    "upgrade-gate record status after",
  );
  const certifiedReadAfter = await runtime.verifyHttp({
    canisterId: installed.canisterId,
    url: qualificationUrl(runtime, recordPath),
    method: "GET",
    status: 200,
    authority: "portable",
    expressionPath: exactExpressionPath(recordPath),
    headers: portableHeaders({ kind: "mutable_blob", body }),
    body,
  });
  if (
    statusBefore.observation.request.sha256 !==
      statusAfter.observation.request.sha256 ||
    statusBefore.observation.reply.sha256 !==
      statusAfter.observation.reply.sha256
  ) {
    throw new Error(
      "Same-Wasm upgrade changed the exact record-status response",
    );
  }

  const installedBefore =
    upgraded.before.installedTransportWasmSha256;
  const installedAfter =
    upgraded.after.installedTransportWasmSha256;
  if (
    installedBefore === null ||
    installedAfter === null ||
    installedBefore !== input.deployment.transportWasmSha256 ||
    installedAfter !== input.deployment.transportWasmSha256
  ) {
    throw new Error(
      "Same-Wasm upgrade management status does not bind the candidate module",
    );
  }
  const upgrade: SameWasmUpgradeGateObservation = {
    schema: CERTIFIED_ASSETS_UPGRADE_GATE_SCHEMA,
    canister_id: installed.canisterId,
    status_before: "running",
    canister_version_before:
      upgraded.before.canisterVersion.toString(),
    controllers_before: upgraded.before.controllers,
    installed_transport_wasm_sha256_before: installedBefore,
    upgrade_call: {
      schema: CERTIFIED_ASSETS_RAW_CANDID_OBSERVATION_SCHEMA,
      mode: upgraded.installChunkedCodeCall.mode,
      method: upgraded.installChunkedCodeCall.method,
      request: exactBytes(upgraded.installChunkedCodeCall.request),
      reply: exactBytes(upgraded.installChunkedCodeCall.reply),
    },
    status_after: "running",
    canister_version_after: upgraded.after.canisterVersion.toString(),
    controllers_after: upgraded.after.controllers,
    installed_transport_wasm_sha256_after: installedAfter,
    record_status_before: statusBefore.observation,
    record_status_after: statusAfter.observation,
    certified_read_before: certifiedReadBefore,
    certified_read_after: certifiedReadAfter,
  };

  const hostileRequest: CertifiedHttpQueryRequest = {
    method: "GET",
    url: recordPath,
    headers: [
      ["host", `${installed.canisterId}.localhost:8000`],
      ["range", "bytes=0-1,2-3"],
    ],
    body: new Uint8Array(),
    certificate_version: [2],
  };
  const hostileCall = await capturedRawHttpCall(runtime, hostileRequest);
  const hostileUrl = qualificationUrl(runtime, recordPath);
  assertHostileRangeRejected({
    url: hostileUrl,
    request: hostileRequest,
    response: hostileCall.value,
  });
  const responseHeaders = canonicalHeaders(
    hostileCall.value.headers,
    "hostile Range response",
  );
  if (
    hostileCall.value.status_code !== 400 ||
    hostileCall.value.body.byteLength !== 0 ||
    hostileCall.value.streaming_strategy.length !== 0 ||
    hostileCall.value.upgrade.length !== 0
  ) {
    throw new Error(
      "Hostile Range response did not remain the closed empty 400",
    );
  }
  const hostile: HostileRawHttpGateObservation = {
    schema: CERTIFIED_ASSETS_HOSTILE_HTTP_GATE_SCHEMA,
    canister_id: installed.canisterId,
    installed_transport_wasm_sha256: installedAfter,
    call: hostileCall.observation,
    url: hostileUrl,
    request_headers: canonicalHeaders(
      hostileRequest.headers,
      "hostile Range request",
    ),
    status_code: 400,
    response_headers: responseHeaders,
    body: exactBytes(hostileCall.value.body),
    streaming_strategy_entries:
      hostileCall.value.streaming_strategy.length,
    upgrade_entries: hostileCall.value.upgrade.length,
  };
  return { upgrade, hostile };
}

async function capturedRawHttpCall(
  runtime: QualificationSampleRuntime,
  request: CertifiedHttpQueryRequest,
): Promise<{
  value: Awaited<ReturnType<QualificationSampleRuntime["rawHttpRequest"]>>;
  observation: RawCandidObservation;
}> {
  const before = runtime.observations.candid.length;
  const value = await runtime.rawHttpRequest(request);
  const after = runtime.observations.candid;
  if (
    after.length !== before + 1 ||
    after[before]?.method !== "http_request"
  ) {
    throw new Error(
      "Qualification raw HTTP call did not emit one http_request observation",
    );
  }
  return { value, observation: after[before]! };
}

function expectPresentRecordStatus(value: unknown, label: string): void {
  const ok = expectDomainOk(value, label);
  unknownRecord(
    expectNamedVariant(ok, "present", `${label}.ok`),
    `${label}.ok.present`,
  );
}

function expectAbsentRecordStatus(value: unknown, label: string): void {
  const ok = expectDomainOk(value, label);
  unknownRecord(
    expectNamedVariant(ok, "absent", `${label}.ok`),
    `${label}.ok.absent`,
  );
}

function canonicalHeaders(
  value: readonly (readonly [string, string])[],
  label: string,
): readonly (readonly [string, string])[] {
  const headers = value.map(([name, headerValue], index) => {
    if (
      typeof name !== "string" ||
      typeof headerValue !== "string" ||
      name.length === 0 ||
      /[\r\n]/u.test(name) ||
      /[\r\n]/u.test(headerValue)
    ) {
      throw new Error(`${label}[${index}] is invalid`);
    }
    return [name.toLowerCase(), headerValue] as const;
  });
  headers.sort(([leftName, leftValue], [rightName, rightValue]) => {
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
    if (leftValue === rightValue) return 0;
    return leftValue < rightValue ? -1 : 1;
  });
  const names = headers.map(([name]) => name);
  if (new Set(names).size !== names.length) {
    throw new Error(`${label} repeats a header name`);
  }
  return headers;
}

function expectDomainOk(value: unknown, label: string): unknown {
  return expectNamedVariant(value, "ok", label);
}

function expectDomainError(
  value: unknown,
  expected: string,
  label: string,
): void {
  const error = expectNamedVariant(value, "err", label);
  expectNamedVariant(error, expected, `${label}.err`);
}

function expectNamedVariant(
  value: unknown,
  expected: string,
  label: string,
): unknown {
  const record = unknownRecord(value, label);
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== expected) {
    throw new Error(
      `${label} is ${keys.join(",") || "empty"}, expected ${expected}`,
    );
  }
  return record[expected];
}

function unknownRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  return value as Record<string, unknown>;
}

function unknownArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function unknownNat(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`${label} must be a Nat`);
  }
  return value;
}

function unknownNat32(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffff_ffff
  ) {
    throw new Error(`${label} must be a Nat32`);
  }
  return value;
}

function unknownBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "number" &&
        Number.isInteger(entry) &&
        entry >= 0 &&
        entry <= 0xff,
    )
  ) {
    return Uint8Array.from(value as number[]);
  }
  throw new Error(`${label} must be bytes`);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function requiredMapValue(
  values: ReadonlyMap<string, string>,
  name: string,
  label: string,
): string {
  const value = values.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`${label} lacks ${name}`);
  }
  return value;
}

function canonicalBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > 4 * 1024 ||
    bytes.toString("base64") !== value
  ) {
    throw new Error("Qualification root key is not canonical base64");
  }
  return new Uint8Array(bytes);
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Qualification canonical JSON requires safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(
    "Qualification canonical JSON contains an unsupported value",
  );
}

async function writeReceiptAtomically(bytes: Uint8Array): Promise<void> {
  const temporaryPath =
    `${RECEIPT_PATH}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, bytes, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, RECEIPT_PATH);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(formatQualificationFailure(error));
    process.exitCode = 1;
  }
}
