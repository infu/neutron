import { HttpAgent } from "@dfinity/agent";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { AgentAssetCanister } from "./asset_canister.ts";
import { updateSourceOrigin } from "./http.ts";

const DEFAULT_IC_HOST = "https://icp-api.io";
const MAX_IDENTITY_FILE_BYTES = 1024;

export type ParsedArguments = {
  values: Map<string, string>;
  flags: Set<string>;
  positional: string[];
};

export function parseArguments(
  argv: readonly string[],
  options: {
    valueFlags?: readonly string[];
    booleanFlags?: readonly string[];
  } = {},
): ParsedArguments {
  const valueFlags = new Set(options.valueFlags ?? []);
  const booleanFlags = new Set(options.booleanFlags ?? []);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  let afterSeparator = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (afterSeparator || !argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    if (argument === "--") {
      afterSeparator = true;
      continue;
    }
    const equals = argument.indexOf("=");
    const key = argument.slice(2, equals < 0 ? undefined : equals);
    if (booleanFlags.has(key)) {
      if (equals >= 0) throw new Error(`--${key} does not accept a value`);
      if (flags.has(key)) throw new Error(`--${key} was provided more than once`);
      flags.add(key);
      continue;
    }
    if (!valueFlags.has(key)) throw new Error(`Unknown option --${key}`);
    if (values.has(key)) throw new Error(`--${key} was provided more than once`);
    const value = equals >= 0 ? argument.slice(equals + 1) : argv[++index];
    if (!value) throw new Error(`--${key} requires a value`);
    values.set(key, value);
  }
  return { values, flags, positional };
}

export const COMMON_VALUE_FLAGS = [
  "canister-id",
  "host",
  "identity-file",
  "source-origin",
] as const;

export async function createCliContext(
  parsed: ParsedArguments,
  options: { requireIdentity?: boolean } = {},
): Promise<{
  canisterId: string;
  origin: string;
  port: AgentAssetCanister;
}> {
  const canisterId =
    parsed.values.get("canister-id") ??
    process.env.UPDATE_SOURCE_CANISTER_ID?.trim();
  if (!canisterId) {
    throw new Error("--canister-id or UPDATE_SOURCE_CANISTER_ID is required");
  }

  const host = validateAgentHost(
    parsed.values.get("host") ??
      process.env.UPDATE_SOURCE_HOST?.trim() ??
      DEFAULT_IC_HOST,
  );

  const identityFile =
    parsed.values.get("identity-file") ??
    process.env.UPDATE_SOURCE_IDENTITY_FILE?.trim();
  if (options.requireIdentity && !identityFile) {
    throw new Error(
      "--identity-file or UPDATE_SOURCE_IDENTITY_FILE is required for this command",
    );
  }
  const identity = identityFile
    ? await readOperatorIdentity(identityFile)
    : undefined;
  const agent = await HttpAgent.create({
    host: host.toString(),
    ...(identity ? { identity } : {}),
  });

  const port = new AgentAssetCanister({ canisterId, agent });
  const configuredOrigin = parsed.values.get("source-origin");
  const origin = configuredOrigin
    ? validateSourceOrigin(configuredOrigin)
    : updateSourceOrigin({
        canisterId: port.canisterId,
      });
  return { canisterId: port.canisterId, origin, port };
}

export async function readOperatorIdentity(
  identityPath: string,
): Promise<Ed25519KeyIdentity> {
  let handle;
  try {
    handle = await open(
      identityPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (cause) {
    throw new Error(`Unable to open identity file '${identityPath}'`, { cause });
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new Error("Identity path must be one regular, non-linked file");
    }
    const owner = process.getuid?.();
    if (owner !== undefined && stats.uid !== owner) {
      throw new Error("Identity file must be owned by the current user");
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error("Identity file permissions must not grant group or other access");
    }
    if (stats.size < 1 || stats.size > MAX_IDENTITY_FILE_BYTES) {
      throw new Error("Identity file has an invalid size");
    }
    const bytes = await handle.readFile();
    let parsed: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      parsed = JSON.parse(text) as unknown;
    } catch (cause) {
      throw new Error("Identity file must contain valid UTF-8 JSON", { cause });
    }
    const canonical = validateIdentityJson(parsed);
    return Ed25519KeyIdentity.fromParsedJson(canonical);
  } finally {
    await handle.close();
  }
}

export function requireSinglePositional(
  parsed: ParsedArguments,
  label: string,
): string {
  if (parsed.positional.length !== 1) {
    throw new Error(`Expected exactly one ${label}`);
  }
  return parsed.positional[0]!;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function failCli(error: unknown): never {
  process.stderr.write(
    `Error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

function validateAgentHost(value: string): URL {
  let host: URL;
  try {
    host = new URL(value);
  } catch (cause) {
    throw new Error("Agent host must be an absolute HTTPS origin", { cause });
  }
  if (
    host.protocol !== "https:" ||
    host.username ||
    host.password ||
    (host.pathname !== "/" && host.pathname !== "") ||
    host.search ||
    host.hash
  ) {
    throw new Error("Agent host must be an uncredentialed HTTPS origin");
  }
  if (isLoopback(host)) {
    throw new Error("Update-source operator commands cannot target a local host");
  }
  return host;
}

function validateSourceOrigin(value: string): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch (cause) {
    throw new Error("--source-origin must be an absolute HTTPS origin", {
      cause,
    });
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    (origin.pathname !== "/" && origin.pathname !== "") ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("--source-origin must be an uncredentialed HTTPS origin");
  }
  if (isLoopback(origin)) {
    throw new Error("--source-origin cannot target a local host");
  }
  return origin.origin;
}

function isLoopback(value: URL): boolean {
  const hostname = value.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]"
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(
    hostname,
  );
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127;
}

function validateIdentityJson(value: unknown): [string, string] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string" ||
    !/^[0-9a-f]{88}$/u.test(value[0]) ||
    !/^[0-9a-f]{64}$/u.test(value[1])
  ) {
    throw new Error("Identity file has an invalid canonical Ed25519 shape");
  }
  const secret = new Uint8Array(Buffer.from(value[1], "hex"));
  if (secret.every((byte) => byte === 0)) {
    throw new Error("Identity secret must not be all zero");
  }
  const derived = Ed25519KeyIdentity.fromSecretKey(secret).toJSON();
  if (derived[0] !== value[0] || derived[1] !== value[1]) {
    throw new Error("Identity public and private keys do not match");
  }
  return [value[0], value[1]];
}
