import { create } from "zustand";
import { KernelPolicyError } from "neutron-tools/protocol";

export type OwnerAttentionKind =
  | "frontend_tool"
  | "signed_canister_call"
  | "backend_access"
  | "connection"
  | "agent_grant"
  | "install_offer";

type ActiveOwnerAttention = {
  token: string;
  appId: string;
  kind: OwnerAttentionKind;
  startedAt: number;
};

type UiAttentionState = {
  active: ActiveOwnerAttention | null;
  pausedUntil: Record<string, number>;
};

export const useUiAttentionStore = create<UiAttentionState>(() => ({
  active: null,
  pausedUntil: {},
}));

export function admitOwnerAttention(
  appId: string,
  kind: OwnerAttentionKind,
): string {
  const now = Date.now();
  const pausedUntil = useUiAttentionStore.getState().pausedUntil[appId] ?? 0;
  if (pausedUntil > now) {
    throw new KernelPolicyError("APP_PAUSED", "App requests are paused", {
      retryAfterMs: pausedUntil - now,
    });
  }
  if (useUiAttentionStore.getState().active) {
    throw new KernelPolicyError("UI_BUSY", "Another app request is active");
  }

  const token = randomToken();
  useUiAttentionStore.setState({
    active: { token, appId, kind, startedAt: now },
  });
  return token;
}

export function finishOwnerAttention(
  token: string,
  options: { recoveryPause?: boolean } = {},
): void {
  const active = useUiAttentionStore.getState().active;
  if (!active || active.token !== token) return;
  useUiAttentionStore.setState({ active: null });
  if (options.recoveryPause) pauseAppAttention(active.appId, 10_000);
}

export function pauseAppAttention(appId: string, milliseconds: number): void {
  const until = Date.now() + Math.max(0, milliseconds);
  useUiAttentionStore.setState((state) => ({
    pausedUntil: { ...state.pausedUntil, [appId]: until },
  }));
}

export function pauseAppAttentionForSession(appId: string): void {
  useUiAttentionStore.setState((state) => ({
    pausedUntil: {
      ...state.pausedUntil,
      [appId]: Number.MAX_SAFE_INTEGER,
    },
  }));
}

export function resumeAppAttention(appId: string): void {
  useUiAttentionStore.setState((state) => {
    const pausedUntil = { ...state.pausedUntil };
    delete pausedUntil[appId];
    return { pausedUntil };
  });
}

export function removeUiAttentionAppState(appId: string): void {
  resumeAppAttention(appId);
  const active = useUiAttentionStore.getState().active;
  if (active?.appId === appId) useUiAttentionStore.setState({ active: null });
}

export function resetUiAttentionState(): void {
  useUiAttentionStore.setState({ active: null, pausedUntil: {} });
}

function randomToken(): string {
  const value = new Uint8Array(16);
  crypto.getRandomValues(value);
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
