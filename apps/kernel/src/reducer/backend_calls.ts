import { create } from "zustand";
import {
  KernelPolicyError,
  type JsonValue,
} from "neutron-tools/protocol";
import type { NeutronBackendCallReservation } from "neutron-tools/src/capabilities/catalog.js";
import {
  getRegisteredEndpoint,
  subscribeEndpointChanges,
} from "../frame_context.ts";
import {
  admitOwnerAttention,
  finishOwnerAttention,
} from "../ui_attention/owner.ts";
import { requestCancellationError } from "../request_cancel.ts";
import type { CallBinaryFieldInspection } from "./request.ts";

export type BackendCallScopeKind = "exact" | "principal" | "method";

export type BackendCallScope = NeutronBackendCallReservation;

export type BackendCallReservationAction = {
  kind: "reserve" | "release";
  scope: BackendCallScope;
  /** Authoritative reservation state captured before this request was shown. */
  reservationPresentAtRequest?: boolean;
};

export type BackendCallRequestSource =
  | {
      role: "tile";
      tileId: string;
      instanceId: string;
      workspace: number;
    }
  | {
      role: "background";
    };

export type BackendCallConsentLimits = Readonly<{
  maxConcurrency: number;
  maxCyclesPerCall: number;
  maxCyclesPerDay: number;
}>;

export type BackendCallConsentSnapshot = {
  endpoint: string;
  endpointSession?: string;
  appId: string;
  source: BackendCallRequestSource;
  actions: BackendCallReservationAction[];
  limits?: BackendCallConsentLimits;
  call?: {
    method: string;
    args: JsonValue[];
    binaryFields?: readonly CallBinaryFieldInspection[];
  };
};

export type PendingBackendCallRequest = BackendCallConsentSnapshot & {
  id: number;
  attentionToken: string;
};

type ConsentCallbacks = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
};

type BackendCallConsentState = {
  requests: Record<number, PendingBackendCallRequest>;
  add: (request: PendingBackendCallRequest) => void;
  remove: (id: number) => void;
};

export const useBackendCallConsentStore = create<BackendCallConsentState>(
  (set) => ({
    requests: {},
    add: (request) =>
      set((state) => ({
        requests: {
          ...state.requests,
          [request.id]: immutableBackendCallSnapshot(request),
        },
      })),
    remove: (id) =>
      set((state) => {
        const requests = { ...state.requests };
        delete requests[id];
        return { requests };
      }),
  }),
);

const callbacks = new Map<number, ConsentCallbacks>();
let nextId = 0;

export function requestBackendCallConsent(
  request: Omit<PendingBackendCallRequest, "id" | "attentionToken">,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      requestCancellationError(
        signal,
        "Backend access request was cancelled by the requesting app",
      ),
    );
  }
  const id = ++nextId;
  const attentionToken = admitOwnerAttention(request.appId, "backend_access");
  useBackendCallConsentStore.getState().add({
    ...request,
    id,
    attentionToken,
  });
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      rejectRequest(
        id,
        requestCancellationError(
          signal,
          "Backend access request was cancelled by the requesting app",
        ),
      );
    };
    callbacks.set(id, {
      resolve,
      reject,
      ...(signal ? { signal, abort } : {}),
      timeout: setTimeout(() => {
        rejectRequest(
          id,
          new KernelPolicyError("REQUEST_EXPIRED", "Backend request expired"),
        );
      }, 60_000),
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/**
 * Break every reference to app-controlled request data and freeze the retained
 * consent facts. Approval therefore always applies to the exact snapshot that
 * the owner saw, even if the sender mutates its original message objects.
 */
export function immutableBackendCallSnapshot<
  T extends BackendCallConsentSnapshot,
>(request: T): T {
  const source: BackendCallRequestSource =
    request.source.role === "tile"
      ? Object.freeze({
          role: "tile",
          tileId: request.source.tileId,
          instanceId: request.source.instanceId,
          workspace: request.source.workspace,
        })
      : Object.freeze({ role: "background" });
  const actions = request.actions.map((action) =>
    Object.freeze({
      kind: action.kind,
      scope: Object.freeze({
        kind: action.scope.kind,
        ...(action.scope.principal
          ? { principal: action.scope.principal }
          : {}),
        ...(action.scope.method ? { method: action.scope.method } : {}),
      }),
      ...(action.reservationPresentAtRequest !== undefined
        ? {
            reservationPresentAtRequest:
              action.reservationPresentAtRequest,
          }
        : {}),
    }),
  );
  Object.freeze(actions);
  const call = request.call
    ? Object.freeze({
        method: request.call.method,
        args: immutableBackendCallArguments(request.call.args),
        ...(request.call.binaryFields && request.call.binaryFields.length > 0
          ? {
              binaryFields: Object.freeze(
                request.call.binaryFields.map((field) =>
                  Object.freeze({
                    path: field.path,
                    byteLength: field.byteLength,
                    sha256: field.sha256,
                  }),
                ),
              ),
            }
          : {}),
      })
    : undefined;
  const limits = request.limits
    ? Object.freeze({
        maxConcurrency: request.limits.maxConcurrency,
        maxCyclesPerCall: request.limits.maxCyclesPerCall,
        maxCyclesPerDay: request.limits.maxCyclesPerDay,
      })
    : undefined;
  return Object.freeze({
    ...request,
    source,
    actions,
    ...(limits ? { limits } : {}),
    ...(call ? { call } : {}),
  }) as T;
}

export function immutableBackendCallArguments(
  value: JsonValue[],
): JsonValue[] {
  const result = value.map(immutableJsonValue);
  return Object.freeze(result) as JsonValue[];
}

function immutableJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return immutableBackendCallArguments(value);
  if (value !== null && typeof value === "object") {
    const result = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        immutableJsonValue(entry),
      ]),
    ) as Record<string, JsonValue>;
    return Object.freeze(result);
  }
  return value;
}

export function approveBackendCallRequest(id: number): void {
  const callback = callbacks.get(id);
  if (callback) cleanupCallback(callback);
  callback?.resolve();
  callbacks.delete(id);
  const request = useBackendCallConsentStore.getState().requests[id];
  if (request) finishOwnerAttention(request.attentionToken);
  useBackendCallConsentStore.getState().remove(id);
}

export function rejectBackendCallRequest(id: number): void {
  rejectRequest(id, new Error("User rejected backend access"));
}

export function removeBackendCallRequestsForApp(appId: string): void {
  for (const request of Object.values(
    useBackendCallConsentStore.getState().requests,
  )) {
    if (request.appId !== appId) continue;
    rejectRequest(request.id, new Error(`App ${appId} was uninstalled`));
  }
}

function rejectRequest(id: number, error: Error): void {
  const callback = callbacks.get(id);
  if (callback) cleanupCallback(callback);
  callback?.reject(error);
  callbacks.delete(id);
  const request = useBackendCallConsentStore.getState().requests[id];
  if (request) {
    finishOwnerAttention(request.attentionToken);
  }
  useBackendCallConsentStore.getState().remove(id);
}

function cleanupCallback(callback: ConsentCallbacks): void {
  clearTimeout(callback.timeout);
  if (callback.signal && callback.abort) {
    callback.signal.removeEventListener("abort", callback.abort);
  }
}

subscribeEndpointChanges(() => {
  for (const request of Object.values(
    useBackendCallConsentStore.getState().requests,
  )) {
    const endpoint = getRegisteredEndpoint(request.endpoint);
    if (!endpoint || endpoint.sessionId !== request.endpointSession) {
      rejectRequest(
        request.id,
        new Error("The requesting app surface was closed or reloaded"),
      );
    }
  }
});
