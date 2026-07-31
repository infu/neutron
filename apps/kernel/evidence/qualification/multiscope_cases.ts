import { createHash } from "node:crypto";
import {
  CERTIFIED_ASSETS_QUALIFICATION_CASES,
  CERTIFIED_ASSETS_QUALIFICATION_CONTRACT,
} from "neutron-tools/src/certified_assets_qualification.js";
import type { SampleRuntime } from "./cases.ts";
import {
  CERTIFIED_ASSETS_QUALIFICATION_FIXTURES,
  type CertifiedAssetsQualificationFixture,
  type CertifiedAssetsQualificationFixtureId,
} from "./fixture_manifests.ts";

export const CERTIFIED_ASSETS_MULTISCOPE_CASE_IDS = [
  "global_stage_admission",
  "scope_isolation",
] as const;

export type CertifiedAssetsMultiscopeCaseId =
  (typeof CERTIFIED_ASSETS_MULTISCOPE_CASE_IDS)[number];

export type QualificationScopeRuntime = Readonly<{
  appId: CertifiedAssetsQualificationFixtureId;
  runtime: SampleRuntime;
}>;

type Dict = Record<string, unknown>;
type BegunStage = Readonly<{ id: bigint; generation: bigint; collection: string }>;

const workload = CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.workload;

/**
 * Execute the actor-wide cases against the exact five fixtures installed in
 * one fresh Kernel canister. The launcher cannot substitute a smaller or
 * caller-selected scope set.
 */
export async function executeMultiscopeQualificationCase(
  scopes: readonly QualificationScopeRuntime[],
  caseId: CertifiedAssetsMultiscopeCaseId,
): Promise<readonly string[]> {
  assertExactScopeSet(scopes);
  if (caseId === "global_stage_admission") {
    await globalStageAdmission(scopes);
  } else if (caseId === "scope_isolation") {
    await scopeIsolation(scopes);
  } else {
    const unreachable: never = caseId;
    throw new Error(`Unknown multiscope qualification case ${unreachable}`);
  }
  const definition = CERTIFIED_ASSETS_QUALIFICATION_CASES.find(
    ({ id }) => id === caseId,
  );
  if (definition === undefined) {
    throw new Error(`Qualification contract omitted case ${caseId}`);
  }
  return [...definition.checkpoints];
}

async function globalStageAdmission(
  scopes: readonly QualificationScopeRuntime[],
): Promise<void> {
  const accepted: Array<{
    scope: QualificationScopeRuntime;
    stage: BegunStage;
  }> = [];
  for (let index = 0; index < 4; index += 1) {
    const scope = scopes[index]!;
    accepted.push({
      scope,
      stage: await beginOneByteStage(scope, 10 + index),
    });
  }
  if (new Set(accepted.map(({ stage }) => stage.id)).size !== 4) {
    throw new Error("Actor-wide admitted stages did not receive unique IDs");
  }
  for (const { scope } of accepted) {
    if (await activeStageCount(scope.runtime) !== 1n) {
      throw new Error(`Admitted scope ${scope.appId} did not retain one stage`);
    }
  }

  const rejected = scopes[4]!;
  const rejectedCollection = stageCollection(fixtureFor(rejected.appId));
  const rejectedGeneration = await rejected.runtime.generation(
    rejectedCollection,
  );
  const before = await multiscopeState(scopes, accepted);
  expectError(
    await rejected.runtime.call("qualification_begin_stage", [
      beginStageInput(
        rejected,
        20,
        rejectedCollection,
        rejectedGeneration,
      ),
    ]),
    "quota",
    "fifth actor-wide stage",
  );
  const after = await multiscopeState(scopes, accepted);
  assertEqualValue(
    before,
    after,
    "Rejected fifth stage changed Certified Assets state",
  );

  expectOk(
    await accepted[0]!.scope.runtime.call(
      "qualification_abort_stage",
      [accepted[0]!.stage.id],
    ),
    "release actor-wide stage slot",
  );
  const replacement = await beginOneByteStage(rejected, 21);

  for (const { scope, stage } of accepted.slice(1)) {
    expectOk(
      await scope.runtime.call("qualification_abort_stage", [stage.id]),
      `cleanup admitted stage for ${scope.appId}`,
    );
  }
  expectOk(
    await rejected.runtime.call(
      "qualification_abort_stage",
      [replacement.id],
    ),
    "cleanup replacement actor-wide stage",
  );
}

async function scopeIsolation(
  scopes: readonly QualificationScopeRuntime[],
): Promise<void> {
  // Primary and aux_2 intentionally use the same collection ID and locator
  // form. Any observed separation therefore comes from the app scope, not a
  // conveniently different collection name.
  const observer = scopes[0]!;
  const owner = scopes[2]!;
  const stage = await beginOneByteStage(owner, 30);

  const foreignStatus = variant(
    expectOk(
      await observer.runtime.call("qualification_stage_status", [stage.id]),
      "foreign stage status",
    ),
    "foreign stage status",
  );
  expectVariant(foreignStatus, "unknown", "foreign stage visibility");
  expectError(
    await observer.runtime.call("qualification_put_chunk", [{
      stage_id: stage.id,
      index: 0,
      body: new Uint8Array([0x61]),
    }]),
    "not_found",
    "foreign stage mutation",
  );

  const body = new Uint8Array([0x62]);
  const chunk = record(
    expectOk(
      await owner.runtime.call("qualification_put_chunk", [{
        stage_id: stage.id,
        index: 0,
        body,
      }]),
      "owning scope stage upload",
    ),
    "owning scope stage upload",
  );
  if (chunk.complete !== true) {
    throw new Error("One-byte isolation stage did not complete");
  }
  const digest = sha256(body);
  const ownerTarget = immutableTarget(
    stage.collection,
    stage.generation,
    digest,
  );
  const receipt = record(
    expectOk(
      await owner.runtime.call("qualification_commit_batch", [{
        nonce: deterministic(owner.runtime, 31, workload.nonce_bytes),
        operations: [{
          put: {
            target: ownerTarget,
            condition: { absent: null },
            body: { stage: stage.id },
          },
        }],
        requires_present_after: [],
      }]),
      "owning scope commit",
    ),
    "owning scope commit",
  );
  const operations = array(receipt.operations, "owning scope operations");
  if (operations.length !== 1) {
    throw new Error("Owning scope commit returned the wrong operation count");
  }
  const put = expectVariant(
    variant(operations[0], "owning scope operation"),
    "put",
    "owning scope operation",
  );
  const lifecycle = record(
    record(put, "owning scope put receipt").lifecycle,
    "owning scope lifecycle",
  );
  const identity = record(
    lifecycle.committed,
    "owning scope committed identity",
  );
  const revision = nat64(
    identity.kernel_revision,
    "owning scope record revision",
  );
  const contentTag = fixedBytes(
    identity.content_tag,
    32,
    "owning scope content tag",
  );
  if (!equalBytes(contentTag, digest)) {
    throw new Error("Owning scope content tag did not match its body");
  }

  const ownerStatus = variant(
    expectOk(
      await owner.runtime.call("qualification_record_status", [ownerTarget]),
      "owning scope record status",
    ),
    "owning scope record status",
  );
  expectVariant(ownerStatus, "present", "owning scope record status");

  const observerGeneration = await observer.runtime.generation(
    stageCollection(fixtureFor(observer.appId)),
  );
  const observerTarget = immutableTarget(
    stage.collection,
    observerGeneration,
    digest,
  );
  const observerStatus = variant(
    expectOk(
      await observer.runtime.call(
        "qualification_record_status",
        [observerTarget],
      ),
      "same locator in observer scope",
    ),
    "same locator in observer scope",
  );
  expectVariant(
    observerStatus,
    "absent",
    "same locator in observer scope",
  );
  expectError(
    await observer.runtime.call("qualification_commit_batch", [{
      nonce: deterministic(observer.runtime, 32, workload.nonce_bytes),
      operations: [{
        delete: {
          target: observerTarget,
          condition: {
            revision,
            content_tag: contentTag,
          },
        },
      }],
      requires_present_after: [],
    }]),
    "not_found",
    "foreign identity delete",
  );

  expectOk(
    await owner.runtime.call("qualification_commit_batch", [{
      nonce: deterministic(owner.runtime, 33, workload.nonce_bytes),
      operations: [{
        delete: {
          target: ownerTarget,
          condition: {
            revision,
            content_tag: contentTag,
          },
        },
      }],
      requires_present_after: [],
    }]),
    "owning scope cleanup",
  );
}

async function beginOneByteStage(
  scope: QualificationScopeRuntime,
  step: number,
): Promise<BegunStage> {
  const fixture = fixtureFor(scope.appId);
  const collection = stageCollection(fixture);
  const generation = await scope.runtime.generation(collection);
  const result = record(
    expectOk(
      await scope.runtime.call(
        "qualification_begin_stage",
        [beginStageInput(scope, step, collection, generation)],
      ),
      `begin stage for ${scope.appId}`,
    ),
    `begin stage for ${scope.appId}`,
  );
  const stageId = nat64(result.stage_id, `stage ID for ${scope.appId}`);
  const geometry = record(
    result.geometry,
    `stage geometry for ${scope.appId}`,
  );
  if (
    nat(geometry.expected_bytes, "stage expected bytes") !== 1n ||
    nat32(geometry.block_count, "stage block count") !== 1
  ) {
    throw new Error(`One-byte stage geometry is invalid for ${scope.appId}`);
  }
  return { id: stageId, generation, collection };
}

function beginStageInput(
  scope: QualificationScopeRuntime,
  step: number,
  collection: string,
  generation: bigint,
): Dict {
  return {
    nonce: deterministic(scope.runtime, step, workload.nonce_bytes),
    target: {
      derive_body_sha256: {
        collection,
        collection_generation: generation,
      },
    },
    expected_bytes: 1n,
  };
}

async function activeStageCount(runtime: SampleRuntime): Promise<bigint> {
  const current = await currentUsage(runtime);
  return nat(current.active_stages, "active stage count");
}

async function currentUsage(runtime: SampleRuntime): Promise<Dict> {
  const usage = record(
    expectOk(
      await runtime.call("qualification_usage", [null]),
      "qualification usage",
    ),
    "qualification usage",
  );
  return record(usage.current, "qualification current usage");
}

async function multiscopeState(
  scopes: readonly QualificationScopeRuntime[],
  stages: readonly {
    scope: QualificationScopeRuntime;
    stage: BegunStage;
  }[],
): Promise<unknown> {
  const usages = await Promise.all(
    scopes.map(({ runtime }) => currentUsage(runtime)),
  );
  const diagnostics = record(
    await scopes[0]!.runtime.call("kernel_diagnostics", [null]),
    "Kernel Certified Assets diagnostics",
  );
  const stageStatuses = await Promise.all(
    stages.map(({ scope, stage }) =>
      scope.runtime.call("qualification_stage_status", [stage.id])
    ),
  );
  return { usages, diagnostics, stage_statuses: stageStatuses };
}

function assertExactScopeSet(
  scopes: readonly QualificationScopeRuntime[],
): void {
  if (scopes.length !== CERTIFIED_ASSETS_QUALIFICATION_FIXTURES.length) {
    throw new Error(
      `Multiscope qualification requires exactly ${CERTIFIED_ASSETS_QUALIFICATION_FIXTURES.length} scopes`,
    );
  }
  const canisterId = scopes[0]!.runtime.canisterId;
  for (let index = 0; index < scopes.length; index += 1) {
    const expected = CERTIFIED_ASSETS_QUALIFICATION_FIXTURES[index]!;
    const actual = scopes[index]!;
    if (actual.appId !== expected.app_id) {
      throw new Error(
        `Multiscope qualification scope ${index} must be ${expected.app_id}`,
      );
    }
    if (actual.runtime.canisterId !== canisterId) {
      throw new Error(
        "Multiscope qualification fixtures must share one Kernel canister",
      );
    }
  }
}

function fixtureFor(
  appId: CertifiedAssetsQualificationFixtureId,
): CertifiedAssetsQualificationFixture {
  const fixture = CERTIFIED_ASSETS_QUALIFICATION_FIXTURES.find(
    (candidate) => candidate.app_id === appId,
  );
  if (fixture === undefined) {
    throw new Error(`Unknown qualification fixture ${appId}`);
  }
  return fixture;
}

function stageCollection(
  fixture: CertifiedAssetsQualificationFixture,
): string {
  const collections = fixture.certified_assets.collections.filter(
    ({ kind }) => kind === "immutable_blob",
  );
  if (collections.length !== 1) {
    throw new Error(
      `Qualification fixture ${fixture.app_id} must have one immutable stage collection`,
    );
  }
  return collections[0]!.id;
}

function immutableTarget(
  collection: string,
  generation: bigint,
  digest: Uint8Array,
): Dict {
  return {
    collection,
    collection_generation: generation,
    locator: { body_sha256: { digest } },
  };
}

function deterministic(
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

function expectOk(value: unknown, label: string): unknown {
  const result = variant(value, label);
  if ("ok" in result) return result.ok;
  const error = variant(result.err, `${label} error`);
  throw new Error(`${label} failed with ${Object.keys(error)[0]}`);
}

function expectError(
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

function expectVariant(
  value: Dict,
  expected: string,
  label: string,
): unknown {
  const actual = Object.keys(value)[0]!;
  if (actual !== expected) {
    throw new Error(`${label} is ${actual}, expected ${expected}`);
  }
  return value[actual];
}

function variant(value: unknown, label: string): Dict {
  const result = record(value, label);
  if (Object.keys(result).length !== 1) {
    throw new Error(`${label} must be a one-field variant`);
  }
  return result;
}

function record(value: unknown, label: string): Dict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  return value as Dict;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function nat(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`${label} must be a Nat`);
  }
  return value;
}

function nat64(value: unknown, label: string): bigint {
  const result = nat(value, label);
  if (result > 18_446_744_073_709_551_615n) {
    throw new Error(`${label} exceeds Nat64`);
  }
  return result;
}

function nat32(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 4_294_967_295
  ) {
    throw new Error(`${label} must be a Nat32`);
  }
  return value;
}

function fixedBytes(
  value: unknown,
  length: number,
  label: string,
): Uint8Array {
  const bytes =
    value instanceof Uint8Array
      ? value
      : Array.isArray(value) &&
          value.every(
            (item) =>
              typeof item === "number" &&
              Number.isInteger(item) &&
              item >= 0 &&
              item <= 255,
          )
        ? Uint8Array.from(value as number[])
        : null;
  if (bytes === null || bytes.byteLength !== length) {
    throw new Error(`${label} must be ${length} bytes`);
  }
  return bytes;
}

function sha256(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
}

function assertEqualValue(
  left: unknown,
  right: unknown,
  label: string,
): void {
  if (canonicalValue(left) !== canonicalValue(right)) {
    throw new Error(label);
  }
}

function canonicalValue(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (value instanceof Uint8Array) {
    return `bytes:${Buffer.from(value).toString("hex")}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalValue).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Dict;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("Qualification value is not canonicalizable");
}
