import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";

export type ExpectedSelfCallBinding = {
  appId: string;
  logicalMethod: string;
  physicalMethod: string;
  mode: "query" | "update";
};

type PlanLike = {
  entries: readonly unknown[];
};

type CompiledPlanLike = {
  plan: PlanLike;
};

type PrimitiveType = {
  kind: "primitive";
  name: string;
};

type NamedType = {
  kind: "named";
  name: string;
};

type UnaryType = {
  kind: "unary";
  constructor: "opt" | "vec";
  value: CandidType;
};

type CandidField = {
  label: string | null;
  value: CandidType | null;
};

type AggregateType = {
  kind: "record" | "variant";
  fields: CandidField[];
};

type FunctionType = {
  kind: "func";
  inputs: CandidType[];
  outputs: CandidType[];
  mode: "query" | "update" | "oneway" | "composite_query";
};

type ServiceType = {
  kind: "service";
  methods: Map<string, FunctionType>;
};

type CandidType =
  | PrimitiveType
  | NamedType
  | UnaryType
  | AggregateType
  | FunctionType
  | ServiceType;

type ParsedCandid = {
  aliases: Map<string, CandidType>;
  actor: CandidType;
};

const PRIMITIVE_TYPES = new Set([
  "blob",
  "bool",
  "empty",
  "float32",
  "float64",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "nat",
  "nat8",
  "nat16",
  "nat32",
  "nat64",
  "null",
  "principal",
  "reserved",
  "text",
]);

/**
 * Bind every preapproved self-call to the deterministic physical method that
 * the assembler emitted. The application's Candid arguments and results are
 * intentionally unrestricted here; the live Candid interface owns their
 * complete structure, including any nested or repeated blob fields.
 */
export function assertCompiledSelfCallBindings(
  candid: string,
  capabilityPlans: Record<string, CompiledPlanLike>,
): ExpectedSelfCallBinding[] {
  const expected = Object.entries(capabilityPlans)
    .flatMap(([appId, compiled]) =>
      preapprovedSelfCallMethods(compiled.plan).map((method) => ({
        appId,
        logicalMethod: method.method,
        physicalMethod:
          appId === "kernel"
            ? method.method
            : physicalAppMethodName(appId, method.method),
        mode: method.mode,
      })),
    )
    .sort(
      (left, right) =>
        compareCanonicalText(left.appId, right.appId) ||
        compareCanonicalText(left.logicalMethod, right.logicalMethod),
    );
  if (expected.length === 0) return [];

  const parsed = new CandidParser(candid).parse();
  const service = resolveService(parsed.actor, parsed.aliases);
  for (const binding of expected) {
    const method = service.methods.get(binding.physicalMethod);
    if (!method) {
      throw bindingError(binding, "physical method is missing");
    }
    assertPhysicalMethodMode(binding, method);
  }
  return expected;
}

export function assertCandidMethodBinding(
  candid: string,
  expected: Pick<ExpectedSelfCallBinding, "physicalMethod" | "mode">,
): void {
  const parsed = new CandidParser(candid).parse();
  const service = resolveService(parsed.actor, parsed.aliases);
  const binding: ExpectedSelfCallBinding = {
    appId: "fixture",
    logicalMethod: expected.physicalMethod,
    ...expected,
  };
  const method = service.methods.get(expected.physicalMethod);
  if (!method) throw bindingError(binding, "physical method is missing");
  assertPhysicalMethodMode(binding, method);
}

export function assertInstallCommitBinding(candid: string): void {
  const parsed = new CandidParser(candid).parse();
  const service = resolveService(parsed.actor, parsed.aliases);
  const method = service.methods.get("kernel_install_commit");
  if (!method) {
    throw installCommitBindingError("method is missing");
  }
  if (method.mode !== "update") {
    throw installCommitBindingError(
      `mode is ${method.mode}, expected update`,
    );
  }
  if (method.inputs.length !== 1) {
    throw installCommitBindingError(
      `input arity is ${method.inputs.length}, expected 1`,
    );
  }
  const input = semanticType(method.inputs[0]!, parsed.aliases);
  if (input.kind !== "record" || input.fields.length !== 1) {
    throw installCommitBindingError(
      "input must be record { deployment_id : text }",
    );
  }
  const deploymentId = input.fields[0]!;
  if (
    deploymentId.label !== "deployment_id" ||
    deploymentId.value === null ||
    !isPrimitiveType(deploymentId.value, "text", parsed.aliases)
  ) {
    throw installCommitBindingError(
      "input must be record { deployment_id : text }",
    );
  }
  if (method.outputs.length !== 1) {
    throw installCommitBindingError(
      `output arity is ${method.outputs.length}, expected 1`,
    );
  }
  const output = semanticType(method.outputs[0]!, parsed.aliases);
  if (output.kind !== "variant" || output.fields.length !== 2) {
    throw installCommitBindingError(
      "output must be variant { blocked; committed }",
    );
  }
  const fields = new Map(output.fields.map((field) => [field.label, field]));
  for (const label of ["blocked", "committed"]) {
    const field = fields.get(label);
    if (
      field === undefined ||
      !isNullVariantField(field, parsed.aliases)
    ) {
      throw installCommitBindingError(
        "output must be variant { blocked; committed }",
      );
    }
  }
}

function isPrimitiveType(
  type: CandidType,
  name: string,
  aliases: Map<string, CandidType>,
): boolean {
  const resolved = semanticType(type, aliases);
  return resolved.kind === "primitive" && resolved.name === name;
}

function isNullVariantField(
  field: CandidField,
  aliases: Map<string, CandidType>,
): boolean {
  return (
    field.value === null ||
    isPrimitiveType(field.value, "null", aliases)
  );
}

function installCommitBindingError(detail: string): Error {
  return new Error(`Compiled install commit binding mismatch: ${detail}`);
}

function preapprovedSelfCallMethods(plan: PlanLike): Array<{
  method: string;
  mode: "query" | "update";
}> {
  const entry = plan.entries.find(
    (candidate) =>
      isRecord(candidate) && candidate.id === "preapproved_self_calls",
  );
  if (entry === undefined) return [];
  if (!isRecord(entry) || !isRecord(entry.config) || entry.config.api !== 1) {
    throw new Error("Invalid API-1 preapproved_self_calls compiler plan");
  }
  if (!Array.isArray(entry.config.methods)) {
    throw new Error("Invalid API-1 preapproved_self_calls compiler plan");
  }
  return entry.config.methods.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.method !== "string" ||
      (candidate.mode !== "query" && candidate.mode !== "update")
    ) {
      throw new Error("Invalid API-1 preapproved self-call compiler method");
    }
    return {
      method: candidate.method,
      mode: candidate.mode,
    };
  });
}

function assertPhysicalMethodMode(
  expected: ExpectedSelfCallBinding,
  method: FunctionType,
): void {
  if (method.mode !== expected.mode) {
    throw bindingError(
      expected,
      `mode is ${method.mode}, expected ${expected.mode}`,
    );
  }
}

function bindingError(
  expected: ExpectedSelfCallBinding,
  detail: string,
): Error {
  return new Error(
    `Compiled preapproved self-call binding mismatch for ${expected.appId}.${expected.logicalMethod} -> ${expected.physicalMethod}: ${detail}`,
  );
}

function semanticType(
  type: CandidType,
  aliases: Map<string, CandidType>,
): CandidType {
  const seen = new Set<string>();
  let current = type;
  while (current.kind === "named") {
    if (seen.has(current.name)) {
      throw new Error(`Recursive Candid type alias ${current.name}`);
    }
    seen.add(current.name);
    const resolved = aliases.get(current.name);
    if (!resolved) throw new Error(`Unknown Candid type ${current.name}`);
    current = resolved;
  }
  return current;
}

function resolveService(
  type: CandidType,
  aliases: Map<string, CandidType>,
): ServiceType {
  const resolved = semanticType(type, aliases);
  if (resolved.kind !== "service") {
    throw new Error("Compiled Candid does not expose a service");
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class CandidParser {
  readonly #tokens: string[];
  #offset = 0;

  constructor(source: string) {
    this.#tokens = tokenize(source);
  }

  parse(): ParsedCandid {
    const aliases = new Map<string, CandidType>();
    let actor: CandidType | null = null;
    while (!this.#eof()) {
      if (this.#consume("type")) {
        const name = this.#identifier("type name");
        this.#expect("=");
        const value = this.#type();
        this.#expect(";");
        if (aliases.has(name)) throw this.#error(`duplicate type ${name}`);
        aliases.set(name, value);
        continue;
      }
      if (this.#consume("service")) {
        this.#expect(":");
        if (this.#peek() === "(") {
          this.#typeList();
          this.#expect("->");
        }
        actor = this.#type();
        this.#consume(";");
        if (!this.#eof()) {
          throw this.#error("tokens after the service declaration");
        }
        break;
      }
      throw this.#error(`unexpected top-level token ${this.#peek()}`);
    }
    if (!actor) throw this.#error("missing service declaration");
    return { aliases, actor };
  }

  #type(): CandidType {
    const token = this.#take("type");
    if (token === "opt" || token === "vec") {
      return {
        kind: "unary",
        constructor: token,
        value: this.#type(),
      };
    }
    if (token === "record" || token === "variant") {
      return {
        kind: token,
        fields: this.#fields(token),
      };
    }
    if (token === "func") return this.#functionSignature();
    if (token === "service") return this.#service();
    if (PRIMITIVE_TYPES.has(token)) {
      return { kind: "primitive", name: token };
    }
    assertIdentifierToken(token, "Candid type");
    return { kind: "named", name: unquote(token) };
  }

  #fields(kind: "record" | "variant"): CandidField[] {
    this.#expect("{");
    const fields: CandidField[] = [];
    while (!this.#consume("}")) {
      const mark = this.#offset;
      const possibleLabel = this.#take(`${kind} field`);
      if (this.#consume(":")) {
        fields.push({
          label: unquote(possibleLabel),
          value: this.#type(),
        });
      } else if (
        kind === "variant" &&
        (this.#peek() === ";" || this.#peek() === "}")
      ) {
        fields.push({ label: unquote(possibleLabel), value: null });
      } else {
        this.#offset = mark;
        fields.push({ label: null, value: this.#type() });
      }
      if (!this.#consume(";") && this.#peek() !== "}") {
        throw this.#error(
          `expected ; or }, found ${this.#peek() ?? "EOF"}`,
        );
      }
    }
    return fields;
  }

  #functionSignature(): FunctionType {
    const inputs = this.#typeList();
    this.#expect("->");
    const outputs = this.#typeList();
    let mode: FunctionType["mode"] = "update";
    const annotation = this.#peek();
    if (
      annotation === "query" ||
      annotation === "oneway" ||
      annotation === "composite_query"
    ) {
      mode = annotation;
      this.#offset += 1;
    }
    return { kind: "func", inputs, outputs, mode };
  }

  #typeList(): CandidType[] {
    this.#expect("(");
    const types: CandidType[] = [];
    while (!this.#consume(")")) {
      if (isLabelToken(this.#peek()) && this.#peek(1) === ":") {
        this.#offset += 2;
      }
      types.push(this.#type());
      if (!this.#consume(",")) this.#expect(")");
      if (this.#tokens[this.#offset - 1] === ")") break;
    }
    return types;
  }

  #service(): ServiceType {
    this.#expect("{");
    const methods = new Map<string, FunctionType>();
    while (!this.#consume("}")) {
      const method = unquote(this.#take("service method"));
      this.#expect(":");
      const signature = this.#functionSignature();
      if (!this.#consume(";") && this.#peek() !== "}") {
        throw this.#error(
          `expected ; or }, found ${this.#peek() ?? "EOF"}`,
        );
      }
      if (methods.has(method)) throw this.#error(`duplicate method ${method}`);
      methods.set(method, signature);
    }
    return { kind: "service", methods };
  }

  #identifier(label: string): string {
    const token = this.#take(label);
    assertIdentifierToken(token, label);
    return unquote(token);
  }

  #peek(ahead = 0): string | undefined {
    return this.#tokens[this.#offset + ahead];
  }

  #take(label: string): string {
    const token = this.#tokens[this.#offset];
    if (token === undefined) throw this.#error(`missing ${label}`);
    this.#offset += 1;
    return token;
  }

  #consume(token: string): boolean {
    if (this.#peek() !== token) return false;
    this.#offset += 1;
    return true;
  }

  #expect(token: string): void {
    if (!this.#consume(token)) {
      throw this.#error(`expected ${token}, found ${this.#peek() ?? "EOF"}`);
    }
  }

  #eof(): boolean {
    return this.#offset === this.#tokens.length;
  }

  #error(detail: string): Error {
    return new Error(
      `Invalid compiled Candid near token ${this.#offset}: ${detail}`,
    );
  }
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    const char = source[offset]!;
    if (/\s/u.test(char)) {
      offset += 1;
      continue;
    }
    if (source.startsWith("//", offset)) {
      const end = source.indexOf("\n", offset + 2);
      offset = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("/*", offset)) {
      const end = source.indexOf("*/", offset + 2);
      if (end === -1) throw new Error("Invalid compiled Candid: open comment");
      offset = end + 2;
      continue;
    }
    if (source.startsWith("->", offset)) {
      tokens.push("->");
      offset += 2;
      continue;
    }
    if ('{}():;,='.includes(char)) {
      tokens.push(char);
      offset += 1;
      continue;
    }
    if (char === '"') {
      let end = offset + 1;
      let escaped = false;
      for (; end < source.length; end += 1) {
        const current = source[end]!;
        if (!escaped && current === '"') break;
        if (!escaped && current === "\\") {
          escaped = true;
        } else {
          escaped = false;
        }
      }
      if (end >= source.length) {
        throw new Error("Invalid compiled Candid: open quoted identifier");
      }
      tokens.push(source.slice(offset, end + 1));
      offset = end + 1;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*|^[0-9]+/u.exec(
      source.slice(offset),
    );
    if (!match) {
      throw new Error(
        `Invalid compiled Candid: unsupported character ${JSON.stringify(char)} at ${offset}`,
      );
    }
    tokens.push(match[0]);
    offset += match[0].length;
  }
  return tokens;
}

function isLabelToken(value: string | undefined): boolean {
  return (
    value !== undefined &&
    (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) ||
      /^[0-9]+$/u.test(value) ||
      (value.startsWith('"') && value.endsWith('"')))
  );
}

function assertIdentifierToken(value: string, label: string): void {
  if (!isLabelToken(value)) throw new Error(`Invalid ${label} ${value}`);
}

function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch (error) {
    throw new Error(`Invalid quoted Candid identifier ${value}`, {
      cause: error,
    });
  }
}
