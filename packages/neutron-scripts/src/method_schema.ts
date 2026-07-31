import { IDL } from "@dfinity/candid";
import icblast from "icblast";
import fs from "fs/promises";
import path from "path";
import type {
  NeutronFunctionConfig,
  NeutronManifest,
} from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

type CandidModule = typeof IDL;
type CandidType = InstanceType<typeof IDL.Type>;
type CandidFunc = ReturnType<typeof IDL.Func>;
type JsonObject = { [key: string]: JsonValue };
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;
type MethodSchemaJson = JsonObject & {
  input: JsonObject;
  output: JsonObject;
};

export type AppMethodSchemaArtifact = {
  $schema: "https://neutron.app/schema/app-methods.v1.json";
  version: 1;
  app: {
    id: string;
    name: string;
    version: number;
  };
  methods: Record<
    string,
    MethodSchemaJson & {
      type: Exclude<NeutronFunctionConfig["type"], "internal">;
      allow?: NeutronFunctionConfig["allow"];
    }
  >;
};

type GeneratedAliases = Record<
  string,
  {
    input?: string;
    output?: string;
  }
>;

type PublicTypeAliases = Record<string, string>;

export function extractGeneratedAliases(source: string): GeneratedAliases {
  const aliases: GeneratedAliases = {};
  for (const [name, value] of Object.entries(extractPublicTypeAliases(source))) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)_(Input|Output)$/.exec(name);
    const method = match?.[1];
    const kind = match?.[2];
    if (!method || !kind) continue;
    aliases[method] ??= {};
    if (kind === "Input") aliases[method].input = value;
    if (kind === "Output") aliases[method].output = value;
  }
  return aliases;
}

export function generateAppMethodSchemaArtifact(
  manifest: NeutronManifest,
  source: string
): AppMethodSchemaArtifact {
  const aliases = extractGeneratedAliases(source);
  const publicTypes = extractPublicTypeAliases(source);
  const idlSpecs: MethodIdlSpec[] = [];
  const methods: AppMethodSchemaArtifact["methods"] = {};

  for (const [method, config] of Object.entries(manifest.func ?? {})) {
    if (config.type === "internal") continue;
    const alias = aliases[method];
    if (!alias?.input || !alias.output) {
      throw new Error(`Generated aliases not found for ${method}`);
    }

    idlSpecs.push({
      method,
      input: alias.input,
      output: alias.output,
      config,
      aliases: publicTypes,
    });
  }

  const schemaMap = icblast.explainServiceSchema(
    serviceIdlFactory(idlSpecs)
  ) as Record<string, MethodSchemaJson>;

  for (const spec of idlSpecs) {
    const schema = schemaMap[spec.method];
    if (!schema) throw new Error(`Generated schema not found for ${spec.method}`);

    methods[spec.method] = {
      ...schema,
      type: spec.config.type === "query" ? "query" : "update",
      ...(spec.config.allow ? { allow: spec.config.allow } : {}),
    };
  }

  return {
    $schema: "https://neutron.app/schema/app-methods.v1.json",
    version: 1,
    app: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
    },
    methods,
  };
}

export function validateAppMethodArgs(
  artifact: AppMethodSchemaArtifact,
  method: string,
  args: JsonValue[]
): { valid: boolean; errors: unknown[] } {
  const schema = artifact.methods[method];
  if (!schema) throw new Error(`Method schema not found for ${method}`);
  const validation = icblast.validateMethodInputSchema(schema, args);
  return {
    valid: validation.ok,
    errors: validation.ok ? [] : [validation.errors],
  };
}

type MethodIdlSpec = {
  method: string;
  input: string;
  output: string;
  config: NeutronFunctionConfig;
  aliases: PublicTypeAliases;
};

function serviceIdlFactory(specs: MethodIdlSpec[]) {
  return ({ IDL: candid }: { IDL: CandidModule }) => {
    const service: Record<string, CandidFunc> = {};
    for (const spec of specs) {
      service[spec.method] = methodIdl(candid, spec);
    }
    return candid.Service(service);
  };
}

function methodIdl(
  candid: CandidModule,
  {
    input,
    output,
    config,
    aliases,
  }: MethodIdlSpec): CandidFunc {
  return candid.Func(
    [motokoTypeToIdl(input, candid, aliases)],
    [motokoTypeToIdl(output, candid, aliases)],
    config.type === "query" ? ["query"] : []
  );
}

export function motokoTypeToIdl(
  typeSource: string,
  candid: CandidModule = IDL,
  aliases: PublicTypeAliases = {},
  resolving: Set<string> = new Set()
): CandidType {
  const type = typeSource.trim();
  const alias = aliases[type];
  if (alias !== undefined) {
    if (resolving.has(type)) throw new Error(`Cyclic Motoko type alias: ${type}`);
    const next = new Set(resolving);
    next.add(type);
    return motokoTypeToIdl(alias, candid, aliases, next);
  }
  if (type === "()") return candid.Null;
  if (type.startsWith("?")) {
    return candid.Opt(motokoTypeToIdl(type.slice(1), candid, aliases, resolving));
  }
  if (type.startsWith("[") && type.endsWith("]")) {
    return candid.Vec(
      motokoTypeToIdl(type.slice(1, -1), candid, aliases, resolving)
    );
  }
  if (isWrapped(type, "(", ")")) {
    const inner = type.slice(1, -1).trim();
    if (!inner) return candid.Null;
    const items = splitTopLevel(inner, ",").map((field) =>
      motokoTypeToIdl(stripFieldName(field), candid, aliases, resolving)
    );
    if (items.length === 1) return items[0]!;
    return candid.Tuple(...(items as [CandidType, CandidType, ...CandidType[]]));
  }
  if (isWrapped(type, "{", "}")) {
    const fields = splitTopLevel(type.slice(1, -1), ";").filter(Boolean);
    if (fields.length > 0 && fields.every((field) => field.startsWith("#"))) {
      const variant: Record<string, CandidType> = {};
      for (const field of fields) {
        const source = field.slice(1).trim();
        const separator = findTopLevelColon(source);
        const name = (separator < 0 ? source : source.slice(0, separator)).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw new Error(`Unsupported variant field name: ${name}`);
        }
        variant[motokoIdentifierToCandidLabel(name)] =
          separator < 0
            ? candid.Null
            : motokoTypeToIdl(
                source.slice(separator + 1).trim(),
                candid,
                aliases,
                resolving
              );
      }
      return candid.Variant(variant);
    }
    const record: Record<string, CandidType> = {};
    for (const field of fields) {
      const separator = findTopLevelColon(field);
      if (separator <= 0) {
        throw new Error(`Unsupported record field syntax: ${field}`);
      }
      const name = field.slice(0, separator).trim();
      const fieldType = field.slice(separator + 1).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Unsupported record field name: ${name}`);
      }
      record[motokoIdentifierToCandidLabel(name)] = motokoTypeToIdl(
        fieldType,
        candid,
        aliases,
        resolving
      );
    }
    return candid.Record(record);
  }

  switch (type) {
    case "Text":
      return candid.Text;
    case "Bool":
      return candid.Bool;
    case "Float":
      return candid.Float64;
    case "Principal":
      return candid.Principal;
    case "Int":
      return candid.Int;
    case "Int8":
      return candid.Int8;
    case "Int16":
      return candid.Int16;
    case "Int32":
      return candid.Int32;
    case "Int64":
      return candid.Int64;
    case "Nat":
      return candid.Nat;
    case "Nat8":
      return candid.Nat8;
    case "Nat16":
      return candid.Nat16;
    case "Nat32":
      return candid.Nat32;
    case "Nat64":
      return candid.Nat64;
    case "Blob":
      return candid.Vec(candid.Nat8);
    case "Null":
      return candid.Null;
    default:
      throw new Error(
        `Unsupported Motoko type in generated schema: ${type}. ` +
          "Use primitive, tuple, option, array, record, or variant types in public app method aliases."
      );
  }
}

// Motoko appends an underscore to escape Candid labels that collide with a
// Motoko keyword. It always removes one trailing underscore again when it
// emits Candid, so `shared_` is the wire label `shared` and `shared__` is the
// wire label `shared_`. Mirror that boundary mapping in generated schemas.
function motokoIdentifierToCandidLabel(value: string): string {
  return value.endsWith("_") ? value.slice(0, -1) : value;
}

export function extractPublicTypeAliases(source: string): PublicTypeAliases {
  const aliases: PublicTypeAliases = {};
  const pattern = /public\s+type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (!name || match.index === undefined) continue;
    const start = match.index + match[0].length;
    let depth = 0;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (char === "(" || char === "{" || char === "[") depth += 1;
      if (char === ")" || char === "}" || char === "]") depth -= 1;
      if (char === ";" && depth === 0) {
        end = index;
        break;
      }
    }
    if (end < start) throw new Error(`Unterminated public type alias ${name}`);
    aliases[name] = source.slice(start, end).trim();
  }
  return aliases;
}

function stripFieldName(field: string): string {
  const separator = findTopLevelColon(field);
  if (separator < 0) return field.trim();
  return field.slice(separator + 1).trim();
}

function findTopLevelColon(value: string): number {
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "(" || char === "{" || char === "[") depth++;
    if (char === ")" || char === "}" || char === "]") depth--;
    if (char === ":" && depth === 0) return index;
  }
  return -1;
}

function splitTopLevel(value: string, delimiter: "," | ";"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "(" || char === "{" || char === "[") depth++;
    if (char === ")" || char === "}" || char === "]") depth--;
    if (char === delimiter && depth === 0) {
      const part = value.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function isWrapped(value: string, open: string, close: string): boolean {
  if (!value.startsWith(open) || !value.endsWith(close)) return false;
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === open) depth++;
    if (char === close) depth--;
    if (depth === 0 && index < value.length - 1) return false;
  }
  return depth === 0;
}

export async function writeAppMethodSchema({
  rootDir = process.cwd(),
}: {
  rootDir?: string;
} = {}): Promise<AppMethodSchemaArtifact> {
  const manifestPath = path.join(rootDir, "neutron.json");
  const manifest = JSON.parse(
    await fs.readFile(manifestPath, "utf8")
  ) as NeutronManifest;
  const result = validate_neutron_conf(manifest);
  if (result.errors.length > 0) {
    throw new Error(
      `Invalid neutron.json: ${result.errors.map((x) => x.stack).join("; ")}`
    );
  }
  if (!manifest.src) throw new Error("neutron.json must include src");

  const source = await fs.readFile(
    path.join(rootDir, "backend", manifest.src),
    "utf8"
  );
  const artifact = generateAppMethodSchemaArtifact(manifest, source);
  const distDir = path.join(rootDir, "dist");
  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(
    path.join(distDir, "schema.json"),
    JSON.stringify(artifact, null, 2),
    "utf8"
  );
  return artifact;
}

if (import.meta.main) {
  await writeAppMethodSchema();
}
