import { createHash } from "node:crypto";
import {
  CERTIFIED_ASSETS_QUALIFICATION_CASES,
  CERTIFIED_ASSETS_QUALIFICATION_CONTRACT,
  type CertifiedAssetsQualificationCaseId,
} from "neutron-tools/src/certified_assets_qualification.js";
import type { QualificationMethodName } from "./idl.ts";
import {
  exactExpressionPath,
  hostBoundAbsenceHeaders,
  portableAbsenceHeaders,
  portableHeaders,
  publicationHeaders,
  wildcardExpressionPath,
  type ExpectedCertifiedHttpResponse,
} from "./http_v2.ts";
import type {
  CertifiedHttpObservation,
  RawCandidObservation,
} from "./receipt.ts";

export type SampleLogicalMethod =
  | QualificationMethodName
  | "kernel_diagnostics"
  | "kernel_app_usage";

export type SingleScopeQualificationCaseId = Exclude<
  CertifiedAssetsQualificationCaseId,
  "global_stage_admission" | "scope_isolation"
>;

/**
 * The case layer knows only logical qualification methods and public HTTP.
 * Physical method names, Candid encoding, raw observations, and canister
 * transport stay in the launcher.
 */
export interface SampleRuntime {
  readonly canisterId: string;
  readonly gatewayOrigin: string;
  readonly observations: {
    readonly candid: readonly RawCandidObservation[];
    readonly http: readonly CertifiedHttpObservation[];
  };
  call(method: SampleLogicalMethod, args: readonly unknown[]): Promise<unknown>;
  generation(collection: string): Promise<bigint>;
  deterministicBytes(step: number, length: number): Uint8Array;
  verifyHttp(
    expected: ExpectedCertifiedHttpResponse,
  ): Promise<CertifiedHttpObservation>;
}

export type Dict = Record<string, unknown>;
type Target = Readonly<{
  collection: string;
  collection_generation: bigint;
  locator:
    | { publication: { publication_id: Uint8Array; filename: string } }
    | { body_sha256: { digest: Uint8Array } }
    | { key32: { key: Uint8Array } }
    | { exact_path: null };
}>;
type Identity = Readonly<{
  target: Target;
  kernel_revision: bigint;
  content_tag: Uint8Array;
  body_bytes: bigint;
  geometry: Dict;
  block_hashes: readonly Uint8Array[];
}>;
type Geometry = Readonly<{
  blockBytes: number;
  blockCount: number;
  expectedBytes: number;
}>;
type BegunStage = Readonly<{
  id: bigint;
  geometry: Geometry;
  computedTarget: Target | null;
  mode: "publication" | "digest";
  collection: string;
  generation: bigint;
}>;
type UploadedStage = Readonly<{
  begun: BegunStage;
  target: Target;
  rawDigest: Uint8Array;
  blockLengths: readonly number[];
}>;
type Publication = Readonly<{
  target: Target;
  identity: Identity;
  path: string;
  body: Uint8Array;
  blockBytes: number;
  blockLengths: readonly number[];
}>;
type RejectionState = Readonly<{
  usage: Dict;
  diagnostics: Dict;
  records: readonly unknown[];
  stages: readonly unknown[];
}>;

const workload = CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.workload;
const EMPTY = new Uint8Array();
const COLLECTION = {
  publication: "publication",
  immutable: "immutable",
  mutableKey: "mutable_key",
  mutableExact: "mutable_exact",
} as const;
const MOUNT = {
  publication: "download",
  portable: "portable",
} as const;
const CHURN_RECORD_COUNT = 4;

export async function executeQualificationCase(
  runtime: SampleRuntime,
  caseId: SingleScopeQualificationCaseId,
  appId: string,
): Promise<readonly string[]> {
  assertFixtureAppId(appId);
  const executor = EXECUTORS[caseId];
  if (executor === undefined) {
    throw new Error(`Unknown Certified Assets qualification case ${caseId}`);
  }
  await executor(runtime, appId);
  const definition = CERTIFIED_ASSETS_QUALIFICATION_CASES.find(
    ({ id }) => id === caseId,
  );
  if (definition === undefined) {
    throw new Error(`Qualification contract omitted case ${caseId}`);
  }
  return [...definition.checkpoints];
}

const EXECUTORS: Readonly<
  Record<
    SingleScopeQualificationCaseId,
    (runtime: SampleRuntime, appId: string) => Promise<void>
  >
> = {
  publication_lifecycle: publicationLifecycle,
  publication_certified_reads: publicationCertifiedReads,
  immutable_inline_lifecycle: immutableInlineLifecycle,
  immutable_staged_lifecycle: immutableStagedLifecycle,
  mutable_key_cas: (runtime, appId) =>
    mutableCas(runtime, appId, "keyed"),
  mutable_exact_cas: (runtime, appId) =>
    mutableCas(runtime, appId, "exact"),
  portable_certified_reads: portableCertifiedReads,
  idempotency_conflict: idempotencyConflict,
  logical_quota_rejection: logicalQuotaRejection,
  allocator_churn: allocatorChurn,
};

async function publicationLifecycle(
  runtime: SampleRuntime,
  appId: string,
): Promise<void> {
  const body = deterministic(
    runtime,
    1,
    workload.publication_body_bytes,
  );
  const publication = await createPublication(
    runtime,
    appId,
    body,
    "sample.bin",
    2,
    true,
  );
  if (publication.blockLengths.length < 2) {
    throw new Error("Maximum publication did not span multiple blocks");
  }
  await assertPresent(runtime, publication.target, publication.identity);

  const firstLength = publication.blockLengths[0]!;
  const reassembled = new Uint8Array(body.byteLength);
  const first = await runtime.verifyHttp({
    canisterId: runtime.canisterId,
    url: httpUrl(runtime, publication.path),
    method: "GET",
    status: 206,
    authority: "host_bound",
    expressionPath: exactExpressionPath(publication.path),
    headers: publicationHeaders({
      contentTag: publication.identity.content_tag,
      contentLength: firstLength,
      contentRange: `bytes 0-${firstLength - 1}/${body.byteLength}`,
      filename: "sample.bin",
    }),
    body: body.subarray(0, firstLength),
    requestHeaders: [["Range", `bytes=0-${firstLength - 1}`]],
  });
  reassembled.set(
    observedBody(
      first,
      body.subarray(0, firstLength),
      "publication block 0",
    ),
    0,
  );
  await runtime.verifyHttp({
    canisterId: runtime.canisterId,
    url: httpUrl(runtime, publication.path),
    method: "HEAD",
    status: 200,
    authority: "host_bound",
    expressionPath: exactExpressionPath(publication.path),
    headers: publicationHeaders({
      contentTag: publication.identity.content_tag,
      contentLength: body.byteLength,
      filename: "sample.bin",
    }),
    body: EMPTY,
  });

  let offset = firstLength;
  for (let index = 1; index < publication.blockLengths.length; index += 1) {
    const length = publication.blockLengths[index]!;
    const observation = await runtime.verifyHttp({
      canisterId: runtime.canisterId,
      url: httpUrl(runtime, publication.path),
      method: "GET",
      status: 206,
      authority: "host_bound",
      expressionPath: exactExpressionPath(publication.path),
      headers: publicationHeaders({
        contentTag: publication.identity.content_tag,
        contentLength: length,
        contentRange:
          `bytes ${offset}-${offset + length - 1}/${body.byteLength}`,
        filename: "sample.bin",
      }),
      body: body.subarray(offset, offset + length),
      requestHeaders: [["Range", `bytes=${offset}-${offset}`]],
    });
    reassembled.set(
      observedBody(
        observation,
        body.subarray(offset, offset + length),
        `publication block ${index}`,
      ),
      offset,
    );
    offset += length;
  }
  if (offset !== body.byteLength || !equalBytes(reassembled, body)) {
    throw new Error("Maximum publication range reassembly changed its body");
  }

  await deleteTarget(runtime, publication.target, publication.identity, 4);
  await assertDeleted(runtime, publication.target);
  await assertHostBoundAbsence(runtime, appId, publication.path);
}

async function publicationCertifiedReads(
  runtime: SampleRuntime,
  appId: string,
): Promise<void> {
  const singleBody = deterministic(runtime, 10, 65_536);
  const single = await createPublication(
    runtime,
    appId,
    singleBody,
    "single.bin",
    11,
    true,
  );
  if (single.blockLengths.length !== 1) {
    throw new Error("Small publication did not use one block");
  }
  await runtime.verifyHttp({
    canisterId: runtime.canisterId,
    url: httpUrl(runtime, single.path),
    method: "GET",
    status: 200,
    authority: "host_bound",
    expressionPath: exactExpressionPath(single.path),
    headers: publicationHeaders({
      contentTag: single.identity.content_tag,
      contentLength: singleBody.byteLength,
      filename: "single.bin",
    }),
    body: singleBody,
  });

  const blockBytes = single.blockBytes;
  const rangedBody = deterministic(runtime, 14, blockBytes + 1);
  const ranged = await createPublication(
    runtime,
    appId,
    rangedBody,
    "range.bin",
    15,
    false,
  );
  if (ranged.blockLengths.length !== 2) {
    throw new Error("Range publication did not use exactly two blocks");
  }
  await runtime.verifyHttp({
    canisterId: runtime.canisterId,
    url: httpUrl(runtime, ranged.path),
    method: "GET",
    status: 206,
    authority: "host_bound",
    expressionPath: exactExpressionPath(ranged.path),
    headers: publicationHeaders({
      contentTag: ranged.identity.content_tag,
      contentLength: 1,
      contentRange: `bytes ${blockBytes}-${blockBytes}/${rangedBody.byteLength}`,
      filename: "range.bin",
    }),
    body: rangedBody.subarray(blockBytes),
    requestHeaders: [["Range", `bytes=${blockBytes}-`]],
  });
  await runtime.verifyHttp({
    canisterId: runtime.canisterId,
    url: httpUrl(runtime, ranged.path),
    method: "HEAD",
    status: 200,
    authority: "host_bound",
    expressionPath: exactExpressionPath(ranged.path),
    headers: publicationHeaders({
      contentTag: ranged.identity.content_tag,
      contentLength: rangedBody.byteLength,
      filename: "range.bin",
    }),
    body: EMPTY,
  });

  const missing = `${routeBase(appId, MOUNT.publication)}/missing`;
  await assertHostBoundAbsence(runtime, appId, missing);
}

async function immutableInlineLifecycle(
  runtime: SampleRuntime,
  appId: string,
): Promise<void> {
  const generation = await runtime.generation(COLLECTION.immutable);
  const body = deterministic(runtime, 20, workload.portable_body_bytes);
  const digest = sha256(body);
  const target = immutableTarget(generation, digest);
  const input = putInput(21, runtime, target, { absent: null }, {
    inline: body,
  });
  const receipt = expectOk(
    await runtime.call("qualification_commit_batch", [input]),
    "inline immutable commit",
  );
  const identity = putIdentity(receipt, "inline immutable commit");
  assertIdentity(identity, target, body);
  if (!equalBytes(identity.content_tag, digest)) {
    throw new Error("Immutable content tag was not derived from its body");
  }

  const replay = expectOk(
    await runtime.call("qualification_commit_batch", [input]),
    "inline immutable replay",
  );
  if (!equalValue(receipt, replay)) {
    throw new Error("Inline immutable replay changed its receipt");
  }

  const objectPath = immutablePath(appId, digest);
  await assertPortablePresent(
    runtime,
    objectPath,
    body,
    "immutable_blob",
  );
  await deleteTarget(runtime, target, identity, 22);
  await assertDeleted(runtime, target);
  await assertPortableAbsence(runtime, appId, objectPath);
}

async function immutableStagedLifecycle(
  runtime: SampleRuntime,
  appId: string,
): Promise<void> {
  const generation = await runtime.generation(COLLECTION.immutable);
  const body = deterministic(runtime, 30, workload.portable_body_bytes);
  const uploaded = await uploadStage(
    runtime,
    {
      derive_body_sha256: {
        collection: COLLECTION.immutable,
        collection_generation: generation,
      },
    },
    body,
    31,
    false,
  );
  const expectedTarget = immutableTarget(generation, sha256(body));
  assertTarget(uploaded.target, expectedTarget, "derived immutable target");
  if (!equalBytes(uploaded.rawDigest, sha256(body))) {
    throw new Error("Staged immutable digest did not match its body");
  }
  const identity = await commitPut(
    runtime,
    32,
    uploaded.target,
    { absent: null },
    { stage: uploaded.begun.id },
  );
  assertIdentity(identity, uploaded.target, body);
  await assertPortablePresent(
    runtime,
    immutablePath(appId, uploaded.rawDigest),
    body,
    "immutable_blob",
  );

  const mismatchBody = deterministic(runtime, 33, 65_536);
  const mismatch = await uploadStage(
    runtime,
    {
      derive_body_sha256: {
        collection: COLLECTION.immutable,
        collection_generation: generation,
      },
    },
    mismatchBody,
    34,
    false,
  );
  const wrongDigest = Uint8Array.from(mismatch.rawDigest);
  wrongDigest[0] = wrongDigest[0]! ^ 0xff;
  const wrongTarget = immutableTarget(generation, wrongDigest);
  expectError(
    await runtime.call("qualification_commit_batch", [
      putInput(35, runtime, wrongTarget, { absent: null }, {
        stage: mismatch.begun.id,
      }),
    ]),
    "conflict",
    "mismatched staged immutable digest",
  );
  expectOk(
    await runtime.call("qualification_abort_stage", [mismatch.begun.id]),
    "mismatched immutable stage abort",
  );
}

async function mutableCas(
  runtime: SampleRuntime,
  appId: string,
  locator: "keyed" | "exact",
): Promise<void> {
  const collection =
    locator === "keyed" ? COLLECTION.mutableKey : COLLECTION.mutableExact;
  const generation = await runtime.generation(collection);
  const target =
    locator === "keyed"
      ? mutableKeyTarget(
          generation,
          deterministic(runtime, 40, workload.keyed_locator_bytes),
        )
      : mutableExactTarget(generation);
  const firstBody = deterministic(runtime, 41, 65_536);
  const first = await commitPut(
    runtime,
    42,
    target,
    { absent: null },
    { inline: firstBody },
  );
  assertIdentity(first, target, firstBody);

  const secondBody = deterministic(runtime, 43, 65_537);
  const second = await commitPut(
    runtime,
    44,
    target,
    matchCondition(first),
    { inline: secondBody },
  );
  assertIdentity(second, target, secondBody);
  if (second.kernel_revision !== first.kernel_revision + 1n) {
    throw new Error("Mutable exact CAS did not advance one revision");
  }

  const stale = expectError(
    await runtime.call("qualification_commit_batch", [
      putInput(
        45,
        runtime,
        target,
        matchCondition(first),
        { inline: deterministic(runtime, 46, 32) },
      ),
    ]),
    "conflict",
    "stale mutable CAS",
  );
  assertConflictIdentity(stale, second);
  await assertPresent(runtime, target, second);

  const path =
    locator === "keyed"
      ? mutableKeyPath(
          appId,
          fixedBytes(
            record(
              variant(target.locator, "mutable key locator").key32,
              "mutable key locator",
            ).key,
            32,
            "mutable key",
          ),
        )
      : mutableExactPath(appId);
  await assertPortablePresent(runtime, path, secondBody, "mutable_blob");
  await deleteTarget(runtime, target, second, 47);
  await assertDeleted(runtime, target);
}

async function portableCertifiedReads(
  runtime: SampleRuntime,
  appId: string,
): Promise<void> {
  const generation = await runtime.generation(COLLECTION.immutable);
  const body = deterministic(runtime, 50, workload.portable_body_bytes);
  const digest = sha256(body);
  const target = immutableTarget(generation, digest);
  const identity = await commitPut(
    runtime,
    51,
    target,
    { absent: null },
    { inline: body },
  );
  assertIdentity(identity, target, body);
  await assertPortablePresent(
    runtime,
    immutablePath(appId, digest),
    body,
    "immutable_blob",
  );

  await assertPortableAbsence(runtime, appId, mutableExactPath(appId));
  const missingDigest = Uint8Array.from(digest);
  missingDigest[0] = missingDigest[0]! ^ 0xff;
  const wildcardMissing =
    `${routeBase(appId, MOUNT.portable)}/objects/${hex(missingDigest)}`;
  await assertPortableAbsence(runtime, appId, wildcardMissing);
}

async function idempotencyConflict(
  runtime: SampleRuntime,
  _appId: string,
): Promise<void> {
  const generation = await runtime.generation(COLLECTION.mutableExact);
  const target = mutableExactTarget(generation);
  const firstBody = deterministic(runtime, 60, 65_536);
  const input = putInput(
    61,
    runtime,
    target,
    { absent: null },
    { inline: firstBody },
  );
  const firstReceipt = expectOk(
    await runtime.call("qualification_commit_batch", [input]),
    "idempotency first commit",
  );
  const identity = putIdentity(firstReceipt, "idempotency first commit");
  const replay = expectOk(
    await runtime.call("qualification_commit_batch", [input]),
    "idempotency exact replay",
  );
  if (!equalValue(firstReceipt, replay)) {
    throw new Error("Identical nonce replay returned a different receipt");
  }

  const changed = {
    ...input,
    operations: [{
      put: {
        target,
        condition: { absent: null },
        body: { inline: deterministic(runtime, 62, 65_536) },
      },
    }],
  };
  const beforeConflict = await rejectionState(runtime, {
    targets: [target],
  });
  expectError(
    await runtime.call("qualification_commit_batch", [changed]),
    "conflict",
    "changed nonce replay",
  );
  assertNoStateDrift(
    beforeConflict,
    await rejectionState(runtime, { targets: [target] }),
    "changed nonce replay",
  );
  await assertPresent(runtime, target, identity);
}

async function logicalQuotaRejection(
  runtime: SampleRuntime,
  appId: string,
): Promise<void> {
  const immutableGeneration = await runtime.generation(COLLECTION.immutable);
  const firstStage = await beginStage(
    runtime,
    {
      derive_body_sha256: {
        collection: COLLECTION.immutable,
        collection_generation: immutableGeneration,
      },
    },
    1,
    70,
  );
  const beforeStageRejection = await rejectionState(runtime, {
    stages: [firstStage.id],
  });
  assertQuotaBoundary(beforeStageRejection.usage, "stages");
  expectError(
    await runtime.call("qualification_begin_stage", [{
      nonce: deterministic(runtime, 71, workload.nonce_bytes),
      target: {
        derive_body_sha256: {
          collection: COLLECTION.immutable,
          collection_generation: immutableGeneration,
        },
      },
      expected_bytes: 1n,
    }]),
    "quota",
    "pending-stage quota",
  );
  assertNoStateDrift(
    beforeStageRejection,
    await rejectionState(runtime, { stages: [firstStage.id] }),
    "pending-stage rejection",
  );
  expectOk(
    await runtime.call("qualification_abort_stage", [firstStage.id]),
    "quota stage abort",
  );

  const firstPublication = await createPublication(
    runtime,
    appId,
    deterministic(runtime, 72, workload.publication_body_bytes),
    "quota-a.bin",
    73,
    false,
  );
  await createPublication(
    runtime,
    appId,
    deterministic(runtime, 75, workload.publication_body_bytes),
    "quota-b.bin",
    76,
    false,
  );
  const mutableKeyGeneration = await runtime.generation(COLLECTION.mutableKey);
  const byteQuotaTarget = mutableKeyTarget(
    mutableKeyGeneration,
    deterministic(runtime, 78, workload.keyed_locator_bytes),
  );
  const beforeByteRejection = await rejectionState(runtime, {
    targets: [byteQuotaTarget],
  });
  assertQuotaBoundary(beforeByteRejection.usage, "committed_bytes");
  expectError(
    await runtime.call("qualification_commit_batch", [
      putInput(
        79,
        runtime,
        byteQuotaTarget,
        { absent: null },
        { inline: deterministic(runtime, 80, 1) },
      ),
    ]),
    "quota",
    "committed-byte quota",
  );
  assertNoStateDrift(
    beforeByteRejection,
    await rejectionState(runtime, { targets: [byteQuotaTarget] }),
    "committed-byte rejection",
  );

  await deleteTarget(
    runtime,
    firstPublication.target,
    firstPublication.identity,
    81,
  );
  await drainMaintenance(runtime);

  const entryState = await usage(runtime);
  const entryCounters = currentUsage(entryState);
  const entryLimit = nat(
    record(entryState.effective_limits, "effective limits").entries,
    "effective entry limit",
  );
  const occupied =
    nat(entryCounters.occupied_entry_slots, "occupied entry slots") +
    nat(entryCounters.reserved_entry_slots, "reserved entry slots");
  if (occupied >= entryLimit) {
    throw new Error(
      "Logical quota fixture has no entry slot for its mutable CAS probe",
    );
  }
  const additionsNeeded = safeNumber(
    entryLimit - occupied,
    "entry quota fill count",
  );
  const exactGeneration = await runtime.generation(COLLECTION.mutableExact);
  const exactTarget = mutableExactTarget(exactGeneration);
  let exactIdentity: Identity | null = null;
  const additions: Array<{ target: Target; body: Uint8Array }> = [{
    target: exactTarget,
    body: deterministic(runtime, 82, 1),
  }];
  for (let index = 0; index < additionsNeeded - 1; index += 1) {
    additions.push({
      target: mutableKeyTarget(
        mutableKeyGeneration,
        deterministic(
          runtime,
          100 + index,
          workload.keyed_locator_bytes,
        ),
      ),
      body: deterministic(runtime, 200 + index, 1),
    });
  }
  for (let offset = 0; offset < additions.length; offset += 16) {
    const page = additions.slice(offset, offset + 16);
    const receipt = expectOk(
      await runtime.call("qualification_commit_batch", [{
        nonce: deterministic(
          runtime,
          300 + offset,
          workload.nonce_bytes,
        ),
        operations: page.map(({ target, body }) => ({
          put: {
            target,
            condition: { absent: null },
            body: { inline: body },
          },
        })),
        requires_present_after: [],
      }]),
      "entry-quota fill",
    );
    const identities = putIdentities(receipt, "entry-quota fill");
    if (identities.length !== page.length) {
      throw new Error("Entry-quota fill returned the wrong operation count");
    }
    for (let index = 0; index < page.length; index += 1) {
      assertIdentity(identities[index]!, page[index]!.target, page[index]!.body);
      if (equalValue(page[index]!.target, exactTarget)) {
        exactIdentity = identities[index]!;
      }
    }
  }
  if (exactIdentity === null) {
    throw new Error("Entry-quota fill omitted its mutable exact record");
  }

  const entryQuotaTarget = mutableKeyTarget(
    mutableKeyGeneration,
    deterministic(runtime, 400, workload.keyed_locator_bytes),
  );
  const beforeEntryRejection = await rejectionState(runtime, {
    targets: [entryQuotaTarget],
  });
  assertQuotaBoundary(beforeEntryRejection.usage, "entries");
  expectError(
    await runtime.call("qualification_commit_batch", [
      putInput(
        401,
        runtime,
        entryQuotaTarget,
        { absent: null },
        { inline: deterministic(runtime, 402, 1) },
      ),
    ]),
    "quota",
    "entry quota",
  );
  assertNoStateDrift(
    beforeEntryRejection,
    await rejectionState(runtime, { targets: [entryQuotaTarget] }),
    "entry rejection",
  );

  const receiptFill = await usage(runtime);
  const receiptCounters = currentUsage(receiptFill);
  const receiptLimit = nat(
    record(receiptFill.effective_limits, "effective limits").general_receipts,
    "general receipt limit",
  );
  const receiptUsed =
    nat(receiptCounters.general_receipt_lanes, "general receipt lanes") +
    nat(
      receiptCounters.reserved_general_receipt_lanes,
      "reserved general receipt lanes",
    );
  if (receiptUsed > receiptLimit) {
    throw new Error("General receipt usage exceeded the synthetic quota");
  }
  const receiptFillCount = safeNumber(
    receiptLimit - receiptUsed,
    "general receipt fill count",
  );
  for (let receiptIndex = 0; receiptIndex < receiptFillCount; receiptIndex += 1) {
    const body = deterministic(runtime, 500 + receiptIndex, 1);
    exactIdentity = await commitPut(
      runtime,
      700 + receiptIndex,
      exactTarget,
      matchCondition(exactIdentity),
      { inline: body },
    );
  }
  await drainMaintenance(runtime);

  const beforeReceiptRejection = await rejectionState(runtime, {
    targets: [exactTarget],
  });
  assertQuotaBoundary(beforeReceiptRejection.usage, "receipts");
  expectError(
    await runtime.call("qualification_commit_batch", [
      putInput(
        900,
        runtime,
        exactTarget,
        matchCondition(exactIdentity),
        { inline: deterministic(runtime, 901, 1) },
      ),
    ]),
    "receipt_full",
    "general receipt quota",
  );
  assertNoStateDrift(
    beforeReceiptRejection,
    await rejectionState(runtime, { targets: [exactTarget] }),
    "receipt rejection",
  );
  await assertPresent(runtime, exactTarget, exactIdentity);
}

async function allocatorChurn(
  runtime: SampleRuntime,
  _appId: string,
): Promise<void> {
  const generation = await runtime.generation(COLLECTION.mutableKey);
  const targets = Array.from({ length: CHURN_RECORD_COUNT }, (_, index) =>
    mutableKeyTarget(
      generation,
      deterministic(runtime, 1_000 + index, workload.keyed_locator_bytes),
    )
  );
  let identities = await initializeChurn(runtime, targets, 1_010);
  let settledUsage = await usage(runtime);
  for (
    let round = 0;
    round < workload.churn_warmup_rounds;
    round += 1
  ) {
    const before = settledUsage;
    identities = await churnRound(
      runtime,
      targets,
      identities,
      1_100 + round * 20,
    );
    settledUsage = await usage(runtime);
    assertReceiptRetentionGrowth(before, settledUsage);
  }
  const baselineUsage = bodyUsagePlateau(settledUsage);
  assertSettledChurnUsage(baselineUsage);
  const baselineDiagnostics = diagnosticsPlateau(await diagnostics(runtime));

  for (
    let round = 0;
    round < workload.churn_measured_rounds;
    round += 1
  ) {
    identities = await churnRound(
      runtime,
      targets,
      identities,
      1_200 + round * 20,
    );
    const nextSettledUsage = await usage(runtime);
    assertReceiptRetentionGrowth(settledUsage, nextSettledUsage);
    settledUsage = nextSettledUsage;
    const nextUsage = bodyUsagePlateau(nextSettledUsage);
    const nextDiagnostics = diagnosticsPlateau(await diagnostics(runtime));
    if (!equalValue(nextUsage, baselineUsage)) {
      throw new Error("Allocator churn body usage did not plateau");
    }
    if (
      !equalValue(nextDiagnostics.allocator, baselineDiagnostics.allocator)
    ) {
      throw new Error("Allocator churn live allocation did not plateau");
    }
    if (!equalValue(nextDiagnostics.forest, baselineDiagnostics.forest)) {
      throw new Error("Allocator churn authenticated nodes did not plateau");
    }
  }
}

async function initializeChurn(
  runtime: SampleRuntime,
  targets: readonly Target[],
  step: number,
): Promise<Identity[]> {
  const bodies = targets.map((_target, index) =>
    deterministic(runtime, step + index, workload.churn_body_bytes)
  );
  const receipt = expectOk(
    await runtime.call("qualification_commit_batch", [{
      nonce: deterministic(runtime, step + 10, workload.nonce_bytes),
      operations: targets.map((target, index) => ({
        put: {
          target,
          condition: { absent: null },
          body: { inline: bodies[index]! },
        },
      })),
      requires_present_after: [],
    }]),
    "allocator churn initialization",
  );
  const identities = putIdentities(receipt, "allocator churn initialization");
  if (identities.length !== targets.length) {
    throw new Error("Allocator churn initialization receipt is incomplete");
  }
  for (let index = 0; index < targets.length; index += 1) {
    assertIdentity(identities[index]!, targets[index]!, bodies[index]!);
  }
  return identities;
}

async function churnRound(
  runtime: SampleRuntime,
  targets: readonly Target[],
  prior: readonly Identity[],
  step: number,
): Promise<Identity[]> {
  if (
    targets.length !== CHURN_RECORD_COUNT ||
    prior.length !== targets.length
  ) {
    throw new Error("Allocator churn requires its fixed four-record set");
  }
  const bodies = targets.map((_target, index) =>
    deterministic(runtime, step + index, workload.churn_body_bytes)
  );
  const receipt = expectOk(
    await runtime.call("qualification_commit_batch", [{
      nonce: deterministic(runtime, step + 10, workload.nonce_bytes),
      operations: targets.map((target, index) => ({
        put: {
          target,
          condition: matchCondition(prior[index]!),
          body: { inline: bodies[index]! },
        },
      })),
      requires_present_after: [],
    }]),
    "allocator churn allocation",
  );
  const identities = putIdentities(receipt, "allocator churn allocation");
  if (identities.length !== targets.length) {
    throw new Error("Allocator churn allocation receipt is incomplete");
  }
  for (let index = 0; index < targets.length; index += 1) {
    assertIdentity(identities[index]!, targets[index]!, bodies[index]!);
    if (
      identities[index]!.kernel_revision !==
      prior[index]!.kernel_revision + 1n
    ) {
      throw new Error("Allocator churn replacement skipped a revision");
    }
  }
  await drainMaintenance(runtime);
  return identities;
}

async function createPublication(
  runtime: SampleRuntime,
  appId: string,
  body: Uint8Array,
  filename: string,
  step: number,
  replayFirstChunk: boolean,
): Promise<Publication> {
  const generation = await runtime.generation(COLLECTION.publication);
  const uploaded = await uploadStage(
    runtime,
    {
      allocate_publication: {
        collection: COLLECTION.publication,
        collection_generation: generation,
        filename,
        presentation: { attachment: null },
      },
    },
    body,
    step,
    replayFirstChunk,
  );
  const identity = await commitPut(
    runtime,
    step + 1,
    uploaded.target,
    { absent: null },
    { stage: uploaded.begun.id },
  );
  assertIdentity(identity, uploaded.target, body);
  const locator = variant(
    uploaded.target.locator,
    "publication locator",
  );
  if (!("publication" in locator)) {
    throw new Error("Allocated publication returned a non-publication target");
  }
  const publication = record(locator.publication, "publication locator");
  const publicationId = fixedBytes(
    publication.publication_id,
    32,
    "publication id",
  );
  if (publication.filename !== filename) {
    throw new Error("Allocated publication changed its filename");
  }
  return {
    target: uploaded.target,
    identity,
    path:
      `${routeBase(appId, MOUNT.publication)}/${hex(publicationId)}/${filename}`,
    body,
    blockBytes: uploaded.begun.geometry.blockBytes,
    blockLengths: uploaded.blockLengths,
  };
}

async function uploadStage(
  runtime: SampleRuntime,
  target: Dict,
  body: Uint8Array,
  step: number,
  replayFirstChunk: boolean,
): Promise<UploadedStage> {
  const begun = await beginStage(runtime, target, body.byteLength, step);
  const blockLengths: number[] = [];
  let completedTarget: Target | null = begun.computedTarget;
  let rawDigest: Uint8Array | null = null;
  for (let index = 0; index < begun.geometry.blockCount; index += 1) {
    const start = index * begun.geometry.blockBytes;
    const end = Math.min(start + begun.geometry.blockBytes, body.byteLength);
    const chunkBody = body.subarray(start, end);
    blockLengths.push(chunkBody.byteLength);
    const result = expectOk(
      await runtime.call("qualification_put_chunk", [{
        stage_id: begun.id,
        index,
        body: chunkBody,
      }]),
      `stage chunk ${index}`,
    );
    const chunk = record(result, `stage chunk ${index}`);
    if (
      nat64(chunk.stage_id, "chunk stage id") !== begun.id ||
      nat32(chunk.index, "chunk index") !== index ||
      !equalBytes(
        fixedBytes(chunk.block_sha256, 32, "chunk SHA-256"),
        sha256(chunkBody),
      )
    ) {
      throw new Error(`Stage chunk ${index} identity is invalid`);
    }
    expectVariant(chunk.accepted, "new", `stage chunk ${index} acceptance`);
    const expectedComplete = index + 1 === begun.geometry.blockCount;
    const chunkDigest = option(
      chunk.raw_sha256,
      (value) => fixedBytes(value, 32, `stage chunk ${index} digest`),
      `stage chunk ${index} digest`,
    );
    const chunkTarget = option(
      chunk.computed_target,
      (value) => targetValue(value, `stage chunk ${index} target`),
      `stage chunk ${index} target`,
    );
    if (chunk.complete !== expectedComplete) {
      throw new Error(`Stage chunk ${index} completion flag is invalid`);
    }
    if (!expectedComplete && chunkDigest !== null) {
      throw new Error(`Incomplete stage chunk ${index} exposed a digest`);
    }
    if (
      begun.mode === "publication"
        ? chunkTarget === null ||
          begun.computedTarget === null ||
          !equalValue(chunkTarget, begun.computedTarget)
        : !expectedComplete && chunkTarget !== null
    ) {
      throw new Error(`Stage chunk ${index} changed its target policy`);
    }
    if (replayFirstChunk && index === 0) {
      const replay = record(
        expectOk(
          await runtime.call("qualification_put_chunk", [{
            stage_id: begun.id,
            index,
            body: chunkBody,
          }]),
          "stage chunk replay",
        ),
        "stage chunk replay",
      );
      expectVariant(replay.accepted, "replayed", "stage chunk replay");
      const replayDigest = option(
        replay.raw_sha256,
        (value) => fixedBytes(value, 32, "replayed stage chunk digest"),
        "replayed stage chunk digest",
      );
      const replayTarget = option(
        replay.computed_target,
        (value) => targetValue(value, "replayed stage chunk target"),
        "replayed stage chunk target",
      );
      if (
        nat64(replay.stage_id, "replayed chunk stage id") !== begun.id ||
        nat32(replay.index, "replayed chunk index") !== index ||
        replay.complete !== expectedComplete ||
        !equalValue(replayDigest, chunkDigest) ||
        !equalValue(replayTarget, chunkTarget) ||
        !equalBytes(
          fixedBytes(replay.block_sha256, 32, "replayed chunk SHA-256"),
          sha256(chunkBody),
        )
      ) {
        throw new Error("Replayed stage chunk changed its result");
      }
    }
    if (expectedComplete) {
      rawDigest = chunkDigest;
      completedTarget = chunkTarget;
    }
  }
  if (rawDigest === null || completedTarget === null) {
    throw new Error("Completed stage omitted its digest or target");
  }
  if (begun.mode === "digest") {
    assertTarget(
      completedTarget,
      {
        collection: begun.collection,
        collection_generation: begun.generation,
        locator: { body_sha256: { digest: rawDigest } },
      },
      "completed digest-derived target",
    );
  } else if (
    begun.computedTarget === null ||
    !equalValue(completedTarget, begun.computedTarget)
  ) {
    throw new Error("Completed publication changed its allocated target");
  }
  const status = variant(
    expectOk(
      await runtime.call("qualification_stage_status", [begun.id]),
      "completed stage status",
    ),
    "completed stage status",
  );
  if (!("active" in status)) {
    throw new Error("Completed uncommitted stage is not active");
  }
  const active = record(status.active, "active completed stage");
  if (
    nat64(active.stage_id, "active stage id") !== begun.id ||
    !equalValue(
      geometryValue(active.geometry, "active stage geometry"),
      begun.geometry,
    )
  ) {
    throw new Error("Stage status changed its identity or geometry");
  }
  const activeIdentity = record(active.identity, "active stage identity");
  if (
    activeIdentity.collection !== begun.collection ||
    nat64(
      activeIdentity.collection_generation,
      "active stage generation",
    ) !== begun.generation
  ) {
    throw new Error("Stage status changed its collection identity");
  }
  const statusTarget = option(
    activeIdentity.computed_target,
    (value) => targetValue(value, "stage status target"),
    "stage status target",
  );
  const progress = record(active.progress, "active stage progress");
  if (
    nat32(progress.next_block_index, "active stage next block") !==
      begun.geometry.blockCount ||
    !equalValue(
      array(progress.block_hashes, "active stage block hashes").map(
        (value, index) =>
          fixedBytes(value, 32, `active stage block hash ${index}`),
      ),
      blockLengths.map((length, index) => {
        const start = index * begun.geometry.blockBytes;
        return sha256(body.subarray(start, start + length));
      }),
    )
  ) {
    throw new Error("Stage status changed its ordered block progress");
  }
  const statusDigest = option(
    active.raw_sha256,
    (value) => fixedBytes(value, 32, "stage status digest"),
    "stage status digest",
  );
  if (
    statusDigest === null ||
    !equalBytes(statusDigest, rawDigest) ||
    !equalValue(statusTarget, completedTarget)
  ) {
    throw new Error("Stage status did not retain its completed identity");
  }
  return { begun, target: completedTarget, rawDigest, blockLengths };
}

async function beginStage(
  runtime: SampleRuntime,
  target: Dict,
  expectedBytes: number,
  step: number,
): Promise<BegunStage> {
  const result = record(
    expectOk(
      await runtime.call("qualification_begin_stage", [{
        nonce: deterministic(runtime, step, workload.nonce_bytes),
        target,
        expected_bytes: BigInt(expectedBytes),
      }]),
      "begin stage",
    ),
    "begin stage",
  );
  const geometry = geometryValue(result.geometry, "begin stage geometry");
  if (geometry.expectedBytes !== expectedBytes || geometry.blockCount < 1) {
    throw new Error("Begin-stage geometry does not match the requested body");
  }
  const identity = record(result.identity, "begin stage identity");
  const authored = variant(target, "begin stage target");
  const mode = "allocate_publication" in authored
    ? "publication"
    : "derive_body_sha256" in authored
      ? "digest"
      : null;
  if (mode === null) {
    throw new Error("Begin stage used an unknown target policy");
  }
  const declaration = record(
    authored[
      mode === "publication"
        ? "allocate_publication"
        : "derive_body_sha256"
    ],
    "begin stage target declaration",
  );
  const collection = text(
    declaration.collection,
    "begin stage collection",
  );
  const generation = nat64(
    declaration.collection_generation,
    "begin stage collection generation",
  );
  if (
    identity.collection !== collection ||
    nat64(
      identity.collection_generation,
      "begin stage identity generation",
    ) !== generation
  ) {
    throw new Error("Begin stage changed its collection identity");
  }
  const computedTarget = option(
    identity.computed_target,
    (value) => targetValue(value, "begin-stage computed target"),
    "begin-stage computed target",
  );
  if (mode === "digest" && computedTarget !== null) {
    throw new Error("Digest-derived stage allocated a target before upload");
  }
  if (mode === "publication") {
    if (computedTarget === null) {
      throw new Error("Publication stage did not allocate its target at begin");
    }
    const locator = variant(
      computedTarget.locator,
      "allocated publication locator",
    );
    if (!("publication" in locator)) {
      throw new Error("Publication stage allocated a non-publication target");
    }
    const allocated = record(
      locator.publication,
      "allocated publication locator",
    );
    const expected = record(
      authored.allocate_publication,
      "publication stage declaration",
    );
    fixedBytes(
      allocated.publication_id,
      32,
      "allocated publication id",
    );
    if (
      computedTarget.collection !== collection ||
      computedTarget.collection_generation !== generation ||
      allocated.filename !== expected.filename
    ) {
      throw new Error("Publication stage allocated the wrong target");
    }
  }
  return {
    id: nat64(result.stage_id, "stage id"),
    geometry,
    computedTarget,
    mode,
    collection,
    generation,
  };
}

async function commitPut(
  runtime: SampleRuntime,
  step: number,
  target: Target,
  condition: Dict,
  body: Dict,
): Promise<Identity> {
  return putIdentity(
    expectOk(
      await runtime.call("qualification_commit_batch", [
        putInput(step, runtime, target, condition, body),
      ]),
      "put commit",
    ),
    "put commit",
  );
}

function putInput(
  step: number,
  runtime: SampleRuntime,
  target: Target,
  condition: Dict,
  body: Dict,
): Dict {
  return {
    nonce: deterministic(runtime, step, workload.nonce_bytes),
    operations: [{ put: { target, condition, body } }],
    requires_present_after: [],
  };
}

async function deleteTarget(
  runtime: SampleRuntime,
  target: Target,
  identity: Identity,
  step: number,
): Promise<void> {
  const receipt = expectOk(
    await runtime.call("qualification_commit_batch", [{
      nonce: deterministic(runtime, step, workload.nonce_bytes),
      operations: [{
        delete: {
          target,
          condition: {
            revision: identity.kernel_revision,
            content_tag: identity.content_tag,
          },
        },
      }],
      requires_present_after: [],
    }]),
    "conditional delete",
  );
  const operations = array(record(receipt, "delete receipt").operations, "delete operations");
  if (operations.length !== 1) {
    throw new Error("Conditional delete returned the wrong operation count");
  }
  const operation = variant(operations[0], "delete operation receipt");
  if (!("delete" in operation)) {
    throw new Error("Conditional delete returned a put receipt");
  }
  const deleted = record(
    record(operation.delete, "delete receipt").identity,
    "deleted identity",
  );
  if (
    nat32(
      record(operation.delete, "delete receipt").request_index,
      "delete request index",
    ) !== 0
  ) {
    throw new Error("Conditional delete returned the wrong request index");
  }
  assertTarget(
    targetValue(deleted.target, "deleted target"),
    target,
    "deleted target",
  );
  if (
    nat64(deleted.kernel_revision, "delete revision") !==
      identity.kernel_revision + 1n ||
    !equalBytes(
      fixedBytes(deleted.prior_content_tag, 32, "prior content tag"),
      identity.content_tag,
    )
  ) {
    throw new Error("Conditional delete receipt is inconsistent");
  }
}

async function assertPresent(
  runtime: SampleRuntime,
  target: Target,
  expected: Identity,
): Promise<void> {
  const status = variant(
    expectOk(
      await runtime.call("qualification_record_status", [target]),
      "record status",
    ),
    "record status",
  );
  if (!("present" in status)) {
    throw new Error("Expected a present certified record");
  }
  const actual = identityValue(status.present, "present identity");
  if (!equalValue(actual, expected)) {
    throw new Error("Present record identity does not match its commit");
  }
}

async function assertDeleted(
  runtime: SampleRuntime,
  target: Target,
): Promise<void> {
  const status = variant(
    expectOk(
      await runtime.call("qualification_record_status", [target]),
      "deleted record status",
    ),
    "deleted record status",
  );
  if (!("recently_deleted" in status) && !("deleted_high_water" in status)) {
    throw new Error("Conditionally deleted record is still present");
  }
}

async function assertPortablePresent(
  runtime: SampleRuntime,
  path: string,
  body: Uint8Array,
  kind: "immutable_blob" | "mutable_blob",
): Promise<void> {
  await runtime.verifyHttp({
    canisterId: runtime.canisterId,
    url: httpUrl(runtime, path),
    method: "GET",
    status: 200,
    authority: "portable",
    expressionPath: exactExpressionPath(path),
    headers: portableHeaders({ kind, body }),
    body,
  });
}

async function assertPortableAbsence(
  runtime: SampleRuntime,
  appId: string,
  path: string,
): Promise<void> {
  await runtime.verifyHttp({
    canisterId: runtime.canisterId,
    url: httpUrl(runtime, path),
    method: "GET",
    status: 404,
    authority: "portable",
    expressionPath: wildcardExpressionPath(
      routeBase(appId, MOUNT.portable),
    ),
    headers: portableAbsenceHeaders(),
    body: EMPTY,
  });
}

async function assertHostBoundAbsence(
  runtime: SampleRuntime,
  appId: string,
  path: string,
): Promise<void> {
  await runtime.verifyHttp({
    canisterId: runtime.canisterId,
    url: httpUrl(runtime, path),
    method: "GET",
    status: 404,
    authority: "host_bound",
    expressionPath: wildcardExpressionPath(
      routeBase(appId, MOUNT.publication),
    ),
    headers: hostBoundAbsenceHeaders(),
    body: EMPTY,
  });
}

async function usage(runtime: SampleRuntime): Promise<Dict> {
  return record(
    expectOk(
      await runtime.call("qualification_usage", [null]),
      "qualification usage",
    ),
    "qualification usage",
  );
}

async function diagnostics(runtime: SampleRuntime): Promise<Dict> {
  return record(
    await runtime.call("kernel_diagnostics", [null]),
    "Kernel Certified Assets diagnostics",
  );
}

async function rejectionState(
  runtime: SampleRuntime,
  input: {
    targets?: readonly Target[];
    stages?: readonly bigint[];
  },
): Promise<RejectionState> {
  const snapshotUsage = await usage(runtime);
  const snapshotDiagnostics = await diagnostics(runtime);
  const records: unknown[] = [];
  for (const target of input.targets ?? []) {
    records.push(
      await runtime.call("qualification_record_status", [target]),
    );
  }
  const stages: unknown[] = [];
  for (const stage of input.stages ?? []) {
    stages.push(
      await runtime.call("qualification_stage_status", [stage]),
    );
  }
  return {
    usage: snapshotUsage,
    diagnostics: snapshotDiagnostics,
    records,
    stages,
  };
}

async function drainMaintenance(runtime: SampleRuntime): Promise<void> {
  for (let page = 0; page < 128; page += 1) {
    const result = record(
      expectOk(
        await runtime.call("qualification_maintenance_page", [null]),
        "Certified Assets maintenance",
      ),
      "Certified Assets maintenance",
    );
    if (result.has_more === false && nat(result.remaining_jobs, "remaining jobs") === 0n) {
      return;
    }
    if (result.has_more !== true) {
      throw new Error("Maintenance page returned an invalid continuation flag");
    }
  }
  throw new Error("Certified Assets maintenance did not converge");
}

function bodyUsagePlateau(value: Dict): Dict {
  const current = currentUsage(value);
  return {
    live_entries: nat(current.live_entries, "live entries"),
    committed_body_bytes: nat(
      current.committed_body_bytes,
      "committed body bytes",
    ),
    allocated_body_bytes: nat(
      current.allocated_body_bytes,
      "allocated body bytes",
    ),
    accepted_staged_bytes: nat(
      current.accepted_staged_bytes,
      "accepted staged bytes",
    ),
    reserved_staged_bytes: nat(
      current.reserved_staged_bytes,
      "reserved staged bytes",
    ),
    detached_charged_bytes: nat(
      current.detached_charged_bytes,
      "detached charged bytes",
    ),
    active_stages: nat(current.active_stages, "active stages"),
    cleanup_jobs: nat(current.cleanup_jobs, "cleanup jobs"),
  };
}

function diagnosticsPlateau(value: Dict): {
  allocator: Dict;
  forest: Dict;
} {
  const allocator = record(value.allocator, "allocator diagnostics");
  const forest = record(
    value.authenticated_forest,
    "authenticated forest diagnostics",
  );
  if (
    allocator.header_valid !== true ||
    forest.healthy !== true ||
    forest.dirty !== false
  ) {
    throw new Error("Allocator churn diagnostics are unhealthy");
  }
  const allocatedBytes = nat64(
    allocator.allocated_bytes,
    "allocator allocated bytes",
  );
  const allocatedExtents = nat(
    allocator.allocated_extents,
    "allocator allocated extents",
  );
  const freeExtents = nat(allocator.free_extents, "allocator free extents");
  const descriptorCount = nat(
    allocator.descriptor_count,
    "allocator descriptor count",
  );
  const expectedAllocatedBytes = BigInt(
    CHURN_RECORD_COUNT * workload.churn_body_bytes,
  );
  if (
    allocatedBytes !== expectedAllocatedBytes ||
    allocatedExtents !== BigInt(CHURN_RECORD_COUNT)
  ) {
    throw new Error("Allocator churn live allocation is not exact");
  }
  if (
    freeExtents > BigInt(CHURN_RECORD_COUNT + 1) ||
    descriptorCount !== allocatedExtents + freeExtents
  ) {
    throw new Error("Allocator churn free-list descriptors exceed their bound");
  }
  return {
    allocator: {
      committed_high_water_bytes: nat64(
        allocator.committed_high_water_bytes,
        "allocator high water",
      ),
      allocated_bytes: allocatedBytes,
      allocated_extents: allocatedExtents,
    },
    forest: {
      live_nodes: nat(forest.live_nodes, "forest live nodes"),
      allocated_nodes: nat(forest.allocated_nodes, "forest allocated nodes"),
      free_nodes: nat(forest.free_nodes, "forest free nodes"),
      live_maps: nat(forest.live_maps, "forest live maps"),
      allocated_maps: nat(forest.allocated_maps, "forest allocated maps"),
      free_maps: nat(forest.free_maps, "forest free maps"),
    },
  };
}

function currentUsage(value: Dict): Dict {
  return record(value.current, "current Certified Assets usage");
}

function assertQuotaBoundary(
  value: Dict,
  resource: "stages" | "committed_bytes" | "entries" | "receipts",
): void {
  const current = currentUsage(value);
  const limits = record(value.effective_limits, "effective limits");
  const occupied =
    nat(current.occupied_entry_slots, "occupied entry slots") +
    nat(current.reserved_entry_slots, "reserved entry slots");
  const committed =
    nat(current.committed_body_bytes, "committed body bytes") +
    nat(
      current.reserved_committed_body_bytes,
      "reserved committed body bytes",
    );
  const receipts =
    nat(current.general_receipt_lanes, "general receipt lanes") +
    nat(
      current.reserved_general_receipt_lanes,
      "reserved general receipt lanes",
    );
  const stages = nat(current.active_stages, "active stages");
  const entryLimit = nat(limits.entries, "effective entry limit");
  const committedLimit = nat(
    limits.committed_bytes,
    "effective committed-byte limit",
  );
  const receiptLimit = nat(
    limits.general_receipts,
    "effective receipt limit",
  );
  const stageLimit = nat(
    limits.pending_stages,
    "effective pending-stage limit",
  );
  const atBoundary =
    resource === "stages"
      ? stages === stageLimit && occupied < entryLimit &&
        committed < committedLimit
      : resource === "committed_bytes"
        ? committed === committedLimit && occupied < entryLimit
        : resource === "entries"
          ? occupied === entryLimit && committed < committedLimit
          : receipts === receiptLimit;
  if (!atBoundary) {
    throw new Error(
      `${resource} rejection was not isolated at its effective limit`,
    );
  }
}

function assertSettledChurnUsage(value: Dict): void {
  const expectedCommitted =
    BigInt(4 * workload.churn_body_bytes);
  if (
    value.live_entries !== 4n ||
    value.committed_body_bytes !== expectedCommitted ||
    value.allocated_body_bytes !== expectedCommitted ||
    value.accepted_staged_bytes !== 0n ||
    value.reserved_staged_bytes !== 0n ||
    value.detached_charged_bytes !== 0n ||
    value.active_stages !== 0n ||
    value.cleanup_jobs !== 0n
  ) {
    throw new Error("Allocator churn did not reach a settled live plateau");
  }
}

function assertReceiptRetentionGrowth(before: Dict, after: Dict): void {
  const prior = currentUsage(before);
  const next = currentUsage(after);
  const policy = workload.churn_receipt_growth;
  const receiptDelta = BigInt(policy.receipts_per_round);
  const chargeDelta = BigInt(policy.charged_metadata_bytes_per_round);
  const exactGrowth = (
    field:
      | "receipt_lanes"
      | "general_receipt_lanes"
      | "receipt_nonce_indexes"
      | "receipt_expiry_indexes",
  ) =>
    nat(next[field], `next ${field}`) ===
    nat(prior[field], `prior ${field}`) + receiptDelta;
  if (
    !exactGrowth("receipt_lanes") ||
    !exactGrowth("general_receipt_lanes") ||
    !exactGrowth("receipt_nonce_indexes") ||
    !exactGrowth("receipt_expiry_indexes") ||
    nat(next.charged_metadata_bytes, "next charged metadata bytes") !==
      nat(prior.charged_metadata_bytes, "prior charged metadata bytes") +
        chargeDelta ||
    nat(next.reserved_general_receipt_lanes, "next reserved receipt lanes") !==
      nat(
        prior.reserved_general_receipt_lanes,
        "prior reserved receipt lanes",
      ) ||
    nat(next.cleanup_jobs, "next cleanup jobs") !== 0n
  ) {
    throw new Error(
      "Allocator churn did not retain exactly one bounded charged receipt",
    );
  }
}

function assertNoStateDrift(
  before: RejectionState,
  after: RejectionState,
  label: string,
): void {
  if (!equalValue(before, after)) {
    throw new Error(`${label} changed Certified Assets state`);
  }
}

function putIdentities(value: unknown, label: string): Identity[] {
  return array(record(value, label).operations, `${label} operations`).map(
    (operation, index) => {
      const receipt = variant(operation, `${label} operation ${index}`);
      if (!("put" in receipt)) {
        throw new Error(`${label} operation ${index} is not a put`);
      }
      const put = record(receipt.put, `${label} put ${index}`);
      if (
        nat32(put.request_index, `${label} request index ${index}`) !== index
      ) {
        throw new Error(`${label} returned an out-of-order request index`);
      }
      return identityValue(
        record(
          put.lifecycle,
          `${label} lifecycle ${index}`,
        ).committed,
        `${label} identity ${index}`,
      );
    },
  );
}

function putIdentity(value: unknown, label: string): Identity {
  const identities = putIdentities(value, label);
  if (identities.length !== 1) {
    throw new Error(`${label} did not return exactly one put receipt`);
  }
  return identities[0]!;
}

function identityValue(value: unknown, label: string): Identity {
  const identity = record(value, label);
  return {
    target: targetValue(identity.target, `${label}.target`),
    kernel_revision: nat64(
      identity.kernel_revision,
      `${label}.kernel_revision`,
    ),
    content_tag: fixedBytes(
      identity.content_tag,
      32,
      `${label}.content_tag`,
    ),
    body_bytes: nat(identity.body_bytes, `${label}.body_bytes`),
    geometry: record(identity.geometry, `${label}.geometry`),
    block_hashes: array(
      identity.block_hashes,
      `${label}.block_hashes`,
    ).map((entry, index) =>
      fixedBytes(entry, 32, `${label}.block_hashes[${index}]`)
    ),
  };
}

function assertIdentity(
  identity: Identity,
  target: Target,
  body: Uint8Array,
): void {
  assertTarget(identity.target, target, "committed target");
  const geometry = geometryValue(identity.geometry, "committed geometry");
  if (
    identity.kernel_revision < 1n ||
    identity.body_bytes !== BigInt(body.byteLength) ||
    !equalBytes(identity.content_tag, sha256(body)) ||
    geometry.expectedBytes !== body.byteLength ||
    geometry.blockCount !== identity.block_hashes.length
  ) {
    throw new Error("Committed record identity does not match its body");
  }
  for (let index = 0; index < geometry.blockCount; index += 1) {
    const start = index * geometry.blockBytes;
    const end = Math.min(start + geometry.blockBytes, body.byteLength);
    if (
      start > body.byteLength ||
      !equalBytes(
        identity.block_hashes[index]!,
        sha256(body.subarray(start, end)),
      )
    ) {
      throw new Error(`Committed block hash ${index} does not match its body`);
    }
  }
}

function assertConflictIdentity(value: unknown, expected: Identity): void {
  const conflict = record(value, "CAS conflict");
  const current = option(
    conflict.current,
    (entry) => record(entry, "CAS conflict current"),
    "CAS conflict current",
  );
  if (current === null) {
    throw new Error("Stale CAS conflict omitted the current identity");
  }
  if (
    nat64(current.collection_generation, "CAS collection generation") !==
      expected.target.collection_generation ||
    nat64(current.kernel_revision, "CAS revision") !==
      expected.kernel_revision ||
    nat(current.body_bytes, "CAS body bytes") !== expected.body_bytes ||
    !equalBytes(
      fixedBytes(current.content_tag, 32, "CAS content tag"),
      expected.content_tag,
    )
  ) {
    throw new Error("Stale CAS conflict reported the wrong current identity");
  }
}

function targetValue(value: unknown, label: string): Target {
  const target = record(value, label);
  const collection = text(target.collection, `${label}.collection`);
  const collectionGeneration = nat64(
    target.collection_generation,
    `${label}.collection_generation`,
  );
  const locator = variant(target.locator, `${label}.locator`);
  if ("publication" in locator) {
    const publication = record(locator.publication, `${label}.publication`);
    return {
      collection,
      collection_generation: collectionGeneration,
      locator: {
        publication: {
          publication_id: fixedBytes(
            publication.publication_id,
            32,
            `${label}.publication_id`,
          ),
          filename: text(publication.filename, `${label}.filename`),
        },
      },
    };
  }
  if ("body_sha256" in locator) {
    return {
      collection,
      collection_generation: collectionGeneration,
      locator: {
        body_sha256: {
          digest: fixedBytes(
            record(locator.body_sha256, `${label}.body_sha256`).digest,
            32,
            `${label}.digest`,
          ),
        },
      },
    };
  }
  if ("key32" in locator) {
    return {
      collection,
      collection_generation: collectionGeneration,
      locator: {
        key32: {
          key: fixedBytes(
            record(locator.key32, `${label}.key32`).key,
            32,
            `${label}.key`,
          ),
        },
      },
    };
  }
  if ("exact_path" in locator && locator.exact_path === null) {
    return {
      collection,
      collection_generation: collectionGeneration,
      locator: { exact_path: null },
    };
  }
  throw new Error(`${label} contains an unknown locator`);
}

function immutableTarget(generation: bigint, digest: Uint8Array): Target {
  return {
    collection: COLLECTION.immutable,
    collection_generation: generation,
    locator: { body_sha256: { digest } },
  };
}

function mutableKeyTarget(generation: bigint, key: Uint8Array): Target {
  if (key.byteLength !== workload.keyed_locator_bytes) {
    throw new Error("Mutable keyed locator is not 32 bytes");
  }
  return {
    collection: COLLECTION.mutableKey,
    collection_generation: generation,
    locator: { key32: { key } },
  };
}

function mutableExactTarget(generation: bigint): Target {
  return {
    collection: COLLECTION.mutableExact,
    collection_generation: generation,
    locator: { exact_path: null },
  };
}

function matchCondition(identity: Identity): Dict {
  return {
    match: {
      revision: identity.kernel_revision,
      content_tag: identity.content_tag,
    },
  };
}

function geometryValue(value: unknown, label: string): Geometry {
  const geometry = record(value, label);
  return {
    blockBytes: safeNumber(
      nat(geometry.block_bytes, `${label}.block_bytes`),
      `${label}.block_bytes`,
    ),
    blockCount: nat32(geometry.block_count, `${label}.block_count`),
    expectedBytes: safeNumber(
      nat(geometry.expected_bytes, `${label}.expected_bytes`),
      `${label}.expected_bytes`,
    ),
  };
}

function routeBase(appId: string, mount: string): string {
  return `/app/${appId}/_route/${mount}`;
}

function immutablePath(appId: string, digest: Uint8Array): string {
  return `${routeBase(appId, MOUNT.portable)}/objects/${hex(digest)}`;
}

function mutableKeyPath(appId: string, key: Uint8Array): string {
  return `${routeBase(appId, MOUNT.portable)}/heads/${hex(key)}`;
}

function mutableExactPath(appId: string): string {
  return `${routeBase(appId, MOUNT.portable)}/profile`;
}

function httpUrl(runtime: SampleRuntime, pathname: string): string {
  const url = new URL(runtime.gatewayOrigin);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.href;
}

export function deterministic(
  runtime: SampleRuntime,
  step: number,
  length: number,
): Uint8Array {
  const value = runtime.deterministicBytes(step, length);
  if (value.byteLength !== length) {
    throw new Error(`Deterministic workload step ${step} returned wrong length`);
  }
  return value;
}

function observedBody(
  observation: CertifiedHttpObservation,
  expected: Uint8Array,
  label: string,
): Uint8Array {
  if (
    expected.byteLength !== observation.body.bytes ||
    hex(sha256(expected)) !== observation.body.sha256
  ) {
    throw new Error(`${label} observation bytes are inconsistent`);
  }
  return expected;
}

export function expectOk(value: unknown, label: string): unknown {
  const result = variant(value, label);
  if ("ok" in result) return result.ok;
  const error = variant(result.err, `${label} error`);
  throw new Error(`${label} failed with ${Object.keys(error)[0]}`);
}

export function expectError(
  value: unknown,
  expected: string,
  label: string,
): unknown {
  const result = variant(value, label);
  if ("ok" in result) {
    throw new Error(`${label} unexpectedly succeeded`);
  }
  const error = variant(result.err, `${label} error`);
  const actual = Object.keys(error)[0]!;
  if (actual !== expected) {
    throw new Error(`${label} returned ${actual}, expected ${expected}`);
  }
  return error[actual];
}

function expectVariant(value: unknown, expected: string, label: string): void {
  const result = variant(value, label);
  const actual = Object.keys(result)[0]!;
  if (actual !== expected) {
    throw new Error(`${label} is ${actual}, expected ${expected}`);
  }
}

export function variant(value: unknown, label: string): Dict {
  const result = record(value, label);
  if (Object.keys(result).length !== 1) {
    throw new Error(`${label} must be a one-field variant`);
  }
  return result;
}

export function record(value: unknown, label: string): Dict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  return value as Dict;
}

export function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function option<T>(
  value: unknown,
  parse: (entry: unknown) => T,
  label: string,
): T | null {
  const entries = array(value, label);
  if (entries.length === 0) return null;
  if (entries.length !== 1) throw new Error(`${label} is not a Candid option`);
  return parse(entries[0]);
}

export function fixedBytes(
  value: unknown,
  length: number,
  label: string,
): Uint8Array {
  const result = bytes(value, label);
  if (result.byteLength !== length) {
    throw new Error(`${label} must be ${length} bytes`);
  }
  return result;
}

function bytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`${label} must be a byte vector`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  return value;
}

export function nat(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`${label} must be a Candid Nat`);
  }
  return value;
}

export function nat64(value: unknown, label: string): bigint {
  const result = nat(value, label);
  if (result > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`${label} exceeds Nat64`);
  }
  return result;
}

export function nat32(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffff_ffff
  ) {
    throw new Error(`${label} must be a Candid Nat32`);
  }
  return value;
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the safe integer range`);
  }
  return Number(value);
}

function assertTarget(actual: Target, expected: Target, label: string): void {
  if (!equalValue(actual, expected)) {
    throw new Error(`${label} does not match the requested target`);
  }
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

export function equalValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return equalBytes(left, right);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((entry, index) => equalValue(entry, right[index]))
    );
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object"
  ) {
    const leftRecord = left as Dict;
    const rightRecord = right as Dict;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          equalValue(leftRecord[key], rightRecord[key]),
      )
    );
  }
  return false;
}

function sha256(value: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(value).digest());
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function assertFixtureAppId(value: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(value)) {
    throw new Error("Qualification fixture app id is invalid");
  }
}
