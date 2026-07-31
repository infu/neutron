import { useEffect, type ComponentType } from "react";
import {
  IoAlertCircleOutline,
  IoCheckmarkCircleOutline,
  IoClose,
  IoInformationCircleOutline,
  IoWarningOutline,
} from "react-icons/io5";
import {
  dismissToast,
  useToastStore,
  type KernelToast,
  type ToastTone,
} from "./store.ts";

const toneIcons: Record<ToastTone, ComponentType<{ "aria-hidden"?: boolean }>> = {
  success: IoCheckmarkCircleOutline,
  info: IoInformationCircleOutline,
  warning: IoWarningOutline,
  danger: IoAlertCircleOutline,
};

export function ToastViewport() {
  const toasts = useToastStore((state) => state.toasts);
  return (
    <div
      aria-label="Notifications"
      aria-live="polite"
      className="toast-viewport"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: KernelToast }) {
  const Icon = toneIcons[toast.tone];

  useEffect(() => {
    const timer = globalThis.setTimeout(
      () => dismissToast(toast.id),
      toast.durationMs,
    );
    return () => globalThis.clearTimeout(timer);
  }, [toast.createdAt, toast.durationMs, toast.id]);

  return (
    <div
      className="kernel-toast"
      data-tone={toast.tone}
      role={toast.tone === "danger" ? "alert" : "status"}
    >
      <Icon aria-hidden={true} />
      <span>{toast.message}</span>
      <button
        aria-label="Dismiss notification"
        className="toast-dismiss"
        onClick={() => dismissToast(toast.id)}
        type="button"
      >
        <IoClose aria-hidden="true" />
      </button>
    </div>
  );
}
