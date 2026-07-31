import type { NeutronCertifiedAssetsCapabilityConfig } from "neutron-tools/src/capabilities/catalog.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";

const U32_MAX = 4_294_967_295n;
const U64_MAX = 18_446_744_073_709_551_615n;

export type CertifiedAssetsScopeWire = {
  app_id: string;
  installation_uid: bigint | number;
};

export type CertifiedAssetsLimits = Readonly<{
  entries: bigint;
  committedBytes: bigint;
  objectBytes: bigint;
  stagedBytes: bigint;
  pendingStages: bigint;
  batchOperations: bigint;
  batchBytes: bigint;
  generalReceipts: bigint;
  revocationLanes: bigint;
}>;

export type CertifiedAssetsCollectionInfo = Readonly<{
  id: string;
  kind: "publication" | "immutable_blob" | "mutable_blob";
  authorityEpoch: bigint;
  generation: bigint;
  serving: "enabled" | "disabled";
  writes: "enabled" | "frozen";
  manifestLimits: CertifiedAssetsLimits;
  effectiveLimits: CertifiedAssetsLimits;
}>;

export type CertifiedAssetsScopeInfo = Readonly<{
  installationGeneration: bigint;
  storeAuthorityEpoch: bigint;
  collections: readonly CertifiedAssetsCollectionInfo[];
}>;

export type CertifiedAssetsUsageCounters = Readonly<{
  liveEntries: bigint;
  occupiedEntrySlots: bigint;
  committedBodyBytes: bigint;
  allocatedBodyBytes: bigint;
  chargedMetadataBytes: bigint;
  acceptedStagedBytes: bigint;
  reservedStagedBytes: bigint;
  detachedChargedBytes: bigint;
  activeStages: bigint;
  receiptLanes: bigint;
  generalReceiptLanes: bigint;
  reservedGeneralReceiptLanes: bigint;
  reservedRevocationLanes: bigint;
  filledRevocationLanes: bigint;
  receiptNonceIndexes: bigint;
  receiptExpiryIndexes: bigint;
  cleanupJobs: bigint;
}>;

export type CertifiedAssetsUsage = Readonly<{
  current: CertifiedAssetsUsageCounters;
  manifestLimits: CertifiedAssetsLimits;
  effectiveLimits: CertifiedAssetsLimits;
}>;

export type CertifiedAssetsSettingsSnapshot = Readonly<{
  scopeInfo: CertifiedAssetsScopeInfo;
  usage: CertifiedAssetsUsage;
}>;

export type CertifiedAssetsAdmissionCeilings = Readonly<{
  entries: bigint;
  committedBytes: bigint;
  stagedBytes: bigint;
  generalReceipts: bigint;
}>;

export type CertifiedAssetsReclaimed = Readonly<{
  records: bigint;
  bodies: bigint;
  bodyBytes: bigint;
  chargedBytes: bigint;
  authenticatedNodes: bigint;
  receipts: bigint;
}>;

export type CertifiedAssetsMaintenancePage = Readonly<{
  page: CertifiedAssetsReclaimed;
  hasMore: boolean;
  remainingJobs: bigint;
}>;

export type CertifiedAssetsSettingsActor = {
  kernel_certified_assets_scope_info(
    scope: CertifiedAssetsScopeWire,
  ): Promise<unknown>;
  kernel_certified_assets_usage(
    scope: CertifiedAssetsScopeWire,
  ): Promise<unknown>;
  kernel_certified_assets_set_admission_ceilings(input: {
    scope: CertifiedAssetsScopeWire;
    ceilings: {
      entries: bigint;
      committed_bytes: bigint;
      staged_bytes: bigint;
      general_receipts: bigint;
    };
  }): Promise<unknown>;
  kernel_certified_assets_set_writes_frozen(input: {
    scope: CertifiedAssetsScopeWire;
    frozen: boolean;
  }): Promise<unknown>;
  kernel_certified_assets_maintenance_page(
    scope: CertifiedAssetsScopeWire,
  ): Promise<unknown>;
};

export async function loadCertifiedAssetsSettings(
  actor: CertifiedAssetsSettingsActor,
  scope: CertifiedAssetsScopeWire,
  manifest: NeutronCertifiedAssetsCapabilityConfig,
): Promise<CertifiedAssetsSettingsSnapshot> {
  const [scopeInfoRaw, usageRaw] = await Promise.all([
    actor.kernel_certified_assets_scope_info(scope),
    actor.kernel_certified_assets_usage(scope),
  ]);
  const snapshot = Object.freeze({
    scopeInfo: parseResult(
      scopeInfoRaw,
      "Certified-assets scope information",
      parseScopeInfo,
    ),
    usage: parseResult(
      usageRaw,
      "Certified-assets usage",
      parseUsage,
    ),
  });
  assertSnapshotMatchesManifest(snapshot, manifest);
  return snapshot;
}

export async function setCertifiedAssetsAdmissionCeilings(
  actor: CertifiedAssetsSettingsActor,
  scope: CertifiedAssetsScopeWire,
  manifest: NeutronCertifiedAssetsCapabilityConfig,
  ceilings: CertifiedAssetsAdmissionCeilings,
): Promise<void> {
  assertAdmissionCeilings(ceilings, manifestLimits(manifest));
  parseUnitResult(
    await actor.kernel_certified_assets_set_admission_ceilings({
      scope,
      ceilings: {
        entries: ceilings.entries,
        committed_bytes: ceilings.committedBytes,
        staged_bytes: ceilings.stagedBytes,
        general_receipts: ceilings.generalReceipts,
      },
    }),
    "Certified-assets admission-ceiling update",
  );
}

export async function setCertifiedAssetsWritesFrozen(
  actor: CertifiedAssetsSettingsActor,
  scope: CertifiedAssetsScopeWire,
  frozen: boolean,
): Promise<void> {
  if (typeof frozen !== "boolean") {
    throw new Error("Certified-assets write-freeze state is invalid");
  }
  parseUnitResult(
    await actor.kernel_certified_assets_set_writes_frozen({ scope, frozen }),
    "Certified-assets write-freeze update",
  );
}

export async function runCertifiedAssetsMaintenancePage(
  actor: CertifiedAssetsSettingsActor,
  scope: CertifiedAssetsScopeWire,
): Promise<CertifiedAssetsMaintenancePage> {
  return parseMaintenancePage(
    await actor.kernel_certified_assets_maintenance_page(scope),
  );
}

export function parseAdmissionCeilings(
  values: Readonly<Record<keyof CertifiedAssetsAdmissionCeilings, string>>,
  manifest: NeutronCertifiedAssetsCapabilityConfig,
): CertifiedAssetsAdmissionCeilings {
  const parsed = Object.freeze({
    entries: decimalNat(values.entries, "Entry ceiling"),
    committedBytes: decimalNat(
      values.committedBytes,
      "Committed-byte ceiling",
    ),
    stagedBytes: decimalNat(values.stagedBytes, "Staged-byte ceiling"),
    generalReceipts: decimalNat(
      values.generalReceipts,
      "General-receipt ceiling",
    ),
  });
  assertAdmissionCeilings(parsed, manifestLimits(manifest));
  return parsed;
}

export function certifiedAssetsWriteState(
  scopeInfo: CertifiedAssetsScopeInfo,
): "enabled" | "frozen" | "mixed" {
  const values = new Set(scopeInfo.collections.map(({ writes }) => writes));
  if (values.size === 1) return values.values().next().value!;
  return "mixed";
}

function parseScopeInfo(value: unknown): CertifiedAssetsScopeInfo {
  const record = exactRecord(
    value,
    ["installation_generation", "store_authority_epoch", "collections"],
    "Certified-assets scope information",
  );
  if (!Array.isArray(record.collections)) {
    throw new Error("Certified-assets collections are invalid");
  }
  const collections = record.collections.map(parseCollectionInfo);
  for (let index = 1; index < collections.length; index += 1) {
    if (
      compareCanonicalText(
        collections[index - 1]!.id,
        collections[index]!.id,
      ) >= 0
    ) {
      throw new Error("Certified-assets collections are not canonical");
    }
  }
  return Object.freeze({
    installationGeneration: nat64(
      record.installation_generation,
      "Certified-assets installation generation",
    ),
    storeAuthorityEpoch: positiveNat64(
      record.store_authority_epoch,
      "Certified-assets store authority epoch",
    ),
    collections: Object.freeze(collections),
  });
}

function parseCollectionInfo(value: unknown): CertifiedAssetsCollectionInfo {
  const record = exactRecord(
    value,
    [
      "id",
      "kind",
      "authority_epoch",
      "generation",
      "serving",
      "writes",
      "manifest_limits",
      "effective_limits",
    ],
    "Certified-assets collection",
  );
  if (
    typeof record.id !== "string" ||
    !/^[a-z][a-z0-9_]{0,39}$/u.test(record.id)
  ) {
    throw new Error("Certified-assets collection id is invalid");
  }
  const manifest = parseLimits(record.manifest_limits, "manifest limits");
  const effective = parseLimits(record.effective_limits, "effective limits");
  assertLimitsAtMost(effective, manifest, "Certified-assets effective limits");
  return Object.freeze({
    id: record.id,
    kind: nullVariant(
      record.kind,
      ["publication", "immutable_blob", "mutable_blob"],
      "Certified-assets collection kind",
    ),
    authorityEpoch: positiveNat64(
      record.authority_epoch,
      "Certified-assets collection authority epoch",
    ),
    generation: positiveNat64(
      record.generation,
      "Certified-assets collection generation",
    ),
    serving: nullVariant(
      record.serving,
      ["enabled", "disabled"],
      "Certified-assets serving state",
    ),
    writes: nullVariant(
      record.writes,
      ["enabled", "frozen"],
      "Certified-assets write state",
    ),
    manifestLimits: manifest,
    effectiveLimits: effective,
  });
}

function parseUsage(value: unknown): CertifiedAssetsUsage {
  const record = exactRecord(
    value,
    ["current", "manifest_limits", "effective_limits"],
    "Certified-assets usage",
  );
  const manifest = parseLimits(record.manifest_limits, "manifest limits");
  const effective = parseLimits(record.effective_limits, "effective limits");
  assertLimitsAtMost(effective, manifest, "Certified-assets effective limits");
  return Object.freeze({
    current: parseUsageCounters(record.current),
    manifestLimits: manifest,
    effectiveLimits: effective,
  });
}

function parseUsageCounters(value: unknown): CertifiedAssetsUsageCounters {
  const record = exactRecord(
    value,
    [
      "live_entries",
      "occupied_entry_slots",
      "committed_body_bytes",
      "allocated_body_bytes",
      "charged_metadata_bytes",
      "accepted_staged_bytes",
      "reserved_staged_bytes",
      "detached_charged_bytes",
      "active_stages",
      "receipt_lanes",
      "general_receipt_lanes",
      "reserved_general_receipt_lanes",
      "reserved_revocation_lanes",
      "filled_revocation_lanes",
      "receipt_nonce_indexes",
      "receipt_expiry_indexes",
      "cleanup_jobs",
    ],
    "Certified-assets usage counters",
  );
  const counters = Object.freeze({
    liveEntries: nat(record.live_entries, "live entries"),
    occupiedEntrySlots: nat(
      record.occupied_entry_slots,
      "occupied entry slots",
    ),
    committedBodyBytes: nat(
      record.committed_body_bytes,
      "committed body bytes",
    ),
    allocatedBodyBytes: nat(
      record.allocated_body_bytes,
      "allocated body bytes",
    ),
    chargedMetadataBytes: nat(
      record.charged_metadata_bytes,
      "charged metadata bytes",
    ),
    acceptedStagedBytes: nat(
      record.accepted_staged_bytes,
      "accepted staged bytes",
    ),
    reservedStagedBytes: nat(
      record.reserved_staged_bytes,
      "reserved staged bytes",
    ),
    detachedChargedBytes: nat(
      record.detached_charged_bytes,
      "detached charged bytes",
    ),
    activeStages: nat(record.active_stages, "active stages"),
    receiptLanes: nat(record.receipt_lanes, "receipt lanes"),
    generalReceiptLanes: nat(
      record.general_receipt_lanes,
      "general receipt lanes",
    ),
    reservedGeneralReceiptLanes: nat(
      record.reserved_general_receipt_lanes,
      "reserved general receipt lanes",
    ),
    reservedRevocationLanes: nat(
      record.reserved_revocation_lanes,
      "reserved revocation lanes",
    ),
    filledRevocationLanes: nat(
      record.filled_revocation_lanes,
      "filled revocation lanes",
    ),
    receiptNonceIndexes: nat(
      record.receipt_nonce_indexes,
      "receipt nonce indexes",
    ),
    receiptExpiryIndexes: nat(
      record.receipt_expiry_indexes,
      "receipt expiry indexes",
    ),
    cleanupJobs: nat(record.cleanup_jobs, "cleanup jobs"),
  });
  if (counters.liveEntries > counters.occupiedEntrySlots) {
    throw new Error("Certified-assets entry counters are inconsistent");
  }
  if (
    counters.generalReceiptLanes +
      counters.reservedGeneralReceiptLanes +
      counters.reservedRevocationLanes +
      counters.filledRevocationLanes !==
    counters.receiptLanes
  ) {
    throw new Error("Certified-assets receipt counters are inconsistent");
  }
  return counters;
}

function parseLimits(value: unknown, label: string): CertifiedAssetsLimits {
  const record = exactRecord(
    value,
    [
      "entries",
      "committed_bytes",
      "object_bytes",
      "staged_bytes",
      "pending_stages",
      "batch_operations",
      "batch_bytes",
      "general_receipts",
      "revocation_lanes",
    ],
    `Certified-assets ${label}`,
  );
  return Object.freeze({
    entries: nat(record.entries, `${label} entries`),
    committedBytes: nat(
      record.committed_bytes,
      `${label} committed bytes`,
    ),
    objectBytes: nat(record.object_bytes, `${label} object bytes`),
    stagedBytes: nat(record.staged_bytes, `${label} staged bytes`),
    pendingStages: nat(record.pending_stages, `${label} pending stages`),
    batchOperations: nat(
      record.batch_operations,
      `${label} batch operations`,
    ),
    batchBytes: nat(record.batch_bytes, `${label} batch bytes`),
    generalReceipts: nat(
      record.general_receipts,
      `${label} general receipts`,
    ),
    revocationLanes: nat(
      record.revocation_lanes,
      `${label} revocation lanes`,
    ),
  });
}

function parseMaintenancePage(value: unknown): CertifiedAssetsMaintenancePage {
  const record = exactRecord(
    value,
    ["page", "has_more", "remaining_jobs"],
    "Certified-assets maintenance page",
  );
  if (typeof record.has_more !== "boolean") {
    throw new Error("Certified-assets maintenance has_more is invalid");
  }
  return Object.freeze({
    page: parseReclaimed(record.page),
    hasMore: record.has_more,
    remainingJobs: nat(
      record.remaining_jobs,
      "Certified-assets remaining cleanup jobs",
    ),
  });
}

function parseReclaimed(value: unknown): CertifiedAssetsReclaimed {
  const record = exactRecord(
    value,
    [
      "records",
      "bodies",
      "body_bytes",
      "charged_bytes",
      "authenticated_nodes",
      "receipts",
    ],
    "Certified-assets reclaimed counts",
  );
  return Object.freeze({
    records: nat(record.records, "reclaimed records"),
    bodies: nat(record.bodies, "reclaimed bodies"),
    bodyBytes: nat(record.body_bytes, "reclaimed body bytes"),
    chargedBytes: nat(record.charged_bytes, "reclaimed charged bytes"),
    authenticatedNodes: nat(
      record.authenticated_nodes,
      "reclaimed authenticated nodes",
    ),
    receipts: nat(record.receipts, "reclaimed receipts"),
  });
}

function assertSnapshotMatchesManifest(
  snapshot: CertifiedAssetsSettingsSnapshot,
  manifest: NeutronCertifiedAssetsCapabilityConfig,
): void {
  if (manifest.api !== 2) {
    throw new Error("Certified-assets Settings require manifest API 2");
  }
  const expected = manifestLimits(manifest);
  assertLimitsEqual(
    snapshot.usage.manifestLimits,
    expected,
    "Certified-assets manifest limits",
  );
  const expectedCollections = [...manifest.collections].sort((left, right) =>
    compareCanonicalText(left.id, right.id),
  );
  if (snapshot.scopeInfo.collections.length !== expectedCollections.length) {
    throw new Error("Certified-assets scope collections do not match the manifest");
  }
  for (let index = 0; index < expectedCollections.length; index += 1) {
    const declared = expectedCollections[index]!;
    const actual = snapshot.scopeInfo.collections[index]!;
    if (
      actual.id !== declared.id ||
      actual.kind !== declared.kind
    ) {
      throw new Error(
        "Certified-assets scope collections do not match the manifest",
      );
    }
    assertLimitsEqual(
      actual.manifestLimits,
      {
        ...expected,
        objectBytes: BigInt(
          Math.min(
            manifest.max_object_bytes,
            declared.max_object_bytes ?? manifest.max_object_bytes,
          ),
        ),
      },
      `Certified-assets ${actual.id} manifest limits`,
    );
  }
}

function manifestLimits(
  manifest: NeutronCertifiedAssetsCapabilityConfig,
): CertifiedAssetsLimits {
  if (manifest.api !== 2) {
    throw new Error("Certified-assets Settings require manifest API 2");
  }
  return Object.freeze({
    entries: BigInt(manifest.max_entries),
    committedBytes: BigInt(manifest.max_committed_bytes),
    objectBytes: BigInt(manifest.max_object_bytes),
    stagedBytes: BigInt(manifest.max_staged_bytes),
    pendingStages: BigInt(manifest.max_pending_stages),
    batchOperations: BigInt(manifest.max_batch_operations),
    batchBytes: BigInt(manifest.max_batch_bytes),
    generalReceipts: BigInt(manifest.max_idempotency_receipts),
    revocationLanes: BigInt(manifest.max_entries),
  });
}

function assertAdmissionCeilings(
  ceilings: CertifiedAssetsAdmissionCeilings,
  manifest: CertifiedAssetsLimits,
): void {
  const values = [
    ["entries", ceilings.entries, manifest.entries],
    ["committed bytes", ceilings.committedBytes, manifest.committedBytes],
    ["staged bytes", ceilings.stagedBytes, manifest.stagedBytes],
    ["general receipts", ceilings.generalReceipts, manifest.generalReceipts],
  ] as const;
  for (const [label, value, maximum] of values) {
    if (typeof value !== "bigint" || value < 0n || value > maximum) {
      throw new Error(
        `Certified-assets ${label} ceiling exceeds its manifest maximum`,
      );
    }
  }
}

function assertLimitsAtMost(
  candidate: CertifiedAssetsLimits,
  maximum: CertifiedAssetsLimits,
  label: string,
): void {
  for (const key of Object.keys(maximum) as (keyof CertifiedAssetsLimits)[]) {
    if (candidate[key] > maximum[key]) {
      throw new Error(`${label} exceed manifest maxima`);
    }
  }
}

function assertLimitsEqual(
  candidate: CertifiedAssetsLimits,
  expected: CertifiedAssetsLimits,
  label: string,
): void {
  for (const key of Object.keys(expected) as (keyof CertifiedAssetsLimits)[]) {
    if (candidate[key] !== expected[key]) {
      throw new Error(`${label} do not match the installed plan`);
    }
  }
}

function parseUnitResult(value: unknown, label: string): void {
  // The static @dfinity actor preserves the Result variant. The established
  // runtime-DID fallback unwraps a successful nullary Result to null.
  if (value === null) return;
  const result = plainRecord(value, `${label} result`);
  const keys = Object.keys(result);
  if (keys.length !== 1) throw new Error(`${label} result is invalid`);
  if (keys[0] === "ok" && result.ok === null) return;
  if (keys[0] === "err") {
    throw new Error(`${label} failed: ${parseErrorCode(result.err)}`);
  }
  throw new Error(`${label} result is invalid`);
}

function parseResult<T>(
  value: unknown,
  label: string,
  parse: (candidate: unknown) => T,
): T {
  // icblast's runtime-DID bridge unwraps successful Candid Results. Parsing
  // the business record directly remains fail-closed because each parser
  // below enforces its complete record shape.
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !Object.prototype.hasOwnProperty.call(value, "ok") &&
    !Object.prototype.hasOwnProperty.call(value, "err")
  ) {
    return parse(value);
  }
  const result = plainRecord(value, `${label} result`);
  const keys = Object.keys(result);
  if (keys.length !== 1) throw new Error(`${label} result is invalid`);
  if (keys[0] === "ok") return parse(result.ok);
  if (keys[0] === "err") {
    throw new Error(`${label} failed: ${parseErrorCode(result.err)}`);
  }
  throw new Error(`${label} result is invalid`);
}

function parseErrorCode(value: unknown): string {
  const variant = plainRecord(value, "Certified-assets error");
  const keys = Object.keys(variant);
  if (keys.length !== 1) throw new Error("Certified-assets error is invalid");
  const code = keys[0]!;
  const payload = variant[code];
  const nullary = [
    "invalid",
    "stale_scope",
    "disabled",
    "frozen",
    "not_found",
    "retired_key",
    "quota",
    "receipt_full",
    "aborted",
    "expired",
    "not_ready",
    "generation_exhausted",
    "revision_exhausted",
    "low_cycles",
    "busy",
  ];
  if (nullary.includes(code) && payload === null) return code;
  if (code === "stale_generation") {
    const record = exactRecord(
      payload,
      ["current"],
      "Certified-assets stale-generation error",
    );
    positiveNat64(record.current, "current generation");
    return code;
  }
  if (code === "incomplete") {
    const record = exactRecord(
      payload,
      ["missing_blocks"],
      "Certified-assets incomplete error",
    );
    if (!Array.isArray(record.missing_blocks) || record.missing_blocks.length > 16) {
      throw new Error("Certified-assets incomplete error is invalid");
    }
    for (const index of record.missing_blocks) {
      if (nat(index, "missing block index") > U32_MAX) {
        throw new Error("Certified-assets incomplete error is invalid");
      }
    }
    return code;
  }
  // A conflict contains a potentially extensible app-facing identity. It is
  // a legitimate failure, but Settings never needs or displays that payload.
  if (code === "conflict") {
    plainRecord(payload, "Certified-assets conflict error");
    return code;
  }
  throw new Error("Certified-assets error variant is unsupported");
}

function decimalNat(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} must be a whole non-negative number`);
  }
  return BigInt(value);
}

function nullVariant<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  const variant = plainRecord(value, label);
  const keys = Object.keys(variant);
  if (
    keys.length !== 1 ||
    !allowed.includes(keys[0] as T) ||
    variant[keys[0]!] !== null
  ) {
    throw new Error(`${label} is invalid`);
  }
  return keys[0] as T;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = plainRecord(value, label);
  const actual = Object.keys(record).sort(compareCanonicalText);
  const expected = [...keys].sort(compareCanonicalText);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return record;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function nat(value: unknown, label: string): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)) {
    return BigInt(value);
  }
  throw new Error(`${label} is not a safe Nat`);
}

function nat64(value: unknown, label: string): bigint {
  const parsed = nat(value, label);
  if (parsed > U64_MAX) throw new Error(`${label} exceeds Nat64`);
  return parsed;
}

function positiveNat64(value: unknown, label: string): bigint {
  const parsed = nat64(value, label);
  if (parsed === 0n) throw new Error(`${label} must be positive`);
  return parsed;
}
