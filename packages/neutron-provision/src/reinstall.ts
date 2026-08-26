import type { Identity } from "@dfinity/agent";
import { createDeploymentNonce } from "neutron-compiler/src/install.js";
import {
  assertPreparedDeploymentTarget,
  assertPreparedDeploymentMatchesExpectedArtifacts,
  prepareDeployment,
  sha256,
  snapshotExpectedPackageArtifacts,
  type PinnedPackageArtifact,
  type PreparedDeployment,
} from "./artifact.ts";
import {
  persistTransactionPayload,
  readTransactionPayload,
  removeTransactionPayload,
  serializeTransactionPayload,
  sweepUnreferencedTransactionPayloads,
  type SerializedTransactionPayload,
} from "./payload.ts";
import {
  collectDeploymentObservationV1,
  createDeploymentEvidenceV1,
  persistDeploymentProofBundle,
  readDeploymentProofBundle,
  sweepUnreferencedDeploymentProofBundles,
  type DeploymentEvidenceProviderV1,
  type DeploymentEvidenceV1,
  type DeploymentObservationV1,
} from "./deployment_evidence.ts";
import { bindDeploymentRuntimeConfig } from "./runtime_config.ts";
import {
  canonicalPrincipals,
  IcProvisionClient,
  type CanisterOperationalState,
  type CertifiedCanisterState,
} from "./ic_client.ts";
import {
  loadExistingBlastIdentity,
  type BlastIdentity,
} from "./identity.ts";
import { seedFreshKernel, verifyFreshKernel } from "./provision.ts";
import {
  createReinstallTransaction,
  currentDeployment,
  journalDeploymentProofDigests,
  readSession,
  reinstallPlanFingerprint,
  withMainnetExecutionLock,
  withSessionLock,
  writeSession,
  type AdoptionReceipt,
  type CreationState,
  type ProvisionJournal,
  type ReinstallPlan,
  type ReinstallState,
  type ReinstallRunState,
} from "./session.ts";

export type ReinstallOptions = {
  configSha256: string;
  host: string;
  identityId: number;
  targetSubnet: string;
  sessionPath: string;
  expectedArtifacts: readonly PinnedPackageArtifact[];
  execute: boolean;
};

export type ReinstallResult = {
  mode: "plan" | "executed";
  principal: string;
  canisterId: string;
  plan: ReinstallPlan;
  session: ProvisionJournal;
};

export type ReinstallClient = Pick<
  IcProvisionClient,
  | "certifiedState"
  | "operationalState"
  | "ensureStopped"
  | "ensureRunning"
  | "stageWasmChunks"
  | "deleteAllCanisterSnapshots"
  | "reinstallChunkedWasm"
  | "kernelActor"
  | "verifyInitialKernelAccess"
>;

export type ReinstallDependencies = {
  loadIdentity?: (id: number) => Promise<BlastIdentity>;
  /**
   * Prepared-deployment injection seam for unit tests. Production callers
   * should omit it; returned bytes are still reconciled to expectedArtifacts.
   */
  prepare?: (
    expectedArtifacts: readonly PinnedPackageArtifact[],
    options?: { deploymentNonce?: string },
  ) => Promise<PreparedDeployment>;
  createClient?: (input: {
    host: string;
    identity: Identity;
    logger: Pick<Console, "log">;
  }) => Promise<ReinstallClient>;
  confirm?: (summary: {
    principal: string;
    canisterId: string;
    packages: ReinstallPlan["packages"];
  }) => Promise<void>;
  seed?: typeof seedFreshKernel;
  verify?: typeof verifyFreshKernel;
  now?: () => Date;
  logger?: Pick<Console, "log">;
  deploymentEvidenceProvider?: DeploymentEvidenceProviderV1;
};

type PreparedOperation = {
  deployment: PreparedDeployment;
  serializedPayload: SerializedTransactionPayload | null;
  plan: ReinstallPlan;
  existingState: ReinstallState | null;
  expectedProofBundle: Uint8Array | null;
};

type LocallyPreparedOperation = {
  deployment: PreparedDeployment;
  serializedPayload: SerializedTransactionPayload | null;
  currentState: ReinstallState | null;
  deploymentNonce: string;
};

type DeploymentSource =
  | { kind: "origin"; receipt: CreationState }
  | { kind: "adoption"; receipt: AdoptionReceipt };

export async function runReinstall(
  options: ReinstallOptions,
  dependencies: ReinstallDependencies = {},
): Promise<ReinstallResult> {
  const expectedArtifacts = snapshotExpectedPackageArtifacts(
    options.expectedArtifacts,
  );
  const logger = dependencies.logger ?? console;
  const now = dependencies.now ?? (() => new Date());
  const identity = await (
    dependencies.loadIdentity ?? loadExistingBlastIdentity
  )(options.identityId);
  let journal = await requireDeploymentSourceJournal(options.sessionPath);
  assertReinstallConfigBinding(journal, options.configSha256);
  let source = deploymentSource(journal);
  assertSourceIntent(options, identity, source);
  deploymentSourceEvidence(source);
  // Fail before constructing an IC client or reading/mutating the canister.
  requireDeploymentEvidenceProvider(dependencies.deploymentEvidenceProvider);
  const canisterId = sourceCanisterId(source);

  const proceed = async (): Promise<ReinstallResult> => {
    if (options.execute) {
      journal = await withSessionLock(options.sessionPath, async () => {
        const current = await requireDeploymentSourceJournal(options.sessionPath);
        assertReinstallConfigBinding(current, options.configSha256);
        assertSourceIntent(options, identity, deploymentSource(current));
        const active = current.active;
        const removed = await sweepUnreferencedTransactionPayloads(
          options.sessionPath,
          active && active.kind !== "local-reinstall"
            ? active.state.plan.payload.sha256
            : undefined,
        );
        if (removed > 0) {
          logger.log(
            `Removed ${removed} unreferenced transaction payload${removed === 1 ? "" : "s"}`,
          );
        }
        const removedProofs =
          await sweepUnreferencedDeploymentProofBundles(
            options.sessionPath,
            journalDeploymentProofDigests(current),
          );
        if (removedProofs > 0) {
          logger.log(
            `Removed ${removedProofs} unreferenced deployment proof bundle${removedProofs === 1 ? "" : "s"}`,
          );
        }
        return current;
      });
      source = deploymentSource(journal);
      deploymentSourceEvidence(source);
    }
    if (journal.active?.kind === "create") {
      throw new Error(
        "Creation journal cleanup is unfinished; rerun the ordinary provision command before reinstall",
      );
    }
    if (journal.active?.kind === "reinstall" && journal.active.completedAt) {
      if (options.execute) {
        journal = await finishCompletedReinstallCleanup(
          options.sessionPath,
          journal,
          now,
          logger,
        );
      }
    }
    const currentState =
      journal.active?.kind === "reinstall" && !journal.active.completedAt
        ? journal.active.state
        : null;
    const localOperation = await prepareLocalOperation({
      options,
      dependencies,
      source,
      currentState,
      identity,
      expectedArtifacts,
    });
    assertPreparedDeploymentTarget(localOperation.deployment, canisterId);
    const client = await (
      dependencies.createClient ??
      ((input) => IcProvisionClient.create(input))
    )({ host: options.host, identity: identity.identity, logger });
    const operation = await prepareOperation({
      options,
      dependencies,
      source,
      localOperation,
      identity,
      client,
    });
    printReinstallPlan(operation, logger, options.execute);

    if (!options.execute) {
      return {
        mode: "plan",
        principal: identity.principal,
        canisterId,
        plan: operation.plan,
        session: journal,
      };
    }

    if (operation.existingState === null) {
      await dependencies.confirm?.({
        principal: identity.principal,
        canisterId,
        packages: operation.plan.packages,
      });
    }

    const completed = await withSessionLock(options.sessionPath, async () => {
      const onDisk = await requireDeploymentSourceJournal(options.sessionPath);
      assertReinstallConfigBinding(onDisk, options.configSha256);
      assertSourceIntent(
        options,
        identity,
        deploymentSource(onDisk),
      );
      let state: ReinstallState;
      let deployment = operation.deployment;
      if (operation.existingState) {
        if (
          onDisk.active?.kind !== "reinstall" ||
          onDisk.active.completedAt ||
          onDisk.active.state.plan.fingerprint !== operation.plan.fingerprint
        ) {
          throw new Error(
            "Provision journal changed while preparing reinstall resume; rerun after the other process finishes",
          );
        }
        state = onDisk.active.state;
      } else {
        if (onDisk.active) {
          throw new Error(
            "An active transaction appeared while preparing reinstall; rerun to resume it",
          );
        }
        // Confirmation can take arbitrarily long. Re-prove the exact target
        // under the session lock before publishing a durable transaction. A
        // rejected check must not leave a pristine journal that can never be
        // resumed against the now-different canister.
        const [certified, operational] = await Promise.all([
          client.certifiedState(canisterId),
          client.operationalState(canisterId),
        ]);
        assertPristineTargetMatchesPlan(
          operation.plan,
          certified,
          operational,
        );
        const expectedProofBundle = operation.expectedProofBundle;
        if (!expectedProofBundle) {
          throw new Error("Missing expected deployment proof bundle");
        }
        await persistDeploymentProofBundle(
          options.sessionPath,
          expectedProofBundle,
          operation.plan.deploymentEvidenceExpected.evidenceSha256,
        );
        const payload = operation.serializedPayload;
        if (!payload) throw new Error("Missing reinstall transaction payload");
        const payloadPath = await persistTransactionPayload(
          options.sessionPath,
          payload,
        );
        logger.log(`Persisted active transaction payload ${payloadPath}`);
        // A completed source receipt is permanent, while this top-level hash
        // names the desired/current format-3 archive set. Rebind only in the
        // same atomic write that publishes a fresh immutable transaction.
        onDisk.configSha256 = options.configSha256;
        onDisk.active = createReinstallTransaction(operation.plan, now());
        await writeSession(options.sessionPath, onDisk, now());
        logger.log(`Recorded reinstall in provision journal ${options.sessionPath}`);
        state = onDisk.active.state;
      }

      deployment = await readTransactionPayload({
        sessionPath: options.sessionPath,
        expectedSha256: state.plan.payload.sha256,
        expectedVersion: state.plan.payload.version,
        packageProvenance: state.plan.packages,
      });
      assertDeploymentMatchesPlan(deployment, state.plan);

      await executeReinstallPhases({
        client,
        canisterId,
        host: options.host,
        deployment,
        state,
        journal: onDisk,
        sessionPath: options.sessionPath,
        seed: dependencies.seed ?? seedFreshKernel,
        verify: dependencies.verify ?? verifyFreshKernel,
        now,
        logger,
        ...(dependencies.deploymentEvidenceProvider
          ? {
              deploymentEvidenceProvider:
                dependencies.deploymentEvidenceProvider,
            }
          : {}),
      });
      if (!state.deploymentEvidence) {
        throw new Error(
          "Reinstall completed without registry-backed deployment evidence",
        );
      }
      const completedAt = now().toISOString();
      onDisk.active!.completedAt = completedAt;
      onDisk.current = currentDeployment(
        "reinstall",
        state.plan,
        canisterId,
        completedAt,
        state.deploymentEvidence,
        state.plan.sourceSessionFingerprint,
      );
      await writeSession(options.sessionPath, onDisk, now());
      await removeTransactionPayload(
        options.sessionPath,
        state.plan.payload.sha256,
        state.plan.payload.version,
      );
      delete onDisk.active;
      await writeSession(options.sessionPath, onDisk, now());
      return onDisk;
    });

    logger.log(`Neutron was reinstalled at https://${canisterId}.icp0.io/`);
    return {
      mode: "executed",
      principal: identity.principal,
      canisterId,
      plan: operation.plan,
      session: completed,
    };
  };

  return options.execute
    ? withMainnetExecutionLock(identity.principal, proceed)
    : proceed();
}

async function prepareOperation({
  options,
  dependencies,
  source,
  localOperation,
  identity,
  client,
}: {
  options: ReinstallOptions;
  dependencies: ReinstallDependencies;
  source: DeploymentSource;
  localOperation: LocallyPreparedOperation;
  identity: BlastIdentity;
  client: ReinstallClient;
}): Promise<PreparedOperation> {
  const canisterId = sourceCanisterId(source);
  const { currentState, deployment, serializedPayload, deploymentNonce } =
    localOperation;
  if (currentState) {
    assertResumeMatchesSource(
      currentState,
      source,
      options,
      identity,
    );
    const [certified, operational] = await Promise.all([
      client.certifiedState(canisterId),
      client.operationalState(canisterId),
    ]);
    assertRemoteMatchesPlan(
      currentState.plan,
      certified,
      operational,
      currentState.wasmInstalledAt === undefined,
    );
    return {
      deployment,
      serializedPayload: null,
      plan: currentState.plan,
      existingState: currentState,
      expectedProofBundle: null,
    };
  }

  const [certified, operational] = await Promise.all([
    client.certifiedState(canisterId),
    client.operationalState(canisterId),
  ]);
  assertNewOperationTarget({
    canisterId,
    targetSubnet: options.targetSubnet,
    principal: identity.principal,
    certified,
    operational,
  });
  if (!serializedPayload) {
    throw new Error("Fresh reinstall preparation has no transaction payload");
  }
  const expectedResult = await collectDeploymentObservationV1(
    requireDeploymentEvidenceProvider(
      dependencies.deploymentEvidenceProvider,
    ),
    { subnetId: options.targetSubnet },
  );
  const plan = buildReinstallPlan({
    options,
    source,
    identity,
    operational,
    deploymentNonce,
    deployment,
    payload: serializedPayload,
    sourceDeploymentEvidence: deploymentSourceEvidence(source),
    deploymentEvidenceExpected: expectedResult.observation,
  });
  if (plan.transportWasmSha256 === operational.moduleHash) {
    throw new Error(
      "Fresh reinstall compilation did not produce a unique Wasm hash",
    );
  }
  return {
    deployment,
    serializedPayload,
    plan,
    existingState: null,
    expectedProofBundle: expectedResult.proofBundle,
  };
}

async function prepareLocalOperation({
  options,
  dependencies,
  source,
  currentState,
  identity,
  expectedArtifacts,
}: {
  options: ReinstallOptions;
  dependencies: ReinstallDependencies;
  source: DeploymentSource;
  currentState: ReinstallState | null;
  identity: BlastIdentity;
  expectedArtifacts: readonly PinnedPackageArtifact[];
}): Promise<LocallyPreparedOperation> {
  if (currentState) {
    assertResumeMatchesSource(currentState, source, options, identity);
    const deployment = await readTransactionPayload({
      sessionPath: options.sessionPath,
      expectedSha256: currentState.plan.payload.sha256,
      expectedVersion: currentState.plan.payload.version,
      packageProvenance: currentState.plan.packages,
    });
    assertPreparedDeploymentMatchesExpectedArtifacts(
      deployment,
      expectedArtifacts,
    );
    assertDeploymentMatchesPlan(deployment, currentState.plan);
    return {
      deployment,
      serializedPayload: null,
      currentState,
      deploymentNonce: currentState.plan.deploymentNonce,
    };
  }
  const deploymentNonce = createDeploymentNonce();
  const deployment = await (
    dependencies.prepare ?? preparePinnedProductionDeployment
  )(
    expectedArtifacts,
    { deploymentNonce },
  );
  assertPreparedDeploymentMatchesExpectedArtifacts(
    deployment,
    expectedArtifacts,
  );
  return {
    deployment,
    serializedPayload: serializeTransactionPayload(deployment),
    currentState: null,
    deploymentNonce,
  };
}

function preparePinnedProductionDeployment(
  expectedArtifacts: readonly PinnedPackageArtifact[],
  options: { deploymentNonce?: string } = {},
): Promise<PreparedDeployment> {
  return prepareDeployment(
    expectedArtifacts.map(({ path }) => path),
    {
      target: "production",
      expectedArtifacts,
      ...(options.deploymentNonce
        ? { deploymentNonce: options.deploymentNonce }
        : {}),
    },
  );
}

async function executeReinstallPhases({
  client,
  canisterId,
  host,
  deployment,
  state,
  journal,
  sessionPath,
  seed,
  verify,
  now,
  logger,
  deploymentEvidenceProvider,
}: {
  client: ReinstallClient;
  canisterId: string;
  host: string;
  deployment: PreparedDeployment;
  state: ReinstallState;
  journal: ProvisionJournal;
  sessionPath: string;
  seed: typeof seedFreshKernel;
  verify: typeof verifyFreshKernel;
  now: () => Date;
  logger: Pick<Console, "log">;
  deploymentEvidenceProvider?: DeploymentEvidenceProviderV1;
}): Promise<void> {
  if (!state.wasmStagedAt) {
    const [certified, operational] = await Promise.all([
      client.certifiedState(canisterId),
      client.operationalState(canisterId),
    ]);
    assertPristineTargetMatchesPlan(state.plan, certified, operational);
    logger.log(`Staging ${deployment.chunks.length} Wasm chunk(s)`);
    await client.stageWasmChunks({
      canisterId,
      chunks: deployment.chunks,
    });
    state.wasmStagedAt = now().toISOString();
    await writeSession(sessionPath, journal, now());
  }

  if (!state.wasmInstalledAt) {
    const [certifiedBeforeStop, operationalBeforeStop] = await Promise.all([
      client.certifiedState(canisterId),
      client.operationalState(canisterId),
    ]);
    assertRemoteMatchesPlan(
      state.plan,
      certifiedBeforeStop,
      operationalBeforeStop,
      true,
    );
    logger.log(`Stopping and draining ${canisterId}`);
    try {
      const stopped = await client.ensureStopped(canisterId);
      assertOperationalInvariants(state.plan, stopped, [
        state.plan.previousModuleHash,
        state.plan.transportWasmSha256,
      ]);
    } catch (error) {
      if (
        state.plan.originalStatus === "running" &&
        operationalBeforeStop.status === "running"
      ) {
        try {
          await client.ensureRunning(canisterId);
          logger.log(
            `Restored ${canisterId} to running after the reinstall stop check failed`,
          );
        } catch (restoreError) {
          logger.log(
            `Could not restore ${canisterId} after the reinstall stop check failed: ${errorMessage(restoreError)}`,
          );
        }
      }
      throw error;
    }
    if (!state.stoppedAt) {
      state.stoppedAt = now().toISOString();
      await writeSession(sessionPath, journal, now());
    }
    if (!state.snapshotsDeletedAt) {
      const removed = await client.deleteAllCanisterSnapshots(canisterId);
      logger.log(`Deleted ${removed} pre-reinstall canister snapshot(s)`);
      state.snapshotsDeletedAt = now().toISOString();
      await writeSession(sessionPath, journal, now());
    }
    logger.log(
      `Reinstalling ${deployment.transportWasm.byteLength.toLocaleString("en-US")} compressed Wasm bytes in ${deployment.chunks.length} chunk(s)`,
    );
    await client.reinstallChunkedWasm({
      canisterId,
      chunks: deployment.chunks,
      transportWasmHash: sha256(deployment.transportWasm),
      previousModuleHash: state.plan.previousModuleHash,
    });
    // A controller could have taken one final old-state snapshot after the
    // first sweep but before the code replacement. Once replacement commits,
    // deleting again guarantees no snapshot of the pre-reinstall actor remains.
    await client.deleteAllCanisterSnapshots(canisterId);
    state.wasmInstalledAt = now().toISOString();
    await writeSession(sessionPath, journal, now());
  }

  const actorWorkPending =
    !state.assetsSeededAt ||
    !state.initialAccessVerifiedAt ||
    !state.verifiedAt;
  if (actorWorkPending) {
    logger.log(`Starting fresh Neutron ${canisterId}`);
    const running = await client.ensureRunning(canisterId);
    assertOperationalInvariants(state.plan, running, [
      state.plan.transportWasmSha256,
    ]);
    if (!state.startedAt) {
      state.startedAt = now().toISOString();
      await writeSession(sessionPath, journal, now());
    }
  }

  const actor = client.kernelActor(canisterId);
  bindDeploymentRuntimeConfig({ deployment, canisterId, target: "ic" });
  if (!state.assetsSeededAt) {
    await seed({ actor, canisterId, deployment, logger });
    state.assetsSeededAt = now().toISOString();
    await writeSession(sessionPath, journal, now());
  }
  if (!state.initialAccessVerifiedAt) {
    await client.verifyInitialKernelAccess(canisterId);
    state.initialAccessVerifiedAt = now().toISOString();
    await writeSession(sessionPath, journal, now());
    logger.log("Verified the icblast deployer is the sole fresh kernel principal");
  }
  if (!state.verifiedAt) {
    await verify({
      actor,
      canisterId,
      host,
      deployment,
    });
    const [certified, operational] = await Promise.all([
      client.certifiedState(canisterId),
      client.operationalState(canisterId),
    ]);
    assertRemoteMatchesPlan(state.plan, certified, operational, false);
    if (operational.status !== "running") {
      throw new Error("Fresh Neutron stopped before final verification completed");
    }
  }

  // Snapshots taken after code replacement contain only fresh state, but a
  // whole reset should leave no restore points at all.
  const finalSnapshots = await client.deleteAllCanisterSnapshots(canisterId);
  if (finalSnapshots > 0) {
    logger.log(`Deleted ${finalSnapshots} snapshot(s) created during reinstall`);
  }

  if (state.plan.originalStatus === "stopped") {
    logger.log(`Restoring ${canisterId} to its original stopped state`);
    const stopped = await client.ensureStopped(canisterId);
    assertOperationalInvariants(state.plan, stopped, [
      state.plan.transportWasmSha256,
    ]);
    if (!state.originalStatusRestoredAt) {
      state.originalStatusRestoredAt = now().toISOString();
    }
  } else {
    // Reconcile even when verification was already journaled. The process may
    // have died before completion, or another controller may have stopped the
    // canister between attempts.
    const running = await client.ensureRunning(canisterId);
    assertOperationalInvariants(state.plan, running, [
      state.plan.transportWasmSha256,
    ]);
  }

  if (!state.verifiedAt) {
    const expected = state.plan.deploymentEvidenceExpected;
    const expectedProof = await readDeploymentProofBundle(
      sessionPath,
      expected.evidenceSha256,
    );
    const observedResult = await collectDeploymentObservationV1(
      requireDeploymentEvidenceProvider(deploymentEvidenceProvider),
      { subnetId: state.plan.targetSubnet },
    );
    const evidence = createDeploymentEvidenceV1(
      expected,
      observedResult.observation,
      {
        expected: expectedProof,
        observed: observedResult.proofBundle,
      },
    );
    await persistDeploymentProofBundle(
      sessionPath,
      observedResult.proofBundle,
      evidence.observed.evidenceSha256,
    );
    // The complete target, including its restored run state, is rechecked
    // after the independent proof and artifact persistence. The caller writes
    // this evidence and the final current receipt in one journal commit.
    const [certified, operational] = await Promise.all([
      client.certifiedState(canisterId),
      client.operationalState(canisterId),
    ]);
    assertRemoteMatchesPlan(state.plan, certified, operational, false);
    if (operational.status !== state.plan.originalStatus) {
      throw new Error(
        "Fresh Neutron run state changed during deployment evidence verification",
      );
    }
    state.deploymentEvidence = evidence;
    state.verifiedAt = now().toISOString();
  }
}

async function finishCompletedReinstallCleanup(
  sessionPath: string,
  expected: ProvisionJournal,
  now: () => Date,
  logger: Pick<Console, "log">,
): Promise<ProvisionJournal> {
  return withSessionLock(sessionPath, async () => {
    const journal = await requireDeploymentSourceJournal(sessionPath);
    const active = journal.active;
    if (!active || active.kind !== "reinstall" || !active.completedAt) {
      if (!journal.active && journal.current?.kind === "reinstall") return journal;
      throw new Error("Provision journal changed during completed reinstall cleanup");
    }
    if (
      expected.active?.kind !== "reinstall" ||
      expected.active.state.plan.fingerprint !== active.state.plan.fingerprint
    ) {
      throw new Error("Provision journal changed before completed reinstall cleanup");
    }
    await removeTransactionPayload(
      sessionPath,
      active.state.plan.payload.sha256,
      active.state.plan.payload.version,
    );
    delete journal.active;
    await writeSession(sessionPath, journal, now());
    logger.log("Removed completed reinstall transaction payload");
    return journal;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildReinstallPlan({
  options,
  source,
  identity,
  operational,
  deploymentNonce,
  deployment,
  payload,
  sourceDeploymentEvidence,
  deploymentEvidenceExpected,
}: {
  options: ReinstallOptions;
  source: DeploymentSource;
  identity: BlastIdentity;
  operational: CanisterOperationalState;
  deploymentNonce: string;
  deployment: PreparedDeployment;
  payload: SerializedTransactionPayload;
  sourceDeploymentEvidence: DeploymentEvidenceV1;
  deploymentEvidenceExpected: DeploymentObservationV1;
}): ReinstallPlan {
  if (operational.status === "stopping") {
    throw new Error(
      "Canister is already stopping; wait for that external operation to finish before planning reinstall",
    );
  }
  if (!operational.moduleHash) {
    throw new Error("Cannot reinstall a canister that has no installed module");
  }
  const base: Omit<ReinstallPlan, "fingerprint"> = {
    sourceSessionFingerprint: sourceFingerprint(source),
    canisterId: sourceCanisterId(source),
    identityId: options.identityId,
    deployerPrincipal: identity.principal,
    targetSubnet: options.targetSubnet,
    controllers: operational.controllers,
    originalStatus: operational.status as ReinstallRunState,
    previousModuleHash: operational.moduleHash,
    settingsFingerprint: operational.settingsFingerprint,
    deploymentNonce,
    packages: deployment.packageArtifacts,
    compilerId: deployment.compiled.compilerId,
    deploymentId: deployment.compiled.deploymentId,
    rawWasmSha256: deployment.rawWasmSha256,
    wasmMetadata: deployment.wasmMetadata,
    transportWasmSha256: deployment.transportWasmSha256,
    transportWasmBytes: deployment.transportWasm.byteLength,
    candidSha256: deployment.candidSha256,
    stableSha256: deployment.stableSha256,
    chunkHashes: deployment.chunks.map(({ hashHex }) => hashHex),
    payload: {
      version: payload.version,
      sha256: payload.sha256,
      bytes: payload.bytes.byteLength,
    },
    sourceDeploymentEvidence,
    deploymentEvidenceExpected,
  };
  return { ...base, fingerprint: reinstallPlanFingerprint(base) };
}

async function requireDeploymentSourceJournal(
  sessionPath: string,
): Promise<ProvisionJournal> {
  const journal = await readSession(sessionPath);
  if (!journal) {
    throw new Error(
      `Whole-canister reinstall requires existing provision journal ${sessionPath}`,
    );
  }
  if (
    (!journal.origin?.canisterId || !journal.origin.verifiedAt) &&
    !journal.adoption
  ) {
    throw new Error(
      "Whole-canister reinstall requires a verified creation or adoption receipt",
    );
  }
  return journal;
}

function deploymentSource(journal: ProvisionJournal): DeploymentSource {
  if (journal.origin?.canisterId && journal.origin.verifiedAt) {
    return { kind: "origin", receipt: journal.origin };
  }
  if (journal.adoption) {
    return { kind: "adoption", receipt: journal.adoption };
  }
  throw new Error(
    "Whole-canister reinstall requires a verified creation or adoption receipt",
  );
}

function sourceCanisterId(source: DeploymentSource): string {
  return source.receipt.canisterId!;
}

function sourceFingerprint(source: DeploymentSource): string {
  return source.kind === "origin"
    ? source.receipt.fingerprint!
    : source.receipt.fingerprint;
}

function deploymentSourceEvidence(
  source: DeploymentSource,
): DeploymentEvidenceV1 {
  const evidence = source.receipt.deploymentEvidence;
  if (!evidence) {
    throw new Error(
      "Whole-canister reinstall requires registry-backed deployment evidence on its creation or adoption receipt; this deployment remains ordinary until it is verified",
    );
  }
  const targetSubnet =
    source.kind === "origin"
      ? source.receipt.plan.targetSubnet
      : source.receipt.targetSubnet;
  if (evidence.observed.subnetId !== targetSubnet) {
    throw new Error(
      "Deployment source evidence does not match the recorded target subnet",
    );
  }
  return evidence;
}

function requireDeploymentEvidenceProvider(
  provider: DeploymentEvidenceProviderV1 | undefined,
): DeploymentEvidenceProviderV1 {
  if (!provider) {
    throw new Error(
      "Registry-backed deployment evidence provider is required; refusing to infer confidential placement from configuration",
    );
  }
  return provider;
}

/**
 * An idle permanent IC source may plan a fresh format-3 artifact set. Once any
 * transaction is active, the top-level config hash is immutable until that
 * exact transaction is completed and cleaned up.
 */
function assertReinstallConfigBinding(
  journal: ProvisionJournal,
  configSha256: string,
): void {
  if (journal.runtime.kind !== "ic") {
    throw new Error("Whole-canister reinstall requires an IC provision journal");
  }
  if (
    journal.configSha256 !== configSha256 &&
    journal.active !== undefined
  ) {
    throw new Error(
      "An active IC transaction is bound to a different deployment config; restore that exact config and finish it before advancing archive pins",
    );
  }
}

function assertSourceIntent(
  options: ReinstallOptions,
  identity: BlastIdentity,
  source: DeploymentSource,
): void {
  const identityId =
    source.kind === "origin"
      ? source.receipt.plan.identityId
      : source.receipt.identityId;
  const deployerPrincipal =
    source.kind === "origin"
      ? source.receipt.plan.deployerPrincipal
      : source.receipt.deployerPrincipal;
  const targetSubnet =
    source.kind === "origin"
      ? source.receipt.plan.targetSubnet
      : source.receipt.targetSubnet;
  if (
    identityId !== options.identityId ||
    deployerPrincipal !== identity.principal
  ) {
    throw new Error(
      "Configured icblast identity does not match the deployment source receipt",
    );
  }
  if (targetSubnet !== options.targetSubnet) {
    throw new Error(
      "Configured target subnet does not match the deployment source receipt",
    );
  }
  if (source.kind === "adoption" && source.receipt.host !== options.host) {
    throw new Error(
      "Configured IC API host does not match the adoption receipt",
    );
  }
}

function assertResumeMatchesSource(
  state: ReinstallState,
  source: DeploymentSource,
  options: ReinstallOptions,
  identity: BlastIdentity,
): void {
  if (
    state.plan.sourceSessionFingerprint !== sourceFingerprint(source) ||
    state.plan.canisterId !== sourceCanisterId(source) ||
    state.plan.identityId !== options.identityId ||
    state.plan.deployerPrincipal !== identity.principal ||
    state.plan.targetSubnet !== options.targetSubnet ||
    state.plan.sourceDeploymentEvidence.fingerprint !==
      deploymentSourceEvidence(source).fingerprint
  ) {
    throw new Error(
      "Unfinished reinstall does not match the current deployment source and identity",
    );
  }
}

function assertNewOperationTarget({
  canisterId,
  targetSubnet,
  principal,
  certified,
  operational,
}: {
  canisterId: string;
  targetSubnet: string;
  principal: string;
  certified: CertifiedCanisterState;
  operational: CanisterOperationalState;
}): void {
  if (certified.subnetId !== targetSubnet) {
    throw new Error(
      `Canister ${canisterId} is on subnet ${certified.subnetId}, expected ${targetSubnet}`,
    );
  }
  if (!certified.moduleHash || certified.moduleHash !== operational.moduleHash) {
    throw new Error("Certified and management module state do not agree");
  }
  if (!sameStrings(certified.controllers, operational.controllers)) {
    throw new Error("Certified and management controller state do not agree");
  }
  if (!operational.controllers.includes(principal)) {
    throw new Error(
      `Configured icblast principal ${principal} is not a controller of ${canisterId}`,
    );
  }
  if (!operational.controllers.includes(canisterId)) {
    throw new Error(
      `Neutron ${canisterId} is not its own controller; refusing a reinstall that would disable checked self-upgrades`,
    );
  }
  if (operational.status === "stopping") {
    throw new Error(
      "Canister is already stopping; wait for that external operation to finish",
    );
  }
}

function assertRemoteMatchesPlan(
  plan: ReinstallPlan,
  certified: CertifiedCanisterState,
  operational: CanisterOperationalState,
  allowPreviousModule: boolean,
): void {
  if (certified.subnetId !== plan.targetSubnet) {
    throw new Error("Reinstall target moved to an unexpected subnet");
  }
  if (
    !sameStrings(certified.controllers, plan.controllers) ||
    !sameStrings(operational.controllers, plan.controllers)
  ) {
    throw new Error("Canister controllers changed during reinstall");
  }
  const allowed = allowPreviousModule
    ? [plan.previousModuleHash, plan.transportWasmSha256]
    : [plan.transportWasmSha256];
  if (
    !allowed.includes(certified.moduleHash ?? "") ||
    certified.moduleHash !== operational.moduleHash
  ) {
    throw new Error("Canister module does not match the reinstall journal");
  }
  assertOperationalInvariants(plan, operational, allowed);
}

function assertPristineTargetMatchesPlan(
  plan: ReinstallPlan,
  certified: CertifiedCanisterState,
  operational: CanisterOperationalState,
): void {
  assertRemoteMatchesPlan(plan, certified, operational, true);
  if (
    certified.moduleHash !== plan.previousModuleHash ||
    operational.moduleHash !== plan.previousModuleHash
  ) {
    throw new Error("Canister module changed before reinstall began");
  }
  if (operational.status !== plan.originalStatus) {
    throw new Error(
      `Canister run state changed before reinstall began: expected ${plan.originalStatus}, found ${operational.status}`,
    );
  }
}

function assertOperationalInvariants(
  plan: ReinstallPlan,
  operational: CanisterOperationalState,
  allowedModuleHashes: string[],
): void {
  if (!sameStrings(operational.controllers, plan.controllers)) {
    throw new Error("Canister controllers changed during reinstall");
  }
  if (operational.settingsFingerprint !== plan.settingsFingerprint) {
    throw new Error("Canister settings changed during reinstall");
  }
  if (!allowedModuleHashes.includes(operational.moduleHash ?? "")) {
    throw new Error("Canister module changed outside the reinstall transaction");
  }
}

function assertDeploymentMatchesPlan(
  deployment: PreparedDeployment,
  plan: ReinstallPlan,
): void {
  const chunkHashes = deployment.chunks.map(({ hashHex }) => hashHex);
  if (
    deployment.compiled.compilerId !== plan.compilerId ||
    deployment.compiled.deploymentId !== plan.deploymentId ||
    deployment.rawWasmSha256 !== plan.rawWasmSha256 ||
    !sameWasmMetadata(deployment.wasmMetadata, plan.wasmMetadata) ||
    deployment.transportWasmSha256 !== plan.transportWasmSha256 ||
    deployment.transportWasm.byteLength !== plan.transportWasmBytes ||
    deployment.candidSha256 !== plan.candidSha256 ||
    deployment.stableSha256 !== plan.stableSha256 ||
    chunkHashes.length !== plan.chunkHashes.length ||
    chunkHashes.some((hash, index) => hash !== plan.chunkHashes[index])
  ) {
    throw new Error("Active transaction payload does not match reinstall plan");
  }
}

function sameWasmMetadata(
  left: PreparedDeployment["wasmMetadata"],
  right: ReinstallPlan["wasmMetadata"],
): boolean {
  return (
    left.sectionName === right.sectionName &&
    left.sectionCount === right.sectionCount &&
    left.value === right.value
  );
}

function printReinstallPlan(
  operation: PreparedOperation,
  logger: Pick<Console, "log">,
  execute: boolean,
): void {
  const { plan } = operation;
  logger.log(
    execute
      ? "Neutron whole-canister reinstall"
      : "Neutron whole-canister reinstall plan (read-only)",
  );
  logger.log(`Target: ${plan.canisterId}`);
  logger.log(`Blast identity: ${plan.identityId} (${plan.deployerPrincipal})`);
  logger.log(`Subnet: ${plan.targetSubnet}`);
  logger.log(`Controllers preserved: ${plan.controllers.join(", ")}`);
  logger.log(`Original run state: ${plan.originalStatus}`);
  logger.log("CMC payment: none; no canister will be created");
  logger.log(
    "Destructive reset: all installed-app state, keys, permissions, authorizations, certified assets, canister snapshots, and restore points will be permanently erased",
  );
  for (const pkg of plan.packages) {
    logger.log(
      `Package: ${pkg.id} v${pkg.version} ${pkg.sha256.slice(0, 16)}… (${pkg.bytes.toLocaleString("en-US")} bytes)`,
    );
  }
  logger.log(
    `Wasm: ${plan.transportWasmSha256} (${plan.transportWasmBytes.toLocaleString("en-US")} compressed bytes, ${plan.chunkHashes.length} chunks)`,
  );
  logger.log(
    `Wasm metadata: ${plan.wasmMetadata.sectionName}=${plan.wasmMetadata.value} (${plan.wasmMetadata.sectionCount} section)`,
  );
  if (operation.existingState) {
    logger.log("Resume: continuing the exact active reinstall transaction");
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  const canonicalLeft = canonicalPrincipals(left);
  const canonicalRight = canonicalPrincipals(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((value, index) => value === canonicalRight[index])
  );
}
