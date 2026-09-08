import { create } from "zustand";
import { KernelPolicyError } from "neutron-tools/protocol";
import { admitOwnerAttention, finishOwnerAttention } from "../ui_attention/owner.ts";
import type { ExtensionConnectionStatus, ExtensionRouteGrant } from "./broker.ts";

export type ExtensionConsent = {
  grant: ExtensionRouteGrant;
  reason?: string;
  current: () => boolean;
  approve: () => void;
  reject: () => void;
};

export const useBrowserExtensionStore = create<{
  status: ExtensionConnectionStatus | null;
  grants: ExtensionRouteGrant[];
  error: string | null;
  dialog: ExtensionConsent | null;
}>(() => ({ status: null, grants: [], error: null, dialog: null }));

export function requestConsent(grant: ExtensionRouteGrant, reason: string | undefined, current: () => boolean, signal?: AbortSignal): Promise<void> {
  const attentionToken = admitOwnerAttention(grant.appId, "connection");
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      if (useBrowserExtensionStore.getState().dialog?.grant !== grant) return;
      signal?.removeEventListener("abort", abort);
      finishOwnerAttention(attentionToken);
      useBrowserExtensionStore.setState({ dialog: null });
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new KernelPolicyError("REQUEST_CANCELLED", "Browser extension permission request was cancelled"));
    useBrowserExtensionStore.setState({ dialog: {
      grant, ...(reason === undefined ? {} : { reason }), current,
      approve: () => current() ? finish() : abort(),
      reject: () => finish(new Error("Browser extension access was not approved")),
    } });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
