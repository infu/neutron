import { create } from "zustand";
import { KernelPolicyError } from "neutron-tools/protocol";
import type { FrameContext } from "../frame_context.ts";
import {
  getRegisteredEndpoint,
  subscribeEndpointChanges,
  type RegisteredEndpoint,
} from "../frame_context.ts";
import { sameAppScope, type AppScope } from "../app_scope.ts";
import {
  admitOwnerAttention,
  finishOwnerAttention,
} from "../ui_attention/owner.ts";
import { requestCancellationError } from "../request_cancel.ts";

export type PendingCallRequest = {
  canister: string;
  method: string;
  mode: "query" | "update" | "unknown";
  args: unknown[];
  canonicalArgs?: boolean;
  /**
   * Transient trusted projection for consent UI. It is removed with the
   * request and is never copied into the persistent message-bus audit.
   */
  binaryFields?: readonly CallBinaryFieldInspection[];
  cid: number;
  frame: FrameContext;
  endpointId: string;
  endpointSession?: string;
  endpointAppVersion?: number;
  endpointAppGeneration?: number;
  endpointAppScope?: AppScope;
  attentionToken: string;
};

export type CallBinaryFieldInspection = Readonly<{
  path: string;
  byteLength: number;
  sha256: string;
}>;

export type SignedCallEndpointBinding = Readonly<{
  endpoint: RegisteredEndpoint;
  endpointId: string;
  source: Window;
  frame: FrameContext;
  sessionId?: string;
  appVersion?: number;
  appGeneration?: number;
  appScope?: AppScope;
  authorityEpoch: bigint;
}>;

type RequestCallbacks = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  binding: SignedCallEndpointBinding;
  signal?: AbortSignal;
  abort?: () => void;
};

type RequestState = {
  calls: Record<number, PendingCallRequest>;
  addCallRequest: (request: PendingCallRequest) => void;
  removeCallRequest: (cid: number) => void;
};

export const useRequestStore = create<RequestState>((set) => ({
  calls: {},
  addCallRequest: (request) =>
    set((state) => ({
      calls: {
        ...state.calls,
        [request.cid]: request,
      },
    })),
  removeCallRequest: (cid) =>
    set((state) => {
      const calls = { ...state.calls };
      delete calls[cid];
      return { calls };
    }),
}));

let callbacks: Record<number, RequestCallbacks> = {};
let cidIncr = 0;
let authorityEpoch = 0n;

export function callRequest(req: {
  canister: string;
  method: string;
  mode?: "query" | "update";
  args: unknown[];
  canonicalArgs?: boolean;
  binaryFields?: readonly CallBinaryFieldInspection[];
  binding: SignedCallEndpointBinding;
  signal?: AbortSignal;
}): Promise<void> {
  assertSignedCallEndpointCurrent(req.binding);
  if (req.signal?.aborted) {
    return Promise.reject(
      requestCancellationError(
        req.signal,
        "Signature request was cancelled by the requesting app",
      ),
    );
  }
  cidIncr += 1;
  const cid = cidIncr;
  const attentionToken = admitOwnerAttention(
    req.binding.frame.appId,
    "signed_canister_call",
  );
  useRequestStore.getState().addCallRequest({
    canister: req.canister,
    method: req.method,
    mode: req.mode ?? "unknown",
    args: req.args,
    ...(req.canonicalArgs !== undefined
      ? { canonicalArgs: req.canonicalArgs }
      : {}),
    ...(req.binaryFields && req.binaryFields.length > 0
      ? {
          binaryFields: req.binaryFields.map((field) =>
            Object.freeze({ ...field }),
          ),
        }
      : {}),
    frame: req.binding.frame,
    endpointId: req.binding.endpointId,
    ...(req.binding.sessionId
      ? { endpointSession: req.binding.sessionId }
      : {}),
    ...(req.binding.appVersion !== undefined
      ? { endpointAppVersion: req.binding.appVersion }
      : {}),
    ...(req.binding.appGeneration !== undefined
      ? { endpointAppGeneration: req.binding.appGeneration }
      : {}),
    ...(req.binding.appScope ? { endpointAppScope: req.binding.appScope } : {}),
    cid,
    attentionToken,
  });
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      rejectCall(
        cid,
        requestCancellationError(
          req.signal,
          "Signature request was cancelled by the requesting app",
        ),
        false,
      );
    };
    callbacks[cid] = {
      resolve,
      reject,
      binding: req.binding,
      ...(req.signal ? { signal: req.signal, abort } : {}),
      timeout: setTimeout(() => {
        rejectCall(
          cid,
          new KernelPolicyError("REQUEST_EXPIRED", "Signature request expired"),
          false,
        );
      }, 60_000),
    };
    req.signal?.addEventListener("abort", abort, { once: true });
    if (req.signal?.aborted) abort();
  });
}

subscribeEndpointChanges(() => {
  for (const request of Object.values(useRequestStore.getState().calls)) {
    const callback = callbacks[request.cid];
    if (!callback || !signedCallEndpointIsCurrent(callback.binding)) {
      rejectCall(
        request.cid,
        new KernelPolicyError(
          "REQUEST_CANCELLED",
          "The requesting app surface changed",
        ),
        false,
      );
    }
  }
});

export function callApprove({ cid }: { cid: number | string }): void {
  const numericCid = Number(cid);
  const callback = callbacks[numericCid];
  if (callback && !signedCallEndpointIsCurrent(callback.binding)) {
    rejectCall(
      numericCid,
      new KernelPolicyError(
        "REQUEST_CANCELLED",
        "The requesting app surface changed",
      ),
      false,
    );
    return;
  }
  if (callback) cleanupCallback(callback);
  callback?.resolve();
  delete callbacks[numericCid];
  const request = useRequestStore.getState().calls[numericCid];
  if (request) finishOwnerAttention(request.attentionToken);
  useRequestStore.getState().removeCallRequest(numericCid);
}

export function callReject({ cid }: { cid: number | string }): void {
  rejectCall(Number(cid), new Error("User rejected"), true);
}

export function captureSignedCallEndpoint(
  endpoint: RegisteredEndpoint,
): SignedCallEndpointBinding {
  const frame = Object.freeze({ ...endpoint.context }) as FrameContext;
  const appScope = endpoint.appScope
    ? Object.freeze({ ...endpoint.appScope })
    : undefined;
  return Object.freeze({
    endpoint,
    endpointId: endpoint.endpointId,
    source: endpoint.source,
    frame,
    ...(endpoint.sessionId ? { sessionId: endpoint.sessionId } : {}),
    ...(endpoint.appVersion !== undefined
      ? { appVersion: endpoint.appVersion }
      : {}),
    ...(endpoint.appGeneration !== undefined
      ? { appGeneration: endpoint.appGeneration }
      : {}),
    ...(appScope ? { appScope } : {}),
    authorityEpoch,
  });
}

export function assertSignedCallEndpointCurrent(
  binding: SignedCallEndpointBinding,
): RegisteredEndpoint {
  const endpoint = getRegisteredEndpoint(binding.endpointId);
  if (
    endpoint !== binding.endpoint ||
    endpoint.source !== binding.source ||
    endpoint.sessionId !== binding.sessionId ||
    endpoint.appVersion !== binding.appVersion ||
    endpoint.appGeneration !== binding.appGeneration ||
    !sameAppScope(endpoint.appScope, binding.appScope) ||
    !sameFrameContext(endpoint.context, binding.frame) ||
    binding.authorityEpoch !== authorityEpoch
  ) {
    throw new KernelPolicyError(
      "REQUEST_CANCELLED",
      "The requesting app surface changed",
    );
  }
  return endpoint;
}

export function removeCallRequestsForApp(appId: string): void {
  authorityEpoch += 1n;
  for (const request of Object.values(useRequestStore.getState().calls)) {
    if (request.frame.appId === appId) {
      rejectCall(
        request.cid,
        new KernelPolicyError(
          "REQUEST_CANCELLED",
          `App ${appId} authority changed while a signature request was pending`,
        ),
        false,
      );
    }
  }
}

export function removeAllCallRequests(): void {
  authorityEpoch += 1n;
  for (const request of Object.values(useRequestStore.getState().calls)) {
    rejectCall(
      request.cid,
      new KernelPolicyError(
        "REQUEST_CANCELLED",
        "App authority changed while a signature request was pending",
      ),
      false,
    );
  }
}

export async function dispatchSignedCallWithReplyFence<T>(
  dispatch: () => Promise<T>,
  assertAuthority: () => void,
): Promise<T> {
  let result: T;
  try {
    result = await dispatch();
  } catch (error) {
    assertSignedCallReplyAuthority(assertAuthority);
    throw error;
  }
  assertSignedCallReplyAuthority(assertAuthority);
  return result;
}

function assertSignedCallReplyAuthority(assertAuthority: () => void): void {
  try {
    assertAuthority();
  } catch {
    throw new KernelPolicyError(
      "REQUEST_CANCELLED",
      "Canister call authority changed after dispatch; the outcome is unknown and the reply was withheld",
    );
  }
}

function signedCallEndpointIsCurrent(
  binding: SignedCallEndpointBinding,
): boolean {
  try {
    assertSignedCallEndpointCurrent(binding);
    return true;
  } catch {
    return false;
  }
}

function sameFrameContext(left: FrameContext, right: FrameContext): boolean {
  if (left.role !== right.role || left.appId !== right.appId) return false;
  if (left.role === "background" || right.role === "background") {
    return left.role === right.role;
  }
  if (left.role === "tray" || right.role === "tray") {
    return (
      left.role === "tray" &&
      right.role === "tray" &&
      left.instanceId === right.instanceId
    );
  }
  return (
    left.tileId === right.tileId &&
    left.instanceId === right.instanceId &&
    left.workspace === right.workspace
  );
}

function rejectCall(cid: number, error: Error, recoveryPause: boolean): void {
  const callback = callbacks[cid];
  if (callback) cleanupCallback(callback);
  callback?.reject(error);
  delete callbacks[cid];
  const request = useRequestStore.getState().calls[cid];
  if (request) {
    finishOwnerAttention(request.attentionToken, { recoveryPause });
  }
  useRequestStore.getState().removeCallRequest(cid);
}

function cleanupCallback(callback: RequestCallbacks): void {
  clearTimeout(callback.timeout);
  if (callback.signal && callback.abort) {
    callback.signal.removeEventListener("abort", callback.abort);
  }
}
