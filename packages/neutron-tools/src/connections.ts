import {
  exec,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "./app.ts";
import { isValidAppId } from "./app_ids.ts";
import { CONNECTIONS_MAX_PROVIDERS_PER_APP } from "./capabilities/catalog.ts";

export type ConnectionRequest = JsonObject & {
  provider: string;
};

export type ConnectionSummary = JsonObject & {
  appId: string;
  installationUid: string;
  provider: string;
  createdAt: string;
};

export type SensitiveCredential = JsonObject & {
  provider: string;
  credential: string;
};

export type ConnectionCallOptions = {
  timeout?: number;
};

const CONNECTION_DIALOG_TIMEOUT_SECONDS = 15 * 60;

export async function requestConnection(
  request: ConnectionRequest,
  options: ConnectionCallOptions = {}
): Promise<ConnectionSummary> {
  validateRequest(request);
  const summary = parseSummary(
    await exec(
      "connections.request",
      request,
      options.timeout ?? CONNECTION_DIALOG_TIMEOUT_SECONDS
    )
  );
  requireProviderMatch(summary.provider, request.provider);
  return summary;
}

export async function listConnections(
  provider?: string,
  options: ConnectionCallOptions = {}
): Promise<ConnectionSummary[]> {
  if (provider !== undefined) validateProvider(provider);
  const result = await exec(
    "connections.list",
    provider ? { provider } : {},
    options.timeout ?? 30
  );
  if (
    !Array.isArray(result) ||
    result.length > CONNECTIONS_MAX_PROVIDERS_PER_APP
  ) {
    throw new Error("Invalid connections response");
  }
  const summaries = result.map(parseSummary);
  if (provider !== undefined) {
    for (const summary of summaries) {
      requireProviderMatch(summary.provider, provider);
    }
  }
  return summaries;
}

export async function acquireConnectionCredential(
  provider: string,
  options: ConnectionCallOptions = {}
): Promise<SensitiveCredential> {
  validateProvider(provider);
  const result = await exec(
    "connections.acquire",
    { provider },
    options.timeout ?? 30
  );
  if (
    !isJsonObject(result) ||
    !hasExactKeys(result, ["provider", "credential"]) ||
    typeof result.provider !== "string" ||
    result.provider !== provider ||
    typeof result.credential !== "string" ||
    result.credential.length < 1 ||
    result.credential.length > 4_096
  ) {
    throw new Error("Invalid credential response");
  }
  return result as SensitiveCredential;
}

export async function disconnectConnection(
  provider: string,
  options: ConnectionCallOptions = {}
): Promise<ConnectionSummary> {
  validateProvider(provider);
  const summary = parseSummary(
    await exec(
      "connections.disconnect",
      { provider },
      options.timeout ?? CONNECTION_DIALOG_TIMEOUT_SECONDS
    )
  );
  requireProviderMatch(summary.provider, provider);
  return summary;
}

function validateRequest(request: ConnectionRequest): void {
  if (!isJsonObject(request)) throw new Error("Invalid connection request");
  validateProvider(request.provider);
  if (Object.keys(request).some((key) => key !== "provider")) {
    throw new Error("Invalid connection request");
  }
}

function validateProvider(provider: string): void {
  if (!isValidProvider(provider)) {
    throw new Error("Invalid connection provider");
  }
}

function parseSummary(value: JsonValue): ConnectionSummary {
  if (
    !isJsonObject(value) ||
    !hasExactKeys(value, [
      "appId",
      "installationUid",
      "provider",
      "createdAt",
    ]) ||
    typeof value.appId !== "string" ||
    !isValidAppId(value.appId) ||
    typeof value.installationUid !== "string" ||
    !isPositiveNat64(value.installationUid) ||
    typeof value.provider !== "string" ||
    !isValidProvider(value.provider) ||
    typeof value.createdAt !== "string" ||
    !isNat64(value.createdAt)
  ) {
    throw new Error("Invalid connection summary");
  }
  return value as ConnectionSummary;
}

function requireProviderMatch(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("Connection provider mismatch");
}

function isValidProvider(provider: string): boolean {
  return /^[a-z][a-z0-9_]{1,31}$/.test(provider);
}

function isNat64(value: string): boolean {
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(value)) return false;
  return BigInt(value) <= 18_446_744_073_709_551_615n;
}

function isPositiveNat64(value: string): boolean {
  return value !== "0" && isNat64(value);
}

function hasExactKeys(
  value: JsonObject,
  expectedKeys: readonly string[],
): boolean {
  const expected = new Set(expectedKeys);
  const keys = Object.keys(value);
  return (
    keys.length === expected.size && keys.every((key) => expected.has(key))
  );
}
