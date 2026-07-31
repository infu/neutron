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
const MAX_PENDING_REQUESTS = 16;
const MAX_PENDING_REQUESTS_PER_APP = 4;

export function requestBackendCallConsent(
  request: Omit<PendingBackendCallRequest, "id" | "attentionToken">,
): Promise<void> {
  const pending = Object.values(useBackendCallConsentStore.getState().requests);
  if (pending.length >= MAX_PENDING_REQUESTS) {
    return Promise.reject(new Error("Too many pending backend access requests"));
  }
  if (
    pending.filter((candidate) => candidate.appId === request.appId).length >=
    MAX_PENDING_REQUESTS_PER_APP
  ) {
    return Promise.reject(
      new Error("This app has too many pending backend access requests"),
    );
  }
  if (pending.some((candidate) => candidate.endpoint === request.endpoint)) {
    return Promise.reject(
      new Error("This app endpoint already has a backend access request"),
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
    callbacks.set(id, {
      resolve,
      reject,
      timeout: setTimeout(() => {
        rejectRequest(
          id,
          new KernelPolicyError("REQUEST_EXPIRED", "Backend request expired"),
          false,
        );
      }, 60_000),
    });
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
  if (callback) clearTimeout(callback.timeout);
  callback?.resolve();
  callbacks.delete(id);
  const request = useBackendCallConsentStore.getState().requests[id];
  if (request) finishOwnerAttention(request.attentionToken);
  useBackendCallConsentStore.getState().remove(id);
}

export function rejectBackendCallRequest(id: number): void {
  rejectRequest(id, new Error("User rejected backend access"), true);
}

export function removeBackendCallRequestsForApp(appId: string): void {
  for (const request of Object.values(
    useBackendCallConsentStore.getState().requests,
  )) {
    if (request.appId !== appId) continue;
    rejectRequest(request.id, new Error(`App ${appId} was uninstalled`), false);
  }
}

function rejectRequest(id: number, error: Error, recoveryPause: boolean): void {
  const callback = callbacks.get(id);
  if (callback) clearTimeout(callback.timeout);
  callback?.reject(error);
  callbacks.delete(id);
  const request = useBackendCallConsentStore.getState().requests[id];
  if (request) {
    finishOwnerAttention(request.attentionToken, { recoveryPause });
  }
  useBackendCallConsentStore.getState().remove(id);
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
        false,
      );
    }
  }
});
