import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Actor, type ActorMethod } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { createFixtureAgent } from "./pocketic-clock";

const SNAPSHOT_CHUNK_BYTES = 1_900_000n;
const MIN_MATERIAL_BYTES = 16;
const MAX_MATERIALS = 16;

export type ForbiddenMaterial = {
  bytes: Uint8Array;
  label: string;
  textual?: boolean;
};

export type RedactionNeedle = {
  bytes: Uint8Array;
  encoding: string;
  material: string;
};

export type BackendRedactionEvidence = {
  canisterLogs: {
    bytes: number;
    records: number;
  };
  snapshot: {
    decodedWasmBytes: number;
    metadataBytes: number;
    stableMemoryBytes: number;
    wasmChunkBytes: number;
    wasmMemoryBytes: number;
    wasmMemoryTransientFindings: string[];
    wasmModuleBytes: number;
  };
  surfaces: readonly [
    "complete-wasm-module-and-memory-snapshot",
    "complete-stable-memory-snapshot",
    "wasm-chunk-store",
    "canister-logs",
  ];
};

type SnapshotKind =
  | { wasm_module: { offset: bigint; size: bigint } }
  | { wasm_memory: { offset: bigint; size: bigint } }
  | { stable_memory: { offset: bigint; size: bigint } }
  | { wasm_chunk: { hash: Uint8Array } };

type ManagementActor = {
  delete_canister_snapshot: ActorMethod<[{
    canister_id: Principal;
    snapshot_id: Uint8Array;
  }], undefined>;
  fetch_canister_logs: ActorMethod<[{
    canister_id: Principal;
  }], { canister_log_records: Array<{
    content: Uint8Array;
    idx: bigint;
    timestamp_nanos: bigint;
  }> }>;
  read_canister_snapshot_data: ActorMethod<[{
    canister_id: Principal;
    kind: SnapshotKind;
    snapshot_id: Uint8Array;
  }], { chunk: Uint8Array }>;
  read_canister_snapshot_metadata: ActorMethod<[{
    canister_id: Principal;
    snapshot_id: Uint8Array;
  }], {
    certified_data: Uint8Array;
    globals: Array<Record<string, number | bigint>>;
    stable_memory_size: bigint;
    wasm_chunk_store: Array<{ hash: Uint8Array }>;
    wasm_memory_size: bigint;
    wasm_module_size: bigint;
  }>;
  start_canister: ActorMethod<[{ canister_id: Principal }], undefined>;
  stop_canister: ActorMethod<[{ canister_id: Principal }], undefined>;
  take_canister_snapshot: ActorMethod<[{
    canister_id: Principal;
    replace_snapshot: [];
    sender_canister_version: [];
    uninstall_code: [];
  }], {
    id: Uint8Array;
    taken_at_timestamp: bigint;
    total_size: bigint;
  }>;
};

/** Build exact raw and common serialization needles for every forbidden value. */
export function redactionNeedles(
  materials: readonly ForbiddenMaterial[],
): RedactionNeedle[] {
  if (materials.length === 0 || materials.length > MAX_MATERIALS) {
    throw new Error("Redaction proof needs one to sixteen forbidden materials");
  }
  const labels = new Set<string>();
  const output = new Map<string, RedactionNeedle>();
  for (const material of materials) {
    if (
      !/^[a-z][a-z0-9-]{1,63}$/u.test(material.label) ||
      labels.has(material.label)
    ) {
      throw new Error("Redaction material labels must be unique canonical ids");
    }
    labels.add(material.label);
    const bytes = exactMaterialBytes(material.bytes, material.label);
    const buffer = Buffer.from(bytes);
    const encodings: Array<[string, Uint8Array]> = [
      ["raw", buffer],
      ["hex-lower", Buffer.from(buffer.toString("hex"), "ascii")],
      ["hex-upper", Buffer.from(buffer.toString("hex").toUpperCase(), "ascii")],
      ["base64", Buffer.from(buffer.toString("base64"), "ascii")],
      [
        "base64url",
        Buffer.from(buffer.toString("base64url"), "ascii"),
      ],
      ["json-array", Buffer.from(JSON.stringify(Array.from(bytes)), "utf8")],
      ["decimal-csv", Buffer.from(Array.from(bytes).join(","), "ascii")],
    ];
    if (material.textual) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const utf16le = Buffer.from(text, "utf16le");
      const utf16be = Buffer.from(utf16le);
      utf16be.swap16();
      encodings.push(["utf16le", utf16le], ["utf16be", utf16be]);
    }
    for (const [encoding, candidate] of encodings) {
      if (candidate.byteLength < MIN_MATERIAL_BYTES) continue;
      const key = Buffer.from(candidate).toString("hex");
      if (!output.has(key)) {
        output.set(key, {
          bytes: Uint8Array.from(candidate),
          encoding,
          material: material.label,
        });
      }
    }
  }
  return [...output.values()];
}

export function assertNoForbiddenMaterial(
  value: Uint8Array,
  surface: string,
  materials: readonly ForbiddenMaterial[],
): void {
  const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  for (const needle of redactionNeedles(materials)) {
    if (buffer.indexOf(needle.bytes) !== -1) {
      throw new Error(
        `${needle.material} appeared in ${surface} (${needle.encoding})`,
      );
    }
  }
}

/** Return hashes only; the command report must not reprint proof secrets. */
export function summarizeForbiddenMaterials(
  materials: readonly ForbiddenMaterial[],
): Array<{ bytes: number; label: string; sha256: string }> {
  redactionNeedles(materials);
  return materials.map((material) => ({
    bytes: material.bytes.byteLength,
    label: material.label,
    sha256: createHash("sha256").update(material.bytes).digest("hex"),
  }));
}

/**
 * Scan the real management snapshot and bounded canister log projection. The
 * temporary snapshot is always deleted and the canister is always restarted.
 */
export async function inspectInstalledBackendRedaction(input: {
  canisterId: string;
  host: string;
  materials: readonly ForbiddenMaterial[];
  wasmMemoryTransitLabels?: readonly string[];
}): Promise<BackendRedactionEvidence> {
  const transitLabels = new Set(input.wasmMemoryTransitLabels ?? []);
  const knownLabels = new Set(input.materials.map((material) => material.label));
  for (const label of transitLabels) {
    if (!knownLabels.has(label)) {
      throw new Error(`Unknown Wasm transit material ${label}`);
    }
  }
  const strictWasmMaterials = input.materials.filter(
    (material) => !transitLabels.has(material.label),
  );
  const transitWasmMaterials = input.materials.filter(
    (material) => transitLabels.has(material.label),
  );
  const target = Principal.fromText(input.canisterId);
  const agent = await createFixtureAgent(input.host);
  const management = Actor.createActor<ManagementActor>(managementIdl, {
    agent,
    canisterId: Principal.fromText("aaaaa-aa"),
    effectiveCanisterId: target,
    queryTransform: () => ({ effectiveCanisterId: target }),
  });

  const logs = await management.fetch_canister_logs({ canister_id: target });
  const logProjection = Buffer.from(JSON.stringify(
    logs.canister_log_records.map((record) => ({
      content: Buffer.from(record.content).toString("base64"),
      idx: record.idx.toString(),
      timestampNanos: record.timestamp_nanos.toString(),
    })),
  ));
  assertNoForbiddenMaterial(
    logProjection,
    "canister log projection",
    input.materials,
  );
  for (const record of logs.canister_log_records) {
    assertNoForbiddenMaterial(
      record.content,
      `canister log record ${record.idx}`,
      input.materials,
    );
  }

  let snapshotId: Uint8Array | null = null;
  await management.stop_canister({ canister_id: target });
  try {
    const snapshot = await management.take_canister_snapshot({
      canister_id: target,
      replace_snapshot: [],
      sender_canister_version: [],
      uninstall_code: [],
    });
    snapshotId = exactNonemptyBytes(snapshot.id, "snapshot id");
  } finally {
    await management.start_canister({ canister_id: target });
  }

  try {
    const metadata = await management.read_canister_snapshot_metadata({
      canister_id: target,
      snapshot_id: snapshotId,
    });
    const metadataBytes = Buffer.from(JSON.stringify(metadata, jsonReplacer));
    assertNoForbiddenMaterial(
      metadataBytes,
      "snapshot metadata",
      input.materials,
    );

    const wasmModule = await readSnapshotRange(
      management,
      target,
      snapshotId,
      "wasm_module",
      metadata.wasm_module_size,
      input.materials,
      true,
    );
    const wasmMemory = await readSnapshotRange(
      management,
      target,
      snapshotId,
      "wasm_memory",
      metadata.wasm_memory_size,
      strictWasmMaterials,
      false,
      transitWasmMaterials,
    );
    const stableMemory = await readSnapshotRange(
      management,
      target,
      snapshotId,
      "stable_memory",
      metadata.stable_memory_size,
      input.materials,
      false,
    );
    let wasmChunkBytes = 0;
    for (const [index, chunk] of metadata.wasm_chunk_store.entries()) {
      const response = await management.read_canister_snapshot_data({
        canister_id: target,
        snapshot_id: snapshotId,
        kind: { wasm_chunk: { hash: chunk.hash } },
      });
      assertNoForbiddenMaterial(
        response.chunk,
        `snapshot Wasm chunk ${index}`,
        input.materials,
      );
      wasmChunkBytes += response.chunk.byteLength;
    }
    return {
      canisterLogs: {
        bytes: logProjection.byteLength,
        records: logs.canister_log_records.length,
      },
      snapshot: {
        decodedWasmBytes: wasmModule.decodedBytes,
        metadataBytes: metadataBytes.byteLength,
        stableMemoryBytes: stableMemory.rawBytes,
        wasmChunkBytes,
        wasmMemoryBytes: wasmMemory.rawBytes,
        wasmMemoryTransientFindings: wasmMemory.observedMaterials,
        wasmModuleBytes: wasmModule.rawBytes,
      },
      surfaces: [
        "complete-wasm-module-and-memory-snapshot",
        "complete-stable-memory-snapshot",
        "wasm-chunk-store",
        "canister-logs",
      ],
    };
  } finally {
    if (snapshotId !== null) {
      await management.delete_canister_snapshot({
        canister_id: target,
        snapshot_id: snapshotId,
      });
    }
  }
}

async function readSnapshotRange(
  management: ManagementActor,
  canisterId: Principal,
  snapshotId: Uint8Array,
  kind: "wasm_module" | "wasm_memory" | "stable_memory",
  totalSize: bigint,
  materials: readonly ForbiddenMaterial[],
  collect: boolean,
  observeMaterials: readonly ForbiddenMaterial[] = [],
): Promise<{
  decodedBytes: number;
  observedMaterials: string[];
  rawBytes: number;
}> {
  if (totalSize < 0n || totalSize > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Snapshot ${kind} size is outside the supported range`);
  }
  const needles = redactionNeedles(materials);
  const observedNeedles = observeMaterials.length > 0
    ? redactionNeedles(observeMaterials)
    : [];
  const allNeedles = [...needles, ...observedNeedles];
  const overlap = Math.max(...allNeedles.map((needle) => needle.bytes.byteLength)) - 1;
  const observed = new Set<string>();
  let tail = Buffer.alloc(0);
  let offset = 0n;
  const collected: Buffer[] = [];
  while (offset < totalSize) {
    const size = totalSize - offset < SNAPSHOT_CHUNK_BYTES
      ? totalSize - offset
      : SNAPSHOT_CHUNK_BYTES;
    const response = await management.read_canister_snapshot_data({
      canister_id: canisterId,
      snapshot_id: snapshotId,
      kind: { [kind]: { offset, size } } as SnapshotKind,
    });
    if (response.chunk.byteLength !== Number(size)) {
      throw new Error(
        `Snapshot ${kind} returned ${response.chunk.byteLength} bytes at ${offset}, expected ${size}`,
      );
    }
    const bytes = Buffer.from(response.chunk);
    const combined = tail.byteLength === 0 ? bytes : Buffer.concat([tail, bytes]);
    assertNeedlesAbsent(combined, `snapshot ${kind}`, needles);
    for (const needle of observedNeedles) {
      if (combined.indexOf(needle.bytes) !== -1) {
        observed.add(needle.material);
      }
    }
    tail = combined.subarray(Math.max(0, combined.byteLength - overlap));
    if (collect) collected.push(bytes);
    offset += size;
  }

  let decodedBytes = Number(totalSize);
  if (collect) {
    const raw = Buffer.concat(collected);
    const decoded = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
    assertNoForbiddenMaterial(
      decoded,
      `decoded snapshot ${kind}`,
      materials,
    );
    decodedBytes = decoded.byteLength;
  }
  return {
    decodedBytes,
    observedMaterials: [...observed].sort(),
    rawBytes: Number(totalSize),
  };
}

function assertNeedlesAbsent(
  value: Uint8Array,
  surface: string,
  needles: readonly RedactionNeedle[],
): void {
  const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  for (const needle of needles) {
    if (buffer.indexOf(needle.bytes) !== -1) {
      throw new Error(
        `${needle.material} appeared in ${surface} (${needle.encoding})`,
      );
    }
  }
}

function exactMaterialBytes(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < MIN_MATERIAL_BYTES) {
    throw new Error(`${label} must contain at least sixteen bytes`);
  }
  return value.slice();
}

function exactNonemptyBytes(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error(`Management canister returned an empty ${label}`);
  }
  return value.slice();
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return { base64: Buffer.from(value).toString("base64") };
  }
  return value;
}

function managementIdl(
  { IDL }: Parameters<Parameters<typeof Actor.createActor>[0]>[0],
): ReturnType<Parameters<typeof Actor.createActor>[0]> {
  const Canister = IDL.Record({ canister_id: IDL.Principal });
  return IDL.Service({
    delete_canister_snapshot: IDL.Func([IDL.Record({
      canister_id: IDL.Principal,
      snapshot_id: IDL.Vec(IDL.Nat8),
    })], [], []),
    fetch_canister_logs: IDL.Func([Canister], [IDL.Record({
      canister_log_records: IDL.Vec(IDL.Record({
        content: IDL.Vec(IDL.Nat8),
        idx: IDL.Nat64,
        timestamp_nanos: IDL.Nat64,
      })),
    })], ["query"]),
    read_canister_snapshot_data: IDL.Func([IDL.Record({
      canister_id: IDL.Principal,
      kind: IDL.Variant({
        stable_memory: IDL.Record({ offset: IDL.Nat64, size: IDL.Nat64 }),
        wasm_chunk: IDL.Record({ hash: IDL.Vec(IDL.Nat8) }),
        wasm_memory: IDL.Record({ offset: IDL.Nat64, size: IDL.Nat64 }),
        wasm_module: IDL.Record({ offset: IDL.Nat64, size: IDL.Nat64 }),
      }),
      snapshot_id: IDL.Vec(IDL.Nat8),
    })], [IDL.Record({ chunk: IDL.Vec(IDL.Nat8) })], []),
    read_canister_snapshot_metadata: IDL.Func([IDL.Record({
      canister_id: IDL.Principal,
      snapshot_id: IDL.Vec(IDL.Nat8),
    })], [IDL.Record({
      certified_data: IDL.Vec(IDL.Nat8),
      globals: IDL.Vec(IDL.Variant({
        f32: IDL.Float32,
        f64: IDL.Float64,
        i32: IDL.Int32,
        i64: IDL.Int64,
        v128: IDL.Nat,
      })),
      stable_memory_size: IDL.Nat64,
      wasm_chunk_store: IDL.Vec(IDL.Record({ hash: IDL.Vec(IDL.Nat8) })),
      wasm_memory_size: IDL.Nat64,
      wasm_module_size: IDL.Nat64,
    })], []),
    start_canister: IDL.Func([Canister], [], []),
    stop_canister: IDL.Func([Canister], [], []),
    take_canister_snapshot: IDL.Func([IDL.Record({
      canister_id: IDL.Principal,
      replace_snapshot: IDL.Opt(IDL.Vec(IDL.Nat8)),
      sender_canister_version: IDL.Opt(IDL.Nat64),
      uninstall_code: IDL.Opt(IDL.Bool),
    })], [IDL.Record({
      id: IDL.Vec(IDL.Nat8),
      taken_at_timestamp: IDL.Nat64,
      total_size: IDL.Nat64,
    })], []),
  });
}
