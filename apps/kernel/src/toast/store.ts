import { create } from "zustand";

export type ToastTone = "success" | "info" | "warning" | "danger";

export type KernelToast = {
  id: string;
  message: string;
  tone: ToastTone;
  durationMs: number;
  createdAt: number;
};

export type ToastInput = {
  message: string;
  tone?: ToastTone;
  durationMs?: number;
};

const MAX_VISIBLE_TOASTS = 4;
const DEFAULT_DURATION_MS = 2_400;
const DEDUPE_WINDOW_MS = 700;
let nextToastId = 1;

type ToastState = {
  toasts: KernelToast[];
};

export const useToastStore = create<ToastState>(() => ({ toasts: [] }));

export function showToast(input: ToastInput): string {
  const now = Date.now();
  const message = normalizeMessage(input.message);
  const tone = input.tone ?? "info";
  const durationMs = normalizeDuration(input.durationMs);
  let id = "";

  useToastStore.setState((state) => {
    const duplicate = [...state.toasts]
      .reverse()
      .find(
        (toast) =>
          toast.message === message &&
          toast.tone === tone &&
          now - toast.createdAt <= DEDUPE_WINDOW_MS,
      );
    if (duplicate) {
      id = duplicate.id;
      return {
        toasts: state.toasts.map((toast) =>
          toast.id === duplicate.id
            ? { ...toast, durationMs, createdAt: now }
            : toast,
        ),
      };
    }

    id = `toast-${nextToastId++}`;
    const toast: KernelToast = { id, message, tone, durationMs, createdAt: now };
    return { toasts: [...state.toasts, toast].slice(-MAX_VISIBLE_TOASTS) };
  });
  return id;
}

export function dismissToast(id: string): void {
  useToastStore.setState((state) => ({
    toasts: state.toasts.filter((toast) => toast.id !== id),
  }));
}

export function clearToasts(): void {
  useToastStore.setState({ toasts: [] });
}

function normalizeMessage(message: string): string {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new Error("Toast message is required");
  }
  return message.trim().slice(0, 240);
}

function normalizeDuration(durationMs: number | undefined): number {
  if (durationMs === undefined) return DEFAULT_DURATION_MS;
  if (!Number.isFinite(durationMs)) return DEFAULT_DURATION_MS;
  return Math.min(10_000, Math.max(1_000, Math.round(durationMs)));
}
