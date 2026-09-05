import type { ReactNode } from "react";
import {
  useKernelUiModeStore,
  type KernelUiMode,
} from "../ui_mode.ts";

export function useConsentUiMode(
  override?: KernelUiMode,
): KernelUiMode {
  const stored = useKernelUiModeStore((state) => state.mode);
  return override ?? stored;
}

export function ConsentTechnicalDetails({
  children,
  className = "",
  mode,
  summary = "Technical details",
}: {
  children: ReactNode;
  className?: string;
  mode?: KernelUiMode;
  summary?: string;
}) {
  return (
    <details
      className={`consent-technical-details${className ? ` ${className}` : ""}`}
      data-tid="consent-technical-details"
      open={mode === "developer" || undefined}
    >
      <summary>{summary}</summary>
      <div className="consent-technical-details-content">{children}</div>
    </details>
  );
}

export function ConsentNotice({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "warning" | "danger" | "success";
}) {
  return (
    <div className={`consent-notice consent-notice--${tone}`}>
      {children}
    </div>
  );
}

export function focusConsentControl(
  control: HTMLElement | null | undefined,
): void {
  if (!control) return;
  control.focus({ preventScroll: true });
  const dialog = control.closest<HTMLElement>('[aria-modal="true"]');
  if (dialog) dialog.scrollTop = 0;
}
