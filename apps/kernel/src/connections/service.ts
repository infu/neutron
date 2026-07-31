import type { JsonObject, JsonValue } from "neutron-tools/protocol";
import { CONNECTIONS_MAX_PROVIDERS_PER_APP } from "neutron-tools/src/capabilities/catalog.js";
import {
  getRegisteredEndpoint,
  type RegisteredEndpoint,
} from "../frame_context.ts";
import { useAppsStore } from "../reducer/apps.ts";
import {
  normalizeConnectionSummary,
  requestConnectionConsent,
  requestDisconnectConsent,
} from "../reducer/connections.ts";
import { getConnectionProvider } from "./catalog.ts";
import { declaredCapability } from "../capabilities/plan.ts";
import { sameAppScope, type AppScope } from "../app_scope.ts";
import {
  currentAppScope,
  isFrontendAuthorityPending,
} from "../runtime_authority.ts";

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

export async function requestConnectionForEndpoint(
  payload: JsonValue,
  endpoint: RegisteredEndpoint,
  authorizeNew?: (request: {
    provider: string;
    scopes: string[];
  }) => Promise<void>,
): Promise<ConnectionSummary> {
  const binding = captureEndpointBinding(endpoint);
  const declaration = requireDeclaredConnection(endpoint, payload);
  const existing = await listOwnedConnections(
    endpoint.context.appId,
    declaration.provider,
    expectedInstallationUid(binding),
  );
  requireCurrentEndpoint(binding);
  const current = existing[0];
  if (current) return current;

  await authorizeNew?.({
    provider: declaration.provider,
    scopes: declaration.scopes,
  });
  requireCurrentEndpoint(binding);

  const actor = await getKernelActor();
  requireCurrentEndpoint(binding);
  const begin = await actor.kernel_connections_begin({
    app_id: endpoint.context.appId,
    provider: declaration.provider,
    callback_base: new URL(
      "/connections/callback.html",
      window.location.href
    ).toString(),
  });
  requireCurrentEndpoint(binding);
  if (!isRecord(begin)) throw new Error("Invalid connection response");
  assertExactResponseKeys(
    begin as JsonObject,
    ["flow_id", "provider", "authorization_url", "expires_at"],
    "connection response",
  );
  const flowId = requiredString(begin.flow_id, "flow id");
  if (requiredString(begin.provider, "provider") !== declaration.provider) {
    throw new Error("Connection provider mismatch");
  }
  requiredNat64(begin.expires_at, "connection expiry");
  const provider = getConnectionProvider(declaration.provider);
  if (!provider) throw new Error("Connection provider is unavailable");
  const authorizationUrl = requiredAuthorizationUrl(
    begin.authorization_url,
    provider.authorizationOrigin,
  );
  const app = useAppsStore.getState().list[endpoint.context.appId];
  if (!app || !provider) throw new Error("Connection declaration is unavailable");
  requireDeclaredConnection(endpoint, payload);

  const summary = await requestConnectionConsent(
    {
      kind: "connect",
      appId: endpoint.context.appId,
      appName: app.name,
      provider: declaration.provider,
      providerName: provider.name,
      scopes: declaration.scopes,
      flowId,
      authorizationUrl,
    },
    () => endpointBindingIsCurrent(binding),
  );
  requireCurrentEndpoint(binding);
  requireOwnedSummary(
    summary,
    binding.appId,
    declaration.provider,
    expectedInstallationUid(binding),
  );
  return summary;
}

export async function listConnectionsForEndpoint(
  payload: JsonValue,
  endpoint: RegisteredEndpoint
): Promise<ConnectionSummary[]> {
  const binding = captureEndpointBinding(endpoint);
  requireBackground(endpoint);
  const record = optionalObject(payload);
  assertExactKeys(record, ["provider"]);
  const provider =
    record.provider === undefined
      ? undefined
      : requiredString(record.provider, "provider");
  if (provider) requireProviderDeclaration(endpoint, provider);
  const connections = await listOwnedConnections(
    endpoint.context.appId,
    provider,
    expectedInstallationUid(binding),
  );
  requireCurrentEndpoint(binding);
  for (const connection of connections) {
    requireProviderDeclaration(endpoint, connection.provider);
  }
  return connections;
}

export async function acquireConnectionForEndpoint(
  payload: JsonValue,
  endpoint: RegisteredEndpoint
): Promise<SensitiveCredential> {
  const binding = captureEndpointBinding(endpoint);
  requireBackground(endpoint);
  const record = requiredObject(payload);
  assertExactKeys(record, ["provider"]);
  const provider = requiredString(record.provider, "provider");
  requireProviderDeclaration(endpoint, provider);
  const actor = await getKernelActor();
  requireCurrentEndpoint(binding);
  const raw = await actor.kernel_connections_acquire({
    app_id: endpoint.context.appId,
    provider,
  });
  requireCurrentEndpoint(binding);
  if (!isRecord(raw)) throw new Error("Invalid credential response");
  assertExactResponseKeys(
    raw as JsonObject,
    ["provider", "credential"],
    "credential response",
  );
  const returnedProvider = requiredString(raw.provider, "provider");
  if (returnedProvider !== provider) {
    throw new Error("Connection provider mismatch");
  }
  return {
    provider: returnedProvider,
    credential: requiredString(raw.credential, "credential"),
  };
}

export async function disconnectConnectionForEndpoint(
  payload: JsonValue,
  endpoint: RegisteredEndpoint,
  authorize?: (request: {
    provider: string;
  }) => Promise<boolean>,
): Promise<ConnectionSummary> {
  const binding = captureEndpointBinding(endpoint);
  requireBackground(endpoint);
  const record = requiredObject(payload);
  assertExactKeys(record, ["provider"]);
  const providerId = requiredString(record.provider, "provider");
  const declaration = requireProviderDeclaration(endpoint, providerId);
  const connections = await listOwnedConnections(
    endpoint.context.appId,
    providerId,
    expectedInstallationUid(binding),
  );
  requireCurrentEndpoint(binding);
  const connection = connections[0];
  if (!connection) throw new Error("Connection was not found");
  const provider = getConnectionProvider(declaration.provider);
  const app = useAppsStore.getState().list[endpoint.context.appId];
  if (!provider || !app) throw new Error("Connection declaration is unavailable");

  const preapproved =
    (await authorize?.({ provider: declaration.provider })) ?? false;
  if (!preapproved) {
    await requestDisconnectConsent({
      kind: "disconnect",
      appId: endpoint.context.appId,
      appName: app.name,
      provider: declaration.provider,
      providerName: provider.name,
    }, () => endpointBindingIsCurrent(binding));
  }
  requireCurrentEndpoint(binding);
  const actor = await getKernelActor();
  requireCurrentEndpoint(binding);
  const summary = normalizeConnectionSummary(
    await actor.kernel_connections_disconnect({
      app_id: endpoint.context.appId,
      provider: declaration.provider,
    })
  );
  requireCurrentEndpoint(binding);
  requireOwnedSummary(
    summary,
    binding.appId,
    declaration.provider,
    expectedInstallationUid(binding),
  );
  return summary;
}

type EndpointBinding = {
  endpointId: string;
  appId: string;
  source: Window;
  sessionId: string;
  appVersion: number | undefined;
  appGeneration: number | undefined;
  appScope: AppScope | undefined;
};

function captureEndpointBinding(endpoint: RegisteredEndpoint): EndpointBinding {
  requireBackground(endpoint);
  return {
    endpointId: endpoint.endpointId,
    appId: endpoint.context.appId,
    source: endpoint.source,
    sessionId: endpoint.sessionId!,
    appVersion: endpoint.appVersion,
    appGeneration: endpoint.appGeneration,
    appScope: endpoint.appScope,
  };
}

function endpointBindingIsCurrent(binding: EndpointBinding): boolean {
  if (isFrontendAuthorityPending()) return false;
  const endpoint = getRegisteredEndpoint(binding.endpointId);
  let authorityCurrent = false;
  try {
    authorityCurrent = endpoint?.isAuthorityCurrent?.() ?? true;
  } catch {
    authorityCurrent = false;
  }
  if (
    !endpoint ||
    !authorityCurrent ||
    endpoint.context.role !== "background" ||
    endpoint.context.appId !== binding.appId ||
    endpoint.source !== binding.source ||
    endpoint.sessionId !== binding.sessionId ||
    endpoint.appVersion !== binding.appVersion ||
    endpoint.appGeneration !== binding.appGeneration ||
    (binding.appScope !== undefined &&
      !sameAppScope(binding.appScope, endpoint.appScope))
  ) {
    return false;
  }
  const app = useAppsStore.getState().list[endpoint.context.appId];
  return (
    app !== undefined &&
    (binding.appScope === undefined ||
      sameAppScope(
        binding.appScope,
        currentAppScope(endpoint.context.appId),
      )) &&
    (binding.appVersion === undefined ||
      binding.appVersion === app.version) &&
    (binding.appGeneration === undefined ||
      binding.appGeneration ===
        (useAppsStore.getState().runtimeGenerations[endpoint.context.appId] ?? 0))
  );
}

function requireCurrentEndpoint(binding: EndpointBinding): void {
  if (!endpointBindingIsCurrent(binding)) {
    throw new Error("The requesting app endpoint is no longer active");
  }
}

async function listOwnedConnections(
  appId: string,
  provider?: string,
  installationUid?: string,
): Promise<ConnectionSummary[]> {
  const actor = await getKernelActor();
  const raw = await actor.kernel_connections_list({
    app_id: appId,
    provider: provider ?? null,
  });
  if (
    !Array.isArray(raw) ||
    raw.length > CONNECTIONS_MAX_PROVIDERS_PER_APP
  ) {
    throw new Error("Invalid connections response");
  }
  return raw.map((value) => {
    const summary = normalizeConnectionSummary(value);
    requireOwnedSummary(summary, appId, provider, installationUid);
    return summary;
  });
}

function expectedInstallationUid(binding: EndpointBinding): string | undefined {
  return (
    binding.appScope?.installationUid ??
    currentAppScope(binding.appId)?.installationUid
  );
}

function requireOwnedSummary(
  summary: ConnectionSummary,
  appId: string,
  provider?: string,
  installationUid?: string,
): void {
  if (
    summary.appId !== appId ||
    (provider !== undefined && summary.provider !== provider) ||
    (installationUid !== undefined &&
      summary.installationUid !== installationUid)
  ) {
    throw new Error("Connection response belongs to another app scope");
  }
}

function requireDeclaredConnection(
  endpoint: RegisteredEndpoint,
  payload: JsonValue
) {
  requireBackground(endpoint);
  const record = requiredObject(payload);
  assertExactKeys(record, ["provider"]);
  const provider = requiredString(record.provider, "provider");
  const declaration = requireProviderDeclaration(endpoint, provider);
  return declaration;
}

function requireProviderDeclaration(
  endpoint: RegisteredEndpoint,
  provider: string
) {
  const app = useAppsStore.getState().list[endpoint.context.appId];
  const declaration = declaredCapability(app, "connections")?.providers.find(
    (connection) => connection.provider === provider
  );
  if (!declaration) {
    throw new Error("Connection provider is not declared by this app");
  }
  return declaration;
}

function requireBackground(endpoint: RegisteredEndpoint): void {
  if (endpoint.context.role !== "background") {
    throw new Error("Connections are available only to an app background process");
  }
  if (!endpoint.port || !endpoint.sessionId) {
    throw new Error("App background process is not connected");
  }
}

function optionalObject(value: JsonValue): JsonObject {
  return value === null ? {} : requiredObject(value);
}

function requiredObject(value: JsonValue): JsonObject {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error("Invalid connection request");
  }
  return value as JsonObject;
}

function assertExactKeys(
  value: JsonObject,
  allowedKeys: readonly string[],
  label = "connection request",
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`Invalid ${label}`);
  }
}

function assertExactResponseKeys(
  value: JsonObject,
  expectedKeys: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedKeys);
  const keys = Object.keys(value);
  if (
    keys.length !== expected.size ||
    keys.some((key) => !expected.has(key))
  ) {
    throw new Error(`Invalid ${label}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requiredNat64(value: unknown, label: string): string {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "bigint" ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      ? String(value)
      : null;
  if (
    text === null ||
    !/^(?:0|[1-9][0-9]{0,19})$/u.test(text) ||
    BigInt(text) > 18_446_744_073_709_551_615n
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return text;
}

function requiredAuthorizationUrl(
  value: unknown,
  authorizationOrigin: string,
): string {
  const text = requiredString(value, "authorization URL");
  const url = new URL(text);
  if (
    url.protocol !== "https:" ||
    url.origin !== authorizationOrigin ||
    url.username ||
    url.password
  ) {
    throw new Error("Invalid provider authorization URL");
  }
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function getKernelActor() {
  return (await import("../reducer/auth.ts")).getNeutronCan();
}
