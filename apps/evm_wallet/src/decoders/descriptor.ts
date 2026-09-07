import { decodeFunctionData, encodeFunctionData, formatUnits, getAddress, parseAbiItem, toFunctionSelector, type AbiFunction, type AbiParameter, type Hex } from "viem";
import type { Asset, Network, Operation } from "../data.ts";
import type { OperationPresentation, PresentationField } from "../presentation.ts";

export type DecoderField = {
  path: string;
  label: string;
  format: "address" | "integer" | "boolean" | "bytes" | "tokenAmount" | "nativeAmount" | "timestamp";
  tokenPath?: string;
  tokenAddress?: string;
  role?: "amount" | "detail" | "party";
};
export type DecoderFunction = {
  signature: string;
  title: string;
  description?: string;
  value: "zero" | "payable";
  fields: DecoderField[];
};
export type DecoderPack = {
  format: 1;
  id: string;
  version: string;
  name: string;
  description: string;
  source?: string;
  deployments: { chainId: string; address: string }[];
  functions: DecoderFunction[];
};

type Path = { source: "args"; indexes: number[]; type: string } | { source: "transaction"; key: "from" | "to" | "value"; type: string };
type CompiledField = { field: DecoderField; path: Path; tokenPath?: Path };
type CompiledFunction = { definition: DecoderFunction; abi: AbiFunction; fields: CompiledField[] };
type CompiledPack = { pack: DecoderPack; functions: Map<string, CompiledFunction> };
const compiledPacks = new WeakMap<DecoderPack, CompiledPack>();
const uint256Max = (1n << 256n) - 1n;
const forbiddenPathSegments = new Set(["__proto__", "prototype", "constructor"]);
const formats = new Set<DecoderField["format"]>(["address", "integer", "boolean", "bytes", "tokenAmount", "nativeAmount", "timestamp"]);

function invalid(message: string): never { throw new Error(`Invalid decoder pack: ${message}`); }
function record(raw: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== "string" || !keys.includes(key)) invalid(`unknown ${label} property ${String(key)}`);
    if (!("value" in descriptors[key]!)) invalid(`${label} must contain data properties`);
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function list(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw)) invalid(`${label} must be an array`);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).length !== raw.length + 1) invalid(`${label} must contain only array items`);
  for (let i = 0; i < raw.length; i++) if (!descriptors[i] || !("value" in descriptors[i]!)) invalid(`${label} must contain data items`);
  return Array.from({ length: raw.length }, (_, index) => descriptors[index]!.value as unknown);
}
function string(raw: unknown, label: string, empty = false): string {
  if (typeof raw !== "string" || (!empty && raw.trim() === "")) invalid(`${label} must be ${empty ? "text" : "nonempty text"}`);
  return raw;
}
function address(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw)) invalid(`${label} must be an EVM address`);
  try { return getAddress(raw); } catch { return invalid(`${label} must be an EVM address`); }
}
function positive(raw: unknown, label: string, maximum?: bigint): string {
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw) || (maximum !== undefined && BigInt(raw) > maximum)) invalid(`${label} must be a canonical positive decimal${maximum ? " in the EVM uint256 domain" : ""}`);
  return raw;
}
function position(segment: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(segment)) return null;
  const value = Number(segment);
  return Number.isSafeInteger(value) ? value : null;
}
function components(parameter: AbiParameter): readonly AbiParameter[] {
  return "components" in parameter ? parameter.components : [];
}
function compilePath(raw: unknown, abi: AbiFunction, label: string): Path {
  const path = string(raw, label);
  const segments = path.split(".");
  if (segments.some((segment) => forbiddenPathSegments.has(segment))) invalid(`${label} contains a forbidden property path`);
  if (segments[0] === "transaction" && segments.length === 2 && ["from", "to", "value"].includes(segments[1]!)) {
    const key = segments[1] as "from" | "to" | "value";
    return { source: "transaction", key, type: key === "value" ? "uint256" : "address" };
  }
  if (segments[0] !== "args" || segments.length < 2) invalid(`${label} must select an ABI argument or transaction field`);
  const first = position(segments[1]!);
  if (first === null || first >= abi.inputs.length) invalid(`${label} selects a missing ABI argument`);
  const indexes = [first];
  let parameter = abi.inputs[first]!;
  for (const segment of segments.slice(2)) {
    const array = /^(.*)\[([0-9]*)\]$/.exec(parameter.type);
    if (array) {
      const index = position(segment);
      if (index === null || (array[2] !== "" && BigInt(index) >= BigInt(array[2]!))) invalid(`${label} selects an invalid array index`);
      indexes.push(index);
      parameter = { ...parameter, type: array[1]! } as AbiParameter;
    } else if (parameter.type === "tuple") {
      const members = components(parameter);
      const positional = position(segment);
      const matches = positional === null ? members.flatMap((member, index) => member.name === segment ? [index] : []) : [positional];
      if (matches.length !== 1 || matches[0]! >= members.length) invalid(`${label} selects a missing or ambiguous tuple field`);
      indexes.push(matches[0]!);
      parameter = members[matches[0]!]!;
    } else invalid(`${label} traverses a scalar ABI value`);
  }
  return { source: "args", indexes, type: parameter.type };
}
function assertFormat(format: DecoderField["format"], type: string, label: string): void {
  const compatible = format === "address" ? type === "address"
    : format === "boolean" ? type === "bool"
      : format === "bytes" ? /^bytes([1-9]|[12][0-9]|3[0-2])?$/.test(type)
        : format === "integer" ? /^u?int([0-9]+)?$/.test(type)
          : /^uint([0-9]+)?$/.test(type);
  if (!compatible) invalid(`${label} format ${format} does not match ABI type ${type}`);
}
// viem normally decodes fully named tuples into objects. Positional tuples
// preserve every ABI member, including duplicate names, without assigning any
// user-provided property name to a JavaScript object.
function positionalParameter(parameter: AbiParameter): AbiParameter {
  const { name: _name, ...rest } = parameter;
  return "components" in parameter ? { ...rest, components: parameter.components.map(positionalParameter) } as AbiParameter : rest as AbiParameter;
}
function supportedParameter(parameter: AbiParameter): void {
  const scalar = parameter.type.replace(/\[[0-9]*\]/g, "");
  if (scalar === "tuple") components(parameter).forEach(supportedParameter);
  else if (!/^(address|bool|string|bytes([1-9]|[12][0-9]|3[0-2])?|u?int([0-9]+)?)$/.test(scalar)) invalid(`ABI type ${parameter.type} is not supported by this decoder engine`);
}
function freezePack(pack: DecoderPack): DecoderPack {
  for (const deployment of pack.deployments) Object.freeze(deployment);
  for (const definition of pack.functions) {
    for (const field of definition.fields) Object.freeze(field);
    Object.freeze(definition.fields);
    Object.freeze(definition);
  }
  Object.freeze(pack.deployments);
  Object.freeze(pack.functions);
  return Object.freeze(pack);
}

/** Validate a data-only pack. No expressions, code, URLs or templates execute. */
export function parseDecoderPack(raw: unknown): DecoderPack {
  const value = record(raw, ["format", "id", "version", "name", "description", "source", "deployments", "functions"], "pack");
  if (value.format !== 1) invalid("unsupported format");
  const id = string(value.id, "id");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) invalid("id must be a lowercase identifier");
  const deploymentKeys = new Set<string>();
  const deployments = list(value.deployments, "deployments").map((entry) => {
    const deployment = record(entry, ["chainId", "address"], "deployment");
    const chainId = positive(deployment.chainId, "chainId", uint256Max);
    const target = address(deployment.address, "deployment address");
    const key = `${chainId}:${target.toLowerCase()}`;
    if (deploymentKeys.has(key)) invalid("duplicate deployment");
    deploymentKeys.add(key);
    return { chainId, address: target };
  });
  if (deployments.length === 0) invalid("at least one deployment is required");
  const compiledFunctions = new Map<string, CompiledFunction>();
  const functions = list(value.functions, "functions").map((entry) => {
    const fn = record(entry, ["signature", "title", "description", "value", "fields"], "function");
    const signature = string(fn.signature, "function signature").trim();
    let abi: AbiFunction;
    try {
      const parsed = parseAbiItem(signature.startsWith("function ") ? signature : `function ${signature}`);
      if (parsed.type !== "function") invalid("signature must describe a function");
      abi = parsed;
    } catch { return invalid(`invalid ABI function signature ${signature}`); }
    abi.inputs.forEach(supportedParameter);
    const selector = toFunctionSelector(abi).toLowerCase();
    if (compiledFunctions.has(selector)) invalid(`ambiguous function selector ${selector}`);
    if (fn.value !== "zero" && fn.value !== "payable") invalid("function value must be zero or payable");
    const fields: CompiledField[] = list(fn.fields, "fields").map((entry) => {
      const field = record(entry, ["path", "label", "format", "tokenPath", "tokenAddress", "role"], "field");
      if (!formats.has(field.format as DecoderField["format"])) invalid("unsupported field format");
      const format = field.format as DecoderField["format"];
      const path = compilePath(field.path, abi, "field path");
      assertFormat(format, path.type, "field");
      if (field.role !== undefined && !["amount", "detail", "party"].includes(field.role as string)) invalid("unsupported field role");
      let tokenPath: Path | undefined;
      let tokenAddress: string | undefined;
      if (format === "tokenAmount") {
        if ((field.tokenPath !== undefined) === (field.tokenAddress !== undefined)) invalid("tokenAmount needs exactly one tokenPath or tokenAddress");
        if (field.tokenPath !== undefined) {
          tokenPath = compilePath(field.tokenPath, abi, "tokenPath");
          assertFormat("address", tokenPath.type, "tokenPath");
        } else tokenAddress = address(field.tokenAddress, "tokenAddress");
      } else if (field.tokenPath !== undefined || field.tokenAddress !== undefined) invalid("only tokenAmount fields can select a token");
      return { field: {
        path: field.path as string, label: string(field.label, "field label"), format,
        ...(field.role !== undefined ? { role: field.role as NonNullable<DecoderField["role"]> } : {}),
        ...(tokenPath ? { tokenPath: field.tokenPath as string } : {}),
        ...(tokenAddress ? { tokenAddress } : {}),
      }, path, ...(tokenPath ? { tokenPath } : {}) };
    });
    if (fields.filter(({ field }) => field.role === "amount").length > 1) invalid("a function can have only one primary amount field");
    const definition: DecoderFunction = { signature, title: string(fn.title, "function title"), value: fn.value, fields: fields.map(({ field }) => field), ...(fn.description !== undefined ? { description: string(fn.description, "function description", true) } : {}) };
    compiledFunctions.set(selector, { definition, abi: { ...abi, inputs: abi.inputs.map(positionalParameter), outputs: abi.outputs.map(positionalParameter) }, fields });
    return definition;
  });
  if (functions.length === 0) invalid("at least one function is required");
  const pack: DecoderPack = freezePack({ format: 1, id, version: positive(value.version, "version"), name: string(value.name, "name"), description: string(value.description, "description", true), ...(value.source !== undefined ? { source: string(value.source, "source") } : {}), deployments, functions });
  compiledPacks.set(pack, { pack, functions: compiledFunctions });
  return pack;
}

function compile(pack: DecoderPack): CompiledPack {
  return compiledPacks.get(pack) ?? compiledPacks.get(parseDecoderPack(pack))!;
}
type Candidate = { operation: Operation; transaction: NonNullable<Operation["intent"]["transaction"]>; args: readonly unknown[]; fn: CompiledFunction };
function candidate(pack: DecoderPack, operation: Operation): Candidate | null {
  const transaction = operation.preparedTransaction ?? operation.intent.transaction;
  if (operation.kind !== "transaction" || !transaction || (operation.preparedTransaction && operation.preparedTransaction.chainId !== operation.chainId)) return null;
  const compiled = compile(pack);
  if (!compiled.pack.deployments.some((deployment) => deployment.chainId === operation.chainId && deployment.address.toLowerCase() === transaction.to.toLowerCase())) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(transaction.value) || BigInt(transaction.value) > uint256Max || !/^0x[0-9a-fA-F]*$/.test(transaction.data)) return null;
  const fn = compiled.functions.get(transaction.data.slice(0, 10).toLowerCase());
  if (!fn || (fn.definition.value === "zero" && transaction.value !== "0")) return null;
  const abi = [fn.abi];
  const decoded = decodeFunctionData({ abi, data: transaction.data as Hex });
  if (encodeFunctionData({ abi, functionName: decoded.functionName, args: decoded.args }).toLowerCase() !== transaction.data.toLowerCase()) return null;
  return { operation, transaction, args: decoded.args ?? [], fn };
}
function resolve(path: Path, decoded: Candidate): unknown {
  if (path.source === "transaction") return path.key === "from" ? decoded.operation.address : path.key === "value" ? BigInt(decoded.transaction.value) : decoded.transaction.to;
  let value: unknown = decoded.args;
  for (const index of path.indexes) {
    if (!Array.isArray(value)) throw new Error("Missing positional ABI value");
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor)) throw new Error("Missing ABI array item");
    value = descriptor.value;
  }
  return value;
}
function tokenOf(field: CompiledField, decoded: Candidate): string {
  return address(field.tokenPath ? resolve(field.tokenPath, decoded) : field.field.tokenAddress, "decoded token address");
}
function integer(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error("Invalid decoded integer");
}
function metadata(assets: readonly Asset[], chainId: string, token: string): Asset | null {
  const matches = assets.filter((asset) => asset.chainId === chainId && asset.address.toLowerCase() === token.toLowerCase());
  const first = matches[0];
  return first && Number.isInteger(first.decimals) && first.decimals >= 0 && first.decimals <= 255 && typeof first.symbol === "string" && first.symbol.trim() !== "" && matches.every((asset) => asset.decimals === first.decimals && asset.symbol === first.symbol) ? first : null;
}

/** Tokens are selected only after the deployment and complete calldata match. */
export function descriptorTokens(pack: DecoderPack, operation: Operation): string[] {
  try {
    const decoded = candidate(pack, operation);
    return decoded ? [...new Set(decoded.fn.fields.filter(({ field }) => field.format === "tokenAmount").map((field) => tokenOf(field, decoded)))] : [];
  } catch { return []; }
}

/** A nullable exact-byte interpretation. The registry supplies decoder provenance. */
export function decodeDescriptorPack(pack: DecoderPack, operation: Operation, assets: readonly Asset[], network?: Network): OperationPresentation | null {
  try {
    const decoded = candidate(pack, operation);
    if (!decoded) return null;
    const nativeSymbol = network?.chainId === operation.chainId ? network.nativeSymbol : "native token";
    const native = (atomic: bigint) => `${formatUnits(atomic, 18)} ${nativeSymbol}`;
    const parties: PresentationField[] = [];
    const advancedDetails: PresentationField[] = [{ label: "Method", value: decoded.fn.definition.signature }];
    let primary: string | null = null;
    let primaryLabel = "Amount";
    let tokenSymbol: string | null = null;
    let tokenAddress: string | null | undefined;
    let amountAtoms: string | undefined;
    let primaryIsNativePayment = false;
    for (const entry of decoded.fn.fields) {
      const { field } = entry;
      const raw = resolve(entry.path, decoded);
      let value: string;
      if (field.format === "address") value = address(raw, "decoded address");
      else if (field.format === "boolean") { if (typeof raw !== "boolean") return null; value = raw ? "Yes" : "No"; }
      else if (field.format === "bytes") { if (typeof raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw)) return null; value = raw; }
      else {
        const atomic = integer(raw);
        if (field.format === "integer") value = atomic.toString();
        else if (field.format === "timestamp") {
          const milliseconds = atomic * 1000n;
          // ECMAScript Date's actual representable domain, not an expiry policy.
          value = milliseconds <= 8_640_000_000_000_000n ? `${new Date(Number(milliseconds)).toISOString()} (${atomic} Unix seconds)` : `${atomic} Unix seconds`;
        } else if (field.format === "nativeAmount") {
          value = native(atomic);
          advancedDetails.push({ label: `${field.label} (wei)`, value: atomic.toString() });
          if (field.role === "amount") {
            tokenSymbol = nativeSymbol;
            tokenAddress = null;
            amountAtoms = atomic.toString();
            primaryIsNativePayment = entry.path.source === "transaction" && entry.path.key === "value";
          }
        } else {
          const token = tokenOf(entry, decoded);
          const asset = metadata(assets, operation.chainId, token);
          value = asset ? `${formatUnits(atomic, asset.decimals)} ${asset.symbol}` : `${atomic} atomic units`;
          advancedDetails.push({ label: `${field.label} token`, value: token }, { label: `${field.label} (atomic units)`, value: atomic.toString() });
          if (field.role === "amount") { tokenSymbol = asset?.symbol ?? null; tokenAddress = token; amountAtoms = atomic.toString(); }
        }
      }
      if (field.role === "amount") { primary = value; primaryLabel = field.label; }
      else (field.role === "party" ? parties : advancedDetails).push({ label: field.label, value });
    }
    return {
      title: decoded.fn.definition.title,
      amount: primary,
      amountLabel: primaryLabel,
      ...(amountAtoms !== undefined ? { amountAtoms } : {}),
      description: decoded.fn.definition.description ?? pack.description,
      parties,
      contract: decoded.transaction.to,
      nativeValue: decoded.transaction.value === "0" || primaryIsNativePayment ? null : native(BigInt(decoded.transaction.value)),
      unlimitedApproval: false,
      tokenSymbol,
      ...(tokenAddress !== undefined ? { tokenAddress } : {}),
      advancedDetails,
    };
  } catch { return null; }
}
