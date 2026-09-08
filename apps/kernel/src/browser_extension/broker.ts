import { isJsonObject, KernelPolicyError, type JsonObject, type JsonValue } from "neutron-tools/protocol";
import type { RegisteredEndpoint } from "../frame_context.ts";
import type { BrowserExtensionTransport } from "./transport.ts";

export const EXTENSION_GRANT_STORAGE_PREFIX = "neutron:browser-extension:grant:v1:";

export type ExtensionRouteGrant = {
  id: string;
  ownerPrincipal: string;
  appId: string;
  installationUid: string;
  appName: string;
  createdAt: number;
  revoked?: boolean;
};

export type ExtensionConnectionStatus = {
  available: boolean;
  paired: boolean;
  extensionVersion?: string;
  incompatible?: boolean;
};

type Owner = { principal: string; logged: boolean; authorized: boolean; sessionGeneration: number };
type InstalledApp = { name: string; version: number; generation: number; installationUid: string };
type Binding = {
  endpoint: RegisteredEndpoint;
  sessionId: string;
  principal: string;
  authGeneration: number;
  version: number;
  generation: number;
  grant: ExtensionRouteGrant;
};
type Transfer = { key: string; requestId: string; wireId: string; binding: Binding; phase: "upload" | "fetch" | "stream"; reading: boolean };
type RequestOptions = { authorize?: () => Promise<boolean>; signal?: AbortSignal };
type Dependencies = {
  transport: Pick<BrowserExtensionTransport, "request" | "status">;
  storage: () => Storage | null;
  owner: () => Owner;
  endpoint: (id: string) => RegisteredEndpoint | null;
  app: (id: string) => InstalledApp | null;
  consent: (grant: ExtensionRouteGrant, reason: string | undefined, current: () => boolean, signal?: AbortSignal) => Promise<void>;
  changed?: () => void;
};

/** Grants are local to this browser and installation, with no clock-based expiry. */
export class BrowserExtensionBroker {
  private readonly transfers = new Map<string, Transfer>();
  private readonly pendingGrants = new Map<string, Promise<void>>();

  constructor(private readonly deps: Dependencies) {}

  grants(): ExtensionRouteGrant[] {
    const storage = this.deps.storage();
    if (!storage) return [];
    const grants: ExtensionRouteGrant[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(EXTENSION_GRANT_STORAGE_PREFIX)) continue;
      const grant = parseGrant(storage.getItem(key));
      if (grant && grantKey(grant.id) === key) grants.push(grant);
    }
    return grants.sort((left, right) => left.appName.localeCompare(right.appName));
  }

  async status(endpoint: RegisteredEndpoint): Promise<JsonObject> {
    const binding = this.capture(endpoint);
    const status = await this.deps.transport.status();
    this.assertCurrent(binding);
    return { ...status, granted: this.hasGrant(binding.grant.id) };
  }

  async request(payload: JsonValue, endpoint: RegisteredEndpoint, options: RequestOptions = {}): Promise<JsonObject> {
    if (!isJsonObject(payload) || Object.keys(payload).some((key) => key !== "reason") ||
        (payload.reason !== undefined && typeof payload.reason !== "string")) {
      throw new Error("Invalid browser extension permission request");
    }
    const binding = this.capture(endpoint);
    options.signal?.throwIfAborted();
    const available = await this.deps.transport.status();
    this.assertCurrent(binding);
    options.signal?.throwIfAborted();
    requireAvailable(available);
    if (!available.paired) {
      await this.deps.transport.request("pair");
      this.assertCurrent(binding);
      options.signal?.throwIfAborted();
    }
    if (!this.hasGrant(binding.grant.id)) {
      let pending = this.pendingGrants.get(binding.grant.id);
      if (!pending) {
        pending = (async () => {
          const authorized = await options.authorize?.() ?? false;
          this.assertCurrent(binding);
          options.signal?.throwIfAborted();
          if (!authorized) {
            await this.deps.consent(binding.grant, payload.reason as string | undefined,
              () => this.isCurrent(binding), options.signal);
          }
          this.assertCurrent(binding);
          options.signal?.throwIfAborted();
          // A storage failure must not silently turn a permanent permission into
          // a session grant that asks again after the next reload.
          const storage = this.requireStorage();
          storage.setItem(grantKey(binding.grant.id), JSON.stringify(binding.grant));
          if (!this.hasGrant(binding.grant.id)) throw new Error("Could not save browser extension access");
          this.deps.changed?.();
        })();
        this.pendingGrants.set(binding.grant.id, pending);
        void pending.finally(() => {
          if (this.pendingGrants.get(binding.grant.id) === pending) this.pendingGrants.delete(binding.grant.id);
        }).catch(() => {});
      }
      await pending;
    }
    options.signal?.throwIfAborted();
    return this.status(endpoint);
  }

  async upload(payload: JsonValue, endpoint: RegisteredEndpoint, signal?: AbortSignal): Promise<JsonObject> {
    const requestId = readRequestId(payload, ["requestId", "chunkBase64"]);
    if (!isJsonObject(payload) || typeof payload.chunkBase64 !== "string") throw new Error("Invalid browser extension upload");
    const transfer = this.getOrCreateTransfer(endpoint, requestId);
    if (transfer.phase !== "upload") throw new Error("This browser extension request has already started");
    return this.transferOperation(transfer, signal, async () => {
      await this.deps.transport.request("upload", { requestId: transfer.wireId, chunkBase64: payload.chunkBase64 });
      return {};
    });
  }

  async fetch(payload: JsonValue, endpoint: RegisteredEndpoint, signal?: AbortSignal): Promise<JsonObject> {
    const requestId = readRequestId(payload, ["requestId", "request"]);
    if (!isJsonObject(payload)) throw new Error("Invalid browser extension fetch");
    const request = validateFetchRequest(payload.request);
    const transfer = this.getOrCreateTransfer(endpoint, requestId);
    if (transfer.phase !== "upload") throw new Error("This browser extension request has already started");
    transfer.phase = "fetch";
    return this.transferOperation(transfer, signal, async () => {
      const response = await this.deps.transport.request("fetch", { requestId: transfer.wireId, request });
      if (!isJsonObject(response) || response.requestId !== transfer.wireId ||
          !Number.isInteger(response.status) || typeof response.statusText !== "string" ||
          typeof response.url !== "string" || !validHeaders(response.headers) ||
          (response.type !== undefined && typeof response.type !== "string") ||
          (response.redirected !== undefined && typeof response.redirected !== "boolean")) {
        throw new Error("Invalid browser extension response headers");
      }
      transfer.phase = "stream";
      return {
        requestId,
        status: response.status as number,
        statusText: response.statusText,
        url: response.url,
        headers: response.headers,
        ...(typeof response.type === "string" ? { type: response.type } : {}),
        ...(typeof response.redirected === "boolean" ? { redirected: response.redirected } : {}),
      };
    });
  }

  async read(payload: JsonValue, endpoint: RegisteredEndpoint, signal?: AbortSignal): Promise<JsonObject> {
    const requestId = readRequestId(payload, ["requestId"]);
    const transfer = this.requireTransfer(endpoint, requestId);
    if (transfer.phase !== "stream" || transfer.reading) throw new Error("Browser extension stream is not ready for a read");
    transfer.reading = true;
    try {
      return await this.transferOperation(transfer, signal, async () => {
        const response = await this.deps.transport.request("read", { requestId: transfer.wireId });
        if (!isJsonObject(response) || typeof response.done !== "boolean" ||
            (response.chunkBase64 !== undefined && typeof response.chunkBase64 !== "string") ||
            (!response.done && typeof response.chunkBase64 !== "string")) {
          throw new Error("Invalid browser extension response chunk");
        }
        return {
          done: response.done,
          ...(typeof response.chunkBase64 === "string" ? { chunkBase64: response.chunkBase64 } : {}),
        };
      }, true);
    } finally {
      transfer.reading = false;
    }
  }

  cancel(payload: JsonValue, endpoint: RegisteredEndpoint): JsonObject {
    const requestId = readRequestId(payload, ["requestId"]);
    const binding = this.capture(endpoint);
    const transfer = this.transfers.get(transferKey(binding, requestId));
    if (transfer) this.cancelTransfer(transfer);
    return {};
  }

  revoke(id: string): void {
    const owner = this.requireOwner();
    const grant = this.grants().find((candidate) => candidate.id === id);
    if (!grant) return;
    if (grant.ownerPrincipal !== owner.principal) throw new KernelPolicyError("OWNER_REQUIRED", "This permission belongs to another owner");
    this.requireStorage().removeItem(grantKey(id));
    if (this.hasGrant(id)) throw new Error("Could not revoke browser extension access");
    this.reconcile();
    this.deps.changed?.();
  }

  reconcile(): void {
    for (const transfer of this.transfers.values()) {
      if (!this.isCurrent(transfer.binding) || !this.hasGrant(transfer.binding.grant.id)) this.cancelTransfer(transfer);
    }
  }

  disconnected(): void {
    // The extension has already aborted its requests. Do not reconnect merely
    // to cancel them; a later explicit app operation can establish a new port.
    this.transfers.clear();
  }

  private capture(endpoint: RegisteredEndpoint): Binding {
    const owner = this.requireOwner();
    const app = this.deps.app(endpoint.context.appId);
    if (!endpoint.sessionId || !endpoint.appScope || !app ||
        endpoint.appScope.appId !== endpoint.context.appId ||
        endpoint.appScope.installationUid !== app.installationUid) {
      throw new KernelPolicyError("REQUEST_CANCELLED", "The requesting app installation is no longer active");
    }
    const binding: Binding = {
      endpoint, sessionId: endpoint.sessionId, principal: owner.principal,
      authGeneration: owner.sessionGeneration, version: app.version, generation: app.generation,
      grant: {
        id: JSON.stringify([owner.principal, endpoint.context.appId, app.installationUid]),
        ownerPrincipal: owner.principal, appId: endpoint.context.appId,
        installationUid: app.installationUid, appName: app.name, createdAt: Date.now(),
      },
    };
    this.assertCurrent(binding);
    return binding;
  }

  private assertCurrent(binding: Binding): void {
    if (!this.isCurrent(binding)) throw new KernelPolicyError("REQUEST_CANCELLED", "The requesting app or owner session is no longer active");
  }

  private isCurrent(binding: Binding): boolean {
    const owner = this.deps.owner();
    const app = this.deps.app(binding.grant.appId);
    try {
      return owner.logged && owner.authorized && owner.principal === binding.principal &&
        owner.sessionGeneration === binding.authGeneration &&
        this.deps.endpoint(binding.endpoint.endpointId) === binding.endpoint &&
        binding.endpoint.sessionId === binding.sessionId &&
        (binding.endpoint.isAuthorityCurrent?.() ?? true) &&
        app?.installationUid === binding.grant.installationUid &&
        app.version === binding.version && app.generation === binding.generation;
    } catch { return false; }
  }

  private requireOwner(): Owner {
    const owner = this.deps.owner();
    if (!owner.logged || !owner.authorized) throw new KernelPolicyError("OWNER_REQUIRED", "Browser extension access requires the authorized owner");
    return owner;
  }

  private requireStorage(): Storage {
    const storage = this.deps.storage();
    if (!storage) throw new Error("Browser storage is unavailable; permanent extension access could not be saved");
    return storage;
  }

  private hasGrant(id: string): boolean {
    try {
      const storage = this.deps.storage();
      if (!storage) return false;
      const grant = parseGrant(storage.getItem(grantKey(id)));
      return grant?.id === id;
    } catch { return false; }
  }

  private getOrCreateTransfer(endpoint: RegisteredEndpoint, requestId: string): Transfer {
    const binding = this.capture(endpoint);
    if (!this.hasGrant(binding.grant.id)) throw new KernelPolicyError("OWNER_REQUIRED", "Allow this app to use the browser extension first");
    const key = transferKey(binding, requestId);
    const existing = this.transfers.get(key);
    if (existing) {
      this.assertCurrent(existing.binding);
      return existing;
    }
    const transfer: Transfer = { key, requestId, wireId: crypto.randomUUID(), binding, phase: "upload", reading: false };
    this.transfers.set(key, transfer);
    return transfer;
  }

  private requireTransfer(endpoint: RegisteredEndpoint, requestId: string): Transfer {
    const binding = this.capture(endpoint);
    const transfer = this.transfers.get(transferKey(binding, requestId));
    if (!transfer || !this.hasGrant(binding.grant.id)) throw new Error("Browser extension request is unavailable or was cancelled");
    this.assertCurrent(transfer.binding);
    return transfer;
  }

  private async transferOperation(
    transfer: Transfer, signal: AbortSignal | undefined, operation: () => Promise<JsonObject>, finishOnDone = false,
  ): Promise<JsonObject> {
    const abort = () => this.cancelTransfer(transfer);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const response = await operation();
      signal?.throwIfAborted();
      this.assertCurrent(transfer.binding);
      if (this.transfers.get(transfer.key) !== transfer || !this.hasGrant(transfer.binding.grant.id)) {
        throw new Error("Browser extension request was cancelled or access was revoked");
      }
      if (finishOnDone && response.done === true) this.transfers.delete(transfer.key);
      return response;
    } catch (error) {
      this.cancelTransfer(transfer);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private cancelTransfer(transfer: Transfer): void {
    if (this.transfers.get(transfer.key) !== transfer) return;
    this.transfers.delete(transfer.key);
    void this.deps.transport.request("cancel", { requestId: transfer.wireId }).catch(() => {});
  }
}

function transferKey(binding: Binding, requestId: string): string {
  return JSON.stringify([binding.endpoint.endpointId, binding.sessionId, requestId]);
}

function grantKey(id: string): string { return `${EXTENSION_GRANT_STORAGE_PREFIX}${encodeURIComponent(id)}`; }

function parseGrant(raw: string | null): ExtensionRouteGrant | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isJsonObject(value) || typeof value.id !== "string" || typeof value.ownerPrincipal !== "string" ||
        typeof value.appId !== "string" || typeof value.installationUid !== "string" ||
        typeof value.appName !== "string" || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) ||
        value.id !== JSON.stringify([value.ownerPrincipal, value.appId, value.installationUid])) return null;
    return value as ExtensionRouteGrant;
  } catch { return null; }
}

function readRequestId(payload: JsonValue, keys: string[]): string {
  if (!isJsonObject(payload) || Object.keys(payload).some((key) => !keys.includes(key)) ||
      typeof payload.requestId !== "string" || payload.requestId.length === 0) {
    throw new Error("Invalid browser extension request identifier");
  }
  return payload.requestId;
}

function validHeaders(value: unknown): value is [string, string][] {
  return Array.isArray(value) && value.every((header) => Array.isArray(header) && header.length === 2 && header.every((part) => typeof part === "string"));
}

function validateFetchRequest(value: JsonValue | undefined): JsonObject {
  if (!isJsonObject(value) || Object.keys(value).some((key) => !["url", "method", "headers", "bodyBase64", "hasBody", "redirect"].includes(key)) ||
      typeof value.url !== "string" || (value.method !== undefined && typeof value.method !== "string") ||
      (value.headers !== undefined && !validHeaders(value.headers)) ||
      (value.bodyBase64 !== undefined && typeof value.bodyBase64 !== "string") ||
      (value.hasBody !== undefined && typeof value.hasBody !== "boolean") ||
      (value.redirect !== undefined && !["follow", "error", "manual"].includes(value.redirect as string))) {
    throw new Error("Invalid browser extension HTTP request");
  }
  const url = new URL(value.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The browser extension route supports HTTP and HTTPS requests");
  return value;
}

export function requireAvailable(status: ExtensionConnectionStatus): void {
  if (status.incompatible) throw new Error("Update the Neutron browser extension to connect");
  if (!status.available) throw new Error("Install or enable the Neutron browser extension, then try again");
}
