import { create } from "zustand";
import { KernelPolicyError } from "neutron-tools/protocol";
import { isValidAppId } from "neutron-tools/src/app_ids.js";
import type { ConnectionSummary } from "../connections/service.ts";
import {
  admitOwnerAttention,
  finishOwnerAttention,
} from "../ui_attention/owner.ts";
import { subscribeEndpointChanges } from "../frame_context.ts";

export const CONNECTION_CALLBACK_CHANNEL = "neutron:connections:v1";
export const CONNECTION_PENDING_FLOW_KEY = "neutron:connections:pending-flow:v1";

export type ConnectionConsent = {
  kind: "connect";
  appId: string;
  appName: string;
  provider: string;
  providerName: string;
  scopes: string[];
  flowId: string;
  authorizationUrl: string;
  phase: "consent" | "waiting";
  error: string | null;
  attentionToken: string;
};

export type DisconnectConsent = {
  kind: "disconnect";
  appId: string;
  appName: string;
  provider: string;
  providerName: string;
  error: string | null;
  attentionToken: string;
};

type ConnectionDialog = ConnectionConsent | DisconnectConsent;

type ConnectionsState = {
  dialog: ConnectionDialog | null;
  setDialog: (dialog: ConnectionDialog | null) => void;
};

export const useConnectionsStore = create<ConnectionsState>((set) => ({
  dialog: null,
  setDialog: (dialog) => set({ dialog }),
}));

type PendingConnect = {
  appId: string;
  flowId: string;
  isCurrent: () => boolean;
  resolve: (summary: ConnectionSummary) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PendingDisconnect = {
  appId: string;
  isCurrent: () => boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

let pendingConnect: PendingConnect | null = null;
let pendingDisconnect: PendingDisconnect | null = null;

export function requestConnectionConsent(
  consent: Omit<ConnectionConsent, "phase" | "error" | "attentionToken">,
  isCurrent: () => boolean,
): Promise<ConnectionSummary> {
  if (pendingConnect || pendingDisconnect) {
    return Promise.reject(new Error("Another connection request is active"));
  }
  const attentionToken = admitOwnerAttention(consent.appId, "connection");
  useConnectionsStore.getState().setDialog({
    ...consent,
    attentionToken,
    phase: "consent",
    error: null,
  });
  return new Promise((resolve, reject) => {
    pendingConnect = {
      appId: consent.appId,
      flowId: consent.flowId,
      isCurrent,
      resolve,
      reject,
      timeout: setTimeout(() => {
        rejectPending(
          new KernelPolicyError("REQUEST_EXPIRED", "Connection request expired"),
        );
        useConnectionsStore.getState().setDialog(null);
        clearPendingFlow(consent.flowId);
      }, 60_000),
    };
  });
}

export function approveConnectionConsent(): void {
  const dialog = useConnectionsStore.getState().dialog;
  if (!dialog || dialog.kind !== "connect") return;
  if (!pendingConnect?.isCurrent()) {
    rejectPending(
      new KernelPolicyError(
        "REQUEST_CANCELLED",
        "The requesting app endpoint is no longer active",
      ),
    );
    useConnectionsStore.getState().setDialog(null);
    clearPendingFlow(dialog.flowId);
    return;
  }

  const popup = window.open(
    "about:blank",
    "_blank",
    "popup,width=720,height=760"
  );
  if (!popup) {
    useConnectionsStore.getState().setDialog({
      ...dialog,
      phase: "consent",
      error: "The authorization window was blocked.",
    });
    return;
  }

  try {
    window.localStorage.setItem(CONNECTION_PENDING_FLOW_KEY, dialog.flowId);
    popup.opener = null;
    popup.location.replace(dialog.authorizationUrl);
    if (pendingConnect?.flowId === dialog.flowId) {
      clearTimeout(pendingConnect.timeout);
      pendingConnect.timeout = setTimeout(() => {
        rejectPending(
          new KernelPolicyError("REQUEST_EXPIRED", "Connection flow expired"),
        );
        clearPendingFlow(dialog.flowId);
      }, 10 * 60_000);
    }
    finishOwnerAttention(dialog.attentionToken);
    useConnectionsStore.getState().setDialog(null);
  } catch {
    popup.close();
    useConnectionsStore.getState().setDialog({
      ...dialog,
      phase: "consent",
      error: "The authorization window could not be opened.",
    });
  }
}

export function requestDisconnectConsent(
  consent: Omit<DisconnectConsent, "error" | "attentionToken">,
  isCurrent: () => boolean,
): Promise<void> {
  if (pendingConnect || pendingDisconnect) {
    return Promise.reject(new Error("Another connection request is active"));
  }
  const attentionToken = admitOwnerAttention(consent.appId, "connection");
  useConnectionsStore.getState().setDialog({
    ...consent,
    attentionToken,
    error: null,
  });
  return new Promise((resolve, reject) => {
    pendingDisconnect = {
      appId: consent.appId,
      isCurrent,
      resolve,
      reject,
      timeout: setTimeout(() => {
        rejectPending(
          new KernelPolicyError("REQUEST_EXPIRED", "Disconnect request expired"),
        );
        useConnectionsStore.getState().setDialog(null);
      }, 60_000),
    };
  });
}

export function approveDisconnectConsent(): void {
  const pending = pendingDisconnect;
  if (!pending) return;
  if (!pending.isCurrent()) {
    rejectPending(
      new KernelPolicyError(
        "REQUEST_CANCELLED",
        "The requesting app endpoint is no longer active",
      ),
    );
    useConnectionsStore.getState().setDialog(null);
    return;
  }
  pendingDisconnect = null;
  clearTimeout(pending.timeout);
  finishOwnerAttention(
    useConnectionsStore.getState().dialog?.attentionToken ?? "",
  );
  useConnectionsStore.getState().setDialog(null);
  pending.resolve();
}

export function rejectConnectionConsent(
  error = new Error("User cancelled the connection request")
): void {
  rejectPending(error);
  useConnectionsStore.getState().setDialog(null);
}

export async function completeConnectionCallback(
  flowId: string,
  code: string
): Promise<ConnectionSummary> {
  const storedFlow = readPendingFlow();
  if (pendingConnect?.flowId !== flowId && storedFlow !== flowId) {
    throw new Error("Connection flow is no longer pending in this session");
  }
  if (pendingConnect && !pendingConnect.isCurrent()) {
    const error = new KernelPolicyError(
      "REQUEST_CANCELLED",
      "The requesting app endpoint is no longer active",
    );
    rejectPending(error);
    clearPendingFlow(flowId);
    throw error;
  }
  const actor = await (await import("./auth.ts")).getNeutronCan();
  if (pendingConnect && !pendingConnect.isCurrent()) {
    const error = new KernelPolicyError(
      "REQUEST_CANCELLED",
      "The requesting app endpoint is no longer active",
    );
    rejectPending(error);
    clearPendingFlow(flowId);
    throw error;
  }
  const raw = await actor.kernel_connections_complete({
    flow_id: flowId,
    code,
  });
  const summary = normalizeConnectionSummary(raw);
  const requestStillPending =
    pendingConnect?.flowId === flowId || readPendingFlow() === flowId;
  const endpointStillCurrent = !pendingConnect || pendingConnect.isCurrent();
  if (!requestStillPending || !endpointStillCurrent) {
    try {
      await actor.kernel_connections_disconnect({
        app_id: summary.appId,
        provider: summary.provider,
      });
    } catch {
      // Backend install/uninstall cleanup may already have removed it.
    }
    const error = new KernelPolicyError(
      "REQUEST_CANCELLED",
      "The requesting app endpoint is no longer active",
    );
    if (pendingConnect) rejectPending(error);
    clearPendingFlow(flowId);
    throw error;
  }

  if (pendingConnect?.flowId === flowId) {
    const pending = pendingConnect;
    pendingConnect = null;
    clearTimeout(pending.timeout);
    finishOwnerAttention(
      useConnectionsStore.getState().dialog?.attentionToken ?? "",
    );
    useConnectionsStore.getState().setDialog(null);
    pending.resolve(summary);
  }
  clearPendingFlow(flowId);
  return summary;
}

export function failConnectionCallback(flowId: string, error: unknown): void {
  if (pendingConnect?.flowId !== flowId) return;
  const pending = pendingConnect;
  pendingConnect = null;
  clearTimeout(pending.timeout);
  const message = error instanceof Error ? error.message : String(error);
  finishOwnerAttention(
    useConnectionsStore.getState().dialog?.attentionToken ?? "",
  );
  useConnectionsStore.getState().setDialog(null);
  pending.reject(new Error(message));
  clearPendingFlow(flowId);
}

function rejectPending(error: Error): void {
  const token = useConnectionsStore.getState().dialog?.attentionToken;
  if (pendingConnect) clearTimeout(pendingConnect.timeout);
  if (pendingDisconnect) clearTimeout(pendingDisconnect.timeout);
  pendingConnect?.reject(error);
  pendingDisconnect?.reject(error);
  pendingConnect = null;
  pendingDisconnect = null;
  if (token) finishOwnerAttention(token);
}

function clearPendingFlow(flowId: string): void {
  if (readPendingFlow() === flowId) {
    try {
      window.localStorage.removeItem(CONNECTION_PENDING_FLOW_KEY);
    } catch {
      // Storage may be unavailable under strict browser privacy settings.
    }
  }
}

function readPendingFlow(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(CONNECTION_PENDING_FLOW_KEY);
  } catch {
    return null;
  }
}

export function removeConnectionRequestsForApp(appId: string): void {
  if (pendingConnect?.appId !== appId && pendingDisconnect?.appId !== appId) {
    return;
  }
  const flowId = pendingConnect?.flowId;
  rejectPending(new Error(`Connection request for '${appId}' was cancelled`));
  useConnectionsStore.getState().setDialog(null);
  if (flowId) clearPendingFlow(flowId);
}

export function clearConnectionRequestsForAuth({
  preserveStoredRecovery = false,
}: { preserveStoredRecovery?: boolean } = {}): void {
  const activeFlowId = pendingConnect?.flowId;
  const storedFlowId = readPendingFlow();
  if (pendingConnect || pendingDisconnect) {
    rejectPending(
      new Error("Connection request was cancelled by an authentication change"),
    );
  }
  useConnectionsStore.getState().setDialog(null);
  if (activeFlowId) {
    clearPendingFlow(activeFlowId);
  } else if (!preserveStoredRecovery && storedFlowId) {
    clearPendingFlow(storedFlowId);
  }
}

subscribeEndpointChanges(() => {
  const connectStale = pendingConnect && !pendingConnect.isCurrent();
  const disconnectStale = pendingDisconnect && !pendingDisconnect.isCurrent();
  if (!connectStale && !disconnectStale) return;
  const flowId = pendingConnect?.flowId;
  rejectPending(
    new KernelPolicyError(
      "REQUEST_CANCELLED",
      "The requesting app endpoint is no longer active",
    ),
  );
  useConnectionsStore.getState().setDialog(null);
  if (flowId) clearPendingFlow(flowId);
});

export function normalizeConnectionSummary(value: unknown): ConnectionSummary {
  if (!isRecord(value)) throw new Error("Invalid connection summary");
  const expected = new Set([
    "app_id",
    "installation_uid",
    "provider",
    "created_at",
  ]);
  const keys = Object.keys(value);
  if (
    keys.length !== expected.size ||
    keys.some((key) => !expected.has(key))
  ) {
    throw new Error("Invalid connection summary");
  }
  const appId = requiredString(value.app_id, "app id");
  const provider = requiredString(value.provider, "provider");
  if (!isValidAppId(appId)) throw new Error("Invalid app id");
  if (!/^[a-z][a-z0-9_]{1,31}$/u.test(provider)) {
    throw new Error("Invalid provider");
  }
  return {
    appId,
    installationUid: naturalText(
      value.installation_uid,
      "installation uid",
    ),
    provider,
    createdAt: naturalText(value.created_at, "connection timestamp", true),
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function scalarText(value: unknown): string {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "bigint"
  ) {
    throw new Error("Invalid connection timestamp");
  }
  return String(value);
}

function naturalText(
  value: unknown,
  label: string,
  allowZero = false,
): string {
  const text = scalarText(value);
  if (
    !/^(?:0|[1-9][0-9]{0,19})$/u.test(text) ||
    (!allowZero && text === "0")
  ) {
    throw new Error(`Invalid ${label}`);
  }
  const natural = BigInt(text);
  if (natural > 18_446_744_073_709_551_615n) {
    throw new Error(`Invalid ${label}`);
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
