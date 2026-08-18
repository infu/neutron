/**
 * Protocol provenance (reviewed 15 August 2026): this local minimal reader is
 * implemented against the public DFINITY IC Registry interfaces at immutable
 * revision eb55873567bcda6cdcf3c0a573d4db13daaa2c8e. It does not vendor the
 * upstream .proto or Rust source files. The Registry transport and key files
 * inherit IC-1.0; the node, node-operator, and data-center protobuf definitions
 * inherit Apache-2.0. Exact paths, hashes, and license copies are recorded in
 * ../THIRD_PARTY_NOTICES.md and ../README.md.
 */
import { HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";

const REGISTRY_CANISTER_ID = Principal.fromText("rwlgt-iiaaa-aaaaa-aaaaa-cai");
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type TopologyPhase =
  | { kind: "subnet" }
  | { kind: "registry" }
  | { kind: "nodes"; completed: number; total: number };

export interface SubnetNode {
  nodeId: string;
  operatorId: string | null;
  providerId: string | null;
  dataCenterId: string | null;
  region: string | null;
  continent: string | null;
  countryCode: string | null;
  locality: string | null;
  owner: string | null;
  latitude: number | null;
  longitude: number | null;
  error: string | null;
}

export interface SubnetTopology {
  canisterId: string;
  subnetId: string;
  registryVersion: string;
  nodes: SubnetNode[];
  loadedAt: number;
}

interface WireField {
  number: number;
  wireType: number;
  value: bigint | Uint8Array;
}

interface OperatorRecord {
  operatorId: string;
  providerId: string | null;
  dataCenterId: string;
}

interface DataCenterRecord {
  dataCenterId: string;
  region: string;
  owner: string;
  latitude: number | null;
  longitude: number | null;
}

interface RegionParts {
  continent: string | null;
  countryCode: string | null;
  locality: string | null;
}

export async function loadSubnetTopology(
  canisterId: string,
  onProgress?: (phase: TopologyPhase) => void,
): Promise<SubnetTopology> {
  onProgress?.({ kind: "subnet" });

  const agent = await HttpAgent.create();
  if (isLocalNetwork()) {
    await agent.fetchRootKey();
  }

  const canister = Principal.fromText(canisterId);
  const subnetStatus = await agent.fetchSubnetKeys(canister);

  if (!subnetStatus) {
    throw new Error("The IC state tree did not return this canister's subnet.");
  }

  const nodeIds = [...subnetStatus.nodeKeys.keys()].sort();
  if (nodeIds.length === 0) {
    throw new Error("The subnet certificate did not include any node keys.");
  }

  onProgress?.({ kind: "registry" });
  const registryVersion = await getLatestRegistryVersion(agent);
  const operatorCache = new Map<string, Promise<OperatorRecord>>();
  const dataCenterCache = new Map<string, Promise<DataCenterRecord>>();
  let completed = 0;

  const nodes = await Promise.all(
    nodeIds.map(async (nodeId) => {
      try {
        return await locateNode(
          agent,
          registryVersion,
          nodeId,
          operatorCache,
          dataCenterCache,
        );
      } catch (error) {
        return unresolvedNode(nodeId, readableError(error));
      } finally {
        completed += 1;
        onProgress?.({ kind: "nodes", completed, total: nodeIds.length });
      }
    }),
  );

  return {
    canisterId,
    subnetId: subnetStatus.subnetId,
    registryVersion: registryVersion.toString(),
    nodes,
    loadedAt: Date.now(),
  };
}

async function locateNode(
  agent: HttpAgent,
  version: bigint,
  nodeId: string,
  operatorCache: Map<string, Promise<OperatorRecord>>,
  dataCenterCache: Map<string, Promise<DataCenterRecord>>,
): Promise<SubnetNode> {
  const nodeRecord = parseWireFields(
    await getRegistryValue(agent, `node_record_${nodeId}`, version),
  );
  const operatorBytes = requiredBytes(nodeRecord, 15, "node operator id");
  const operatorId = Principal.fromUint8Array(operatorBytes).toText();

  let operatorPromise = operatorCache.get(operatorId);
  if (!operatorPromise) {
    operatorPromise = loadOperator(agent, version, operatorId);
    operatorCache.set(operatorId, operatorPromise);
  }
  const operator = await operatorPromise;

  const dataCenterKey = operator.dataCenterId.toLowerCase();
  let dataCenterPromise = dataCenterCache.get(dataCenterKey);
  if (!dataCenterPromise) {
    dataCenterPromise = loadDataCenter(agent, version, dataCenterKey);
    dataCenterCache.set(dataCenterKey, dataCenterPromise);
  }
  const dataCenter = await dataCenterPromise;
  const region = parseRegion(dataCenter.region);

  return {
    nodeId,
    operatorId,
    providerId: operator.providerId,
    dataCenterId: dataCenter.dataCenterId,
    region: dataCenter.region,
    continent: region.continent,
    countryCode: region.countryCode,
    locality: region.locality,
    owner: dataCenter.owner,
    latitude: dataCenter.latitude,
    longitude: dataCenter.longitude,
    error: dataCenter.latitude === null || dataCenter.longitude === null
      ? "The Registry data-center record has no GPS coordinates."
      : null,
  };
}

async function loadOperator(
  agent: HttpAgent,
  version: bigint,
  operatorId: string,
): Promise<OperatorRecord> {
  const fields = parseWireFields(
    await getRegistryValue(agent, `node_operator_record_${operatorId}`, version),
  );
  const providerBytes = optionalBytes(fields, 3);

  return {
    operatorId,
    providerId: providerBytes
      ? Principal.fromUint8Array(providerBytes).toText()
      : null,
    dataCenterId: decodeText(requiredBytes(fields, 4, "data center id")),
  };
}

async function loadDataCenter(
  agent: HttpAgent,
  version: bigint,
  dataCenterKey: string,
): Promise<DataCenterRecord> {
  const fields = parseWireFields(
    await getRegistryValue(agent, `data_center_record_${dataCenterKey}`, version),
  );
  const gpsBytes = optionalBytes(fields, 4);
  const gps = gpsBytes ? parseWireFields(gpsBytes) : [];
  const latitude = optionalFloat32(gps, 1);
  const longitude = optionalFloat32(gps, 2);

  return {
    dataCenterId: decodeText(requiredBytes(fields, 1, "data center record id")),
    region: decodeText(requiredBytes(fields, 2, "data center region")),
    owner: decodeText(requiredBytes(fields, 3, "data center owner")),
    latitude: validLatitude(latitude) ? latitude : null,
    longitude: validLongitude(longitude) ? longitude : null,
  };
}

async function getLatestRegistryVersion(agent: HttpAgent): Promise<bigint> {
  const fields = parseWireFields(
    await rawRegistryQuery(agent, "get_latest_version", new Uint8Array()),
  );
  const version = optionalVarint(fields, 1);

  if (version === null || version === 0n) {
    throw new Error("The NNS Registry returned an invalid version.");
  }
  return version;
}

async function getRegistryValue(
  agent: HttpAgent,
  key: string,
  version: bigint,
): Promise<Uint8Array> {
  const response = parseWireFields(
    await rawRegistryQuery(agent, "get_value", encodeGetValueRequest(key, version)),
  );
  const registryError = optionalBytes(response, 1);

  if (registryError) {
    const fields = parseWireFields(registryError);
    const code = optionalVarint(fields, 1)?.toString() ?? "unknown";
    const reasonBytes = optionalBytes(fields, 2);
    const reason = reasonBytes ? decodeText(reasonBytes) : "Registry key not found";
    throw new Error(`${reason} (Registry error ${code})`);
  }

  const value = optionalBytes(response, 3);
  if (value) {
    return value;
  }
  if (optionalBytes(response, 4)) {
    throw new Error(`Registry value for ${key} requires chunked retrieval.`);
  }
  throw new Error(`Registry value for ${key} was empty.`);
}

async function rawRegistryQuery(
  agent: HttpAgent,
  methodName: string,
  arg: Uint8Array,
): Promise<Uint8Array> {
  const response = await agent.query(REGISTRY_CANISTER_ID, { methodName, arg });
  if (response.status !== "replied") {
    throw new Error(response.reject_message || `Registry query ${methodName} was rejected.`);
  }
  return response.reply.arg;
}

function encodeGetValueRequest(key: string, version: bigint): Uint8Array {
  const versionValue = Uint8Array.from([0x08, ...encodeVarint(version)]);
  const keyValue = textEncoder.encode(key);

  return Uint8Array.from([
    0x0a,
    ...encodeVarint(BigInt(versionValue.length)),
    ...versionValue,
    0x12,
    ...encodeVarint(BigInt(keyValue.length)),
    ...keyValue,
  ]);
}

function encodeVarint(input: bigint): number[] {
  if (input < 0n) {
    throw new Error("Cannot encode a negative protobuf varint.");
  }
  const bytes: number[] = [];
  let value = input;

  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0n);

  return bytes;
}

export function parseWireFields(bytes: Uint8Array): WireField[] {
  const fields: WireField[] = [];
  let cursor = 0;

  while (cursor < bytes.length) {
    const tag = readVarint(bytes, cursor);
    cursor = tag.cursor;
    const number = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x07n);

    if (number <= 0) {
      throw new Error("Invalid protobuf field number.");
    }

    if (wireType === 0) {
      const value = readVarint(bytes, cursor);
      cursor = value.cursor;
      fields.push({ number, wireType, value: value.value });
      continue;
    }

    if (wireType === 1 || wireType === 5) {
      const size = wireType === 1 ? 8 : 4;
      ensureAvailable(bytes, cursor, size);
      fields.push({ number, wireType, value: bytes.slice(cursor, cursor + size) });
      cursor += size;
      continue;
    }

    if (wireType === 2) {
      const length = readVarint(bytes, cursor);
      cursor = length.cursor;
      const size = safeLength(length.value);
      ensureAvailable(bytes, cursor, size);
      fields.push({ number, wireType, value: bytes.slice(cursor, cursor + size) });
      cursor += size;
      continue;
    }

    throw new Error(`Unsupported protobuf wire type ${wireType}.`);
  }

  return fields;
}

function readVarint(bytes: Uint8Array, start: number): { value: bigint; cursor: number } {
  let value = 0n;
  let shift = 0n;
  let cursor = start;

  for (let count = 0; count < 10; count += 1) {
    ensureAvailable(bytes, cursor, 1);
    const byte = bytes[cursor]!;
    cursor += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, cursor };
    }
    shift += 7n;
  }

  throw new Error("Protobuf varint exceeds 64 bits.");
}

function ensureAvailable(bytes: Uint8Array, cursor: number, size: number): void {
  if (cursor < 0 || size < 0 || cursor + size > bytes.length) {
    throw new Error("Truncated protobuf payload.");
  }
}

function safeLength(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Protobuf field is too large for this browser.");
  }
  return Number(value);
}

function optionalBytes(fields: WireField[], number: number): Uint8Array | null {
  const field = fields.find((candidate) => candidate.number === number);
  return field?.value instanceof Uint8Array ? field.value : null;
}

function requiredBytes(fields: WireField[], number: number, label: string): Uint8Array {
  const value = optionalBytes(fields, number);
  if (!value) throw new Error(`Registry record is missing ${label}.`);
  return value;
}

function optionalVarint(fields: WireField[], number: number): bigint | null {
  const field = fields.find((candidate) => candidate.number === number);
  return typeof field?.value === "bigint" ? field.value : null;
}

function optionalFloat32(fields: WireField[], number: number): number | null {
  const bytes = optionalBytes(fields, number);
  if (!bytes || bytes.length !== 4) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true);
}

function decodeText(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

function parseRegion(value: string): RegionParts {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  return {
    continent: parts[0] ?? null,
    countryCode: parts[1]?.toUpperCase() ?? null,
    locality: parts.slice(2).join(", ") || parts[1] || parts[0] || null,
  };
}

function validLatitude(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= -90 && value <= 90;
}

function validLongitude(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= -180 && value <= 180;
}

function unresolvedNode(nodeId: string, error: string): SubnetNode {
  return {
    nodeId,
    operatorId: null,
    providerId: null,
    dataCenterId: null,
    region: null,
    continent: null,
    countryCode: null,
    locality: null,
    owner: null,
    latitude: null,
    longitude: null,
    error,
  };
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "The node's Registry location could not be resolved.";
}

function isLocalNetwork(): boolean {
  const hostname = window.location.hostname.toLowerCase();
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "127.0.0.1"
    || hostname === "0.0.0.0"
    || hostname === "::1"
    || hostname === "[::1]";
}
