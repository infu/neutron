import { create } from "zustand";
import {
  KernelPolicyError,
  type JsonObject,
  type JsonValue,
} from "neutron-tools/protocol";
import {
  admitOwnerAttention,
  finishOwnerAttention,
} from "../ui_attention/owner.ts";
import {
  getRegisteredEndpoint,
  subscribeEndpointChanges,
} from "../frame_context.ts";
import { requestCancellationError } from "../request_cancel.ts";

export type MsgBusCaller = {
  endpoint: string;
  appId: string;
  role: "tile" | "background" | "tray";
  sessionId?: string;
};

export type PendingFrontendToolRequest = {
  cid: number;
  caller: MsgBusCaller;
  target: string;
  tool: string;
  toolTitle?: string;
  toolDescription?: string;
  arguments: JsonObject;
  providerReview?: JsonObject;
  sessionOnly: boolean;
  onceOnly: boolean;
  callerSessionId: string;
  targetSessionId: string;
  attentionToken: string;
  attachmentBytes?: {
    input: number;
    maximumOutput: number;
  };
};

type PermissionCallbacks = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
};

type MsgBusPermissionState = {
  requests: Record<number, PendingFrontendToolRequest>;
  addRequest: (request: PendingFrontendToolRequest) => void;
  removeRequest: (cid: number) => void;
};

export const useMsgBusPermissionStore = create<MsgBusPermissionState>(
  (set) => ({
    requests: {},
    addRequest: (request) =>
      set((state) => ({
        requests: { ...state.requests, [request.cid]: request },
      })),
    removeRequest: (cid) =>
      set((state) => {
        const requests = { ...state.requests };
        delete requests[cid];
        return { requests };
      }),
  }),
);

const callbacks = new Map<number, PermissionCallbacks>();
const sessionGrants = new Set<string>();
let cidIncr = 0;

export function hasFrontendToolGrant(
  caller: MsgBusCaller,
  callerSessionId: string | undefined,
  target: string,
  targetSessionId: string | undefined,
  tool: string,
): boolean {
  const callerSession = callerSessionId ?? "unconnected";
  const targetSession = targetSessionId ?? "unconnected";
  return [tool, "*"].some(
    (candidate) =>
      sessionGrants.has(
        grantKey(
          caller.appId,
          caller.endpoint,
          callerSession,
          target,
          targetSession,
          candidate,
        ),
      ) ||
      sessionGrants.has(
        grantKey(caller.appId, "*", "*", target, "*", candidate),
      ),
  );
}

export function grantFrontendToolSession(
  callerAppId: string,
  target: string,
  tool: string,
  scope: {
    callerEndpoint?: string;
    callerSessionId?: string;
    targetSessionId?: string;
  } = {},
): void {
  sessionGrants.add(
    grantKey(
      callerAppId,
      scope.callerEndpoint ?? "*",
      scope.callerSessionId ?? "*",
      target,
      scope.targetSessionId ?? "*",
      tool,
    ),
  );
}

export function clearFrontendToolSessionGrants(): void {
  sessionGrants.clear();
}

export function removeFrontendAppState(appId: string): void {
  for (const key of sessionGrants) {
    try {
      const [callerAppId, , , target] = JSON.parse(key) as string[];
      if (callerAppId === appId || targetBelongsToApp(target, appId)) {
        sessionGrants.delete(key);
      }
    } catch {
      sessionGrants.delete(key);
    }
  }
  for (const request of Object.values(
    useMsgBusPermissionStore.getState().requests,
  )) {
    if (
      request.caller.appId === appId ||
      targetBelongsToApp(request.target, appId)
    ) {
      rejectRequest(request.cid, new Error(`App ${appId} was uninstalled`));
    }
  }
  for (let index = auditEntries.length - 1; index >= 0; index -= 1) {
    const entry = auditEntries[index];
    if (
      entry &&
      (entry.caller.appId === appId || targetBelongsToApp(entry.target, appId))
    ) {
      auditEntries.splice(index, 1);
    }
  }
}

function targetBelongsToApp(
  target: string | undefined,
  appId: string,
): boolean {
  if (!target) return false;
  return (
    target.startsWith(`app:${appId}:`) ||
    target === appId ||
    target.startsWith(`${appId}/`)
  );
}

export function requestFrontendToolPermission(input: {
  caller: MsgBusCaller;
  target: string;
  tool: string;
  toolTitle?: string;
  toolDescription?: string;
  arguments?: JsonObject;
  providerReview?: JsonObject;
  sessionOnly?: boolean;
  onceOnly?: boolean;
  /** Internal provider-review fence: prior grants must not satisfy this request. */
  requireFreshDecision?: boolean;
  callerSessionId?: string;
  targetSessionId?: string;
  attachmentBytes?: {
    input: number;
    maximumOutput: number;
  };
  signal?: AbortSignal;
}): Promise<void> {
  if (input.signal?.aborted) {
    return Promise.reject(
      requestCancellationError(
        input.signal,
        "App request was cancelled by the requesting surface",
      ),
    );
  }
  if (
    !input.requireFreshDecision &&
    hasFrontendToolGrant(
      input.caller,
      input.callerSessionId,
      input.target,
      input.targetSessionId,
      input.tool,
    )
  ) {
    return Promise.resolve();
  }

  const cid = ++cidIncr;
  const attentionToken = admitOwnerAttention(
    input.caller.appId,
    "frontend_tool",
  );
  const request: PendingFrontendToolRequest = {
    cid,
    caller: input.caller,
    target: input.target,
    tool: input.tool,
    ...(input.toolTitle ? { toolTitle: input.toolTitle } : {}),
    ...(input.toolDescription
      ? { toolDescription: input.toolDescription }
      : {}),
    arguments: input.arguments ?? {},
    ...(input.providerReview ? { providerReview: input.providerReview } : {}),
    sessionOnly: input.sessionOnly ?? false,
    onceOnly: input.onceOnly ?? false,
    callerSessionId: input.callerSessionId ?? "unconnected",
    targetSessionId: input.targetSessionId ?? "unconnected",
    attentionToken,
    ...(input.attachmentBytes
      ? { attachmentBytes: input.attachmentBytes }
      : {}),
  };
  useMsgBusPermissionStore.getState().addRequest(request);
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      rejectRequest(
        cid,
        requestCancellationError(
          input.signal,
          "App request was cancelled by the requesting surface",
        ),
      );
    };
    callbacks.set(cid, {
      resolve,
      reject,
      ...(input.signal ? { signal: input.signal, abort } : {}),
      timeout: setTimeout(() => {
        rejectRequest(
          cid,
          new KernelPolicyError("REQUEST_EXPIRED", "App request expired"),
        );
      }, 60_000),
    });
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
  });
}

export function approveFrontendToolRequest(
  cidValue: number | string,
  duration: "once" | "session",
): void {
  const cid = Number(cidValue);
  const request = useMsgBusPermissionStore.getState().requests[cid];
  if (!request) return;
  if (!request.onceOnly && (duration === "session" || request.sessionOnly)) {
    grantFrontendToolSession(
      request.caller.appId,
      request.target,
      request.tool,
      {
        callerEndpoint: request.caller.endpoint,
        callerSessionId: request.callerSessionId,
        targetSessionId: request.targetSessionId,
      },
    );
  }
  const callback = callbacks.get(cid);
  if (callback) cleanupCallback(callback);
  callback?.resolve();
  callbacks.delete(cid);
  finishOwnerAttention(request.attentionToken);
  useMsgBusPermissionStore.getState().removeRequest(cid);
}

export function rejectFrontendToolRequest(cidValue: number | string): void {
  const cid = Number(cidValue);
  rejectRequest(cid, new Error("User rejected frontend tool access"));
}

function rejectRequest(cid: number, error: Error): void {
  const request = useMsgBusPermissionStore.getState().requests[cid];
  const callback = callbacks.get(cid);
  if (callback) cleanupCallback(callback);
  callback?.reject(error);
  callbacks.delete(cid);
  if (request) {
    finishOwnerAttention(request.attentionToken);
  }
  useMsgBusPermissionStore.getState().removeRequest(cid);
}

function cleanupCallback(callback: PermissionCallbacks): void {
  clearTimeout(callback.timeout);
  if (callback.signal && callback.abort) {
    callback.signal.removeEventListener("abort", callback.abort);
  }
}

subscribeEndpointChanges(() => {
  for (const request of Object.values(
    useMsgBusPermissionStore.getState().requests,
  )) {
    const caller = getRegisteredEndpoint(request.caller.endpoint);
    const callerSession = caller?.sessionId ?? "unconnected";
    const target =
      request.target === "kernel"
        ? null
        : getRegisteredEndpoint(request.target);
    const targetSession =
      request.target === "kernel"
        ? "kernel-session"
        : target?.sessionId ?? "unconnected";
    if (
      !caller ||
      callerSession !== request.callerSessionId ||
      targetSession !== request.targetSessionId
    ) {
      rejectRequest(
        request.cid,
        new KernelPolicyError(
          "REQUEST_CANCELLED",
          "An app surface changed while permission was pending",
        ),
      );
    }
  }
});

function grantKey(
  callerAppId: string,
  callerEndpoint: string,
  callerSessionId: string,
  target: string,
  targetSessionId: string,
  tool: string,
): string {
  return JSON.stringify([
    callerAppId,
    callerEndpoint,
    callerSessionId,
    target,
    targetSessionId,
    tool,
  ]);
}

export type MsgBusAuditEntry = {
  id: number;
  timestamp: string;
  caller: MsgBusCaller;
  target: string;
  tool: string;
  status: "ok" | "error";
  durationMs: number;
  arguments: JsonValue;
  result?: JsonValue;
  error?: string;
  metadataBytes?: {
    input: number;
    output: number;
  };
  attachmentBytes?: {
    input: number;
    output: number;
  };
  binaryFields?: {
    input: { count: number; bytes: number };
    output: { count: number; bytes: number };
  };
};

const MAX_AUDIT_ENTRIES = 200;
const auditEntries: MsgBusAuditEntry[] = [];
let auditId = 0;

export function recordMsgBusAudit(
  entry: Omit<MsgBusAuditEntry, "id" | "timestamp">,
): void {
  auditEntries.push({
    ...entry,
    arguments: auditValue(entry.arguments),
    ...(entry.result !== undefined ? { result: auditValue(entry.result) } : {}),
    ...(entry.error ? { error: entry.error.slice(0, 1000) } : {}),
    id: ++auditId,
    timestamp: new Date().toISOString(),
  });
  if (auditEntries.length > MAX_AUDIT_ENTRIES) {
    auditEntries.splice(0, auditEntries.length - MAX_AUDIT_ENTRIES);
  }
}

export function listMsgBusAudit(): MsgBusAuditEntry[] {
  return auditEntries.map((entry) => ({ ...entry }));
}

export function clearMsgBusAudit(): void {
  auditEntries.length = 0;
}

function auditValue(value: JsonValue): JsonValue {
  const encoded = JSON.stringify(value);
  return encoded.length <= 2048 ? value : `${encoded.slice(0, 2045)}...`;
}
