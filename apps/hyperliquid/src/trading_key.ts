import { ApproveAgentTypes } from "@nktkas/hyperliquid/api/exchange";
import { signUserSignedAction, type AbstractWallet, type AbstractViemJsonRpcAccount } from "@nktkas/hyperliquid/signing";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { nextTradingMasterNonce, withTradingLock } from "./trading_store";

/** This binding is supplied by the resident service, never by an Agent tool. */
export interface TradingSessionBinding {
  walletAddress: string;
  installationId: string;
  environment: "mainnet" | "testnet";
}

type SessionState = "missing" | "unapproved" | "approval_pending" | "active" | "revocation_pending" | "revoked" | "expired" | "unknown";
type OperationState = "prepared" | "signed" | "submitted" | "confirmed" | "rejected" | "unknown";
type OperationKind = "approve" | "revoke";
type Hex = `0x${string}`;

export interface TradingSessionStatus {
  state: SessionState;
  walletAddress: string;
  agentAddress: string | null;
  agentName: string | null;
  createdAt: number | null;
  expiresAt: number | null;
  checkedAt: number | null;
  deviceLocal: true;
  approvalEffect: string;
  recoveryNotice?: string;
  error: string | null;
  operation: { requestId: string; kind: OperationKind; state: OperationState; error: string | null; supersedesRequestId?: string } | null;
}

export interface MasterTypedDataRequest {
  requestId: string;
  chainId: 42161;
  address: string;
  typedData: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Hex };
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  };
}

export type MasterTypedDataSigner = (request: MasterTypedDataRequest) => Promise<Hex>;

/** Only use for durable Wallet rejection/cancellation evidence with no signature. */
export class DefinitiveMasterSigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefinitiveMasterSigningError";
  }
}

function definitiveSigningFailure(error: unknown): DefinitiveMasterSigningError | undefined {
  // The SDK wraps failures in AbstractWalletError and preserves their cause.
  const visited = new Set<unknown>();
  let candidate = error;
  while (candidate instanceof Error && !visited.has(candidate)) {
    if (candidate instanceof DefinitiveMasterSigningError) return candidate;
    visited.add(candidate);
    candidate = candidate.cause;
  }
  return undefined;
}

export interface TradingSessionOptions {
  signal?: AbortSignal;
  /** An explicit recovery action may retransmit the exact retained envelope. */
  rebroadcast?: boolean;
}

interface ApprovalAction {
  type: "approveAgent";
  signatureChainId: "0xa4b1";
  hyperliquidChain: "Mainnet" | "Testnet";
  agentAddress: Hex;
  agentName: string;
  nonce: number;
  [key: string]: unknown;
}

interface SessionOperation {
  requestId: string;
  generation: string;
  kind: OperationKind;
  state: OperationState;
  action: ApprovalAction;
  /** Immutable JSON bytes retained before the first exchange request. */
  envelope: string | null;
  error: string | null;
  /** A zero-address action must be acknowledged before absence confirms it. */
  acknowledged?: boolean;
  previousSessionState?: SessionRecord["state"];
  supersedesRequestId?: string;
}

interface SessionRecord {
  version: 1;
  revision: number;
  binding: string;
  generation: string;
  walletAddress: string;
  agentAddress: Hex;
  agentName: string;
  createdAt: number;
  expiresAt: number | null;
  checkedAt: number | null;
  state: Exclude<SessionState, "missing" | "unknown">;
  /** IndexedDB structured-clones this nonextractable WebCrypto key. */
  encryptionKey: CryptoKey;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  operation: SessionOperation | null;
  lastNonce: number;
}

interface RegisteredAgent { address: string; name: string; validUntil: number | null }

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// One app slot per master account. A new browser replaces the prior device's
// authorization instead of accumulating orphaned keys after profile loss.
const AGENT_NAME = "Neutron HL";
const DATABASE_NAME = "neutron-hyperliquid-trading-keys-v1";
const STORE_NAME = "records";
let databasePromise: Promise<IDBDatabase> | undefined;

function bindingKey(input: TradingSessionBinding): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.walletAddress) || input.walletAddress.toLowerCase() === ZERO_ADDRESS) {
    throw new Error("A valid EVM Wallet account is required for a trading session.");
  }
  if (!input.installationId || !["mainnet", "testnet"].includes(input.environment)) {
    throw new Error("Trading session installation and environment are required.");
  }
  return JSON.stringify([input.installationId, input.environment, input.walletAddress.toLowerCase()]);
}

function endpoint(binding: TradingSessionBinding): string {
  return binding.environment === "mainnet" ? "https://api.hyperliquid.xyz" : "https://api.hyperliquid-testnet.xyz";
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onerror = () => reject(request.error ?? new Error("Trading key storage could not be opened."));
    request.onblocked = () => reject(new Error("Close other Hyperliquid windows to open trading key storage."));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); databasePromise = undefined; };
      resolve(database);
    };
  });
  void databasePromise.catch(() => { databasePromise = undefined; });
  return databasePromise;
}

async function read<T>(key: string): Promise<T | undefined> {
  const database = await openDatabase();
  return await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    let result: T | undefined;
    request.onsuccess = () => { result = request.result as T | undefined; };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("Trading key storage read failed."));
  });
}

function sessionRecord(key: string): Promise<SessionRecord | undefined> { return read(`session:${key}`); }

/** Compare-and-swap also protects browsers without the Web Locks API. */
async function save(record: SessionRecord, expectedRevision: number | null): Promise<SessionRecord> {
  const database = await openDatabase();
  const next = { ...record, revision: (expectedRevision ?? 0) + 1 };
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(`session:${record.binding}`);
    let conflict: Error | undefined;
    request.onsuccess = () => {
      const previous = request.result as SessionRecord | undefined;
      if ((previous?.revision ?? null) !== expectedRevision) {
        conflict = new Error("Trading session changed in another window. Refresh before continuing.");
        transaction.abort();
        return;
      }
      if (previous && previous.generation !== next.generation) {
        store.put(previous, `retired:${record.binding}:${previous.generation}`);
      }
      store.put(next, `session:${record.binding}`);
      if (next.operation) store.put(next.operation, `operation:${record.binding}:${next.operation.requestId}`);
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(conflict ?? transaction.error ?? new Error("Trading key storage write failed."));
  });
  return next;
}

function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> { return withTradingLock(`session:${key}`, operation); }

function status(binding: TradingSessionBinding, record?: SessionRecord, error: string | null = null): TradingSessionStatus {
  return {
    state: error ? "unknown" : record?.state ?? "missing",
    walletAddress: binding.walletAddress.toLowerCase(),
    agentAddress: record?.agentAddress ?? null,
    agentName: record?.agentName ?? null,
    createdAt: record?.createdAt ?? null,
    expiresAt: record?.expiresAt ?? null,
    checkedAt: record?.checkedAt ?? null,
    deviceLocal: true,
    approvalEffect: "Approving this browser replaces the Neutron HL trading key on other devices. The key can trade and lose the account's collateral. It stays in this browser and cannot withdraw funds.",
    ...(record?.operation?.supersedesRequestId ? {
      recoveryNotice: "An earlier signed request remains in history and may still arrive while valid. Confirmed revocation retires this browser key; the next approval uses a fresh key.",
    } : {}),
    error,
    operation: record?.operation ? {
      requestId: record.operation.requestId,
      kind: record.operation.kind,
      state: record.operation.state,
      error: record.operation.error,
      ...(record.operation.supersedesRequestId ? { supersedesRequestId: record.operation.supersedesRequestId } : {}),
    } : null,
  };
}

function message(error: unknown): string { return error instanceof Error ? error.message : "Hyperliquid request failed."; }

async function registeredAgents(binding: TradingSessionBinding, signal?: AbortSignal): Promise<RegisteredAgent[]> {
  const response = await fetch(`${endpoint(binding)}/info`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "extraAgents", user: binding.walletAddress.toLowerCase() }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid trading session verification failed (${response.status}).`);
  const value: unknown = await response.json();
  if (!Array.isArray(value) || !value.every((agent) => agent && typeof agent === "object" &&
    /^0x[0-9a-fA-F]{40}$/.test(agent.address) && typeof agent.name === "string" &&
    (agent.validUntil === null || (Number.isSafeInteger(agent.validUntil) && agent.validUntil >= 0)))) {
    throw new Error("Hyperliquid returned an invalid trading session response.");
  }
  return value as RegisteredAgent[];
}

async function reconcile(binding: TradingSessionBinding, record: SessionRecord, signal?: AbortSignal): Promise<SessionRecord> {
  // A retired signer is never revived, even if somebody registers its address again.
  if (record.state === "revoked" || record.state === "expired") return record;
  const agents = await registeredAgents(binding, signal);
  const agent = agents.find((candidate) => candidate.address.toLowerCase() === record.agentAddress && candidate.name === record.agentName);
  const now = Date.now();
  let state: SessionRecord["state"] = record.state;
  let operation = record.operation ? { ...record.operation } : null;
  if (agent && (agent.validUntil === null || agent.validUntil > now)) {
    if (state !== "revocation_pending") {
      state = "active";
      if (operation?.kind === "approve") operation = { ...operation, state: "confirmed", error: null };
    }
  } else if (state === "revocation_pending") {
    // An earlier approval may still be unresolved. Absence alone, especially
    // before Wallet signs zero, does not establish that revocation happened.
    if (operation?.kind === "revoke" && operation.acknowledged) {
      state = "revoked";
      operation = { ...operation, state: "confirmed", error: null };
    }
  } else if (agent || (record.expiresAt !== null && record.expiresAt <= now)) {
    state = "expired";
  } else if (state === "active") {
    state = "revoked";
  }
  return await save({ ...record, state, checkedAt: now, expiresAt: agent?.validUntil ?? record.expiresAt, operation }, record.revision);
}

export async function getTradingSession(binding: TradingSessionBinding, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<TradingSessionStatus> {
  const key = bindingKey(binding);
  return await serialized(key, async () => {
    let record = await sessionRecord(key);
    if (record && options.refresh !== false) {
      try { record = await reconcile(binding, record, options.signal); }
      catch (error) { return status(binding, record, message(error)); }
    }
    return status(binding, record);
  });
}

async function prepare(binding: TradingSessionBinding, key: string): Promise<SessionRecord> {
  const previous = await sessionRecord(key);
  if (previous && previous.state !== "revoked" && previous.state !== "expired") return previous;
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const generation = crypto.randomUUID();
  const agentName = AGENT_NAME;
  const encryptionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(privateKey);
  const aad = new TextEncoder().encode(JSON.stringify(["neutron-hyperliquid-trading-key-v1", key, generation, account.address.toLowerCase()]));
  let ciphertext: ArrayBuffer;
  try { ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, encryptionKey, plaintext); }
  finally { plaintext.fill(0); }
  return await save({
    version: 1, revision: 0, binding: key, generation,
    walletAddress: binding.walletAddress.toLowerCase(), agentAddress: account.address.toLowerCase() as Hex, agentName,
    createdAt: Date.now(), expiresAt: null, checkedAt: null, state: "unapproved",
    encryptionKey, iv: iv.buffer, ciphertext, operation: null, lastNonce: previous?.lastNonce ?? 0,
  }, previous?.revision ?? null);
}

/** Creates encrypted device-local key material; this does not authorize any trading. */
export async function prepareTradingSession(binding: TradingSessionBinding): Promise<TradingSessionStatus> {
  const key = bindingKey(binding);
  return await serialized(key, async () => status(binding, await prepare(binding, key)));
}

async function executeSessionOperation(
  binding: TradingSessionBinding, signMaster: MasterTypedDataSigner, requestId: string,
  kind: OperationKind, options: TradingSessionOptions,
): Promise<TradingSessionStatus> {
  const key = bindingKey(binding);
  if (!/^[a-fA-F0-9]{32}$/.test(requestId)) throw new Error("A 32-character hexadecimal Wallet request ID is required.");
  return await serialized(key, async () => {
    options.signal?.throwIfAborted();
    let record = await sessionRecord(key);
    const historical = await read<SessionOperation>(`operation:${key}:${requestId}`);
    if (historical && (historical.kind !== kind || historical.generation !== record?.generation)) {
      throw new Error("This request ID belongs to a different trading session action.");
    }
    if (kind === "approve" && !historical) record = await prepare(binding, key);
    if (!record) return status(binding);
    // Read the venue before deciding whether a previous submission needs recovery.
    record = await reconcile(binding, record, options.signal);
    if (historical && ["revoked", "expired"].includes(record.state)) return status(binding, record);
    if ((kind === "approve" && record.state === "active") || (kind === "revoke" && ["revoked", "expired", "unapproved"].includes(record.state))) {
      return status(binding, record);
    }
    if (historical && record.operation?.requestId !== requestId) {
      throw new Error("This completed request belongs to an earlier session action; refresh session status.");
    }
    let operation = historical ? record.operation! : null;
    if (!operation) {
      if (kind === "approve" && (record.state === "approval_pending" || record.state === "revocation_pending" ||
          (record.operation && !["confirmed", "rejected"].includes(record.operation.state)))) {
        throw new Error(`Resume trading session request ${record.operation?.requestId ?? "shown in session status"} or explicitly revoke it before starting another approval.`);
      }
      if (kind === "approve" && ["revoked", "expired"].includes(record.state)) {
        record = await prepare(binding, key);
      }
      const nonce = await nextTradingMasterNonce(binding);
      operation = {
        requestId, generation: record.generation, kind, state: "prepared", envelope: null, error: null,
        ...(kind === "revoke" ? {
          acknowledged: false,
          previousSessionState: record.state === "revocation_pending" ? record.operation?.previousSessionState ?? "approval_pending" : record.state,
          ...(record.operation && !["confirmed", "rejected"].includes(record.operation.state) ? { supersedesRequestId: record.operation.requestId } : {}),
        } : {}),
        action: {
          type: "approveAgent", signatureChainId: "0xa4b1",
          hyperliquidChain: binding.environment === "mainnet" ? "Mainnet" : "Testnet",
          agentAddress: kind === "approve" ? record.agentAddress : ZERO_ADDRESS,
          agentName: record.agentName, nonce,
        },
      };
      record = await save({ ...record, state: kind === "approve" ? "approval_pending" : "revocation_pending", operation, lastNonce: nonce }, record.revision);
    }
    if (operation.state === "confirmed" || operation.state === "rejected") return status(binding, record);
    if (!operation.envelope) {
      const action = operation.action;
      const wallet: AbstractViemJsonRpcAccount = {
        getAddresses: async () => [binding.walletAddress.toLowerCase() as Hex],
        getChainId: async () => 42161,
        async signTypedData(params) {
          options.signal?.throwIfAborted();
          // The SDK includes transport-only fields in action. Wallet intentionally
          // rejects unsigned message members, so present exactly the EIP-712 fields.
          const typedData: MasterTypedDataRequest["typedData"] = {
            domain: params.domain, types: params.types, primaryType: params.primaryType,
            message: { hyperliquidChain: action.hyperliquidChain, agentAddress: action.agentAddress, agentName: action.agentName, nonce: action.nonce },
          };
          const signature = await signMaster({ requestId, chainId: 42161, address: record!.walletAddress, typedData });
          const signer = await recoverTypedDataAddress({ ...typedData, signature });
          if (signer.toLowerCase() !== record!.walletAddress) throw new Error("Wallet returned a signature from a different account.");
          return signature;
        },
      };
      let signature: Awaited<ReturnType<typeof signUserSignedAction>>;
      try {
        signature = await signUserSignedAction({ wallet, action, types: ApproveAgentTypes });
      } catch (error) {
        const rejected = definitiveSigningFailure(error);
        if (!rejected) throw error;
        operation = { ...operation, state: "rejected", error: rejected.message };
        record = await save({ ...record, state: kind === "approve" ? "unapproved" : operation.previousSessionState ?? "active", operation }, record.revision);
        return status(binding, record);
      }
      operation = { ...operation, state: "signed", envelope: JSON.stringify({ action, signature, nonce: action.nonce }) };
      record = await save({ ...record, operation }, record.revision);
    }
    // A timeout can mean accepted. An ordinary retry only reconciles; explicit
    // rebroadcast sends the same immutable bytes, never a replacement nonce.
    const wasReplay = ["submitted", "unknown"].includes(operation.state);
    if (wasReplay && !options.rebroadcast) return status(binding, record);
    options.signal?.throwIfAborted();
    operation = { ...operation, state: "submitted", error: null };
    record = await save({ ...record, operation }, record.revision);
    try {
      const response = await fetch(`${endpoint(binding)}/exchange`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: operation.envelope,
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Hyperliquid session submission returned HTTP ${response.status}; its outcome must be reconciled.`);
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("status" in result)) throw new Error("Hyperliquid returned an unrecognized session submission result.");
      if (result.status === "err") {
        const error = "response" in result && typeof result.response === "string" ? result.response : "Hyperliquid rejected the session action.";
        record = await reconcile(binding, record, options.signal);
        if (record.operation?.state !== "confirmed") {
          // A replay rejection only describes this retransmission. The original
          // could have succeeded and then been revoked elsewhere; marking that
          // key unapproved would make a retired signer eligible for reuse.
          operation = { ...operation, state: wasReplay ? "unknown" : "rejected", error: wasReplay ? `The replay was rejected, but the original submission remains unresolved: ${error}` : error };
          const state = wasReplay || ["revoked", "expired"].includes(record.state) ? record.state : kind === "approve" ? "unapproved" : operation.previousSessionState ?? "active";
          record = await save({ ...record, state, operation }, record.revision);
        }
      } else if (result.status === "ok") {
        if (!("response" in result) || !result.response || typeof result.response !== "object" ||
            !("type" in result.response) || result.response.type !== "default") {
          throw new Error("Hyperliquid returned an unrecognized session acknowledgment.");
        }
        operation = { ...operation, acknowledged: true };
        record = await save({ ...record, operation }, record.revision);
        record = await reconcile(binding, record, options.signal);
      } else throw new Error("Hyperliquid returned an unrecognized session status.");
    } catch (error) {
      operation = { ...operation, state: "unknown", error: message(error) };
      record = await save({ ...record, operation }, record.revision);
    }
    return status(binding, record);
  });
}

export function approveTradingSession(binding: TradingSessionBinding, signMaster: MasterTypedDataSigner, requestId: string, options: TradingSessionOptions = {}): Promise<TradingSessionStatus> {
  return executeSessionOperation(binding, signMaster, requestId, "approve", options);
}

/** Hyperliquid revokes a named API wallet by approving zero for that same name. */
export function revokeTradingSession(binding: TradingSessionBinding, signMaster: MasterTypedDataSigner, requestId: string, options: TradingSessionOptions = {}): Promise<TradingSessionStatus> {
  return executeSessionOperation(binding, signMaster, requestId, "revoke", options);
}

export async function assertTradingSessionActive(binding: TradingSessionBinding, options: { signal?: AbortSignal } = {}): Promise<TradingSessionStatus> {
  options.signal?.throwIfAborted();
  const current = await getTradingSession(binding, options);
  if (current.state !== "active") throw new Error(current.error ?? `Trading session is ${current.state}. Authorize this browser before trading.`);
  return current;
}

/** Internal signer adapter. Never expose this object, ciphertext, or key material as a tool result. */
export async function getTradingSigner(binding: TradingSessionBinding, options: { signal?: AbortSignal } = {}): Promise<AbstractWallet> {
  const key = bindingKey(binding);
  const current = await assertTradingSessionActive(binding, options);
  const generation = (await sessionRecord(key))?.generation;
  if (!generation || !current.agentAddress) throw new Error("Trading session is unavailable.");
  const address = current.agentAddress as Hex;
  return {
    getAddresses: async () => [address],
    getChainId: async () => 1337,
    async signTypedData(params) {
      // Check current registration at signing time, including for retained adapters.
      await assertTradingSessionActive(binding, options);
      const record = await sessionRecord(key);
      if (!record || record.generation !== generation || record.agentAddress !== address || record.state !== "active") {
        throw new Error("Trading signer was replaced. Refresh the trading session.");
      }
      if (params.domain.name !== "Exchange" || params.domain.version !== "1" || params.domain.chainId !== 1337 ||
          params.domain.verifyingContract.toLowerCase() !== ZERO_ADDRESS || params.primaryType !== "Agent" ||
          params.message.source !== (binding.environment === "mainnet" ? "a" : "b")) {
        throw new Error("Trading keys sign Hyperliquid exchange actions only.");
      }
      const aad = new TextEncoder().encode(JSON.stringify(["neutron-hyperliquid-trading-key-v1", key, generation, address]));
      const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv, additionalData: aad }, record.encryptionKey, record.ciphertext));
      try {
        const account = privateKeyToAccount(new TextDecoder().decode(plaintext) as Hex);
        if (account.address.toLowerCase() !== address) throw new Error("Stored trading key does not match its session.");
        return await account.signTypedData(params);
      } finally { plaintext.fill(0); }
    },
  } satisfies AbstractViemJsonRpcAccount;
}
