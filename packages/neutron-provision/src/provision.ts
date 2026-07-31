import type { Identity } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { parseKernelRuntimeConfig } from "neutron-tools/src/runtime_config.js";
import {
  assertKernelPackageStateMatchesRuntime,
  buildPackagesInstallAssets,
  createJsonAsset,
  createTextAsset,
  uploadPreparedFiles,
  uploadStaticFileOperation,
  type KernelPackageInstaller,
  type PreparedPackageFile,
} from "neutron-compiler/src/install.js";
import { assetUrl, readKernelPackageState } from "./kernel_state.ts";
import {
  initializePublicationEntropy,
  type KernelActor,
} from "./kernel.ts";
import {
  assertPackageArtifactsMatchExpectedArtifacts,
  assertPreparedDeploymentTarget,
  assertPreparedDeploymentMatchesExpectedArtifacts,
  buildFreshInstallProvenance,
  prepareDeployment,
  sha256,
  sha256Hex,
  snapshotExpectedPackageArtifacts,
  type PinnedPackageArtifact,
  type PreparedDeployment,
} from "./artifact.ts";
import {
  collectDeploymentObservationV1,
  createDeploymentEvidenceV1,
  persistDeploymentProofBundle,
  readDeploymentProofBundle,
  sweepUnreferencedDeploymentProofBundles,
  type DeploymentEvidenceProviderV1,
  type DeploymentObservationV1,
} from "./deployment_evidence.ts";
import {
  persistTransactionPayload,
  readTransactionPayload,
  removeTransactionPayload,
  serializeTransactionPayload,
  sweepUnreferencedTransactionPayloads,
  type SerializedTransactionPayload,
} from "./payload.ts";
import {
  bindDeploymentRuntimeConfig,
  deploymentRuntimeConfig,
} from "./runtime_config.ts";
import {
  canonicalNonAnonymousPrincipal,
  canonicalPrincipals,
  defaultIcpAccountIdentifier,
  formatIcp,
  IcProvisionClient,
  IcpTransferBadFeeError,
  type IcpFundingStatus,
  type ProvisionPreflight,
} from "./ic_client.ts";
import {
  loadExistingBlastIdentity,
  type BlastIdentity,
} from "./identity.ts";
import {
  assertSessionMatchesPlan,
  creationReceiptFingerprint,
  createProvisionJournal,
  currentDeployment,
  journalDeploymentProofDigests,
  readSession,
  sessionPlanFingerprint,
  withMainnetExecutionLock,
  withSessionLock,
  writeSession,
  type CreationState,
  type ProvisionJournal,
  type SessionPlan,
} from "./session.ts";

export const INSTALL_PROVENANCE_PATH = "/system/install-provenance.json";

export type ProvisionOptions = {
  configSha256: string;
  host: string;
  identityId: number;
  targetSubnet: string;
  amountE8s: bigint;
  expectedArtifacts: readonly PinnedPackageArtifact[];
  controllers: string[];
  sessionPath: string;
  execute: boolean;
};

export type ProvisionResult = {
  mode: "plan" | "executed";
  principal: string;
  plan: SessionPlan;
  preflight: ProvisionPreflight;
  session: ProvisionJournal | null;
};

export type ProvisionClient = Pick<
  IcProvisionClient,
  | "preflight"
  | "fundingStatus"
  | "transferCreationIcp"
  | "notifyCreateCanister"
  | "certifiedState"
  | "ensureControllers"
  | "installChunkedWasm"
  | "kernelActor"
  | "verifyInitialKernelAccess"
>;

export type FundingRequirement = IcpFundingStatus & {
  principal: string;
  accountIdentifier: string;
  amountE8s: bigint;
  requiredE8s: bigint;
  shortfallE8s: bigint;
};

export type ProvisionDependencies = {
  loadIdentity?: (id: number) => Promise<BlastIdentity>;
  /**
   * Prepared-deployment injection seam for unit tests. Production callers
   * should omit it; returned bytes are still reconciled to expectedArtifacts.
   */
  prepare?: (
    expectedArtifacts: readonly PinnedPackageArtifact[],
  ) => Promise<PreparedDeployment>;
  createClient?: (input: {
    host: string;
    identity: Identity;
    logger: Pick<Console, "log">;
  }) => Promise<ProvisionClient>;
  confirm?: (summary: {
    principal: string;
    subnet: string;
    amountE8s: bigint;
    feeE8s: bigint;
  }) => Promise<void>;
  waitForFunding?: (requirement: FundingRequirement) => Promise<void>;
  deploymentEvidenceProvider?: DeploymentEvidenceProviderV1;
  seed?: typeof seedFreshKernel;
  verify?: typeof verifyFreshKernel;
  now?: () => Date;
  logger?: Pick<Console, "log">;
};

export async function runProvision(
  options: ProvisionOptions,
  dependencies: ProvisionDependencies = {},
): Promise<ProvisionResult> {
  const expectedArtifacts = snapshotExpectedPackageArtifacts(
    options.expectedArtifacts,
  );
  validateOptions(options);
  const logger = dependencies.logger ?? console;
  const now = dependencies.now ?? (() => new Date());
  const loadIdentity = dependencies.loadIdentity ?? loadExistingBlastIdentity;
  const prepare =
    dependencies.prepare ??
    ((artifacts) => preparePinnedIcDeployment(artifacts));
  const identity = await loadIdentity(options.identityId);
  const initialControllers = canonicalPrincipals([
    identity.principal,
    ...options.controllers,
  ]);
  if (initialControllers.length > 9) {
    throw new Error(
      "At most nine initial controllers are allowed because Neutron adds itself as the tenth controller",
    );
  }
  const proceed = async (): Promise<ProvisionResult> => {
    let existingJournal = await readSession(options.sessionPath);
    assertProvisionJournalConfig(existingJournal, options.configSha256);
    assertNotAdopted(existingJournal);
    assertCreationCommandState(existingJournal);
    assertProvisionJournalExpectedArtifacts(
      existingJournal,
      expectedArtifacts,
    );
    if (options.execute) {
      existingJournal = await withSessionLock(options.sessionPath, async () => {
        const current = await readSession(options.sessionPath);
        assertProvisionJournalConfig(current, options.configSha256);
        assertNotAdopted(current);
        assertCreationCommandState(current);
        assertProvisionJournalExpectedArtifacts(
          current,
          expectedArtifacts,
        );
        const removed = await sweepUnreferencedTransactionPayloads(
          options.sessionPath,
          activeTransactionPayloadSha256(current),
        );
        if (removed > 0) {
          logger.log(
            `Removed ${removed} unreferenced transaction payload${removed === 1 ? "" : "s"}`,
          );
        }
        const removedProofs = await sweepUnreferencedDeploymentProofBundles(
          options.sessionPath,
          current ? journalDeploymentProofDigests(current) : [],
        );
        if (removedProofs > 0) {
          logger.log(
            `Removed ${removedProofs} unreferenced deployment proof bundle${removedProofs === 1 ? "" : "s"}`,
          );
        }
        return current;
      });
    }
    if (existingJournal?.active?.kind === "create" && existingJournal.active.completedAt) {
      if (options.execute) {
        existingJournal = await finishCompletedCreationCleanup(
          options.sessionPath,
          existingJournal,
          now,
          logger,
        );
      }
    }

    const completedOrigin =
      existingJournal?.origin && !existingJournal.active
        ? existingJournal.origin
        : null;
    if (completedOrigin) {
      assertCreationConfigMatches(
        completedOrigin.plan,
        options,
        identity,
        initialControllers,
      );
      const client = await (dependencies.createClient ??
        ((input) => IcProvisionClient.create(input)))({
        host: options.host,
        identity: identity.identity,
        logger,
      });
      const preflight = await client.preflight({
        targetSubnet: options.targetSubnet,
        amountE8s: options.amountE8s,
        requireTargetEligible: false,
      });
      await verifyCompletedCreationReceipt({
        client,
        journal: existingJournal!,
        initialControllers,
        targetSubnet: options.targetSubnet,
      });
      printCompletedCreation(completedOrigin, logger);
      return {
        mode: options.execute ? "executed" : "plan",
        principal: identity.principal,
        plan: completedOrigin.plan,
        preflight,
        session: existingJournal,
      };
    }

    let newPayload: SerializedTransactionPayload | null = null;
    let newExpectedProofBundle: Uint8Array | null = null;
    let deployment: PreparedDeployment;
    let plan: SessionPlan;
    let existingCreation: CreationState | null = null;
    if (existingJournal) {
      const active = existingJournal.active;
      if (!active || active.kind !== "create") {
        throw new Error("Provision journal has no resumable creation transaction");
      }
      existingCreation = active.state;
      plan = active.state.plan;
      assertCreationConfigMatches(plan, options, identity, initialControllers);
      deployment = await readTransactionPayload({
        sessionPath: options.sessionPath,
        expectedSha256: plan.payload.sha256,
        packageProvenance: plan.packages,
      });
      assertPreparedDeploymentMatchesExpectedArtifacts(
        deployment,
        expectedArtifacts,
      );
      assertDeploymentMatchesCreationPlan(deployment, plan);
    } else {
      deployment = await prepare(expectedArtifacts);
      assertPreparedDeploymentMatchesExpectedArtifacts(
        deployment,
        expectedArtifacts,
      );
      newPayload = serializeTransactionPayload(deployment);
      const expected = await collectDeploymentObservationV1(
        requireDeploymentEvidenceProvider(dependencies),
        { subnetId: options.targetSubnet },
      );
      newExpectedProofBundle = expected.proofBundle;
      plan = buildSessionPlan({
        options,
        identity,
        deployment,
        initialControllers,
        payload: newPayload,
        deploymentEvidenceExpected: expected.observation,
      });
    }
    if (options.execute) {
      requireDeploymentEvidenceProvider(dependencies);
    }

    const client = await (dependencies.createClient ??
      ((input) => IcProvisionClient.create(input)))({
      host: options.host,
      identity: identity.identity,
      logger,
    });
    let preflight = await client.preflight({
      targetSubnet: options.targetSubnet,
      amountE8s: options.amountE8s,
      requireTargetEligible: existingJournal === null,
    });
    const fundingAccountIdentifier = defaultIcpAccountIdentifier(
      Principal.fromText(identity.principal),
    );
    printPlan({
      options,
      identity,
      deployment,
      plan,
      initialControllers,
      preflight,
      fundingAccountIdentifier,
      existingCreation,
      logger,
    });
    if (!options.execute) {
      return {
        mode: "plan",
        principal: identity.principal,
        plan,
        preflight,
        session: existingJournal,
      };
    }
    if (existingJournal === null) {
      preflight = await waitUntilFunded({
        client,
        preflight,
        principal: identity.principal,
        accountIdentifier: fundingAccountIdentifier,
        amountE8s: options.amountE8s,
        waitForFunding: dependencies.waitForFunding,
        logger,
      });
    }
    await dependencies.confirm?.({
      principal: identity.principal,
      subnet: options.targetSubnet,
      amountE8s: options.amountE8s,
      feeE8s: existingCreation
        ? BigInt(existingCreation.transfer.feeE8s)
        : preflight.ledgerFeeE8s,
    });

    const journal = await withSessionLock(options.sessionPath, async () => {
      let activeJournal = await readSession(options.sessionPath);
      if (activeJournal) {
        assertSessionMatchesPlan(activeJournal, plan);
        const active = requireActiveCreation(activeJournal);
        deployment = await readTransactionPayload({
          sessionPath: options.sessionPath,
          expectedSha256: active.plan.payload.sha256,
          packageProvenance: active.plan.packages,
        });
        assertPreparedDeploymentMatchesExpectedArtifacts(
          deployment,
          expectedArtifacts,
        );
        assertDeploymentMatchesCreationPlan(deployment, active.plan);
      } else {
        if (!newPayload) {
          throw new Error("Missing transaction payload for new creation journal");
        }
        if (!newExpectedProofBundle) {
          throw new Error("Missing expected deployment evidence for new creation");
        }
        const expectedProofPath = await persistDeploymentProofBundle(
          options.sessionPath,
          newExpectedProofBundle,
          plan.deploymentEvidenceExpected.evidenceSha256,
        );
        logger.log(
          `Persisted expected deployment proof ${expectedProofPath.path}`,
        );
        const payloadPath = await persistTransactionPayload(
          options.sessionPath,
          newPayload,
        );
        logger.log(`Persisted active transaction payload ${payloadPath}`);
        activeJournal = createProvisionJournal(
          options.configSha256,
          plan,
          preflight.ledgerFeeE8s,
          now(),
        );
        await writeSession(options.sessionPath, activeJournal, now());
        logger.log(`Created provision journal ${options.sessionPath}`);
      }

      const active = requireActiveCreation(activeJournal);
      if (!active.transfer.blockIndex) {
        logger.log(`Transferring ${formatIcp(options.amountE8s)} ICP to the CMC`);
        let block: bigint | undefined;
        for (let badFeeRetries = 0; block === undefined; ) {
          try {
            block = await client.transferCreationIcp({
              amountE8s: options.amountE8s,
              createdAtTimeNanos: BigInt(active.transfer.createdAtTimeNanos),
              feeE8s: BigInt(active.transfer.feeE8s),
            });
          } catch (error) {
            if (!(error instanceof IcpTransferBadFeeError)) throw error;
            if (
              error.expectedFeeE8s <= 0n ||
              error.expectedFeeE8s.toString() === active.transfer.feeE8s ||
              badFeeRetries >= 2
            ) {
              throw new Error(
                "ICP ledger fee kept changing; the uncommitted transfer was not retried",
                { cause: error },
              );
            }
            active.transfer.feeE8s = error.expectedFeeE8s.toString();
            await writeSession(options.sessionPath, activeJournal, now());
            badFeeRetries += 1;
            logger.log(
              `Ledger fee changed; persisted ${formatIcp(error.expectedFeeE8s)} ICP in the journal and retrying the same transfer`,
            );
          }
        }
        active.transfer.blockIndex = block.toString();
        await writeSession(options.sessionPath, activeJournal, now());
        logger.log(`ICP ledger block ${block}`);
      }

      if (!active.canisterId) {
        logger.log(`Creating canister on ${options.targetSubnet}`);
        active.canisterId = await client.notifyCreateCanister({
          blockIndex: BigInt(active.transfer.blockIndex),
          targetSubnet: options.targetSubnet,
          controllers: initialControllers,
        });
        await writeSession(options.sessionPath, activeJournal, now());
        logger.log(`Created canister ${active.canisterId}`);
      }
      const canisterId = active.canisterId;
      assertPreparedDeploymentTarget(deployment, canisterId);
      const createdState = await client.certifiedState(canisterId);
      if (createdState.subnetId !== options.targetSubnet) {
        throw new Error(
          `Created canister is certified on subnet ${createdState.subnetId}, expected ${options.targetSubnet}`,
        );
      }
      if (!active.controllersVerifiedAt) {
        await client.ensureControllers({ canisterId, initialControllers });
        active.controllersVerifiedAt = now().toISOString();
        await writeSession(options.sessionPath, activeJournal, now());
        logger.log("Verified deployer, backup, and Neutron self-controllers");
      }
      if (!active.wasmInstalledAt) {
        logger.log(
          `Installing ${deployment.transportWasm.byteLength.toLocaleString("en-US")} compressed Wasm bytes in ${deployment.chunks.length} chunk(s)`,
        );
        await client.installChunkedWasm({
          canisterId,
          chunks: deployment.chunks,
          transportWasmHash: sha256(deployment.transportWasm),
        });
        active.wasmInstalledAt = now().toISOString();
        await writeSession(options.sessionPath, activeJournal, now());
        logger.log("Verified installed Wasm hash");
      }
      const kernel = client.kernelActor(canisterId);
      bindDeploymentRuntimeConfig({ deployment, canisterId, target: "ic" });
      if (!active.assetsSeededAt) {
        await (dependencies.seed ?? seedFreshKernel)({
          actor: kernel,
          canisterId,
          deployment,
          logger,
        });
        active.assetsSeededAt = now().toISOString();
        await writeSession(options.sessionPath, activeJournal, now());
      }
      if (!active.initialAccessVerifiedAt) {
        await client.verifyInitialKernelAccess(canisterId);
        active.initialAccessVerifiedAt = now().toISOString();
        await writeSession(options.sessionPath, activeJournal, now());
        logger.log("Verified the icblast deployer is the sole initial kernel principal");
      }
      const expectedControllers = canonicalPrincipals([
        ...initialControllers,
        canisterId,
      ]);
      if (!active.verifiedAt) {
        await (dependencies.verify ?? verifyFreshKernel)({
          actor: kernel,
          canisterId,
          host: options.host,
          deployment,
        });
        const finalState = await client.certifiedState(canisterId);
        if (
          finalState.subnetId !== options.targetSubnet ||
          !sameStrings(finalState.controllers, expectedControllers) ||
          finalState.moduleHash !== deployment.transportWasmSha256
        ) {
          throw new Error("Final certified canister state does not match deployment plan");
        }
        const expected = active.plan.deploymentEvidenceExpected;
        const expectedProofBundle = await readDeploymentProofBundle(
          options.sessionPath,
          expected.evidenceSha256,
        );
        const observed = await collectDeploymentObservationV1(
          requireDeploymentEvidenceProvider(dependencies),
          { subnetId: options.targetSubnet },
        );
        const evidence = createDeploymentEvidenceV1(
          expected,
          observed.observation,
          {
            expected: expectedProofBundle,
            observed: observed.proofBundle,
          },
        );
        const observedProofPath = await persistDeploymentProofBundle(
          options.sessionPath,
          observed.proofBundle,
          observed.observation.evidenceSha256,
        );
        logger.log(
          `Persisted observed deployment proof ${observedProofPath.path}`,
        );
        const postEvidenceState = await client.certifiedState(canisterId);
        if (
          postEvidenceState.subnetId !== options.targetSubnet ||
          !sameStrings(postEvidenceState.controllers, expectedControllers) ||
          postEvidenceState.moduleHash !== deployment.transportWasmSha256
        ) {
          throw new Error(
            "Final certified canister state changed during deployment evidence collection",
          );
        }
        active.deploymentEvidence = evidence;
        active.verifiedAt = now().toISOString();
        active.fingerprint = creationReceiptFingerprint(active);
      }
      const receiptState = await client.certifiedState(canisterId);
      if (
        receiptState.subnetId !== options.targetSubnet ||
        !sameStrings(receiptState.controllers, expectedControllers) ||
        receiptState.moduleHash !== deployment.transportWasmSha256
      ) {
        throw new Error(
          "Final certified canister state changed before receipt completion",
        );
      }

      const completedAt = now().toISOString();
      if (activeJournal.active?.kind !== "create") {
        throw new Error("Creation transaction disappeared before completion");
      }
      activeJournal.active.completedAt = completedAt;
      activeJournal.origin = active;
      activeJournal.current = currentDeployment(
        "create",
        active.plan,
        canisterId,
        completedAt,
        active.deploymentEvidence!,
        active.fingerprint!,
      );
      await writeSession(options.sessionPath, activeJournal, now());
      await removeTransactionPayload(
        options.sessionPath,
        active.plan.payload.sha256,
      );
      delete activeJournal.active;
      await writeSession(options.sessionPath, activeJournal, now());
      return activeJournal;
    });

    logger.log(`Neutron is ready at https://${journal.origin!.canisterId}.icp0.io/`);
    return {
      mode: "executed",
      principal: identity.principal,
      plan,
      preflight,
      session: journal,
    };
  };

  return options.execute
    ? withMainnetExecutionLock(identity.principal, proceed)
    : proceed();
}

function assertNotAdopted(journal: ProvisionJournal | null): void {
  if (journal?.adoption) {
    throw new Error(
      "This existing canister was adopted into this schema-3 journal. Use the reinstall command; create would pay for a different canister.",
    );
  }
}

function assertCreationCommandState(
  journal: ProvisionJournal | null,
): void {
  if (journal?.active?.kind === "reinstall") {
    throw new Error(
      journal.active.completedAt
        ? "The last whole-canister reinstall needs journal cleanup. Rerun the reinstall command with --execute."
        : "A whole-canister reinstall is unfinished. Resume the reinstall command before using the creation receipt.",
    );
  }
  if (journal?.current?.kind === "reinstall") {
    throw new Error(
      "This canister has been superseded by a whole-canister reinstall. Use the reinstall command for another reset; origin remains payment evidence only.",
    );
  }
}

function assertProvisionJournalExpectedArtifacts(
  journal: ProvisionJournal | null,
  expectedArtifacts: readonly PinnedPackageArtifact[],
): void {
  if (journal === null) return;
  const recorded =
    journal.active?.kind === "create"
      ? journal.active.state.plan.packages
      : journal.origin?.plan.packages;
  if (recorded !== undefined) {
    assertPackageArtifactsMatchExpectedArtifacts(
      recorded,
      expectedArtifacts,
    );
  }
}

export async function seedFreshKernel({
  actor,
  canisterId,
  deployment,
  concurrency,
  logger = console,
}: {
  actor: KernelActor;
  canisterId: string;
  deployment: PreparedDeployment;
  concurrency?: number;
  logger?: Pick<Console, "log">;
}): Promise<void> {
  await initializePublicationEntropy(actor);
  logger.log("Clearing the empty kernel asset namespace");
  await actor.kernel_static({ clear: { prefix: "" } });
  await uploadPreparedFiles(actor, uniquePreparedFiles(deployment), {
    ...(concurrency === undefined ? {} : { concurrency }),
    onProgress(progress) {
      if (progress.type === "file") logger.log(`Uploaded ${progress.key}`);
    },
  });
  const assets = buildPackagesInstallAssets({
    existingApps: {},
    packages: deployment.packages,
    candid: deployment.compiled.candid,
  });
  await uploadStaticFileOperation(actor, assets.candidAsset);
  await uploadStaticFileOperation(actor, assets.appRegistryAsset);
  await uploadStaticFileOperation(
    actor,
    createJsonAsset(
      INSTALL_PROVENANCE_PATH,
      buildFreshInstallProvenance(deployment),
    ),
  );
  await uploadStaticFileOperation(
    actor,
    createTextAsset(
      "/pkg/neutron.most",
      deployment.compiled.stable,
      "text/plain",
    ),
  );
  await uploadStaticFileOperation(
    actor,
    createJsonAsset("/pkg/id.json", { id: canisterId }),
  );
  logger.log("Seeded certified package assets");
}

/** Complete final key set produced by `seedFreshKernel`. */
export function freshKernelAssetKeys(
  deployment: PreparedDeployment,
): string[] {
  const keys = new Set(
    uniquePreparedFiles(deployment).map(({ path: assetPath }) =>
      normalizedStaticKey(assetPath),
    ),
  );
  for (const key of [
    "/pkg/neutron.did",
    "/system/apps.json",
    INSTALL_PROVENANCE_PATH,
    "/pkg/neutron.most",
    "/pkg/id.json",
  ]) {
    keys.add(key);
  }
  return [...keys].sort();
}

/**
 * Expected content-addressed Motoko sources, checked locally by digest before
 * they are trusted as verification inputs. The exact installed key set is
 * checked separately against the canister.
 */
export function freshKernelModuleContents(
  deployment: PreparedDeployment,
): ReadonlyMap<string, string> {
  const modules = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const file of uniquePreparedFiles(deployment)) {
    const key = normalizedStaticKey(file.path);
    const match = key.match(/^\/mo\/([a-f0-9]{64})\.mo$/);
    if (match === null) continue;
    const expectedHash = match[1]!;
    const actualHash = sha256Hex(file.content);
    if (actualHash !== expectedHash) {
      throw new Error(
        `Prepared Motoko source ${key} hashes to ${actualHash}, expected ${expectedHash}`,
      );
    }
    let content: string;
    try {
      content = decoder.decode(file.content);
    } catch (error) {
      throw new Error(`Prepared Motoko source ${key} is not UTF-8`, {
        cause: error,
      });
    }
    modules.set(key, content);
  }
  return modules;
}

function normalizedStaticKey(assetPath: string): string {
  if (assetPath.startsWith("/")) return assetPath;
  return assetPath === "index.html" ? "/" : `/${assetPath}`;
}

function uniquePreparedFiles(
  deployment: PreparedDeployment,
): PreparedPackageFile[] {
  const files = new Map<string, PreparedPackageFile>();
  for (const preparedPackage of deployment.packages) {
    for (const file of preparedPackage.files) {
      const existing = files.get(file.path);
      if (existing === undefined) {
        files.set(file.path, file);
        continue;
      }
      if (!equalBytes(existing.content, file.content)) {
        throw new Error(`Prepared packages disagree on asset ${file.path}`);
      }
    }
  }
  return [...files.values()];
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

export async function verifyFreshKernel({
  actor,
  canisterId,
  host,
  deployment,
  fetchImpl = fetch,
}: {
  actor: KernelPackageInstaller;
  canisterId: string;
  host: string;
  deployment: PreparedDeployment;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const runtime = await actor.kernel_runtime_info();
  if (runtime.deployment_id !== deployment.compiled.deploymentId) {
    throw new Error(
      `Runtime deployment ${runtime.deployment_id} does not match ${deployment.compiled.deploymentId}`,
    );
  }
  if (runtime.compiler_id !== deployment.compiled.compilerId) {
    throw new Error(
      `Runtime compiler ${runtime.compiler_id} does not match ${deployment.compiled.compilerId}`,
    );
  }
  const state = await readKernelPackageState({
    actor,
    canisterId,
    host,
    local: false,
    fetchImpl,
  });
  assertKernelPackageStateMatchesRuntime(state, runtime);
  const [id, candid, stable, installProvenance, runtimeConfigSource, browserHtml] = await Promise.all([
    fetchKernelJson<{ id?: unknown }>({
      canisterId,
      host,
      path: "/pkg/id.json",
      fetchImpl,
    }),
    fetchKernelText({
      canisterId,
      host,
      path: "/pkg/neutron.did",
      fetchImpl,
    }),
    fetchKernelText({
      canisterId,
      host,
      path: "/pkg/neutron.most",
      fetchImpl,
    }),
    fetchKernelJson<unknown>({
      canisterId,
      host,
      path: INSTALL_PROVENANCE_PATH,
      fetchImpl,
    }),
    fetchKernelText({
      canisterId,
      host,
      path: "/system/runtime-config.json",
      fetchImpl,
    }),
    fetchKernelText({
      canisterId,
      host,
      path: "/",
      fetchImpl,
    }),
  ]);
  if (id?.id !== canisterId) throw new Error("Certified /pkg/id.json is incorrect");
  if (candid !== deployment.compiled.candid) {
    throw new Error("Certified Candid does not match the compiled actor");
  }
  if (stable !== deployment.compiled.stable) {
    throw new Error("Certified stable-memory schema does not match the compile");
  }
  assertFreshInstallProvenance(installProvenance, deployment);
  const runtimeConfig = parseKernelRuntimeConfig(runtimeConfigSource);
  const expectedRuntimeConfig = deploymentRuntimeConfig({
    deployment,
    canisterId,
    target: "ic",
  });
  if (JSON.stringify(runtimeConfig) !== JSON.stringify(expectedRuntimeConfig)) {
    throw new Error("Certified runtime config does not match the IC deployment");
  }
  if (browserHtml.trim().length === 0) {
    throw new Error("Certified Neutron browser entrypoint is empty");
  }
}

async function fetchKernelText(input: {
  canisterId: string;
  host: string;
  path: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const { fetchImpl = fetch, ...asset } = input;
  const url = assetUrl({ ...asset, local: false });
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.text();
}

async function fetchKernelJson<T>(input: {
  canisterId: string;
  host: string;
  path: string;
  fetchImpl?: typeof fetch;
}): Promise<T> {
  return JSON.parse(await fetchKernelText(input)) as T;
}

export function assertFreshInstallProvenance(
  value: unknown,
  deployment: Pick<PreparedDeployment, "packages" | "packageArtifacts">,
): void {
  const expected = buildFreshInstallProvenance(deployment);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(value, "format") ||
    !Object.prototype.hasOwnProperty.call(value, "apps")
  ) {
    throw new Error(
      "Certified install provenance does not match the fresh package archives",
    );
  }
  const journal = value as { format?: unknown; apps?: unknown };
  if (
    journal.format !== 1 ||
    typeof journal.apps !== "object" ||
    journal.apps === null ||
    Array.isArray(journal.apps)
  ) {
    throw new Error(
      "Certified install provenance does not match the fresh package archives",
    );
  }
  const apps = journal.apps as Record<string, unknown>;
  const expectedIds = Object.keys(expected.apps);
  const actualIds = Object.keys(apps).sort();
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((appId, index) => appId !== expectedIds[index])
  ) {
    throw new Error(
      "Certified install provenance does not match the fresh package archives",
    );
  }
  for (const appId of expectedIds) {
    const entry = apps[appId];
    const expectedEntry = expected.apps[appId]!;
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(entry, "kind") ||
      !Object.prototype.hasOwnProperty.call(entry, "package_digest") ||
      (entry as { kind?: unknown }).kind !== expectedEntry.kind ||
      (entry as { package_digest?: unknown }).package_digest !==
        expectedEntry.package_digest
    ) {
      throw new Error(
        "Certified install provenance does not match the fresh package archives",
      );
    }
  }
}

export function buildSessionPlan({
  options,
  identity,
  deployment,
  initialControllers,
  payload,
  deploymentEvidenceExpected,
}: {
  options: ProvisionOptions;
  identity: BlastIdentity;
  deployment: PreparedDeployment;
  initialControllers: string[];
  payload: SerializedTransactionPayload;
  deploymentEvidenceExpected: DeploymentObservationV1;
}): SessionPlan {
  const base = {
    host: options.host,
    identityId: options.identityId,
    deployerPrincipal: identity.principal,
    targetSubnet: options.targetSubnet,
    amountE8s: options.amountE8s.toString(),
    initialControllers,
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
    deploymentEvidenceExpected,
  };
  return {
    ...base,
    fingerprint: sessionPlanFingerprint(base),
  };
}

function requireDeploymentEvidenceProvider(
  dependencies: ProvisionDependencies,
): DeploymentEvidenceProviderV1 {
  if (!dependencies.deploymentEvidenceProvider) {
    throw new Error(
      "A certified deployment evidence provider is required for a new production provision",
    );
  }
  return dependencies.deploymentEvidenceProvider;
}

function preparePinnedIcDeployment(
  expectedArtifacts: readonly PinnedPackageArtifact[],
): Promise<PreparedDeployment> {
  return prepareDeployment(
    expectedArtifacts.map(({ path }) => path),
    {
      target: "production",
      expectedArtifacts,
    },
  );
}

function validateOptions(options: ProvisionOptions): void {
  canonicalNonAnonymousPrincipal(options.targetSubnet, "Target subnet");
  for (const controller of options.controllers) {
    canonicalNonAnonymousPrincipal(controller, "Controller");
  }
  if (options.amountE8s <= 0n) throw new Error("--icp must be greater than zero");
}

function printPlan({
  options,
  identity,
  deployment,
  plan,
  initialControllers,
  preflight,
  fundingAccountIdentifier,
  existingCreation,
  logger,
}: {
  options: ProvisionOptions;
  identity: BlastIdentity;
  deployment: PreparedDeployment;
  plan: SessionPlan;
  initialControllers: string[];
  preflight: ProvisionPreflight;
  fundingAccountIdentifier: string;
  existingCreation: CreationState | null;
  logger: Pick<Console, "log">;
}): void {
  logger.log(options.execute ? "Neutron production provision" : "Neutron production plan (read-only)");
  logger.log(`Blast identity: ${options.identityId} (${identity.principal})`);
  logger.log(`ICP funding account ID: ${fundingAccountIdentifier}`);
  logger.log(`ICRC-1 funding account (same account): ${identity.principal}`);
  logger.log(`Blast secret: ${identity.secretPath}`);
  logger.log(`Target subnet: ${options.targetSubnet}`);
  const ledgerFeeE8s = existingCreation
    ? BigInt(existingCreation.transfer.feeE8s)
    : preflight.ledgerFeeE8s;
  logger.log(
    `CMC payment: ${formatIcp(options.amountE8s)} ICP + ${formatIcp(ledgerFeeE8s)} ICP ledger fee${existingCreation ? " (persisted in journal)" : ""}`,
  );
  logger.log(`Current balance: ${formatIcp(preflight.ledgerBalanceE8s)} ICP`);
  if (
    existingCreation === null &&
    preflight.ledgerBalanceE8s <
    options.amountE8s + preflight.ledgerFeeE8s
  ) {
    logger.log(
      `Funding required before --execute: ${formatIcp(options.amountE8s + preflight.ledgerFeeE8s - preflight.ledgerBalanceE8s)} ICP`,
    );
  }
  logger.log(`Estimated minted cycles: ${formatTrillionCycles(preflight.estimatedCycles)}`);
  const expectedEvidence = plan.deploymentEvidenceExpected;
  logger.log(
    `Deployment evidence: ${expectedEvidence.subnetType}, ${expectedEvidence.nodeCount} nodes, SEV ${expectedEvidence.sevEnabled ? "enabled" : "disabled"}, registry ${expectedEvidence.registryVersion}`,
  );
  logger.log(`Controllers: ${initialControllers.join(", ")} + Neutron self`);
  logger.log(`Initial kernel principal: ${identity.principal} (icblast deployer)`);
  for (const pkg of deployment.packageArtifacts) {
    logger.log(
      `Package: ${pkg.id} v${pkg.version} ${pkg.sha256.slice(0, 16)}… (${pkg.bytes.toLocaleString("en-US")} bytes)`,
    );
  }
  logger.log(
    `Wasm: ${deployment.transportWasmSha256} (${deployment.transportWasm.byteLength.toLocaleString("en-US")} compressed bytes, ${deployment.chunks.length} chunks)`,
  );
  logger.log(
    `Wasm metadata: ${deployment.wasmMetadata.sectionName}=${deployment.wasmMetadata.value} (${deployment.wasmMetadata.sectionCount} section)`,
  );
  if (existingCreation) {
    logger.log(
      `Resume: ${existingCreation.canisterId ?? `ledger block ${existingCreation.transfer.blockIndex ?? "pending"}`}`,
    );
  }
}

async function finishCompletedCreationCleanup(
  sessionPath: string,
  expected: ProvisionJournal,
  now: () => Date,
  logger: Pick<Console, "log">,
): Promise<ProvisionJournal> {
  return withSessionLock(sessionPath, async () => {
    const journal = await readSession(sessionPath);
    if (!journal) throw new Error("Provision journal disappeared during cleanup");
    const active = journal.active;
    if (!active || active.kind !== "create" || !active.completedAt) {
      if (!journal.active && journal.origin) return journal;
      throw new Error("Provision journal changed during completed creation cleanup");
    }
    if (
      expected.active?.kind !== "create" ||
      expected.active.state.plan.fingerprint !== active.state.plan.fingerprint
    ) {
      throw new Error("Provision journal changed before completed creation cleanup");
    }
    await removeTransactionPayload(sessionPath, active.state.plan.payload.sha256);
    delete journal.active;
    await writeSession(sessionPath, journal, now());
    logger.log("Removed completed creation transaction payload");
    return journal;
  });
}

function requireActiveCreation(journal: ProvisionJournal): CreationState {
  if (!journal.active || journal.active.kind !== "create" || journal.active.completedAt) {
    throw new Error("Provision journal has no unfinished creation transaction");
  }
  return journal.active.state;
}

function assertProvisionJournalConfig(
  journal: ProvisionJournal | null,
  configSha256: string,
): void {
  if (
    journal &&
    (journal.configSha256 !== configSha256 || journal.runtime.kind !== "ic")
  ) {
    throw new Error("Deployment config or runtime does not match provision journal");
  }
}

function activeTransactionPayloadSha256(
  journal: ProvisionJournal | null,
): string | undefined {
  const active = journal?.active;
  return active && active.kind !== "local-reinstall"
    ? active.state.plan.payload.sha256
    : undefined;
}

function assertCreationConfigMatches(
  plan: SessionPlan,
  options: ProvisionOptions,
  identity: BlastIdentity,
  initialControllers: string[],
): void {
  if (
    plan.identityId !== options.identityId ||
    plan.deployerPrincipal !== identity.principal ||
    plan.targetSubnet !== options.targetSubnet ||
    plan.amountE8s !== options.amountE8s.toString() ||
    !sameStrings(plan.initialControllers, initialControllers)
  ) {
    throw new Error(
      "Configured identity, subnet, payment, or controllers do not match the provision journal",
    );
  }
}

function assertDeploymentMatchesCreationPlan(
  deployment: PreparedDeployment,
  plan: SessionPlan,
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
    throw new Error("Active transaction payload does not match creation plan");
  }
}

function sameWasmMetadata(
  left: PreparedDeployment["wasmMetadata"],
  right: SessionPlan["wasmMetadata"],
): boolean {
  return (
    left.sectionName === right.sectionName &&
    left.sectionCount === right.sectionCount &&
    left.value === right.value
  );
}

async function verifyCompletedCreationReceipt({
  client,
  journal,
  initialControllers,
  targetSubnet,
}: {
  client: ProvisionClient;
  journal: ProvisionJournal;
  initialControllers: string[];
  targetSubnet: string;
}): Promise<void> {
  const origin = journal.origin;
  const current = journal.current;
  if (!origin?.canisterId || !current || current.kind !== "create") {
    throw new Error("Provision journal has no completed creation receipt");
  }
  const certified = await client.certifiedState(origin.canisterId);
  const expectedControllers = canonicalPrincipals([
    ...initialControllers,
    origin.canisterId,
  ]);
  if (
    certified.subnetId !== targetSubnet ||
    !sameStrings(certified.controllers, expectedControllers) ||
    certified.moduleHash !== current.transportWasmSha256
  ) {
    throw new Error("Live canister does not match completed creation receipt");
  }
}

function printCompletedCreation(
  origin: CreationState,
  logger: Pick<Console, "log">,
): void {
  logger.log("Neutron production provision receipt");
  logger.log(`Canister: ${origin.canisterId}`);
  logger.log(`Ledger block: ${origin.transfer.blockIndex}`);
  logger.log(`Deployment: ${origin.plan.deploymentId}`);
  logger.log(
    `Wasm metadata: ${origin.plan.wasmMetadata.sectionName}=${origin.plan.wasmMetadata.value} (${origin.plan.wasmMetadata.sectionCount} section)`,
  );
  logger.log(
    `Status: certified deployment evidence ${origin.deploymentEvidence!.fingerprint}; no transaction payload retained`,
  );
}

async function waitUntilFunded({
  client,
  preflight,
  principal,
  accountIdentifier,
  amountE8s,
  waitForFunding,
  logger,
}: {
  client: ProvisionClient;
  preflight: ProvisionPreflight;
  principal: string;
  accountIdentifier: string;
  amountE8s: bigint;
  waitForFunding: ProvisionDependencies["waitForFunding"];
  logger: Pick<Console, "log">;
}): Promise<ProvisionPreflight> {
  let current = preflight;
  for (;;) {
    const requiredE8s = amountE8s + current.ledgerFeeE8s;
    if (current.ledgerBalanceE8s >= requiredE8s) return current;
    const requirement: FundingRequirement = {
      principal,
      accountIdentifier,
      amountE8s,
      ledgerBalanceE8s: current.ledgerBalanceE8s,
      ledgerFeeE8s: current.ledgerFeeE8s,
      requiredE8s,
      shortfallE8s: requiredE8s - current.ledgerBalanceE8s,
    };
    if (!waitForFunding) {
      throw new Error(
        `Blast identity needs ${formatIcp(requirement.shortfallE8s)} more ICP. Send ICP to ${accountIdentifier} (principal ${principal}), then rerun the same command.`,
      );
    }
    await waitForFunding(requirement);
    const funding = await client.fundingStatus();
    current = { ...current, ...funding };
    logger.log(
      `Funding check: ${formatIcp(funding.ledgerBalanceE8s)} ICP available; current ledger fee ${formatIcp(funding.ledgerFeeE8s)} ICP`,
    );
  }
}

function formatTrillionCycles(cycles: bigint): string {
  const whole = cycles / 1_000_000_000_000n;
  const fraction = ((cycles % 1_000_000_000_000n) / 100_000_000n)
    .toString()
    .padStart(4, "0");
  return `${whole}.${fraction} TC`;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
