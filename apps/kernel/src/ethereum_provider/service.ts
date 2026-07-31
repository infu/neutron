import {
  KernelPolicyError,
  assertBoundedJson,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "neutron-tools/protocol";
import {
  ETHEREUM_PROVIDER_METHODS,
  type NeutronEthereumProviderMethod,
} from "neutron-tools/src/schema.js";
import type { RegisteredEndpoint } from "../frame_context.ts";
import { useAppsStore } from "../reducer/apps.ts";
import { declaredCapability } from "../capabilities/plan.ts";

export type Eip1193Provider = {
  request(args: {
    method: string;
    params?: JsonValue[] | JsonObject;
  }): Promise<unknown>;
};

export type Eip1193ProviderDescriptor = {
  provider: Eip1193Provider;
  name: string;
  rdns: string | null;
};

type EthereumProviderSession = {
  id: string;
  endpointId: string;
  endpointSession: string;
  appId: string;
  installationUid: string;
  appVersion: number;
  appGeneration: number;
  ownerPrincipal: string;
  provider: Eip1193Provider;
  providerName: string;
  providerRdns: string | null;
  chains: Set<number>;
  methods: Set<NeutronEthereumProviderMethod>;
  capabilityFingerprint: string;
  accounts: Set<string>;
  expiresAt: number;
  requestCount: number;
  accountRequestCount: number;
  chainSwitchCount: number;
  transactionCount: number;
  inFlightCount: number;
};

type BeginOptions = {
  focused: boolean;
  userActivated: boolean;
  provider?: Eip1193ProviderDescriptor;
  now?: number;
  sessionId?: string;
  ownerAuthorized: boolean;
  ownerPrincipal: string;
};

type RequestOptions = {
  focused: boolean;
  now?: number;
  ownerAuthorized: boolean;
  ownerPrincipal: string;
};

const SESSION_TTL_MS = 20 * 60 * 1_000;
const MAX_SESSIONS = 32;
const MAX_REQUESTS_PER_SESSION = 512;
export const ETHEREUM_PROVIDER_MAX_IN_FLIGHT = 8;
const MAX_TRANSACTIONS_PER_SESSION = 4;
const MAX_RPC_RESULT_BYTES = 256 * 1024;
const MAX_CALL_DATA_HEX_LENGTH = 256 * 1024 + 2;
const knownMethods = new Set<string>(ETHEREUM_PROVIDER_METHODS);
const sessions = new Map<string, EthereumProviderSession>();
const sessionByEndpoint = new Map<string, string>();
const announcedProviders: Eip1193ProviderDescriptor[] = [];
let discoveryInstalled = false;

export async function beginEthereumProviderForEndpoint(
  payload: JsonValue,
  endpoint: RegisteredEndpoint,
  options: BeginOptions,
): Promise<JsonObject> {
  assertEmptyObject(payload, "Ethereum provider begin request");
  if (
    endpoint.context.role !== "tile" ||
    !endpoint.sessionId ||
    !endpoint.appScope ||
    !options.focused ||
    !options.userActivated
  ) {
    throw new KernelPolicyError(
      "USER_INTERACTION_REQUIRED",
      "Start the Ethereum wallet request from the focused tile",
    );
  }
  const app = useAppsStore.getState().list[endpoint.context.appId];
  const declaration = declaredCapability(app, "ethereum_provider");
  if (!options.ownerAuthorized) {
    throw new KernelPolicyError(
      "OWNER_REQUIRED",
      "Ethereum wallet access requires the authorized owner",
    );
  }
  if (!app || !declaration) {
    throw new KernelPolicyError(
      "OWNER_REQUIRED",
      "This app did not declare Ethereum wallet access",
    );
  }

  const now = options.now ?? Date.now();
  pruneSessions(now);
  const provider = options.provider ?? (await discoverEthereumProvider());
  if (!provider) {
    throw new Error("No EIP-6963 browser wallet is available");
  }
  const sessionId = options.sessionId ?? randomSessionId();
  if (!/^[a-f0-9]{32}$/.test(sessionId) || sessions.has(sessionId)) {
    throw new Error("Could not create an Ethereum provider session");
  }
  const previous = sessionByEndpoint.get(endpoint.endpointId);
  if (previous) deleteSession(previous);
  if (sessions.size >= MAX_SESSIONS) {
    throw new KernelPolicyError(
      "UI_BUSY",
      "Too many Ethereum wallet sessions are active",
    );
  }

  const session: EthereumProviderSession = {
    id: sessionId,
    endpointId: endpoint.endpointId,
    endpointSession: endpoint.sessionId,
    appId: endpoint.context.appId,
    installationUid: endpoint.appScope.installationUid,
    appVersion: app.version,
    appGeneration:
      endpoint.appGeneration ??
      (useAppsStore.getState().runtimeGenerations[endpoint.context.appId] ?? 0),
    ownerPrincipal: options.ownerPrincipal,
    provider: provider.provider,
    providerName: provider.name,
    providerRdns: provider.rdns,
    chains: new Set(declaration.chains),
    methods: new Set(declaration.methods),
    capabilityFingerprint: app.capability_plan_fingerprint,
    accounts: new Set(),
    expiresAt: now + SESSION_TTL_MS,
    requestCount: 0,
    accountRequestCount: 0,
    chainSwitchCount: 0,
    transactionCount: 0,
    inFlightCount: 0,
  };
  sessions.set(sessionId, session);
  sessionByEndpoint.set(endpoint.endpointId, sessionId);
  return {
    sessionId,
    provider: {
      name: session.providerName,
      rdns: session.providerRdns,
    },
  };
}

export async function requestEthereumProviderForEndpoint(
  payload: JsonValue,
  endpoint: RegisteredEndpoint,
  options: RequestOptions,
): Promise<JsonValue> {
  const request = assertProviderRequest(payload);
  const now = options.now ?? Date.now();
  const session = requireSession(request.sessionId, endpoint, now, options);
  const method = request.method as NeutronEthereumProviderMethod;
  if (!knownMethods.has(method) || !session.methods.has(method)) {
    throw new KernelPolicyError(
      "OWNER_REQUIRED",
      `Ethereum wallet method '${request.method}' is not declared by this app`,
    );
  }
  if (isInteractiveMethod(method) && !options.focused) {
    throw new KernelPolicyError(
      "USER_INTERACTION_REQUIRED",
      "Keep the requesting tile focused for Ethereum wallet prompts",
    );
  }
  const params = validateMethodParams(method, request.params, session);
  const release = reserveRequest(session);
  try {
    admitRequest(session, method);
    if (method === "eth_sendTransaction") {
      await requireAllowedCurrentChain(session);
    }
    const result = await session.provider.request({
      method,
      ...(params === undefined ? {} : { params }),
    });
    return validateMethodResult(method, result, session);
  } finally {
    release();
  }
}

export function endEthereumProviderForEndpoint(
  payload: JsonValue,
  endpoint: RegisteredEndpoint,
): null {
  const sessionId = assertSessionPayload(payload);
  const session = sessions.get(sessionId);
  if (
    !session ||
    session.endpointId !== endpoint.endpointId ||
    session.endpointSession !== endpoint.sessionId
  ) {
    throw new Error("Ethereum provider session is unavailable");
  }
  deleteSession(sessionId);
  return null;
}

export function reconcileEthereumProviderSessions(
  resolveSession: (endpointId: string) => string | undefined,
): void {
  for (const session of sessions.values()) {
    if (resolveSession(session.endpointId) !== session.endpointSession) {
      deleteSession(session.id);
    }
  }
}

export function resetEthereumProviderSessionsForTests(): void {
  sessions.clear();
  sessionByEndpoint.clear();
  announcedProviders.length = 0;
  discoveryInstalled = false;
}

function assertProviderRequest(payload: JsonValue): {
  sessionId: string;
  method: string;
  params?: JsonValue[] | JsonObject;
} {
  if (
    !isJsonObject(payload) ||
    Object.keys(payload).some(
      (key) => key !== "sessionId" && key !== "method" && key !== "params",
    ) ||
    typeof payload.sessionId !== "string" ||
    !/^[a-f0-9]{32}$/.test(payload.sessionId) ||
    typeof payload.method !== "string" ||
    payload.method.length < 1 ||
    payload.method.length > 80 ||
    (payload.params !== undefined &&
      !Array.isArray(payload.params) &&
      !isJsonObject(payload.params))
  ) {
    throw new Error("Invalid Ethereum provider request");
  }
  if (payload.params !== undefined) {
    assertBoundedJson(payload.params, "Ethereum provider parameters");
  }
  return {
    sessionId: payload.sessionId,
    method: payload.method,
    ...(payload.params === undefined
      ? {}
      : { params: payload.params as JsonValue[] | JsonObject }),
  };
}

function assertSessionPayload(payload: JsonValue): string {
  if (
    !isJsonObject(payload) ||
    Object.keys(payload).length !== 1 ||
    typeof payload.sessionId !== "string" ||
    !/^[a-f0-9]{32}$/.test(payload.sessionId)
  ) {
    throw new Error("Invalid Ethereum provider session request");
  }
  return payload.sessionId;
}

function requireSession(
  sessionId: string,
  endpoint: RegisteredEndpoint,
  now: number,
  owner: Pick<RequestOptions, "ownerAuthorized" | "ownerPrincipal">,
): EthereumProviderSession {
  const session = sessions.get(sessionId);
  const app = useAppsStore.getState().list[endpoint.context.appId];
  if (
    !session ||
    now >= session.expiresAt ||
    session.endpointId !== endpoint.endpointId ||
    session.endpointSession !== endpoint.sessionId ||
    session.appId !== endpoint.context.appId ||
    session.installationUid !== endpoint.appScope?.installationUid ||
    session.appVersion !== (app?.version ?? -1) ||
    session.appGeneration !==
      (useAppsStore.getState().runtimeGenerations[endpoint.context.appId] ?? 0) ||
    session.capabilityFingerprint !== app?.capability_plan_fingerprint ||
    !owner.ownerAuthorized ||
    session.ownerPrincipal !== owner.ownerPrincipal
  ) {
    if (session) deleteSession(session.id);
    throw new Error("Ethereum provider session expired or was revoked");
  }
  return session;
}

function admitRequest(
  session: EthereumProviderSession,
  method: NeutronEthereumProviderMethod,
): void {
  if (session.requestCount >= MAX_REQUESTS_PER_SESSION) {
    throw new KernelPolicyError(
      "REQUEST_EXPIRED",
      "Ethereum wallet session budget is exhausted; start a new session",
    );
  }
  if (method === "eth_requestAccounts") {
    if (session.accountRequestCount >= 1) {
      throw new KernelPolicyError(
        "REQUEST_EXPIRED",
        "Ethereum account access was already requested; start a new session to ask again",
      );
    }
    session.accountRequestCount += 1;
  }
  if (method === "wallet_switchEthereumChain") {
    if (session.chainSwitchCount >= 1) {
      throw new KernelPolicyError(
        "REQUEST_EXPIRED",
        "Ethereum network switching was already requested; start a new session to ask again",
      );
    }
    session.chainSwitchCount += 1;
  }
  if (method === "eth_sendTransaction") {
    if (session.transactionCount >= MAX_TRANSACTIONS_PER_SESSION) {
      throw new KernelPolicyError(
        "REQUEST_EXPIRED",
        "Ethereum transaction consent budget is exhausted; start a new session",
      );
    }
    session.transactionCount += 1;
  }
  session.requestCount += 1;
}

function reserveRequest(session: EthereumProviderSession): () => void {
  if (session.inFlightCount >= ETHEREUM_PROVIDER_MAX_IN_FLIGHT) {
    throw new KernelPolicyError(
      "UI_BUSY",
      "Ethereum wallet session has too many requests in flight",
    );
  }
  session.inFlightCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    session.inFlightCount = Math.max(0, session.inFlightCount - 1);
  };
}

function validateMethodParams(
  method: NeutronEthereumProviderMethod,
  params: JsonValue[] | JsonObject | undefined,
  session: EthereumProviderSession,
): JsonValue[] | undefined {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts":
    case "eth_chainId":
      assertNoParams(params, method);
      return undefined;
    case "wallet_switchEthereumChain": {
      const values = exactParams(params, 1, method);
      const target = values[0];
      if (
        !isJsonObject(target) ||
        Object.keys(target).length !== 1 ||
        typeof target.chainId !== "string"
      ) {
        throw new Error("Invalid wallet_switchEthereumChain parameters");
      }
      const chain = parseChainId(target.chainId);
      if (!session.chains.has(chain)) {
        throw new KernelPolicyError(
          "OWNER_REQUIRED",
          "The requested Ethereum chain is not declared by this app",
        );
      }
      return values;
    }
    case "eth_getCode": {
      const values = exactParams(params, 2, method);
      assertAddress(values[0], "Ethereum contract");
      assertLatestBlock(values[1]);
      return values;
    }
    case "eth_call": {
      const values = exactParams(params, 2, method);
      validateTransaction(values[0]!, false, session);
      assertLatestBlock(values[1]);
      return values;
    }
    case "eth_sendTransaction": {
      const values = exactParams(params, 1, method);
      validateTransaction(values[0]!, true, session);
      return values;
    }
    case "eth_getTransactionReceipt": {
      const values = exactParams(params, 1, method);
      assertHash(values[0], "Ethereum transaction hash");
      return values;
    }
  }
}

function validateMethodResult(
  method: NeutronEthereumProviderMethod,
  raw: unknown,
  session: EthereumProviderSession,
): JsonValue {
  const result =
    raw === undefined && method === "wallet_switchEthereumChain" ? null : raw;
  assertBoundedJson(result, "Ethereum provider result", MAX_RPC_RESULT_BYTES);
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts": {
      if (!Array.isArray(result) || result.length > 16) {
        throw new Error("Ethereum provider returned invalid accounts");
      }
      const accounts = result.map((value) =>
        assertAddress(value, "Ethereum account"),
      );
      if (method === "eth_requestAccounts") {
        session.accounts = new Set(accounts.map((account) => account.toLowerCase()));
      }
      return accounts;
    }
    case "eth_chainId":
      parseChainId(result);
      return result;
    case "wallet_switchEthereumChain":
      if (result !== null) {
        throw new Error("Ethereum provider returned an invalid switch result");
      }
      return null;
    case "eth_call":
    case "eth_getCode":
      assertHexData(result, "Ethereum RPC data");
      return result;
    case "eth_sendTransaction":
      assertHash(result, "Ethereum transaction hash");
      return result;
    case "eth_getTransactionReceipt":
      if (result !== null && !isJsonObject(result)) {
        throw new Error("Ethereum provider returned an invalid receipt");
      }
      return result;
  }
}

async function requireAllowedCurrentChain(
  session: EthereumProviderSession,
): Promise<void> {
  const raw = await session.provider.request({ method: "eth_chainId" });
  const chain = parseChainId(raw);
  if (!session.chains.has(chain)) {
    throw new KernelPolicyError(
      "OWNER_REQUIRED",
      "The browser wallet is connected to an Ethereum chain not declared by this app",
    );
  }
}

function validateTransaction(
  value: JsonValue,
  send: boolean,
  session: EthereumProviderSession,
): void {
  if (!isJsonObject(value)) {
    throw new Error("Invalid Ethereum transaction");
  }
  const allowed = new Set(["from", "to", "data", "value"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Unsupported Ethereum transaction field");
  }
  const to = assertAddress(value.to, "Ethereum transaction recipient");
  if (!to) throw new Error("Ethereum transaction recipient is required");
  assertHexData(value.data, "Ethereum transaction data");
  if (typeof value.data === "string" && value.data.length > MAX_CALL_DATA_HEX_LENGTH) {
    throw new Error("Ethereum transaction data is too large");
  }
  if (value.value !== undefined) {
    parseQuantity(value.value, "Ethereum transaction value");
  }
  if (value.from !== undefined) {
    const from = assertAddress(value.from, "Ethereum transaction sender");
    if (!session.accounts.has(from.toLowerCase())) {
      throw new KernelPolicyError(
        "OWNER_REQUIRED",
        "Ethereum transaction sender was not connected in this session",
      );
    }
  } else if (send) {
    throw new Error("Ethereum transaction sender is required");
  }
}

function assertNoParams(
  params: JsonValue[] | JsonObject | undefined,
  method: string,
): void {
  if (params !== undefined && (!Array.isArray(params) || params.length !== 0)) {
    throw new Error(`Invalid ${method} parameters`);
  }
}

function exactParams(
  params: JsonValue[] | JsonObject | undefined,
  length: number,
  method: string,
): JsonValue[] {
  if (!Array.isArray(params) || params.length !== length) {
    throw new Error(`Invalid ${method} parameters`);
  }
  return params;
}

function assertAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function assertHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function assertHexData(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_CALL_DATA_HEX_LENGTH ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function parseQuantity(value: unknown, label: string): bigint {
  if (
    typeof value !== "string" ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) ||
    value.length > 66
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return BigInt(value);
}

function parseChainId(value: unknown): number {
  const parsed = Number(parseQuantity(value, "Ethereum chain id"));
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Invalid Ethereum chain id");
  }
  return parsed;
}

function assertLatestBlock(value: unknown): void {
  if (value !== "latest") throw new Error("Only the latest Ethereum block is allowed");
}

function isInteractiveMethod(method: NeutronEthereumProviderMethod): boolean {
  return (
    method === "eth_requestAccounts" ||
    method === "wallet_switchEthereumChain" ||
    method === "eth_sendTransaction"
  );
}

function assertEmptyObject(value: JsonValue, label: string): void {
  if (!isJsonObject(value) || Object.keys(value).length !== 0) {
    throw new Error(`Invalid ${label}`);
  }
}

function deleteSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  if (sessionByEndpoint.get(session.endpointId) === sessionId) {
    sessionByEndpoint.delete(session.endpointId);
  }
}

function pruneSessions(now: number): void {
  for (const session of sessions.values()) {
    if (now >= session.expiresAt) deleteSession(session.id);
  }
}

function randomSessionId(): string {
  if (
    typeof crypto === "undefined" ||
    typeof crypto.getRandomValues !== "function"
  ) {
    throw new Error("Secure randomness is unavailable");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function discoverEthereumProvider(): Promise<Eip1193ProviderDescriptor | null> {
  installProviderDiscovery();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (announcedProviders.length === 0) return null;
  if (announcedProviders.length === 1) return announcedProviders[0]!;
  return chooseAnnouncedProvider(announcedProviders);
}

function installProviderDiscovery(): void {
  if (discoveryInstalled || typeof window === "undefined") return;
  discoveryInstalled = true;
  window.addEventListener("eip6963:announceProvider", (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isJsonObject(detail) || !isProvider(detail.provider)) return;
    if (announcedProviders.some((entry) => entry.provider === detail.provider)) {
      return;
    }
    const info = isJsonObject(detail.info) ? detail.info : {};
    const name = safeProviderMetadata(info.name, "Browser wallet");
    const rdns = safeProviderMetadata(info.rdns, null);
    if (announcedProviders.length >= 16) announcedProviders.shift();
    announcedProviders.push({ provider: detail.provider, name, rdns });
  });
}

function isProvider(value: unknown): value is Eip1193Provider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { request?: unknown }).request === "function"
  );
}

function chooseAnnouncedProvider(
  providers: readonly Eip1193ProviderDescriptor[],
): Eip1193ProviderDescriptor {
  if (typeof window === "undefined" || typeof window.prompt !== "function") {
    throw new KernelPolicyError(
      "USER_INTERACTION_REQUIRED",
      "Choose a browser wallet before starting this session",
    );
  }
  const choices = providers
    .map(
      ({ name, rdns }, index) =>
        `${index + 1}. ${name}${rdns === null ? "" : ` (${rdns})`}`,
    )
    .join("\n");
  const selected = window.prompt(
    `Choose the browser wallet for this session:\n\n${choices}`,
    "1",
  );
  if (selected === null || !/^[1-9][0-9]*$/.test(selected.trim())) {
    throw new KernelPolicyError(
      "USER_INTERACTION_REQUIRED",
      "Browser wallet selection was cancelled",
    );
  }
  const provider = providers[Number(selected.trim()) - 1];
  if (!provider) {
    throw new KernelPolicyError(
      "USER_INTERACTION_REQUIRED",
      "Choose one of the listed browser wallets",
    );
  }
  return provider;
}

function safeProviderMetadata<T extends string | null>(
  value: unknown,
  fallback: T,
): string | T {
  return typeof value === "string" && /^[^\u0000-\u001f\u007f]{1,80}$/u.test(value)
    ? value
    : fallback;
}
