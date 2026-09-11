/**
 * Lossless JSON for Candid values. Integers serialize as decimal strings and
 * blobs as { hex }. Options use null for none and a bare value for some. The
 * single-key { $some: value } escape preserves some(null), nested options and
 * payloads whose sole key is $some. Arrays always mean vectors or tuples, never
 * the []/[value] option convention used by @dfinity/candid internally.
 * Floating negative zero uses the string "-0", which survives JSON.stringify.
 */
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";

type JsonObject = Record<string, unknown>;
type Integer = { signed: boolean; bits: number | null };
type Conversion = { direction: "from" | "to"; active: Map<IDL.Type, Set<unknown>> };

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function object(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function singleKey(value: unknown, key: string): value is JsonObject {
  return object(value) && Object.keys(value).length === 1 && Object.hasOwn(value, key);
}

function textValue(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "expected text");
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(path, "text contains an unpaired Unicode surrogate");
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(path, "text contains an unpaired Unicode surrogate");
    }
  }
  return value;
}

function resolved(type: IDL.Type): IDL.Type {
  const seen = new Set<IDL.Type>();
  while (type instanceof IDL.RecClass) {
    if (seen.has(type)) throw new Error("Candid recursive type has no concrete body");
    seen.add(type);
    const body = type.getType();
    if (!body) throw new Error("Candid recursive type has not been filled");
    type = body;
  }
  return type;
}

function integerType(type: IDL.Type): Integer | undefined {
  if (type instanceof IDL.NatClass) return { signed: false, bits: null };
  if (type instanceof IDL.IntClass) return { signed: true, bits: null };
  if (type instanceof IDL.FixedNatClass) return { signed: false, bits: type._bits };
  if (type instanceof IDL.FixedIntClass) return { signed: true, bits: type._bits };
  return undefined;
}

function integerValue(spec: Integer, value: unknown, path: string, fromJson: boolean): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (fromJson && typeof value === "string" && /^-?(0|[1-9][0-9]*)$/.test(value)) {
    parsed = BigInt(value);
  } else {
    fail(path, "expected a lossless decimal integer string, bigint, or safe integer number");
  }
  const minimum = spec.signed ? (spec.bits === null ? undefined : -(1n << BigInt(spec.bits - 1))) : 0n;
  const maximum = spec.bits === null ? undefined : (1n << BigInt(spec.bits - (spec.signed ? 1 : 0))) - 1n;
  if ((minimum !== undefined && parsed < minimum) || (maximum !== undefined && parsed > maximum)) {
    fail(path, `integer is outside ${spec.signed ? "int" : "nat"}${spec.bits ?? ""} range`);
  }
  return parsed;
}

function principalValue(value: unknown, path: string, fromJson: boolean): Principal {
  try {
    if (fromJson && typeof value === "string") return Principal.fromText(value);
    if (Principal.isPrincipal(value)) return Principal.fromText(value.toText());
  } catch {
    fail(path, "invalid principal");
  }
  fail(path, fromJson ? "expected principal text" : "expected a Candid Principal");
}

function vector(value: unknown, path: string, native: boolean): unknown[] {
  if (Array.isArray(value)) return Array.from(value);
  if (native && ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<unknown>);
  }
  fail(path, "expected an array");
}

function tupleTypes(type: IDL.TupleClass<unknown[]>): IDL.Type[] {
  const fields = type.tryAsTuple();
  if (!fields) throw new Error("Invalid Candid tuple type");
  return fields;
}

function convert(type: IDL.Type, value: unknown, path: string, context: Conversion): unknown {
  type = resolved(type);
  const active = context.active.get(type) ?? new Set<unknown>();
  if (active.has(value)) fail(path, "cyclic value or recursive option without a terminating value");
  context.active.set(type, active);
  active.add(value);
  try {
    return convertValue(type, value, path, context);
  } finally {
    active.delete(value);
    if (active.size === 0) context.active.delete(type);
  }
}

function convertValue(type: IDL.Type, value: unknown, path: string, context: Conversion): unknown {
  const from = context.direction === "from";
  const child = (inner: IDL.Type, input: unknown, at = path) => convert(inner, input, at, context);
  const integer = integerType(type);
  if (integer) {
    const parsed = integerValue(integer, value, path, from);
    return from ? (integer.bits !== null && integer.bits <= 32 ? Number(parsed) : parsed) : parsed.toString();
  }
  if (type instanceof IDL.OptClass) {
    if (from) {
      if (value === null || value === undefined) return [];
      return [singleKey(value, "$some") ? child(type._type, value.$some, `${path}.$some`) : child(type._type, value)];
    }
    if (!Array.isArray(value) || value.length > 1) fail(path, "expected native Candid option [] or [value]");
    if (value.length === 0) return null;
    const inner = child(type._type, value[0]);
    return inner === null || singleKey(inner, "$some") ? { $some: inner } : inner;
  }
  if (type instanceof IDL.VecClass) {
    const inner = resolved(type._type);
    const blob = inner instanceof IDL.FixedNatClass && inner._bits === 8;
    if (from && blob && singleKey(value, "hex")) {
      if (typeof value.hex !== "string" || !/^(?:[0-9a-fA-F]{2})*$/.test(value.hex)) {
        fail(path, "blob hex must contain an even number of hexadecimal digits");
      }
      return Uint8Array.from(value.hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
    }
    const items = vector(value, path, !from || blob);
    if (blob) {
      const bytes = items.map((item, index) => Number(integerValue({ signed: false, bits: 8 }, item, `${path}[${index}]`, from)));
      return from ? Uint8Array.from(bytes) : { hex: bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("") };
    }
    return items.map((item, index) => child(type._type, item, `${path}[${index}]`));
  }
  if (type instanceof IDL.TupleClass) {
    const fields = tupleTypes(type);
    if (!Array.isArray(value) || value.length !== fields.length) fail(path, `expected tuple with ${fields.length} elements`);
    return fields.map((field, index) => child(field, value[index], `${path}[${index}]`));
  }
  if (type instanceof IDL.RecordClass) {
    if (!object(value)) fail(path, "expected a record object");
    const names = new Set(type._fields.map(([name]) => name));
    for (const name of Object.keys(value)) if (!names.has(name)) fail(`${path}.${name}`, "unknown record field");
    return Object.fromEntries(type._fields.map(([name, field]) => {
      const present = Object.hasOwn(value, name);
      if (!present && !(from && resolved(field) instanceof IDL.OptClass)) {
        fail(`${path}.${name}`, "missing required record field");
      }
      return [name, child(field, present ? value[name] : undefined, `${path}.${name}`)];
    }));
  }
  if (type instanceof IDL.VariantClass) {
    if (!object(value) || Object.keys(value).length !== 1) fail(path, "expected a single-key variant object");
    const name = Object.keys(value)[0]!;
    const field = type._fields.find(([candidate]) => candidate === name);
    if (!field) fail(`${path}.${name}`, "unknown variant tag");
    return Object.fromEntries([[name, child(field[1], value[name], `${path}.${name}`)]]);
  }
  if (type instanceof IDL.PrincipalClass || type instanceof IDL.ServiceClass) {
    const principal = principalValue(value, path, from);
    return from ? principal : principal.toText();
  }
  if (type instanceof IDL.FuncClass) {
    if (!Array.isArray(value) || value.length !== 2 || typeof value[1] !== "string") {
      fail(path, "expected function reference [principal, method text]");
    }
    const principal = principalValue(value[0], `${path}[0]`, from);
    return [from ? principal : principal.toText(), textValue(value[1], `${path}[1]`)];
  }
  if (type instanceof IDL.FloatClass) {
    if (from && value === "-0") return -0;
    if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
    if (type._bits === 32 && !Object.is(Math.fround(value), value)) fail(path, "number is not exactly representable as float32");
    return !from && Object.is(value, -0) ? "-0" : value;
  }
  if (type instanceof IDL.BoolClass) {
    if (typeof value !== "boolean") fail(path, "expected a boolean");
    return value;
  }
  if (type instanceof IDL.TextClass) {
    return textValue(value, path);
  }
  if (type instanceof IDL.NullClass || type instanceof IDL.ReservedClass) {
    if (value !== null) fail(path, `expected null for Candid ${type.name}`);
    return null;
  }
  if (type instanceof IDL.EmptyClass) fail(path, "Candid empty has no values");
  fail(path, `unsupported Candid type ${type.typeName}`);
}

export function candidValueFromJson(type: IDL.Type, value: unknown, path = "$"): unknown {
  return convert(type, value, path, { direction: "from", active: new Map() });
}

export function candidValueToJson(type: IDL.Type, value: unknown): unknown {
  return convert(type, value, "$", { direction: "to", active: new Map() });
}

function argumentCount(types: IDL.Type[], values: unknown[]): void {
  if (!Array.isArray(values) || values.length !== types.length) {
    throw new Error(`Expected ${types.length} Candid arguments as a JSON array`);
  }
}

export function candidArgsFromJson(types: IDL.Type[], values: unknown[]): unknown[] {
  argumentCount(types, values);
  return types.map((type, index) => candidValueFromJson(type, values[index], `$[${index}]`));
}

export function candidArgsToJson(types: IDL.Type[], values: unknown[]): unknown[] {
  argumentCount(types, values);
  return types.map((type, index) => convert(type, values[index], `$[${index}]`, { direction: "to", active: new Map() }));
}

/** A printable JSON Schema, with Candid signatures retained as annotations. */
export function candidTypeSchema(type: IDL.Type): JsonObject {
  const definitions: JsonObject = {};
  const recursive = new Map<IDL.Type, string>();
  const escape = (inner: JsonObject): JsonObject => ({
    type: "object", properties: { $some: inner }, required: ["$some"], additionalProperties: false,
  });
  const schema = (current: IDL.Type): JsonObject => {
    if (current instanceof IDL.RecClass) {
      const existing = recursive.get(current);
      if (existing) return { $ref: `#/$defs/${existing}` };
      const body = resolved(current);
      const name = `rec${recursive.size}`;
      recursive.set(current, name);
      definitions[name] = schema(body);
      return { $ref: `#/$defs/${name}` };
    }
    const integer = integerType(current);
    if (integer) {
      const minimum = integer.signed ? (integer.bits === null ? undefined : -(1n << BigInt(integer.bits - 1))) : 0n;
      const maximum = integer.bits === null ? undefined : (1n << BigInt(integer.bits - (integer.signed ? 1 : 0))) - 1n;
      return {
        candidType: current.name,
        description: "Decimal integer strings preserve every Candid integer. Numbers must be safe integers.",
        anyOf: [
          { type: "string", pattern: integer.signed ? "^-?(0|[1-9][0-9]*)$" : "^(0|[1-9][0-9]*)$" },
          { type: "integer", minimum: Math.max(Number.MIN_SAFE_INTEGER, Number(minimum ?? Number.MIN_SAFE_INTEGER)), maximum: Math.min(Number.MAX_SAFE_INTEGER, Number(maximum ?? Number.MAX_SAFE_INTEGER)) },
        ],
        ...(minimum === undefined ? {} : { candidMinimum: minimum.toString() }),
        ...(maximum === undefined ? {} : { candidMaximum: maximum.toString() }),
      };
    }
    if (current instanceof IDL.OptClass) {
      const inner = schema(current._type);
      return {
        candidType: "opt", candidInner: inner,
        description: "null or omitted means none; a bare value means some. Use {$some: value} for explicit some, including some(null), nested options and a payload whose sole key is $some. Arrays are bare vectors/tuples, never Candid option wrappers.",
        anyOf: [
          { type: "null" },
          { allOf: [inner, { not: { anyOf: [{ type: "null" }, escape({})] } }] },
          escape(inner),
        ],
      };
    }
    if (current instanceof IDL.VecClass) {
      const inner = resolved(current._type);
      const array = { type: "array", items: schema(current._type) };
      return inner instanceof IDL.FixedNatClass && inner._bits === 8
        ? { candidType: "blob", anyOf: [array, { type: "object", properties: { hex: { type: "string", pattern: "^(?:[0-9a-fA-F]{2})*$" } }, required: ["hex"], additionalProperties: false }] }
        : { candidType: "vec", ...array };
    }
    if (current instanceof IDL.TupleClass) {
      const fields = tupleTypes(current);
      return { candidType: "tuple", type: "array", ...(fields.length ? { prefixItems: fields.map(schema) } : {}), minItems: fields.length, maxItems: fields.length, items: false };
    }
    if (current instanceof IDL.RecordClass) {
      return {
        candidType: "record", type: "object",
        properties: Object.fromEntries(current._fields.map(([name, field]) => [name, schema(field)])),
        required: current._fields.filter(([, field]) => !(resolved(field) instanceof IDL.OptClass)).map(([name]) => name),
        additionalProperties: false,
      };
    }
    if (current instanceof IDL.VariantClass) {
      if (current._fields.length === 0) return { candidType: "variant", not: {} };
      return {
        candidType: "variant",
        oneOf: current._fields.map(([name, field]) => ({ type: "object", properties: Object.fromEntries([[name, schema(field)]]), required: [name], additionalProperties: false })),
      };
    }
    if (current instanceof IDL.FuncClass) {
      return {
        candidType: "func", type: "array", prefixItems: [{ type: "string", format: "ic-principal" }, { type: "string" }], minItems: 2, maxItems: 2, items: false,
        candidArguments: current.argTypes.map(schema), candidReturns: current.retTypes.map(schema), candidAnnotations: [...current.annotations],
      };
    }
    if (current instanceof IDL.ServiceClass) {
      return { candidType: "service", type: "string", format: "ic-principal", candidMethods: Object.fromEntries(current._fields.map(([name, method]) => [name, schema(method)])) };
    }
    if (current instanceof IDL.PrincipalClass) return { candidType: "principal", type: "string", format: "ic-principal" };
    if (current instanceof IDL.FloatClass) return {
      candidType: current.name, anyOf: [{ type: "number" }, { const: "-0" }],
      description: `${current._bits === 32 ? "Finite and exactly representable as float32." : "Finite float64 number."} Use the string \"-0\" for lossless negative zero.`,
    };
    if (current instanceof IDL.BoolClass) return { candidType: "bool", type: "boolean" };
    if (current instanceof IDL.TextClass) return { candidType: "text", type: "string", description: "Unicode text without unpaired surrogates." };
    if (current instanceof IDL.NullClass || current instanceof IDL.ReservedClass) return { candidType: current.name, type: "null" };
    if (current instanceof IDL.EmptyClass) return { candidType: "empty", not: {} };
    throw new Error(`Unsupported Candid type ${current.typeName}`);
  };
  const root = schema(type);
  return { $schema: "https://json-schema.org/draft/2020-12/schema", ...root, ...(recursive.size ? { $defs: definitions } : {}) };
}
