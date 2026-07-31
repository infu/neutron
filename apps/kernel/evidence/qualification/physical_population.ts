import { createHash } from "node:crypto";
import {
  CERTIFIED_ASSETS_PHYSICAL_RESERVATION_POLICY_V1,
} from "neutron-tools/src/capabilities/catalog.js";
import {
  CERTIFIED_ASSETS_QUALIFICATION_FIXTURES,
} from "./fixture_manifests.ts";
import {
  CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE,
} from "./profile.ts";

const boundedPhysical =
  CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE.bounded_physical_sample;

export const PHYSICAL_POPULATION_ENTRIES = boundedPhysical.entries;
export const PHYSICAL_POPULATION_BATCH_OPERATIONS =
  boundedPhysical.batch_operations;
export const PHYSICAL_POPULATION_BATCHES =
  PHYSICAL_POPULATION_ENTRIES / PHYSICAL_POPULATION_BATCH_OPERATIONS;
export const PHYSICAL_POPULATION_BODY_BYTES = 1;
export const PHYSICAL_POPULATION_MAX_COMMITTED_BYTES =
  PHYSICAL_POPULATION_ENTRIES + PHYSICAL_POPULATION_BODY_BYTES;
export const CERTIFIED_ASSETS_RECEIPT_RECONCILE_NS =
  86_400_000_000_000n;
export const CERTIFIED_ASSETS_MAINTENANCE_RECEIPTS_PER_PAGE = 256;

export function physicalReceiptReclaimedChargedBytes(
  receipts: number,
): bigint {
  assertIntegerInRange(
    receipts,
    0,
    CERTIFIED_ASSETS_MAINTENANCE_RECEIPTS_PER_PAGE,
    "reclaimed physical receipt count",
  );
  return BigInt(receipts) *
    CERTIFIED_ASSETS_PHYSICAL_RESERVATION_POLICY_V1.generalReceiptCharge;
}

const primary = CERTIFIED_ASSETS_QUALIFICATION_FIXTURES.find(
  ({ role }) => role === "bounded_physical",
);
if (primary === undefined) {
  throw new Error("Certified Assets qualification has no physical fixture");
}
const physicalCollection = primary.certified_assets.collections.find(
  (collection) =>
    collection.kind === "mutable_blob" &&
    "path_prefix" in collection &&
    typeof collection.path_prefix === "string",
);
if (
  physicalCollection === undefined ||
  !("path_prefix" in physicalCollection) ||
  typeof physicalCollection.path_prefix !== "string" ||
  primary.certified_assets.max_entries !== PHYSICAL_POPULATION_ENTRIES ||
  primary.certified_assets.max_committed_bytes !==
    PHYSICAL_POPULATION_MAX_COMMITTED_BYTES ||
  primary.certified_assets.max_object_bytes !==
    PHYSICAL_POPULATION_BODY_BYTES ||
  primary.certified_assets.max_batch_operations !==
    PHYSICAL_POPULATION_BATCH_OPERATIONS ||
  primary.certified_assets.max_batch_bytes !==
    PHYSICAL_POPULATION_BATCH_OPERATIONS ||
  physicalCollection.max_object_bytes !==
    PHYSICAL_POPULATION_BODY_BYTES
) {
  throw new Error(
    "Certified Assets physical fixture does not match the bounded 256-entry workload",
  );
}

export const PHYSICAL_POPULATION_APP_ID = primary.app_id;
export const PHYSICAL_POPULATION_COLLECTION_ID = physicalCollection.id;
export const PHYSICAL_POPULATION_MOUNT_ID = physicalCollection.mount;
export const PHYSICAL_POPULATION_PATH_PREFIX =
  physicalCollection.path_prefix;
export const PHYSICAL_POPULATION_RECEIPT_LIMIT =
  primary.certified_assets.max_idempotency_receipts;
export const PHYSICAL_POPULATION_ROUTE_PREFIX =
  `/app/${PHYSICAL_POPULATION_APP_ID}/_route/` +
  `${PHYSICAL_POPULATION_MOUNT_ID}${PHYSICAL_POPULATION_PATH_PREFIX}`;

export type PhysicalPopulationTarget = Readonly<{
  collection: typeof PHYSICAL_POPULATION_COLLECTION_ID;
  collection_generation: bigint;
  locator: {
    key32: {
      key: Uint8Array;
    };
  };
}>;

export type PhysicalPopulationPut = Readonly<{
  put: {
    target: PhysicalPopulationTarget;
    condition: { absent: null };
    body: { inline: Uint8Array };
  };
}>;

export type PhysicalPopulationCommitInput = Readonly<{
  nonce: Uint8Array;
  operations: readonly PhysicalPopulationPut[];
  requires_present_after: readonly [];
}>;

export type PhysicalPopulationBatch = Readonly<{
  batch_index: number;
  first_entry_index: number;
  input: PhysicalPopulationCommitInput;
}>;

export type PhysicalPopulationReceiptRollover = Readonly<{
  after_batch_count: number;
  advance_time_ns: bigint;
  expected_receipts_reclaimed: number;
  expected_maintenance_pages: number;
  usage_before: PhysicalPopulationUsageExpectation;
  usage_after: PhysicalPopulationUsageExpectation;
}>;

/**
 * Exact, allocation-independent counters decoded from `qualification_usage`.
 * Allocator and metadata byte counts are intentionally not included.
 */
export type PhysicalPopulationUsageExpectation = Readonly<{
  live_entries: bigint;
  occupied_entry_slots: bigint;
  committed_body_bytes: bigint;
  reserved_committed_body_bytes: 0n;
  accepted_staged_bytes: 0n;
  reserved_staged_bytes: 0n;
  detached_charged_bytes: 0n;
  active_stages: 0n;
  reserved_entry_slots: 0n;
  receipt_lanes: bigint;
  general_receipt_lanes: bigint;
  reserved_general_receipt_lanes: 0n;
  reserved_revocation_lanes: bigint;
  filled_revocation_lanes: 0n;
  receipt_nonce_indexes: bigint;
  receipt_expiry_indexes: bigint;
  cleanup_jobs: 0n;
}>;

export type PhysicalPopulationOverflowExpectation = Readonly<{
  attempted_entries: bigint;
  maximum_entries: bigint;
  attempted_committed_body_bytes: bigint;
  maximum_committed_body_bytes: bigint;
  isolated_resource: "entries";
  expected_error: "quota";
}>;

export type PhysicalPresentWitnessCandidate = Readonly<{
  entry_index: number;
  key_value: bigint;
  key: Uint8Array;
  path: string;
  body: Uint8Array;
}>;

export type PhysicalAbsenceWitnessCandidate = Readonly<{
  gap_index: number;
  key_value: bigint;
  key: Uint8Array;
  path: string;
}>;

export type PhysicalTerminalWitnessGeometry = Readonly<{
  present: Readonly<{
    bytes: number;
    key_values: readonly number[];
  }>;
  absence: Readonly<{
    bytes: number;
    key_values: readonly number[];
  }>;
}>;

const NONCE_DOMAIN_PREFIX = createHash("sha256")
  .update("neutron.kernel.certified-assets.physical-population-nonce.v1\0")
  .digest()
  .subarray(0, 8);

/**
 * Stream the bounded physical workload without holding all operations in
 * memory. Keys are ascending even u64 values embedded in a 32-byte key. The
 * odd values identify every adjacent absence gap.
 */
export function* physicalPopulationBatches(
  collectionGeneration: bigint,
): Generator<PhysicalPopulationBatch> {
  if (collectionGeneration <= 0n) {
    throw new Error("Physical collection generation must be positive");
  }
  for (
    let batchIndex = 0;
    batchIndex < PHYSICAL_POPULATION_BATCHES;
    batchIndex += 1
  ) {
    const firstEntryIndex =
      batchIndex * PHYSICAL_POPULATION_BATCH_OPERATIONS;
    const operations = Array.from(
      { length: PHYSICAL_POPULATION_BATCH_OPERATIONS },
      (_, offset): PhysicalPopulationPut => {
        const entryIndex = firstEntryIndex + offset;
        return {
          put: {
            target: physicalPopulationTarget(
              entryIndex,
              collectionGeneration,
            ),
            condition: { absent: null },
            body: { inline: physicalPopulationBody(entryIndex) },
          },
        };
      },
    );
    yield {
      batch_index: batchIndex,
      first_entry_index: firstEntryIndex,
      input: {
        nonce: physicalPopulationNonce(batchIndex),
        operations,
        requires_present_after: [],
      },
    };
  }
}

/**
 * Positive-batch receipts live for 24 hours. A rollover happens before the
 * next commit that would exceed the fixture's general-receipt ceiling.
 */
export function physicalPopulationReceiptRollovers():
  readonly PhysicalPopulationReceiptRollover[] {
  const limit = PHYSICAL_POPULATION_RECEIPT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 2) {
    throw new Error("Physical receipt limit is invalid");
  }
  const result: PhysicalPopulationReceiptRollover[] = [];
  for (
    let afterBatchCount = limit;
    afterBatchCount < PHYSICAL_POPULATION_BATCHES;
    afterBatchCount += limit
  ) {
    result.push({
      after_batch_count: afterBatchCount,
      advance_time_ns: CERTIFIED_ASSETS_RECEIPT_RECONCILE_NS + 1n,
      expected_receipts_reclaimed: limit,
      expected_maintenance_pages: Math.ceil(
        limit / CERTIFIED_ASSETS_MAINTENANCE_RECEIPTS_PER_PAGE,
      ),
      usage_before: physicalPopulationUsageExpectation(
        afterBatchCount,
        limit,
      ),
      usage_after: physicalPopulationUsageExpectation(
        afterBatchCount,
        0,
      ),
    });
  }
  if (
    result.length !==
      boundedPhysical.receipt_expiry_crossings
  ) {
    throw new Error(
      "Bounded physical sample does not cross the configured receipt expiry count",
    );
  }
  return result;
}

/**
 * Exact settled usage after the fixed population and its one receipt
 * rollover. Receipt parsers can use this source-bound subset instead of
 * trusting opaque usage reply hashes.
 */
export const PHYSICAL_POPULATION_FINAL_USAGE =
  physicalPopulationUsageExpectation(
    PHYSICAL_POPULATION_BATCHES,
    PHYSICAL_POPULATION_BATCHES === 0
      ? 0
      : (
          (PHYSICAL_POPULATION_BATCHES - 1) %
            PHYSICAL_POPULATION_RECEIPT_LIMIT
        ) + 1,
  );

export const PHYSICAL_POPULATION_INITIAL_USAGE =
  physicalPopulationUsageExpectation(0, 0);

/**
 * Admission arithmetic for the post-population one-over probe. The attempted
 * body total remains within its manifest ceiling, so only max_entries is
 * crossed.
 */
export const PHYSICAL_POPULATION_OVERFLOW_EXPECTATION:
  PhysicalPopulationOverflowExpectation = {
    attempted_entries: BigInt(PHYSICAL_POPULATION_ENTRIES + 1),
    maximum_entries: BigInt(PHYSICAL_POPULATION_ENTRIES),
    attempted_committed_body_bytes:
      PHYSICAL_POPULATION_FINAL_USAGE.committed_body_bytes +
      BigInt(PHYSICAL_POPULATION_BODY_BYTES),
    maximum_committed_body_bytes: BigInt(
      PHYSICAL_POPULATION_MAX_COMMITTED_BYTES,
    ),
    isolated_resource: "entries",
    expected_error: "quota",
  };

export function physicalPopulationTarget(
  entryIndex: number,
  collectionGeneration: bigint,
): PhysicalPopulationTarget {
  return physicalPopulationTargetForKey(
    physicalPopulationPresentKey(entryIndex),
    collectionGeneration,
  );
}

/**
 * The first operation beyond the full state. A correct runtime returns
 * `#quota`; the same key remains one of the upper-bound absence paths.
 */
export function physicalPopulationOverflowInput(
  collectionGeneration: bigint,
): PhysicalPopulationCommitInput {
  if (collectionGeneration <= 0n) {
    throw new Error("Physical collection generation must be positive");
  }
  const key = physicalPopulationAbsenceKey(
    PHYSICAL_POPULATION_ENTRIES,
  );
  return {
    nonce: physicalPopulationNonce(PHYSICAL_POPULATION_BATCHES),
    operations: [
      {
        put: {
          target: physicalPopulationTargetForKey(
            key,
            collectionGeneration,
          ),
          condition: { absent: null },
          body: {
            inline: Uint8Array.of(
              PHYSICAL_POPULATION_ENTRIES & 0xff,
            ),
          },
        },
      },
    ],
    requires_present_after: [],
  };
}

function physicalPopulationTargetForKey(
  key: Uint8Array,
  collectionGeneration: bigint,
): PhysicalPopulationTarget {
  return {
    collection: PHYSICAL_POPULATION_COLLECTION_ID,
    collection_generation: collectionGeneration,
    locator: {
      key32: {
        key,
      },
    },
  };
}

function physicalPopulationUsageExpectation(
  batchCount: number,
  generalReceiptLanes: number,
): PhysicalPopulationUsageExpectation {
  assertIntegerInRange(
    batchCount,
    0,
    PHYSICAL_POPULATION_BATCHES,
    "physical population batch count",
  );
  assertIntegerInRange(
    generalReceiptLanes,
    0,
    PHYSICAL_POPULATION_RECEIPT_LIMIT,
    "physical population general receipt lanes",
  );
  const entries = BigInt(
    batchCount * PHYSICAL_POPULATION_BATCH_OPERATIONS,
  );
  const receipts = BigInt(generalReceiptLanes);
  return {
    live_entries: entries,
    occupied_entry_slots: entries,
    committed_body_bytes:
      entries * BigInt(PHYSICAL_POPULATION_BODY_BYTES),
    reserved_committed_body_bytes: 0n,
    accepted_staged_bytes: 0n,
    reserved_staged_bytes: 0n,
    detached_charged_bytes: 0n,
    active_stages: 0n,
    reserved_entry_slots: 0n,
    receipt_lanes: entries + receipts,
    general_receipt_lanes: receipts,
    reserved_general_receipt_lanes: 0n,
    reserved_revocation_lanes: entries,
    filled_revocation_lanes: 0n,
    receipt_nonce_indexes: receipts,
    receipt_expiry_indexes: receipts,
    cleanup_jobs: 0n,
  };
}

export function physicalPopulationPresentKey(
  entryIndex: number,
): Uint8Array {
  assertIntegerInRange(
    entryIndex,
    0,
    PHYSICAL_POPULATION_ENTRIES - 1,
    "physical entry index",
  );
  return keyFromValue(2n * BigInt(entryIndex) + 2n);
}

export function physicalPopulationAbsenceKey(
  gapIndex: number,
): Uint8Array {
  assertIntegerInRange(
    gapIndex,
    0,
    PHYSICAL_POPULATION_ENTRIES,
    "physical absence gap index",
  );
  return keyFromValue(2n * BigInt(gapIndex) + 1n);
}

export function physicalPopulationBody(entryIndex: number): Uint8Array {
  assertIntegerInRange(
    entryIndex,
    0,
    PHYSICAL_POPULATION_ENTRIES - 1,
    "physical entry index",
  );
  return Uint8Array.of(entryIndex & 0xff);
}

export function physicalPopulationNonce(batchIndex: number): Uint8Array {
  assertIntegerInRange(
    batchIndex,
    0,
    PHYSICAL_POPULATION_BATCHES,
    "physical batch index",
  );
  const nonce = new Uint8Array(16);
  nonce.set(NONCE_DOMAIN_PREFIX);
  writeU64be(nonce, 8, BigInt(batchIndex));
  return nonce;
}

export function physicalPopulationPath(key: Uint8Array): string {
  if (key.byteLength !== 32) {
    throw new Error("Physical population key must be exactly 32 bytes");
  }
  return `${PHYSICAL_POPULATION_ROUTE_PREFIX}${Buffer.from(key).toString("hex")}`;
}

/*
 * The terminal `/records/<64 hex>` map is an exact LLRB populated by the
 * ascending even keys above. Exhaustively replaying the pinned balance and
 * mixed-hash-tree serialization rules gives these equal maxima:
 *
 *   membership terminal-map witness: 641 encoded bytes (2 keys)
 *   adjacent-gap terminal-map witness: 742 encoded bytes (2 gaps)
 *
 * The membership calculation normalizes the invariant response-leaf suffix
 * below every record to one empty leaf. Its byte count is therefore a
 * selection score, not the complete HTTP proof metric.
 *
 * All labels above this terminal map, and all singleton expression/request/
 * response branches below it, have the same shape and byte length for every
 * record. The runtime queries every candidate below and retains the largest
 * actual complete HTTP proof. `assertPhysicalWitnessCandidateDerivation`
 * exhaustively replays the pinned LLRB and mixed-hash-tree serialization
 * rules over all 256 members and all 257 neighbor gaps. The release runner
 * calls it before accepting these bounded candidates.
 */
const PRESENT_WITNESS_KEY_VALUES = [
  510,
  512,
] as const;
const ABSENCE_WITNESS_KEY_VALUES = [
  509,
  511,
] as const;

export const PHYSICAL_PRESENT_TERMINAL_WITNESS_BYTES = 641;
export const PHYSICAL_ABSENCE_TERMINAL_WITNESS_BYTES = 742;

export const PHYSICAL_PRESENT_WITNESS_CANDIDATES:
  readonly PhysicalPresentWitnessCandidate[] =
  PRESENT_WITNESS_KEY_VALUES.map((value) => {
    const entryIndex = value / 2 - 1;
    const key = physicalPopulationPresentKey(entryIndex);
    return {
      entry_index: entryIndex,
      key_value: BigInt(value),
      key,
      path: physicalPopulationPath(key),
      body: physicalPopulationBody(entryIndex),
    };
  });

export const PHYSICAL_ABSENCE_WITNESS_CANDIDATES:
  readonly PhysicalAbsenceWitnessCandidate[] =
  ABSENCE_WITNESS_KEY_VALUES.map((value) => {
    const gapIndex = (value - 1) / 2;
    const key = physicalPopulationAbsenceKey(gapIndex);
    return {
      gap_index: gapIndex,
      key_value: BigInt(value),
      key,
      path: physicalPopulationPath(key),
    };
  });

/**
 * Rebuild the exact terminal LLRB created by `physicalPopulationBatches` and
 * exhaustively score every member and every lexicographic neighbor gap. This
 * is intentionally source-owned release logic, not a test-only derivation.
 */
export function derivePhysicalTerminalWitnessGeometry():
  PhysicalTerminalWitnessGeometry {
  let root: GeometryNode | null = null;
  for (
    let index = 0;
    index < PHYSICAL_POPULATION_ENTRIES;
    index += 1
  ) {
    root = insertGeometryNode(root, 2 * index + 2);
    root.red = false;
  }
  if (root === null) {
    throw new Error("Physical witness geometry unexpectedly stayed empty");
  }
  const populatedRoot = root;
  const present = { bytes: -1, key_values: [] as number[] };
  for (
    let index = 0;
    index < PHYSICAL_POPULATION_ENTRIES;
    index += 1
  ) {
    const keyValue = 2 * index + 2;
    retainGeometryMaximum(
      present,
      keyValue,
      membershipGeometry(
        populatedRoot,
        keyValue,
        geometryLeaf(0),
      ).bytes,
    );
  }
  const absence = { bytes: -1, key_values: [] as number[] };
  for (
    let index = 0;
    index <= PHYSICAL_POPULATION_ENTRIES;
    index += 1
  ) {
    const keyValue = 2 * index + 1;
    retainGeometryMaximum(
      absence,
      keyValue,
      absenceGeometry(populatedRoot, keyValue).bytes,
    );
  }
  return { present, absence };
}

export function assertPhysicalWitnessCandidateDerivation():
  PhysicalTerminalWitnessGeometry {
  const geometry = derivePhysicalTerminalWitnessGeometry();
  const expectedPresent = PHYSICAL_PRESENT_WITNESS_CANDIDATES.map(
    ({ key_value }) => Number(key_value),
  );
  const expectedAbsence = PHYSICAL_ABSENCE_WITNESS_CANDIDATES.map(
    ({ key_value }) => Number(key_value),
  );
  if (
    geometry.present.bytes !==
      PHYSICAL_PRESENT_TERMINAL_WITNESS_BYTES ||
    geometry.absence.bytes !==
      PHYSICAL_ABSENCE_TERMINAL_WITNESS_BYTES ||
    !equalNumbers(geometry.present.key_values, expectedPresent) ||
    !equalNumbers(geometry.absence.key_values, expectedAbsence)
  ) {
    throw new Error(
      "Certified Assets physical witness candidates do not match the exhaustive fixed-tree derivation",
    );
  }
  return geometry;
}

function keyFromValue(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new Error("Physical key value is outside u64");
  }
  const key = new Uint8Array(32);
  writeU64be(key, 24, value);
  return key;
}

function writeU64be(
  output: Uint8Array,
  offset: number,
  value: bigint,
): void {
  for (let index = 7; index >= 0; index -= 1) {
    output[offset + index] = Number(value & 0xffn);
    value >>= 8n;
  }
}

function assertIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} is outside ${minimum}..${maximum}`);
  }
}

type GeometryNode = {
  key: number;
  red: boolean;
  left: GeometryNode | null;
  right: GeometryNode | null;
};

type GeometryWitness = {
  kind: "empty" | "pruned" | "other";
  bytes: number;
};

const GEOMETRY_EMPTY: GeometryWitness = {
  kind: "empty",
  bytes: 2,
};
const GEOMETRY_PRUNED: GeometryWitness = {
  kind: "pruned",
  bytes: 36,
};

function insertGeometryNode(
  root: GeometryNode | null,
  key: number,
): GeometryNode {
  if (root === null) {
    return { key, red: true, left: null, right: null };
  }
  if (key < root.key) {
    root.left = insertGeometryNode(root.left, key);
  } else if (key > root.key) {
    root.right = insertGeometryNode(root.right, key);
  }
  if (geometryRed(root.right) && !geometryRed(root.left)) {
    root = rotateGeometryLeft(root);
  }
  if (geometryRed(root.left) && geometryRed(root.left!.left)) {
    root = rotateGeometryRight(root);
  }
  if (geometryRed(root.left) && geometryRed(root.right)) {
    flipGeometryColors(root);
  }
  return root;
}

function rotateGeometryLeft(root: GeometryNode): GeometryNode {
  const next = root.right!;
  root.right = next.left;
  next.left = root;
  next.red = root.red;
  root.red = true;
  return next;
}

function rotateGeometryRight(root: GeometryNode): GeometryNode {
  const next = root.left!;
  root.left = next.right;
  next.right = root;
  next.red = root.red;
  root.red = true;
  return next;
}

function flipGeometryColors(root: GeometryNode): void {
  root.red = !root.red;
  root.left!.red = !root.left!.red;
  root.right!.red = !root.right!.red;
}

function geometryRed(node: GeometryNode | null): boolean {
  return node !== null && node.red;
}

function membershipGeometry(
  root: GeometryNode,
  key: number,
  value: GeometryWitness,
): GeometryWitness {
  if (key === root.key) {
    return geometryThreeWay(
      geometryPrunedNode(root.left),
      geometryLabeled(64, value),
      geometryPrunedNode(root.right),
    );
  }
  if (key < root.key) {
    return geometryThreeWay(
      membershipGeometry(root.left!, key, value),
      GEOMETRY_PRUNED,
      geometryPrunedNode(root.right),
    );
  }
  return geometryThreeWay(
    geometryPrunedNode(root.left),
    GEOMETRY_PRUNED,
    membershipGeometry(root.right!, key, value),
  );
}

function absenceGeometry(
  root: GeometryNode,
  key: number,
): GeometryWitness {
  const lower = geometryBound(root, key, "lower");
  const upper = geometryBound(root, key, "upper");
  if (lower === null && upper === null) return GEOMETRY_EMPTY;
  if (lower !== null && upper === null) {
    return geometryWitnessAbove(root, lower);
  }
  if (lower === null && upper !== null) {
    return geometryWitnessBelow(root, upper);
  }
  return geometryWitnessBetween(root, lower!, upper!);
}

function geometryBound(
  root: GeometryNode | null,
  key: number,
  direction: "lower" | "upper",
): GeometryNode | null {
  let current = root;
  let candidate: GeometryNode | null = null;
  while (current !== null) {
    if (current.key === key) return current;
    if (direction === "lower") {
      if (current.key < key) {
        candidate = current;
        current = current.right;
      } else {
        current = current.left;
      }
    } else if (current.key > key) {
      candidate = current;
      current = current.left;
    } else {
      current = current.right;
    }
  }
  return candidate;
}

function geometryWitnessAbove(
  root: GeometryNode | null,
  lower: GeometryNode,
): GeometryWitness {
  if (root === null) return GEOMETRY_EMPTY;
  if (root.key === lower.key) {
    return geometryThreeWay(
      geometryPrunedNode(root.left),
      geometryKeyWitness(),
      geometryFullWitness(root.right),
    );
  }
  if (root.key < lower.key) {
    return geometryThreeWay(
      geometryPrunedNode(root.left),
      GEOMETRY_PRUNED,
      geometryWitnessAbove(root.right, lower),
    );
  }
  return geometryThreeWay(
    geometryWitnessAbove(root.left, lower),
    geometryKeyWitness(),
    geometryFullWitness(root.right),
  );
}

function geometryWitnessBelow(
  root: GeometryNode | null,
  upper: GeometryNode,
): GeometryWitness {
  if (root === null) return GEOMETRY_EMPTY;
  if (root.key === upper.key) {
    return geometryThreeWay(
      geometryFullWitness(root.left),
      geometryKeyWitness(),
      geometryPrunedNode(root.right),
    );
  }
  if (root.key > upper.key) {
    return geometryThreeWay(
      geometryWitnessBelow(root.left, upper),
      GEOMETRY_PRUNED,
      geometryPrunedNode(root.right),
    );
  }
  return geometryThreeWay(
    geometryFullWitness(root.left),
    geometryKeyWitness(),
    geometryWitnessBelow(root.right, upper),
  );
}

function geometryWitnessBetween(
  root: GeometryNode | null,
  lower: GeometryNode,
  upper: GeometryNode,
): GeometryWitness {
  if (root === null) return GEOMETRY_EMPTY;
  if (root.key === lower.key && root.key === upper.key) {
    return geometryThreeWay(
      geometryPrunedNode(root.left),
      geometryKeyWitness(),
      geometryPrunedNode(root.right),
    );
  }
  if (root.key === upper.key) {
    return geometryThreeWay(
      geometryWitnessBetween(root.left, lower, upper),
      geometryKeyWitness(),
      geometryPrunedNode(root.right),
    );
  }
  if (root.key === lower.key) {
    return geometryThreeWay(
      geometryPrunedNode(root.left),
      geometryKeyWitness(),
      geometryWitnessBetween(root.right, lower, upper),
    );
  }
  if (lower.key < root.key && root.key < upper.key) {
    return geometryThreeWay(
      geometryWitnessBetween(root.left, lower, upper),
      geometryKeyWitness(),
      geometryWitnessBetween(root.right, lower, upper),
    );
  }
  if (lower.key < root.key && root.key > upper.key) {
    return geometryThreeWay(
      geometryWitnessBetween(root.left, lower, upper),
      GEOMETRY_PRUNED,
      geometryPrunedNode(root.right),
    );
  }
  if (lower.key > root.key && root.key < upper.key) {
    return geometryThreeWay(
      geometryPrunedNode(root.left),
      GEOMETRY_PRUNED,
      geometryWitnessBetween(root.right, lower, upper),
    );
  }
  return GEOMETRY_PRUNED;
}

function geometryFullWitness(
  root: GeometryNode | null,
): GeometryWitness {
  if (root === null) return GEOMETRY_EMPTY;
  return geometryThreeWay(
    geometryFullWitness(root.left),
    geometryKeyWitness(),
    geometryFullWitness(root.right),
  );
}

function geometryKeyWitness(): GeometryWitness {
  return geometryLabeled(64, GEOMETRY_PRUNED);
}

function geometryPrunedNode(
  node: GeometryNode | null,
): GeometryWitness {
  return node === null ? GEOMETRY_EMPTY : GEOMETRY_PRUNED;
}

function geometryThreeWay(
  left: GeometryWitness,
  middle: GeometryWitness,
  right: GeometryWitness,
): GeometryWitness {
  if (left.kind === "empty" && right.kind === "empty") return middle;
  if (left.kind === "empty") return geometryFork(middle, right);
  if (right.kind === "empty") return geometryFork(left, middle);
  if (
    left.kind === "pruned" &&
    middle.kind === "pruned" &&
    right.kind === "pruned"
  ) {
    return GEOMETRY_PRUNED;
  }
  if (middle.kind === "pruned" && right.kind === "pruned") {
    return geometryFork(left, GEOMETRY_PRUNED);
  }
  return geometryFork(left, geometryFork(middle, right));
}

function geometryFork(
  left: GeometryWitness,
  right: GeometryWitness,
): GeometryWitness {
  return {
    kind: "other",
    bytes: 2 + left.bytes + right.bytes,
  };
}

function geometryLabeled(
  labelBytes: number,
  child: GeometryWitness,
): GeometryWitness {
  return {
    kind: "other",
    bytes: 2 + geometryCborBlobBytes(labelBytes) + child.bytes,
  };
}

function geometryLeaf(valueBytes: number): GeometryWitness {
  return {
    kind: "other",
    bytes: 2 + geometryCborBlobBytes(valueBytes),
  };
}

function geometryCborBlobBytes(bytes: number): number {
  return (bytes <= 23 ? 1 : 2) + bytes;
}

function retainGeometryMaximum(
  maximum: { bytes: number; key_values: number[] },
  keyValue: number,
  bytes: number,
): void {
  if (bytes > maximum.bytes) {
    maximum.bytes = bytes;
    maximum.key_values = [keyValue];
  } else if (bytes === maximum.bytes) {
    maximum.key_values.push(keyValue);
  }
}

function equalNumbers(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
