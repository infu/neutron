import {
  clearPendingRepositorySetup,
  type RepositoryStorage,
} from "neutron-tools/repository";
import {
  captureKernelHandoff,
  clearPendingActivation,
  handoffWasStripped,
  type KernelHandoffCaptureResult,
} from "./activation_handoff.ts";
import { loadRuntimeDeployment } from "./runtime_deployment.ts";

const SETUP_CAPTURE_EVENT = "neutron:repository-setup-captured";
const volatileSetupStorage = new Map<string, string>();

export function bootstrapKernel(): void {
  const initial = captureCurrentHandoff();
  const initialError = kernelCaptureFailure(initial.result);
  if (initialError) {
    clearCapturedHandoffBestEffort();
    showBootstrapError(initialError);
    return;
  }

  window.addEventListener("hashchange", () => {
    const captured = captureCurrentHandoff();
    const error = kernelCaptureFailure(captured.result);
    if (error) {
      clearCapturedHandoffBestEffort();
      showBootstrapError(error);
    } else if (
      captured.activationCaptured &&
      handoffWasStripped(captured.result)
    ) {
      // A same-document activation link arrives after auth has already run.
      // Reload the now-clean URL so the normal login path consumes it once.
      window.location.reload();
    } else if (captured.result.status === "captured") {
      window.dispatchEvent(new CustomEvent(SETUP_CAPTURE_EVENT));
    }
  });

  void startApplication().catch(() => {
    showBootstrapError("Neutron could not start. Reload the page to try again.");
  });
}

function captureCurrentHandoff() {
  return captureKernelHandoff({
    location: window.location,
    storage: kernelSetupStorage,
    history: window.history,
  });
}

export function kernelCaptureFailure(
  result: KernelHandoffCaptureResult,
): string | null {
  if (
    result.status === "storage_error" ||
    result.status === "activation_storage_error"
  ) {
    return "This browser blocked temporary setup storage. The setup link was not erased or forwarded. Enable session storage and reload this page.";
  }
  if (
    (
      result.status === "captured" ||
      result.status === "invalid" ||
      result.status === "activation_invalid"
    ) &&
    !result.stripped
  ) {
    return "Neutron could not remove the private setup handoff from the address bar. Close this tab and open the setup link again; the handoff was not used.";
  }
  if (result.status === "invalid" && result.retireError !== undefined) {
    return "Neutron removed an invalid setup fragment but could not retire the previous temporary setup. Close this tab before continuing.";
  }
  // A malformed reserved fragment that was successfully removed carries no
  // usable setup. It must not prevent an ordinary login or an already-running
  // Neutron from continuing.
  return null;
}

export const kernelSetupStorage: RepositoryStorage = {
  getItem(key) {
    try {
      return window.sessionStorage.getItem(key) ?? volatileSetupStorage.get(key) ?? null;
    } catch {
      return volatileSetupStorage.get(key) ?? null;
    }
  },
  setItem(key, value) {
    // Mirror before touching browser storage, but report denial to the capture
    // helper. It must leave the fragment intact and stop initial startup so a
    // page reload cannot silently lose the setup reference.
    volatileSetupStorage.set(key, value);
    window.sessionStorage.setItem(key, value);
  },
  removeItem(key) {
    volatileSetupStorage.delete(key);
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // The transient in-memory copy is already erased.
    }
  },
};

async function startApplication(): Promise<void> {
  const deployment = await loadRuntimeDeployment();
  if (deployment.target === "pocketic") {
    await import("./playwright_auth.ts");
  }
  await import("./main.tsx");
}

function showBootstrapError(message: string): void {
  const container = document.getElementById("root");
  if (!container) return;
  if (container.childNodes.length > 0) {
    container.inert = true;
    container.setAttribute("aria-hidden", "true");
    let alert = document.getElementById("neutron-bootstrap-error");
    if (!alert) {
      alert = document.createElement("div");
      alert.id = "neutron-bootstrap-error";
      alert.setAttribute("role", "alert");
      Object.assign(alert.style, {
        background: "#111",
        color: "#fff",
        inset: "0",
        padding: "2rem",
        position: "fixed",
        zIndex: "2147483647",
      });
      document.body.append(alert);
    }
    alert.textContent = message;
    return;
  }
  container.textContent = message;
  container.setAttribute("role", "alert");
}

function clearCapturedHandoffBestEffort(): void {
  try {
    clearPendingRepositorySetup(kernelSetupStorage);
  } catch {
    // Capture has already failed closed. Do not expose any retained value.
  }
  try {
    clearPendingActivation(kernelSetupStorage);
  } catch {
    // Clear each handoff independently in case one storage operation fails.
  }
}

declare global {
  interface WindowEventMap {
    "neutron:repository-setup-captured": CustomEvent<
      { error?: string } | undefined
    >;
  }
}
