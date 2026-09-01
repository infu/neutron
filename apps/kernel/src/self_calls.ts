import type {
  AppRegistryEntry,
  AppRegistryFunction,
} from "neutron-compiler/src/install.js";
import { IDL, idlLabelToId } from "@dfinity/candid";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import { KernelPolicyError, type JsonValue } from "neutron-tools/protocol";
import { declaredCapability } from "./capabilities/plan.ts";

export type PreapprovedSelfCallType = "query" | "update";

export const SELF_CALL_BINARY_MAX_BYTES = 1_900_000;
export const SELF_CALL_BINARY_MAX_COUNT = 512;
export const SELF_CALL_METADATA_MAX_BYTES = 64 * 1024;
export const SELF_CALL_NON_BINARY_CANDID_MAX_BYTES = 128 * 1024;
export const SELF_CALL_CANDID_DECODER_ALLOCATION_MAX_BYTES = 512 * 1024;
export const SELF_CALL_CANDID_TYPE_MAX_ENTRIES = 256;
export const SELF_CALL_CANDID_MAX_DEPTH = 32;
export const SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS = 4_096;

/**
 * icblast unwraps a successful `Result<opt T, E>` before returning it. An
 * absent option at that top-level boundary is therefore JavaScript
 * `undefined`, even though Neutron's message bus permits only JSON values.
 * Canonicalize that one valid Candid result to JSON null; all other values
 * remain available for the normal bounded-JSON validation.
 */
export function normalizeCanisterCallResult(value: unknown): unknown {
  return value === undefined ? null : value;
}

export const CANISTER_RESULT_ERROR_NAME = "CanisterResultError";

export type CanisterResultError = Error & { readonly code: string };

/**
 * icblast rejects a Candid `Result` Err payload. A nullary variant would
 * otherwise become an unclassified `Request failed` after crossing the JSON
 * message bus. Give only that exact shape a stable code while preserving the
 * established rejected-Promise contract and every structured record error.
 */
export function classifyNullaryCanisterResultError(
  error: unknown,
): CanisterResultError | null {
  if (
    typeof error !== "object" ||
    error === null ||
    Array.isArray(error) ||
    error instanceof Error
  ) {
    return null;
  }
  const prototype = Object.getPrototypeOf(error);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(error);
  if (keys.length !== 1 || typeof keys[0] !== "string") return null;
  const code = keys[0];
  const descriptor = Object.getOwnPropertyDescriptor(error, code);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.value !== null ||
    descriptor.enumerable !== true
  ) {
    return null;
  }
  if (!/^[a-z][a-z0-9_]{0,127}$/u.test(code)) return null;
  const classified = new Error(
    "Canister call returned a domain error",
  ) as CanisterResultError;
  classified.name = CANISTER_RESULT_ERROR_NAME;
  Object.defineProperty(classified, "code", {
    configurable: true,
    enumerable: true,
    value: code,
  });
  return classified;
}

export function isCanisterResultError(
  error: unknown,
): error is CanisterResultError {
  if (!(error instanceof Error) || error.name !== CANISTER_RESULT_ERROR_NAME) {
    return false;
  }
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(code);
}

export function assertExternalCanisterCallTarget(
  target: string,
  neutronCanister: string,
): void {
  if (target === "aaaaa-aa" || target === neutronCanister) {
    throw new KernelPolicyError(
      "OWNER_REQUIRED",
      "Management and Neutron administration require a dedicated source-bound kernel service",
    );
  }
}

export function requireConsentedSelfCall(
  app: AppRegistryEntry,
  method: string,
): AppRegistryFunction {
  const entry = app.functions?.find((candidate) => candidate.name === method);
  if (!entry || entry.type === "internal" || entry.access === "internal") {
    throw new KernelPolicyError(
      "OWNER_REQUIRED",
      "The method does not belong to the requesting app",
    );
  }
  return entry;
}

export function requirePreapprovedSelfCall(
  app: AppRegistryEntry,
  method: string,
  expectedType: PreapprovedSelfCallType,
): AppRegistryFunction {
  const entry = app.functions?.find((candidate) => candidate.name === method);
  if (!entry || entry.type === "internal") {
    throw new Error("Method does not belong to the requesting app");
  }
  if (entry.type !== expectedType) {
    throw new Error(`Method is not an app ${expectedType}`);
  }
  if (entry.access !== "authorized") {
    throw new Error("Preapproved self calls must remain owner-authorized");
  }
  const declared = findDeclaredSelfCall(app, method, expectedType);
  if (!declared) {
    throw new Error("Method is not preapproved for this app");
  }
  return entry;
}

type ParsedDeclaredSelfCall = {
  method: string;
  mode: PreapprovedSelfCallType;
};

function findDeclaredSelfCall(
  app: AppRegistryEntry,
  method: string,
  expectedType: PreapprovedSelfCallType,
): ParsedDeclaredSelfCall | null {
  const capability = declaredCapability(
    app,
    "preapproved_self_calls",
  ) as unknown;
  if (
    !isPlainRecord(capability) ||
    capability.api !== 1 ||
    !Array.isArray(capability.methods)
  ) {
    return null;
  }
  for (const candidate of capability.methods) {
    if (
      isPlainRecord(candidate) &&
      Object.keys(candidate).every(
        (key) => key === "method" || key === "mode",
      ) &&
      candidate.method === method &&
      candidate.mode === expectedType
    ) {
      return { method, mode: expectedType };
    }
  }
  return null;
}

type RawCandidType =
  | { kind: "opt" | "vec"; child: number }
  | {
      kind: "record" | "variant";
      fields: Array<{ id: number; type: number }>;
    }
  | { kind: "func"; children: number[] }
  | { kind: "service"; children: number[] };

type CandidReplyBudget = {
  elements: number;
  allocationBytes: number;
  blobCount: number;
  blobBytes: number;
};

export type SelfCallCandidPreflight = {
  blobCount: number;
  blobBytes: number;
  elements: number;
  allocationBytes: number;
};

class CandidReplyCursor {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  readByte(label: string): number {
    if (this.remaining < 1) {
      throw new Error(`Truncated Candid ${label}`);
    }
    return this.bytes[this.offset++]!;
  }

  skipBytes(byteLength: number, label: string): void {
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      byteLength > this.remaining
    ) {
      throw new Error(`Invalid Candid ${label} length`);
    }
    this.offset += byteLength;
  }

  readUnsigned(maximum: number, label: string): number {
    let value = 0n;
    let shift = 0n;
    for (let index = 0; index < 10; index += 1) {
      const byte = this.readByte(label);
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        if (value > BigInt(maximum)) {
          throw new Error(`Candid ${label} exceeds its limit`);
        }
        return Number(value);
      }
      shift += 7n;
    }
    throw new Error(`Invalid Candid ${label}`);
  }

  readSigned(minimum: number, maximum: number, label: string): number {
    let value = 0n;
    let shift = 0n;
    let byte = 0;
    for (let index = 0; index < 10; index += 1) {
      byte = this.readByte(label);
      value |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if ((byte & 0x80) === 0) {
        if ((byte & 0x40) !== 0) value -= 1n << shift;
        if (value < BigInt(minimum) || value > BigInt(maximum)) {
          throw new Error(`Candid ${label} is out of range`);
        }
        return Number(value);
      }
    }
    throw new Error(`Invalid Candid ${label}`);
  }

  skipLeb(label: string): number {
    for (let index = 1; index <= this.bytes.byteLength; index += 1) {
      if ((this.readByte(label) & 0x80) === 0) return index;
    }
    throw new Error(`Invalid Candid ${label}`);
  }
}

function parseRawCandidValues(
  bytes: Uint8Array,
  maximumValues: number,
  valueLabel: string,
): {
  cursor: CandidReplyCursor;
  table: RawCandidType[];
  budget: CandidReplyBudget;
  rootReferences: number[];
} {
  const cursor = new CandidReplyCursor(bytes);
  for (const expected of [0x44, 0x49, 0x44, 0x4c]) {
    if (cursor.readByte("magic") !== expected) {
      throw new Error(`Invalid Candid ${valueLabel} magic`);
    }
  }

  const tableLength = cursor.readUnsigned(
    SELF_CALL_CANDID_TYPE_MAX_ENTRIES,
    "type-table entry count",
  );
  const table: RawCandidType[] = [];
  const budget: CandidReplyBudget = {
    elements: 0,
    allocationBytes: tableLength * 32,
    blobCount: 0,
    blobBytes: 0,
  };
  for (let index = 0; index < tableLength; index += 1) {
    const opcode = cursor.readSigned(-24, -18, "type-table opcode");
    if (opcode === -18 || opcode === -19) {
      table.push({
        kind: opcode === -18 ? "opt" : "vec",
        child: cursor.readSigned(-24, tableLength - 1, "type reference"),
      });
      addReplyAllocation(budget, 16);
      continue;
    }
    if (opcode === -20 || opcode === -21) {
      const fieldCount = cursor.readUnsigned(
        SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS,
        "type field count",
      );
      addReplyAllocation(budget, fieldCount * 24);
      const fields: Array<{ id: number; type: number }> = [];
      let priorId = -1;
      for (let field = 0; field < fieldCount; field += 1) {
        const id = cursor.readUnsigned(0xffff_ffff, "field id");
        if (id <= priorId) throw new Error("Candid field ids are not sorted");
        priorId = id;
        fields.push({
          id,
          type: cursor.readSigned(-24, tableLength - 1, "field type"),
        });
      }
      table.push({ kind: opcode === -20 ? "record" : "variant", fields });
      continue;
    }
    if (opcode === -22) {
      const children: number[] = [];
      const argumentCount = cursor.readUnsigned(
        SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS,
        "function argument count",
      );
      for (let argument = 0; argument < argumentCount; argument += 1) {
        children.push(
          cursor.readSigned(-24, tableLength - 1, "function argument type"),
        );
      }
      const resultCount = cursor.readUnsigned(
        SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS,
        "function result count",
      );
      for (let result = 0; result < resultCount; result += 1) {
        children.push(
          cursor.readSigned(-24, tableLength - 1, "function result type"),
        );
      }
      const annotationCount = cursor.readUnsigned(
        3,
        "function annotation count",
      );
      for (let annotation = 0; annotation < annotationCount; annotation += 1) {
        const value = cursor.readByte("function annotation");
        if (value < 1 || value > 3) {
          throw new Error("Invalid Candid function annotation");
        }
      }
      addReplyAllocation(budget, children.length * 8 + 32);
      table.push({ kind: "func", children });
      continue;
    }
    if (opcode === -23) {
      const methodCount = cursor.readUnsigned(
        SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS,
        "service method count",
      );
      const children: number[] = [];
      for (let method = 0; method < methodCount; method += 1) {
        const nameLength = cursor.readUnsigned(
          cursor.remaining,
          "service method name",
        );
        cursor.skipBytes(nameLength, "service method name");
        addReplyAllocation(budget, nameLength * 2 + 24);
        children.push(
          cursor.readSigned(-24, tableLength - 1, "service method type"),
        );
      }
      table.push({ kind: "service", children });
      continue;
    }
    throw new Error("Unsupported Candid type-table opcode");
  }

  const valueCount = cursor.readUnsigned(maximumValues, `${valueLabel} count`);
  if (valueCount > maximumValues) {
    throw new Error(`Self-call ${valueLabel} contains too many Candid values`);
  }
  const rootReferences = Array.from({ length: valueCount }, () =>
    cursor.readSigned(-24, tableLength - 1, `${valueLabel} type`),
  );
  for (const rootReference of rootReferences) {
    assertRawCandidTypeGraph(rootReference, table);
  }
  return { cursor, table, budget, rootReferences };
}

/**
 * Validate and meter one ordinary self-call reply before IDL.decode allocates
 * any nested containers or binary buffers. Every active `vec nat8` leaf is
 * counted, irrespective of its record/option/variant/vector position.
 */
export function preflightSelfCallReply(
  bytes: Uint8Array,
  expectedOutputType: IDL.Type,
): SelfCallCandidPreflight {
  if (
    !Number.isSafeInteger(bytes.byteLength) ||
    bytes.byteLength >
      SELF_CALL_BINARY_MAX_BYTES + SELF_CALL_NON_BINARY_CANDID_MAX_BYTES
  ) {
    throw new Error("Self-call Candid reply exceeds the raw byte limit");
  }
  const { cursor, table, budget, rootReferences } = parseRawCandidValues(
    bytes,
    1,
    "reply",
  );
  if (rootReferences.length !== 1) {
    throw new Error("Self-call reply must contain one Candid value");
  }
  scanRawCandidValueAgainstExpected(
    cursor,
    rootReferences[0]!,
    expectedOutputType,
    table,
    budget,
    0,
  );
  if (cursor.remaining !== 0) {
    throw new Error("Invalid trailing data in self-call reply");
  }
  if (
    bytes.byteLength - budget.blobBytes >
    SELF_CALL_NON_BINARY_CANDID_MAX_BYTES
  ) {
    throw new Error("Self-call Candid reply exceeds the raw metadata limit");
  }
  return {
    blobCount: budget.blobCount,
    blobBytes: budget.blobBytes,
    elements: budget.elements,
    allocationBytes: budget.allocationBytes,
  };
}

/**
 * Validate the complete encoded request before dispatch and meter every live
 * `vec nat8` independently of the private transferable-sidecar envelope.
 */
export function preflightSelfCallRequest(
  bytes: Uint8Array,
  expectedInputTypes: readonly IDL.Type[],
): SelfCallCandidPreflight {
  if (
    expectedInputTypes.length > SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS ||
    !Number.isSafeInteger(bytes.byteLength) ||
    bytes.byteLength >
      SELF_CALL_BINARY_MAX_BYTES + SELF_CALL_NON_BINARY_CANDID_MAX_BYTES
  ) {
    throw new Error("Self-call Candid request exceeds the raw byte limit");
  }
  const { cursor, table, budget, rootReferences } = parseRawCandidValues(
    bytes,
    expectedInputTypes.length,
    "argument",
  );
  if (rootReferences.length !== expectedInputTypes.length) {
    throw new Error(
      "Self-call request argument count does not match live Candid",
    );
  }
  for (let index = 0; index < expectedInputTypes.length; index += 1) {
    scanRawCandidValueAgainstExpected(
      cursor,
      rootReferences[index]!,
      expectedInputTypes[index]!,
      table,
      budget,
      0,
    );
  }
  if (cursor.remaining !== 0) {
    throw new Error("Invalid trailing data in self-call request");
  }
  if (
    bytes.byteLength - budget.blobBytes >
    SELF_CALL_NON_BINARY_CANDID_MAX_BYTES
  ) {
    throw new Error("Self-call Candid request exceeds the raw metadata limit");
  }
  return {
    blobCount: budget.blobCount,
    blobBytes: budget.blobBytes,
    elements: budget.elements,
    allocationBytes: budget.allocationBytes,
  };
}

function addReplyElements(budget: CandidReplyBudget, count: number): void {
  budget.elements += count;
  if (budget.elements > SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS) {
    throw new Error("Candid reply exceeds the container element limit");
  }
}

function addReplyAllocation(
  budget: CandidReplyBudget,
  byteLength: number,
): void {
  budget.allocationBytes += byteLength;
  if (budget.allocationBytes > SELF_CALL_CANDID_DECODER_ALLOCATION_MAX_BYTES) {
    throw new Error("Candid reply exceeds the decoder allocation limit");
  }
}

function addReplyBlob(budget: CandidReplyBudget, byteLength: number): void {
  budget.blobCount += 1;
  budget.blobBytes += byteLength;
  if (budget.blobCount > SELF_CALL_BINARY_MAX_COUNT) {
    throw new Error("Candid reply exceeds the binary field count limit");
  }
  if (budget.blobBytes > SELF_CALL_BINARY_MAX_BYTES) {
    throw new Error("Candid reply exceeds the aggregate binary byte limit");
  }
}

function rawConstructedType(
  reference: number,
  table: readonly RawCandidType[],
): RawCandidType {
  if (reference < 0 || reference >= table.length) {
    throw new Error("Expected a constructed Candid type");
  }
  return table[reference]!;
}

function isRawCandidBlob(
  reference: number,
  table: readonly RawCandidType[],
): boolean {
  if (reference < 0 || reference >= table.length) return false;
  const type = table[reference]!;
  return type.kind === "vec" && type.child === -5;
}

function unwrapExpectedCandidType(type: IDL.Type): IDL.Type {
  const active = new Set<IDL.Type>();
  let current = type;
  while (current instanceof IDL.RecClass) {
    if (active.has(current)) {
      throw new Error("Cyclic Candid type alias cannot be unfolded directly");
    }
    active.add(current);
    const child = (current as unknown as { _type?: IDL.Type })._type;
    if (!child) throw new Error("Unbound recursive Candid type");
    current = child;
  }
  return current;
}

function expectedPrimitiveReference(type: IDL.Type): number | null {
  if (type instanceof IDL.NullClass) return -1;
  if (type instanceof IDL.BoolClass) return -2;
  if (type instanceof IDL.NatClass) return -3;
  if (type instanceof IDL.IntClass) return -4;
  if (type instanceof IDL.FixedNatClass) {
    if (type._bits === 8) return -5;
    if (type._bits === 16) return -6;
    if (type._bits === 32) return -7;
    if (type._bits === 64) return -8;
    return null;
  }
  if (type instanceof IDL.FixedIntClass) {
    if (type._bits === 8) return -9;
    if (type._bits === 16) return -10;
    if (type._bits === 32) return -11;
    if (type._bits === 64) return -12;
    return null;
  }
  if (type instanceof IDL.FloatClass) {
    if (type._bits === 32) return -13;
    if (type._bits === 64) return -14;
    return null;
  }
  if (type instanceof IDL.TextClass) return -15;
  if (type instanceof IDL.ReservedClass) return -16;
  if (type instanceof IDL.EmptyClass) return -17;
  if (type instanceof IDL.PrincipalClass) return -24;
  return null;
}

function assertRawCandidTypeGraph(
  root: number,
  table: readonly RawCandidType[],
): void {
  const deepestVisit = new Map<number, number>();
  const active = new Set<number>();
  const visit = (reference: number, depth: number): void => {
    if (depth > SELF_CALL_CANDID_MAX_DEPTH) {
      throw new Error("Candid reply exceeds the type depth limit");
    }
    if (reference < 0) {
      if (!isRawCandidPrimitive(reference)) {
        throw new Error("Invalid primitive Candid type");
      }
      return;
    }
    if (reference >= table.length) {
      throw new Error("Candid type reference is out of range");
    }
    if (active.has(reference)) return;
    if ((deepestVisit.get(reference) ?? -1) >= depth) return;
    deepestVisit.set(reference, depth);
    active.add(reference);
    const type = table[reference]!;
    let children: number[];
    switch (type.kind) {
      case "opt":
      case "vec":
        children = [type.child];
        break;
      case "record":
      case "variant":
        children = type.fields.map((field) => field.type);
        break;
      case "func":
      case "service":
        children = type.children;
        break;
    }
    for (const child of children) visit(child, depth + 1);
    active.delete(reference);
  };
  visit(root, 0);
}

function isRawCandidPrimitive(reference: number): boolean {
  return (reference >= -17 && reference <= -1) || reference === -24;
}

/**
 * Meter the allocations performed by @dfinity/candid against the live
 * expected type while still permitting its safe record-evolution behavior.
 * In particular, missing expected optional fields synthesize one empty array
 * per decoded record occurrence, so charging only the compact wire schema
 * would let a small reply expand after this preflight.
 *
 * The boolean result is false only for an unknown variant arm caught by an
 * enclosing expected option. That is the Candid evolution pattern where an
 * old optional variant becomes null instead of failing the whole response.
 */
function scanRawCandidValueAgainstExpected(
  cursor: CandidReplyCursor,
  reference: number,
  expectedType: IDL.Type,
  table: readonly RawCandidType[],
  budget: CandidReplyBudget,
  depth: number,
  allowUnknownVariant = false,
): boolean {
  if (depth > SELF_CALL_CANDID_MAX_DEPTH) {
    throw new Error("Candid reply exceeds the value depth limit");
  }
  const expected = unwrapExpectedCandidType(expectedType);

  if (expected instanceof IDL.ReservedClass) {
    scanRawCandidValue(cursor, reference, table, budget, depth);
    return true;
  }

  if (expected instanceof IDL.OptClass) {
    addReplyAllocation(budget, 16);
    const wire =
      reference >= 0 ? rawConstructedType(reference, table) : undefined;
    if (wire?.kind === "opt") {
      const tag = cursor.readByte("option tag");
      if (tag > 1) throw new Error("Invalid Candid option tag");
      if (tag === 0) return true;
      const present = scanRawCandidValueAgainstExpected(
        cursor,
        wire.child,
        expected._type,
        table,
        budget,
        depth + 1,
        true,
      );
      if (present) addReplyElements(budget, 1);
      return true;
    }
    const present = scanRawCandidValueAgainstExpected(
      cursor,
      reference,
      expected._type,
      table,
      budget,
      depth + 1,
      true,
    );
    if (present) addReplyElements(budget, 1);
    return true;
  }

  if (expected instanceof IDL.TupleClass) {
    const wire = rawConstructedType(reference, table);
    if (
      wire.kind !== "record" ||
      wire.fields.length < expected._fields.length ||
      wire.fields.some((field, index) => field.id !== index)
    ) {
      throw new Error("Candid reply tuple type is incompatible");
    }
    addReplyElements(budget, expected._fields.length);
    addReplyAllocation(budget, expected._fields.length * 8 + 24);
    for (let index = 0; index < wire.fields.length; index += 1) {
      const wireField = wire.fields[index]!;
      const expectedField = expected._fields[index];
      if (expectedField) {
        scanRawCandidValueAgainstExpected(
          cursor,
          wireField.type,
          expectedField[1],
          table,
          budget,
          depth + 1,
        );
      } else {
        scanRawCandidValue(cursor, wireField.type, table, budget, depth + 1);
      }
    }
    return true;
  }

  if (expected instanceof IDL.RecordClass) {
    const wire = rawConstructedType(reference, table);
    if (wire.kind !== "record") {
      throw new Error("Candid reply record type is incompatible");
    }
    addReplyElements(budget, expected._fields.length);
    addReplyAllocation(budget, expected._fields.length * 24 + 32);
    let wireIndex = 0;
    let expectedIndex = 0;
    while (
      wireIndex < wire.fields.length ||
      expectedIndex < expected._fields.length
    ) {
      const wireField = wire.fields[wireIndex];
      const expectedField = expected._fields[expectedIndex];
      const expectedId =
        expectedField === undefined
          ? undefined
          : idlLabelToId(expectedField[0]);
      if (
        wireField !== undefined &&
        expectedField !== undefined &&
        wireField.id === expectedId
      ) {
        scanRawCandidValueAgainstExpected(
          cursor,
          wireField.type,
          expectedField[1],
          table,
          budget,
          depth + 1,
        );
        wireIndex += 1;
        expectedIndex += 1;
        continue;
      }
      if (
        expectedField !== undefined &&
        (wireField === undefined || expectedId! < wireField.id)
      ) {
        if (!isSynthesizedCandidField(expectedField[1])) {
          throw new Error("Candid reply is missing a required record field");
        }
        // @dfinity/candid represents both a missing opt and a missing
        // reserved field as one newly allocated empty array.
        addReplyAllocation(budget, 16);
        expectedIndex += 1;
        continue;
      }
      if (wireField === undefined) {
        throw new Error("Candid reply record type is incompatible");
      }
      // The live expected type ignores this additive wire field, but the
      // decoder still walks and allocates its value before discarding it.
      scanRawCandidValue(cursor, wireField.type, table, budget, depth + 1);
      wireIndex += 1;
    }
    return true;
  }

  if (expected instanceof IDL.VecClass) {
    const wire = rawConstructedType(reference, table);
    if (wire.kind !== "vec") {
      throw new Error("Candid reply vector type is incompatible");
    }
    if (isBlobType(expected)) {
      if (!isRawCandidBlob(reference, table)) {
        throw new Error("Candid reply blob type is incompatible");
      }
      const byteLength = cursor.readUnsigned(
        Math.min(cursor.remaining, SELF_CALL_BINARY_MAX_BYTES),
        "binary field length",
      );
      cursor.skipBytes(byteLength, "binary field");
      addReplyBlob(budget, byteLength);
      return true;
    }
    if (isRawCandidBlob(reference, table)) {
      throw new Error("Candid reply vector type is incompatible");
    }
    const length = cursor.readUnsigned(
      SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS,
      "container element count",
    );
    addReplyElements(budget, length);
    addReplyAllocation(budget, length * 8 + 24);
    for (let index = 0; index < length; index += 1) {
      scanRawCandidValueAgainstExpected(
        cursor,
        wire.child,
        expected._type,
        table,
        budget,
        depth + 1,
      );
    }
    return true;
  }

  if (expected instanceof IDL.VariantClass) {
    const wire = rawConstructedType(reference, table);
    if (wire.kind !== "variant") {
      throw new Error("Candid reply variant type is incompatible");
    }
    const index = cursor.readUnsigned(wire.fields.length - 1, "variant index");
    const selected = wire.fields[index];
    if (!selected) throw new Error("Invalid Candid variant index");
    const expectedField = expected._fields.find(
      ([name]) => idlLabelToId(name) === selected.id,
    );
    addReplyElements(budget, 1);
    addReplyAllocation(budget, 32);
    if (!expectedField) {
      if (!allowUnknownVariant) {
        throw new Error("Decoded an unknown Candid variant option");
      }
      scanRawCandidValue(cursor, selected.type, table, budget, depth + 1);
      return false;
    }
    scanRawCandidValueAgainstExpected(
      cursor,
      selected.type,
      expectedField[1],
      table,
      budget,
      depth + 1,
    );
    return true;
  }

  const expectedReference = expectedPrimitiveReference(expected);
  if (expectedReference === null || expectedReference !== reference) {
    throw new Error("Candid reply primitive type is incompatible");
  }
  scanRawCandidValue(cursor, reference, table, budget, depth);
  return true;
}

function isSynthesizedCandidField(type: IDL.Type): boolean {
  const expected = unwrapExpectedCandidType(type);
  return (
    expected instanceof IDL.OptClass || expected instanceof IDL.ReservedClass
  );
}

function scanRawCandidValue(
  cursor: CandidReplyCursor,
  reference: number,
  table: readonly RawCandidType[],
  budget: CandidReplyBudget,
  depth: number,
): void {
  if (depth > SELF_CALL_CANDID_MAX_DEPTH) {
    throw new Error("Candid reply exceeds the value depth limit");
  }
  if (reference < 0) {
    switch (reference) {
      case -1:
      case -16:
        return;
      case -2: {
        const value = cursor.readByte("boolean");
        if (value > 1) throw new Error("Invalid Candid boolean");
        return;
      }
      case -3:
      case -4:
        addReplyAllocation(budget, cursor.skipLeb("integer") + 16);
        return;
      case -5:
      case -9:
        cursor.skipBytes(1, "fixed integer");
        return;
      case -6:
      case -10:
        cursor.skipBytes(2, "fixed integer");
        return;
      case -7:
      case -11:
      case -13:
        cursor.skipBytes(4, "fixed number");
        return;
      case -8:
      case -12:
      case -14:
        cursor.skipBytes(8, "fixed number");
        return;
      case -15: {
        const byteLength = cursor.readUnsigned(cursor.remaining, "text");
        cursor.skipBytes(byteLength, "text");
        addReplyAllocation(budget, byteLength * 2 + 24);
        return;
      }
      case -17:
        throw new Error("Candid empty type has no value");
      case -24:
        scanRawPrincipal(cursor);
        addReplyAllocation(budget, 48);
        return;
      default:
        throw new Error("Invalid primitive Candid value type");
    }
  }
  const type = rawConstructedType(reference, table);
  if (type.kind === "opt") {
    const tag = cursor.readByte("option tag");
    if (tag > 1) throw new Error("Invalid Candid option tag");
    addReplyAllocation(budget, 16);
    if (tag === 1) {
      addReplyElements(budget, 1);
      scanRawCandidValue(cursor, type.child, table, budget, depth + 1);
    }
    return;
  }
  if (type.kind === "vec") {
    const binary = type.child === -5;
    const maximum = binary
      ? SELF_CALL_BINARY_MAX_BYTES
      : SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS;
    const length = cursor.readUnsigned(
      maximum,
      binary ? "binary field length" : "container element count",
    );
    if (binary) {
      cursor.skipBytes(length, "binary field");
      addReplyBlob(budget, length);
      return;
    }
    addReplyElements(budget, length);
    addReplyAllocation(budget, length * 8 + 24);
    for (let index = 0; index < length; index += 1) {
      scanRawCandidValue(cursor, type.child, table, budget, depth + 1);
    }
    return;
  }
  if (type.kind === "record") {
    addReplyElements(budget, type.fields.length);
    addReplyAllocation(budget, type.fields.length * 24 + 32);
    for (const field of type.fields) {
      scanRawCandidValue(cursor, field.type, table, budget, depth + 1);
    }
    return;
  }
  if (type.kind === "variant") {
    const index = cursor.readUnsigned(type.fields.length - 1, "variant index");
    const field = type.fields[index];
    if (!field) throw new Error("Invalid Candid variant index");
    addReplyElements(budget, 1);
    addReplyAllocation(budget, 32);
    scanRawCandidValue(cursor, field.type, table, budget, depth + 1);
    return;
  }
  if (type.kind === "func") {
    if (cursor.readByte("function reference tag") !== 1) {
      throw new Error("Invalid Candid function reference");
    }
    scanRawPrincipal(cursor);
    const methodLength = cursor.readUnsigned(
      cursor.remaining,
      "function method name",
    );
    cursor.skipBytes(methodLength, "function method name");
    addReplyAllocation(budget, methodLength * 2 + 64);
    return;
  }
  scanRawPrincipal(cursor);
  addReplyAllocation(budget, 48);
}

function scanRawPrincipal(cursor: CandidReplyCursor): void {
  if (cursor.readByte("principal tag") !== 1) {
    throw new Error("Invalid Candid principal");
  }
  const length = cursor.readUnsigned(29, "principal");
  cursor.skipBytes(length, "principal");
}

export type SelfCallBlobPathSegment = string | number;

export type SelfCallWireBlob = {
  path: SelfCallBlobPathSegment[];
  byteLength: number;
  data: ArrayBuffer;
};

export type SelfCallBinaryStats = {
  count: number;
  bytes: number;
};

export type SelfCallBinaryInspection = {
  path: string;
  pathSegments: SelfCallBlobPathSegment[];
  byteLength: number;
  sha256: string;
};

export function requireSelfCallCandidMethod(
  service: IDL.ServiceClass,
  method: string,
  mode: PreapprovedSelfCallType,
): IDL.FuncClass {
  const candidate = service._fields.find(([name]) => name === method)?.[1];
  if (candidate === undefined || !(candidate instanceof IDL.FuncClass)) {
    throw new Error("Installed self-call method is absent from live Candid");
  }
  const isQuery =
    candidate.annotations.includes("query") ||
    candidate.annotations.includes("composite_query");
  if ((mode === "query") !== isQuery) {
    throw new Error(
      "Installed self-call method mode does not match live Candid",
    );
  }
  if (candidate.retTypes.length !== 1) {
    throw new Error("Self-call methods must return exactly one Candid value");
  }
  candidate.argTypes.forEach((type, index) =>
    assertTypeGraphLimits(type, `self-call argument ${index}`),
  );
  assertTypeGraphLimits(candidate.retTypes[0]!, "self-call result");
  assertSelfCallJavaScriptTypeSafety([
    ...candidate.argTypes,
    ...candidate.retTypes,
  ]);
  return candidate;
}

export function assertSelfCallJavaScriptTypeSafety(
  types: readonly IDL.Type[],
): void {
  const seen = new Set<IDL.Type>();
  const visit = (typeValue: IDL.Type): void => {
    const type = unwrapExpectedCandidType(typeValue);
    if (seen.has(type)) return;
    seen.add(type);
    if (
      type instanceof IDL.RecordClass &&
      type._fields.some(
        ([name]) =>
          name === "__proto__" ||
          name === "constructor" ||
          name === "prototype",
      )
    ) {
      throw new Error(
        "Self-call JavaScript conversion does not support metaproperty record labels",
      );
    }
    if (
      (type instanceof IDL.RecordClass || type instanceof IDL.VariantClass) &&
      type._fields.some(([name]) => name.length === 0 || name.length > 256)
    ) {
      throw new Error("Self-call Candid labels exceed the binary path limit");
    }
    for (const child of candidTypeChildren(type)) visit(child);
  };
  types.forEach(visit);
}

export function parseSelfCallWireBlobs(value: unknown): SelfCallWireBlob[] {
  if (!isDensePlainArray(value) || value.length > SELF_CALL_BINARY_MAX_COUNT) {
    throw new Error("Invalid self-call binary field list");
  }
  let aggregateBytes = 0;
  const paths = new Set<string>();
  return value.map((candidate) => {
    if (
      !isPlainRecord(candidate) ||
      !hasExactOwnDataKeys(candidate, ["path", "byteLength", "data"]) ||
      !isDensePlainArray(candidate.path) ||
      candidate.path.length > SELF_CALL_CANDID_MAX_DEPTH ||
      !candidate.path.every(
        (part) =>
          (typeof part === "string" && part.length > 0 && part.length <= 256) ||
          (typeof part === "number" &&
            Number.isSafeInteger(part) &&
            part >= 0 &&
            part < SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS),
      ) ||
      !Number.isSafeInteger(candidate.byteLength) ||
      Number(candidate.byteLength) < 0 ||
      !(candidate.data instanceof ArrayBuffer) ||
      candidate.data.byteLength !== candidate.byteLength
    ) {
      throw new Error("Invalid self-call binary field");
    }
    aggregateBytes += Number(candidate.byteLength);
    if (aggregateBytes > SELF_CALL_BINARY_MAX_BYTES) {
      throw new Error(
        "Self-call value exceeds the aggregate binary byte limit",
      );
    }
    const key = JSON.stringify(candidate.path);
    if (paths.has(key)) {
      throw new Error("Self-call binary field paths must be unique");
    }
    paths.add(key);
    return candidate as SelfCallWireBlob;
  });
}

export function selfCallBlobStats(
  blobs: readonly SelfCallWireBlob[],
): SelfCallBinaryStats {
  return {
    count: blobs.length,
    bytes: blobs.reduce((total, blob) => total + blob.byteLength, 0),
  };
}

/**
 * Reconstruct the private structured-clone envelope only at positions proved
 * by the live Candid method to be `vec nat8`. Sidecar paths are routing hints,
 * never type or authorization input: every sidecar must bind exactly once to a
 * live binary leaf, and every present binary leaf must have one sidecar.
 *
 * The JSON shadow has exactly one binary convention: `null` at a sidecar
 * position. Strings and number arrays are ordinary Candid values and are never
 * reinterpreted as bytes.
 */
export function materializeSelfCallArguments(
  encodedArgs: unknown,
  blobsValue: unknown,
  argumentTypes: readonly IDL.Type[],
): {
  args: unknown[];
  validationArgs: JsonValue[];
  metadata: JsonValue[];
  binary: SelfCallBinaryStats;
  boundBlobs: SelfCallWireBlob[];
} {
  if (
    !isDensePlainArray(encodedArgs) ||
    encodedArgs.length !== argumentTypes.length
  ) {
    throw new Error("Self-call argument count does not match live Candid");
  }
  const blobs = parseSelfCallWireBlobs(blobsValue);
  const byPath = new Map(
    blobs.map((blob) => [JSON.stringify(blob.path), blob] as const),
  );
  const used = new Set<string>();
  const boundBlobs: SelfCallWireBlob[] = [];
  const active = new Set<object>();
  let elements = 0;
  const hasSidecarAtOrBelow = (
    path: readonly SelfCallBlobPathSegment[],
  ): boolean =>
    blobs.some(
      (candidate) =>
        candidate.path.length >= path.length &&
        path.every((part, index) => candidate.path[index] === part),
    );

  type BoundValue = {
    call: unknown;
    /**
     * JSON-schema-safe shadow used only by icblast's generated method
     * validator. Binary leaves are represented by an empty byte array while
     * the exact bytes remain bound separately for live-Candid encoding.
     */
    validation: JsonValue;
    metadata: JsonValue;
  };

  const visit = (
    value: unknown,
    typeValue: IDL.Type,
    path: SelfCallBlobPathSegment[],
    depth: number,
  ): BoundValue => {
    if (depth > SELF_CALL_CANDID_MAX_DEPTH) {
      throw new Error("Self-call value exceeds the Candid value depth limit");
    }
    const type = unwrapExpectedCandidType(typeValue);
    const pathKey = JSON.stringify(path);
    const blob = byPath.get(pathKey);
    if (isBlobType(type)) {
      if (!blob) {
        if (hasSidecarAtOrBelow(path)) {
          throw new Error(
            "Self-call binary data descends from a Candid blob position",
          );
        }
        throw new Error("Self-call Candid blob is missing its binary sidecar");
      }
      if (value !== null) {
        throw new Error("Self-call Candid blob placeholder must be null");
      }
      used.add(pathKey);
      boundBlobs.push(blob);
      return {
        call: new Uint8Array(blob.data),
        validation: [],
        metadata: null,
      };
    }
    if (type instanceof IDL.OptClass) {
      if (value === null && !hasSidecarAtOrBelow(path)) {
        return { call: null, validation: null, metadata: null };
      }
      // API 1 represents an option as null or its direct child. A present
      // optional blob also has a null JSON placeholder, so the sidecar proves
      // that this particular null means present rather than absent.
      return visit(value, type._type, path, depth + 1);
    }
    if (blob) {
      throw new Error("Binary data is present at a non-blob Candid position");
    }
    if (type instanceof IDL.VecClass) {
      if (!isDensePlainArray(value)) {
        throw new Error("Self-call Candid vector must be an array");
      }
      elements += value.length;
      assertSelfCallElementBudget(elements);
      const children = value.map((entry, index) =>
        visit(entry, type._type, [...path, index], depth + 1),
      );
      return {
        call: children.map((child) => child.call),
        validation: children.map((child) => child.validation),
        metadata: children.map((child) => child.metadata),
      };
    }
    if (type instanceof IDL.TupleClass) {
      if (!isDensePlainArray(value) || value.length !== type._fields.length) {
        throw new Error("Self-call Candid tuple has an invalid shape");
      }
      elements += value.length;
      assertSelfCallElementBudget(elements);
      const children = type._fields.map(([, child], index) =>
        visit(value[index], child, [...path, index], depth + 1),
      );
      return {
        call: children.map((child) => child.call),
        validation: children.map((child) => child.validation),
        metadata: children.map((child) => child.metadata),
      };
    }
    if (type instanceof IDL.RecordClass) {
      if (!isPlainRecord(value)) {
        // Some generated JSON contracts expose a scalar shorthand for a
        // Candid record and expand it immediately before live encoding. Keep
        // that projection opaque here; the generated method schema must still
        // accept it, and the encoded request is still checked against live
        // Candid below. Binary sidecars can never hide inside a shorthand.
        if (
          (typeof value === "string" ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value))) &&
          !hasSidecarAtOrBelow(path)
        ) {
          return { call: value, validation: value, metadata: value };
        }
        throw new Error("Self-call Candid record has an invalid shape");
      }
      if (active.has(value))
        throw new Error("Self-call value contains a cycle");
      const suppliedKeys = Reflect.ownKeys(value);
      if (
        suppliedKeys.some((key) => typeof key !== "string") ||
        suppliedKeys.some((key) => {
          const descriptor =
            typeof key === "string"
              ? Object.getOwnPropertyDescriptor(value, key)
              : undefined;
          return (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          );
        })
      ) {
        throw new Error("Self-call Candid records require plain data fields");
      }
      const fields = new Map(type._fields);
      if (
        suppliedKeys.some((key) => typeof key !== "string" || !fields.has(key))
      ) {
        throw new Error("Self-call Candid record contains an unknown field");
      }
      active.add(value);
      try {
        elements += type._fields.length;
        assertSelfCallElementBudget(elements);
        const callEntries: Array<[string, unknown]> = [];
        const validationEntries: Array<[string, JsonValue]> = [];
        const metadataEntries: Array<[string, JsonValue]> = [];
        for (const [name, child] of type._fields) {
          if (!Object.hasOwn(value, name)) {
            if (unwrapExpectedCandidType(child) instanceof IDL.OptClass) {
              if (hasSidecarAtOrBelow([...path, name])) {
                throw new Error(
                  "Self-call binary data is outside the supplied Candid value",
                );
              }
              callEntries.push([name, null]);
              metadataEntries.push([name, null]);
              continue;
            }
            throw new Error(
              `Self-call Candid record is missing required field '${name}'`,
            );
          }
          const bound = visit(value[name], child, [...path, name], depth + 1);
          callEntries.push([name, bound.call]);
          // Generated method schemas project an absent Candid option in a
          // record by omitting the property. Keep the null needed by the live
          // Candid encoder, but do not synthesize a schema-invalid null in the
          // validation shadow.
          if (!(
            unwrapExpectedCandidType(child) instanceof IDL.OptClass &&
            bound.validation === null
          )) {
            validationEntries.push([name, bound.validation]);
          }
          metadataEntries.push([name, bound.metadata]);
        }
        return {
          call: Object.fromEntries(callEntries),
          validation: Object.fromEntries(validationEntries),
          metadata: Object.fromEntries(metadataEntries),
        };
      } finally {
        active.delete(value);
      }
    }
    if (type instanceof IDL.VariantClass) {
      if (!isPlainRecord(value) || !hasOneEnumerableDataField(value)) {
        throw new Error("Self-call Candid variant has an invalid shape");
      }
      if (active.has(value))
        throw new Error("Self-call value contains a cycle");
      const name = Object.keys(value)[0]!;
      const child = type._fields.find(([label]) => label === name)?.[1];
      if (!child)
        throw new Error("Self-call selected an unknown Candid variant");
      elements += 1;
      assertSelfCallElementBudget(elements);
      active.add(value);
      try {
        const bound = visit(value[name], child, [...path, name], depth + 1);
        return {
          call: Object.fromEntries([[name, bound.call]]),
          validation: Object.fromEntries([[name, bound.validation]]),
          metadata: Object.fromEntries([[name, bound.metadata]]),
        };
      } finally {
        active.delete(value);
      }
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      if (hasSidecarAtOrBelow(path)) {
        throw new Error("Binary data descends from a non-blob Candid position");
      }
      return { call: value, validation: value, metadata: value };
    }
    throw new Error("Self-call scalar does not match the live Candid type");
  };

  const boundArgs = argumentTypes.map((type, index) =>
    visit(encodedArgs[index], type, [index], 0),
  );
  if (used.size !== blobs.length) {
    throw new Error(
      "Self-call contains binary data outside the live Candid shape",
    );
  }
  return {
    args: boundArgs.map((bound) => bound.call),
    validationArgs: boundArgs.map((bound) => bound.validation),
    metadata: boundArgs.map((bound) => bound.metadata),
    binary: selfCallBlobStats(blobs),
    boundBlobs,
  };
}

/**
 * Build transient, trusted review data only after the caller has bound every
 * blob to live Candid. Callers must not persist this projection.
 */
export async function inspectBoundSelfCallBlobs(
  blobs: readonly SelfCallWireBlob[],
): Promise<SelfCallBinaryInspection[]> {
  const parsed = parseSelfCallWireBlobs(blobs);
  return Promise.all(
    parsed.map(async (blob) => {
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", blob.data),
      );
      return {
        path: formatSelfCallPath(blob.path),
        pathSegments: [...blob.path],
        byteLength: blob.byteLength,
        sha256: [...digest]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      };
    }),
  );
}

export function isSelfCallDomainErrorResult(
  value: unknown,
  outputType: IDL.Type,
): boolean {
  const type = unwrapExpectedCandidType(outputType);
  if (!(type instanceof IDL.VariantClass) || type._fields.length !== 2) {
    return false;
  }
  const ok = type._fields.find(([name]) => name === "ok" || name === "Ok");
  const err = type._fields.find(([name]) => name === "err" || name === "Err");
  return Boolean(ok && err && isRecord(value) && Object.hasOwn(value, err[0]));
}

const ABSENT_SELF_CALL_OPTION = Symbol("absent-self-call-option");

/**
 * Project one decoded live-Candid value to the API-1 JavaScript boundary.
 * Binary leaves have exactly one representation: an owned Uint8Array that the
 * caller subsequently moves into the private transferable sidecar.
 */
function createSelfCallResultProjector() {
  const visit = (
    candidate: unknown,
    typeValue: IDL.Type,
  ): unknown | typeof ABSENT_SELF_CALL_OPTION => {
    const type = unwrapExpectedCandidType(typeValue);
    if (type instanceof IDL.OptClass) {
      // icblast treats an explicit null as a present JSON null, while the
      // decoded empty option is omitted/filled according to its container.
      if (candidate === null) return null;
      if (candidate === undefined) return ABSENT_SELF_CALL_OPTION;
      if (!Array.isArray(candidate) || candidate.length > 1) {
        throw new Error("Invalid decoded Candid option");
      }
      if (candidate.length === 0) return ABSENT_SELF_CALL_OPTION;
      return visit(candidate[0], type._type);
    }
    if (isBlobType(type)) {
      const bytes = decodedBlobBytes(candidate);
      return Uint8Array.from(bytes);
    }
    if (type instanceof IDL.VecClass) {
      return decodedVectorValues(candidate).map((entry) => {
        const projected = visit(entry, type._type);
        return projected === ABSENT_SELF_CALL_OPTION ? null : projected;
      });
    }
    if (type instanceof IDL.TupleClass) {
      if (
        !Array.isArray(candidate) ||
        candidate.length !== type._fields.length
      ) {
        throw new Error("Invalid decoded Candid tuple");
      }
      return type._fields.map(([, child], index) => {
        const projected = visit(candidate[index], child);
        return projected === ABSENT_SELF_CALL_OPTION ? null : projected;
      });
    }
    if (type instanceof IDL.RecordClass) {
      if (!isRecord(candidate)) {
        throw new Error("Invalid decoded Candid record");
      }
      const entries: Array<[string, unknown]> = [];
      for (const [name, child] of type._fields) {
        const projected = visit(candidate[name], child);
        if (projected !== ABSENT_SELF_CALL_OPTION) {
          entries.push([name, projected]);
        }
      }
      return Object.fromEntries(entries);
    }
    if (type instanceof IDL.VariantClass) {
      if (!isRecord(candidate) || Object.keys(candidate).length !== 1) {
        throw new Error("Invalid decoded Candid variant");
      }
      const selected = type._fields.find(([name]) =>
        Object.hasOwn(candidate, name),
      );
      if (!selected)
        throw new Error("Decoded an unknown Candid variant option");
      const projected = visit(candidate[selected[0]], selected[1]);
      // convertBack first creates { arm: undefined }; toState then omits that
      // property. Preserve that long-standing (if unusual) representation.
      return projected === ABSENT_SELF_CALL_OPTION
        ? {}
        : Object.fromEntries([[selected[0], projected]]);
    }
    if (type instanceof IDL.PrincipalClass) {
      const toText = (candidate as { toText?: unknown } | null)?.toText;
      if (typeof toText !== "function") {
        throw new Error("Invalid decoded Candid principal");
      }
      return (toText as () => string).call(candidate);
    }
    if (typeof candidate === "bigint") return candidate.toString(10);
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      return candidate;
    }
    throw new Error("Invalid decoded Candid value");
  };

  return visit;
}

function projectSelfCallResult(value: unknown, outputType: IDL.Type): unknown {
  const visit = createSelfCallResultProjector();
  const type = unwrapExpectedCandidType(outputType);
  if (type instanceof IDL.VariantClass && type._fields.length === 2) {
    const ok = type._fields.find(([name]) => name === "ok" || name === "Ok");
    const err = type._fields.find(([name]) => name === "err" || name === "Err");
    if (ok && err && isRecord(value)) {
      if (Object.hasOwn(value, ok[0])) {
        const projected = visit(value[ok[0]], ok[1]);
        return projected === ABSENT_SELF_CALL_OPTION ? null : projected;
      }
      if (Object.hasOwn(value, err[0])) {
        const projected = visit(value[err[0]], err[1]);
        throw projected === ABSENT_SELF_CALL_OPTION ? null : projected;
      }
    }
  }
  const projected = visit(value, outputType);
  return projected === ABSENT_SELF_CALL_OPTION ? null : projected;
}

function decodedVectorValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView || value instanceof Uint8Array) {
      throw new Error("Invalid decoded Candid vector");
    }
    return Array.from(value as unknown as ArrayLike<unknown>);
  }
  throw new Error("Invalid decoded Candid vector");
}

function decodedBlobBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("Invalid decoded Candid blob");
}

function assertSelfCallElementBudget(elements: number): void {
  if (elements > SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS) {
    throw new Error(
      "Self-call value exceeds the Candid container element limit",
    );
  }
}

export function assertSelfCallRawRequestBytes(
  byteLength: number,
  binaryBytes: number,
): void {
  if (
    !Number.isSafeInteger(byteLength) ||
    !Number.isSafeInteger(binaryBytes) ||
    binaryBytes < 0 ||
    binaryBytes > SELF_CALL_BINARY_MAX_BYTES ||
    byteLength < binaryBytes ||
    byteLength - binaryBytes > SELF_CALL_NON_BINARY_CANDID_MAX_BYTES
  ) {
    throw new Error("Self-call Candid request exceeds the raw metadata limit");
  }
}

export function selfCallReservationBytes(inputBinaryBytes: number): number {
  if (
    !Number.isSafeInteger(inputBinaryBytes) ||
    inputBinaryBytes < 0 ||
    inputBinaryBytes > SELF_CALL_BINARY_MAX_BYTES
  ) {
    throw new Error("Invalid self-call binary reservation");
  }
  return (
    inputBinaryBytes +
    SELF_CALL_BINARY_MAX_BYTES +
    SELF_CALL_NON_BINARY_CANDID_MAX_BYTES +
    SELF_CALL_CANDID_DECODER_ALLOCATION_MAX_BYTES
  );
}

/**
 * Preserve native Uint8Array leaves while normalizing every other Candid value
 * to the established JSON-facing representation.
 */
export function normalizeSelfCallResult(
  value: unknown,
  outputType: IDL.Type,
): unknown {
  return projectSelfCallResult(value, outputType);
}

export function encodeSelfCallResult(value: unknown): {
  value: JsonValue;
  blobs: SelfCallWireBlob[];
} {
  const blobs: SelfCallWireBlob[] = [];
  const active = new Set<object>();
  let elements = 0;

  const visit = (
    candidate: unknown,
    path: SelfCallBlobPathSegment[],
    depth: number,
  ): JsonValue => {
    if (depth > SELF_CALL_CANDID_MAX_DEPTH) {
      throw new Error("Self-call result exceeds the Candid value depth limit");
    }
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new Error("Self-call result contains a non-finite number");
      }
      return candidate;
    }
    if (candidate instanceof Uint8Array || candidate instanceof ArrayBuffer) {
      if (blobs.length >= SELF_CALL_BINARY_MAX_COUNT) {
        throw new Error(
          "Self-call result exceeds the binary field count limit",
        );
      }
      const source =
        candidate instanceof Uint8Array ? candidate : new Uint8Array(candidate);
      const snapshot = Uint8Array.from(source);
      const nextBytes =
        blobs.reduce((total, blob) => total + blob.byteLength, 0) +
        snapshot.byteLength;
      if (nextBytes > SELF_CALL_BINARY_MAX_BYTES) {
        throw new Error(
          "Self-call result exceeds the aggregate binary byte limit",
        );
      }
      const data = snapshot.buffer as ArrayBuffer;
      blobs.push({ path: [...path], byteLength: data.byteLength, data });
      return null;
    }
    if (typeof candidate !== "object") {
      throw new Error("Self-call result is not JSON/Candid safe");
    }
    if (active.has(candidate))
      throw new Error("Self-call result contains a cycle");
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        elements += candidate.length;
        assertSelfCallElementBudget(elements);
        return candidate.map((entry, index) =>
          visit(entry, [...path, index], depth + 1),
        );
      }
      const entries = Object.entries(candidate);
      elements += entries.length;
      assertSelfCallElementBudget(elements);
      return Object.fromEntries(
        entries.map(([key, entry]) => [
          key,
          visit(entry, [...path, key], depth + 1),
        ]),
      );
    } finally {
      active.delete(candidate);
    }
  };

  const encoded = visit(value, [], 0);
  const metadataBytes = new TextEncoder().encode(
    JSON.stringify(encoded),
  ).byteLength;
  if (metadataBytes > SELF_CALL_METADATA_MAX_BYTES) {
    throw new Error("Self-call result exceeds the metadata byte limit");
  }
  return { value: encoded, blobs };
}

export function assertCandidBoundaryValue(value: unknown, label: string): void {
  let elements = 0;
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > SELF_CALL_CANDID_MAX_DEPTH) {
      throw new Error(`${label} exceeds the Candid value depth limit`);
    }
    if (
      candidate === null ||
      candidate === undefined ||
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      typeof candidate === "boolean" ||
      typeof candidate === "bigint"
    ) {
      return;
    }
    if (candidate instanceof ArrayBuffer) {
      throw new Error(`${label} contains undeclared binary data`);
    }
    if (ArrayBuffer.isView(candidate)) {
      const elementBytes = (
        candidate as ArrayBufferView & { BYTES_PER_ELEMENT?: unknown }
      ).BYTES_PER_ELEMENT;
      if (typeof elementBytes !== "number" || elementBytes === 1) {
        throw new Error(`${label} contains undeclared binary data`);
      }
      elements += candidate.byteLength / elementBytes;
      if (elements > SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS) {
        throw new Error(`${label} exceeds the Candid container element limit`);
      }
      return;
    }
    if (typeof candidate !== "object") {
      throw new Error(`${label} is not Candid/JSON safe`);
    }
    if ("toText" in candidate && typeof candidate.toText === "function") {
      return;
    }
    if (seen.has(candidate)) {
      throw new Error(`${label} contains a cyclic value`);
    }
    seen.add(candidate);
    const children = Array.isArray(candidate)
      ? candidate
      : Object.values(candidate as Record<string, unknown>);
    elements += children.length;
    if (elements > SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS) {
      throw new Error(`${label} exceeds the Candid container element limit`);
    }
    for (const child of children) visit(child, depth + 1);
    seen.delete(candidate);
  };
  visit(value, 0);
}

export function normalizeCandidBoundaryValue(
  value: unknown,
  type: IDL.Type,
): unknown {
  const visit = createSelfCallResultProjector();
  const projected = visit(value, type);
  return projected === ABSENT_SELF_CALL_OPTION ? null : projected;
}

function assertTypeGraphLimits(root: IDL.Type, label: string): void {
  const seen = new Set<IDL.Type>();
  const active = new Set<IDL.Type>();
  let aggregateFields = 0;
  let metadataAllocationBytes = 0;
  const visit = (type: IDL.Type, depth: number): void => {
    if (depth > SELF_CALL_CANDID_MAX_DEPTH) {
      throw new Error(`${label} exceeds the Candid type depth limit`);
    }
    if (active.has(type) || seen.has(type)) return;
    seen.add(type);
    if (seen.size > SELF_CALL_CANDID_TYPE_MAX_ENTRIES) {
      throw new Error(`${label} exceeds the Candid type-table limit`);
    }

    // Account the complete live IDL graph before icblast is allowed to encode
    // a request or decode a reply. A small number of types can still contain
    // thousands of record/variant fields, so the distinct-type and depth
    // limits alone are not allocation bounds.
    metadataAllocationBytes += 32;
    if (type instanceof IDL.OptClass || type instanceof IDL.VecClass) {
      metadataAllocationBytes += 16;
    } else if (
      type instanceof IDL.RecordClass ||
      type instanceof IDL.TupleClass ||
      type instanceof IDL.VariantClass
    ) {
      aggregateFields += type._fields.length;
      metadataAllocationBytes += type._fields.length * 24;
    } else if (
      type instanceof IDL.FuncClass ||
      type instanceof IDL.ServiceClass
    ) {
      throw new Error(`${label} contains a non-JSON Candid reference type`);
    }
    if (aggregateFields > SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS) {
      throw new Error(`${label} exceeds the aggregate Candid field limit`);
    }
    if (
      metadataAllocationBytes > SELF_CALL_CANDID_DECODER_ALLOCATION_MAX_BYTES
    ) {
      throw new Error(`${label} exceeds the Candid type-metadata limit`);
    }

    active.add(type);
    for (const child of candidTypeChildren(type)) visit(child, depth + 1);
    active.delete(type);
  };
  visit(root, 0);
}

function candidTypeChildren(type: IDL.Type): IDL.Type[] {
  if (type instanceof IDL.OptClass || type instanceof IDL.VecClass) {
    return [type._type];
  }
  if (
    type instanceof IDL.RecordClass ||
    type instanceof IDL.TupleClass ||
    type instanceof IDL.VariantClass
  ) {
    return type._fields.map(([, child]) => child);
  }
  if (type instanceof IDL.RecClass) {
    const child = (type as unknown as { _type?: IDL.Type })._type;
    return child ? [child] : [];
  }
  return [];
}

function isBlobType(type: IDL.Type | undefined): boolean {
  return (
    type instanceof IDL.VecClass &&
    type._type instanceof IDL.FixedNatClass &&
    type._type._bits === 8
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDensePlainArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return false;
    }
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  return (
    lengthDescriptor !== undefined &&
    "value" in lengthDescriptor &&
    lengthDescriptor.value === value.length
  );
}

function hasExactOwnDataKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key))
  ) {
    return false;
  }
  return expected.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      descriptor.enumerable === true &&
      "value" in descriptor
    );
  });
}

function hasOneEnumerableDataField(value: Record<string, unknown>): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || typeof keys[0] !== "string") return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, keys[0]);
  return (
    descriptor !== undefined &&
    descriptor.enumerable === true &&
    "value" in descriptor
  );
}

function formatSelfCallPath(path: readonly SelfCallBlobPathSegment[]): string {
  let output = "args";
  for (const part of path) {
    if (typeof part === "number") {
      output += `[${part}]`;
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(part)) {
      output += `.${part}`;
    } else {
      output += `[${JSON.stringify(part)}]`;
    }
  }
  return output;
}

/**
 * Resolve the compiler-owned Candid wrapper only after the logical method has
 * been proven to belong to the source app. Registry parsing already enforces
 * this mapping; the second derivation keeps dispatch fail-closed if an
 * in-memory fixture or corrupted projection bypasses that parser.
 */
export function requirePhysicalSelfCallMethod(
  appId: string,
  entry: AppRegistryFunction,
): string {
  if (entry.type === "internal") {
    throw new Error("Internal app methods have no Candid wrapper");
  }
  const expected =
    appId === "kernel" ? entry.name : physicalAppMethodName(appId, entry.name);
  if (entry.candid_name !== expected) {
    throw new Error("Installed app method has an invalid physical Candid name");
  }
  return expected;
}
