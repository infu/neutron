import {
  captureRepositorySetupFragment,
  type CaptureRepositorySetupResult,
  type RepositoryHistory,
  type RepositoryLocation,
  type RepositoryStorage,
} from "neutron-tools/repository";

const ACTIVATION_STORAGE_KEY = "neutron.kernel.pending-activation.v1";
const ACTIVATION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ACTIVATION_BYTES = 32;
const ALLOWED_KEYS = new Set(["repo", "manifest", "digest", "activate"]);
const SENSITIVE_KEYS = new Set(["repo", "manifest", "digest", "activate"]);
const SETUP_KEYS = ["repo", "manifest", "digest"] as const;
const MAX_FRAGMENT_BYTES = 2_048;

export type ActivationOnlyCaptureResult =
  | {
      status: "activation_captured";
      cleanUrl: string;
      stripped: true;
    }
  | {
      status: "activation_invalid";
      error: Error;
      cleanUrl: string;
      stripped: boolean;
      stripError?: unknown;
    }
  | {
      status: "activation_storage_error";
      error: unknown;
    };

export type KernelHandoffCaptureResult =
  | CaptureRepositorySetupResult
  | ActivationOnlyCaptureResult;

export type KernelHandoffCapture = {
  result: KernelHandoffCaptureResult;
  activationCaptured: boolean;
};

export function captureKernelHandoff({
  location,
  history,
  storage,
}: {
  location: RepositoryLocation;
  history: RepositoryHistory;
  storage: RepositoryStorage;
}): KernelHandoffCapture {
  const sensitiveQueryKey = findSensitiveQueryKey(location.href);
  if (sensitiveQueryKey !== null) {
    const cleanUrl = withoutSensitiveQueryOrFragment(location.href);
    const stripped = tryStrip(history, cleanUrl);
    return {
      result: {
        status: "activation_invalid",
        error: new Error(
          `Private handoff field "${sensitiveQueryKey}" must be supplied in the URL fragment`,
        ),
        cleanUrl,
        stripped: stripped.ok,
        ...("error" in stripped ? { stripError: stripped.error } : {}),
      },
      activationCaptured: false,
    };
  }

  const fragment = location.hash;
  if (!hasActivationKey(fragment)) {
    return {
      result: captureRepositorySetupFragment({
        mode: "internal",
        location,
        history,
        storage,
      }),
      activationCaptured: false,
    };
  }

  const cleanUrl = withoutFragment(location.href);
  let token: string;
  let setupFragment: string | null;
  try {
    ({ token, setupFragment } = parseActivationHandoff(fragment));
  } catch (error) {
    const stripped = tryStrip(history, cleanUrl);
    return {
      result: {
        status: "activation_invalid",
        error: asError(error),
        cleanUrl,
        stripped: stripped.ok,
        ...("error" in stripped ? { stripError: stripped.error } : {}),
      },
      activationCaptured: false,
    };
  }

  let previous: string | null;
  try {
    previous = storage.getItem(ACTIVATION_STORAGE_KEY);
    storage.setItem(ACTIVATION_STORAGE_KEY, token);
  } catch (error) {
    return {
      result: { status: "activation_storage_error", error },
      activationCaptured: false,
    };
  }

  const rollback = () => {
    try {
      if (previous === null) {
        storage.removeItem(ACTIVATION_STORAGE_KEY);
      } else {
        storage.setItem(ACTIVATION_STORAGE_KEY, previous);
      }
    } catch {
      // Startup remains failed closed; no bearer is submitted from memory.
    }
  };

  if (setupFragment !== null) {
    const result = captureRepositorySetupFragment({
      mode: "internal",
      location: {
        href: `${cleanUrl}${setupFragment}`,
        hash: setupFragment,
      },
      history,
      storage,
    });
    if (
      result.status === "storage_error" ||
      ((result.status === "captured" || result.status === "invalid") &&
        !result.stripped)
    ) {
      rollback();
      return { result, activationCaptured: false };
    }
    return { result, activationCaptured: true };
  }

  const stripped = tryStrip(history, cleanUrl);
  if (!stripped.ok) {
    rollback();
    return {
      result: {
        status: "activation_invalid",
        error: new Error(
          "Neutron could not remove the activation code from the address bar",
        ),
        cleanUrl,
        stripped: false,
        stripError: stripped.error,
      },
      activationCaptured: false,
    };
  }
  return {
    result: {
      status: "activation_captured",
      cleanUrl,
      stripped: true,
    },
    activationCaptured: true,
  };
}

export function takePendingActivation(
  storage: RepositoryStorage,
): Uint8Array | null {
  let token: string | null;
  try {
    token = storage.getItem(ACTIVATION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (token === null) return null;
  try {
    storage.removeItem(ACTIVATION_STORAGE_KEY);
  } catch {
    return null;
  }
  try {
    return decodeActivationToken(token);
  } catch {
    return null;
  }
}

export function clearPendingActivation(storage: RepositoryStorage): void {
  storage.removeItem(ACTIVATION_STORAGE_KEY);
}

export function handoffWasStripped(
  result: KernelHandoffCaptureResult,
): boolean {
  if (
    result.status === "none" ||
    result.status === "storage_error" ||
    result.status === "activation_storage_error"
  ) {
    return false;
  }
  return result.stripped;
}

export function decodeActivationToken(token: string): Uint8Array {
  if (!ACTIVATION_PATTERN.test(token)) {
    throw new Error("Activation code must contain 32 bytes of base64url data");
  }
  const binary = atob(
    token.replace(/-/g, "+").replace(/_/g, "/") + "=",
  );
  const bytes = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  if (bytes.byteLength !== ACTIVATION_BYTES || encode(bytes) !== token) {
    throw new Error("Activation code is not canonical");
  }
  return bytes;
}

function parseActivationHandoff(fragment: string): {
  token: string;
  setupFragment: string | null;
} {
  if (new TextEncoder().encode(fragment).byteLength > MAX_FRAGMENT_BYTES) {
    throw new Error("Activation handoff is too large");
  }
  const params = new URLSearchParams(
    fragment.startsWith("#") ? fragment.slice(1) : fragment,
  );
  const seen = new Set<string>();
  for (const [key] of params) {
    if (!ALLOWED_KEYS.has(key) || seen.has(key)) {
      throw new Error("Activation handoff contains unknown or duplicate fields");
    }
    seen.add(key);
  }
  const token = params.get("activate");
  if (token === null) throw new Error("Activation handoff is missing its code");
  decodeActivationToken(token);

  const setupCount = SETUP_KEYS.filter((key) => params.has(key)).length;
  if (setupCount !== 0 && setupCount !== SETUP_KEYS.length) {
    throw new Error(
      "Activation setup must contain repo, manifest, and digest together",
    );
  }
  if (setupCount === 0) return { token, setupFragment: null };

  const setup = new URLSearchParams();
  for (const key of SETUP_KEYS) setup.set(key, params.get(key)!);
  return { token, setupFragment: `#${setup.toString()}` };
}

function hasActivationKey(fragment: string): boolean {
  if (!fragment) return false;
  const params = new URLSearchParams(
    fragment.startsWith("#") ? fragment.slice(1) : fragment,
  );
  return [...params.keys()].some(
    (key) => key.toLowerCase() === "activate",
  );
}

function withoutFragment(href: string): string {
  const url = new URL(href);
  url.hash = "";
  return url.href;
}

function findSensitiveQueryKey(href: string): string | null {
  const url = new URL(href);
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) return key;
  }
  return null;
}

function withoutSensitiveQueryOrFragment(href: string): string {
  const url = new URL(href);
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.hash = "";
  return url.href;
}

function tryStrip(
  history: RepositoryHistory,
  cleanUrl: string,
): { ok: true } | { ok: false; error: unknown } {
  try {
    history.replaceState(history.state ?? null, "", cleanUrl);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
