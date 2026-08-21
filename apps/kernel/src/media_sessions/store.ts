import { create } from "zustand";
import { KernelPolicyError, isJsonObject, type JsonObject, type JsonValue } from "neutron-tools/protocol";
import type { RegisteredEndpoint } from "../frame_context.ts";
import { getNeutronCan } from "../reducer/auth.ts";
import { useAppsStore } from "../reducer/apps.ts";
import { declaredCapability } from "../capabilities/plan.ts";

export type MediaFeature = "camera" | "microphone";

export type PendingMediaSession = Readonly<{
  id: string;
  endpointId: string;
  appId: string;
  appName: string;
  purpose: string;
  features: readonly MediaFeature[];
  durationSeconds: number;
  resolve: (result: JsonObject) => void;
  reject: (error: Error) => void;
}>;

export type ActiveMediaSession = Readonly<{
  sessionId: string;
  endpointId: string;
  appId: string;
  appName: string;
  appVersion: number;
  appGeneration: number;
  installationUid: string;
  planFingerprint: string;
  entrypoint: string;
  originNonce: string;
  authorityEpoch: string;
  expiresAtNanoseconds: string;
  features: readonly MediaFeature[];
}>;

type MediaSessionState = {
  pending: PendingMediaSession | null;
  active: ActiveMediaSession | null;
};

export const useMediaSessionStore = create<MediaSessionState>(() => ({
  pending: null,
  active: null,
}));

const FEATURE_ORDER: readonly MediaFeature[] = ["camera", "microphone"];
const PURPOSE_MAX_LENGTH = 160;

export function requestMediaSession(
  payload: JsonValue,
  endpoint: RegisteredEndpoint,
  options: {
    focused: boolean;
    userActivated: boolean;
    ownerAuthorized: boolean;
    delegated: boolean;
  },
): Promise<JsonObject> {
  if (!options.ownerAuthorized) {
    throw new KernelPolicyError("OWNER_REQUIRED", "Media access requires the authorized owner");
  }
  if (
    endpoint.context.role !== "tile" ||
    !endpoint.sessionId ||
    !endpoint.appScope ||
    !options.focused ||
    options.delegated
  ) {
    throw new KernelPolicyError(
      "USER_INTERACTION_REQUIRED",
      "Start media from the focused app tile and confirm it in the Kernel",
    );
  }
  const parsed = parseOpenPayload(payload);
  const apps = useAppsStore.getState();
  const app = apps.list[endpoint.context.appId];
  const declaration = declaredCapability(app, "media_sessions");
  if (!app || !declaration || !endpoint.appScope) {
    throw new KernelPolicyError("OWNER_REQUIRED", "This app did not declare media sessions");
  }
  const allowed = new Set(declaration.features);
  if (parsed.features.some((feature) => !allowed.has(feature))) {
    throw new KernelPolicyError("INVALID_REQUEST", "The requested device was not declared");
  }
  const durationSeconds = parsed.durationSeconds ?? declaration.max_duration_seconds;
  if (durationSeconds < 1 || durationSeconds > declaration.max_duration_seconds) {
    throw new KernelPolicyError("INVALID_REQUEST", "The requested media duration exceeds the installed declaration");
  }
  if (useMediaSessionStore.getState().pending || useMediaSessionStore.getState().active) {
    throw new KernelPolicyError("UI_BUSY", "Another media session is already pending or active");
  }
  return new Promise<JsonObject>((resolve, reject) => {
    useMediaSessionStore.setState({
      pending: Object.freeze({
        id: randomHex(16),
        endpointId: endpoint.endpointId,
        appId: endpoint.context.appId,
        appName: app.name,
        purpose: parsed.purpose,
        features: parsed.features,
        durationSeconds,
        resolve,
        reject,
      }),
    });
  });
}

export async function approvePendingMediaSession(): Promise<void> {
  const pending = useMediaSessionStore.getState().pending;
  if (!pending) return;
  const apps = useAppsStore.getState();
  const app = apps.list[pending.appId];
  const instance = apps.appInstances[pending.appId];
  if (!app || !instance) return rejectPendingMediaSession("The app is no longer installed");
  try {
    const actor = await getNeutronCan();
    const raw = await actor.kernel_media_session_begin({
      app_id: pending.appId,
      request_id: randomHex(16),
      features: pending.features.map((feature) => ({ [feature]: null }) as { camera: null } | { microphone: null }),
      duration_seconds: BigInt(pending.durationSeconds),
    });
    const lease = parseBeginResult(raw);
    const current = useMediaSessionStore.getState().pending;
    if (current?.id !== pending.id) {
      await actor.kernel_media_session_close(lease.sessionId);
      return;
    }
    const latest = useAppsStore.getState();
    const latestApp = latest.list[pending.appId];
    const latestInstance = latest.appInstances[pending.appId];
    if (
      !latestApp ||
      !latestInstance ||
      latestApp.version !== lease.appVersion ||
      latestApp.capability_plan_fingerprint !== lease.planFingerprint ||
      latestInstance.scope.installationUid !== lease.installationUid
    ) {
      await actor.kernel_media_session_close(lease.sessionId);
      throw new Error("App authority changed while approving media access");
    }
    const active: ActiveMediaSession = Object.freeze({
      ...lease,
      endpointId: pending.endpointId,
      appName: pending.appName,
      appGeneration: latest.runtimeGenerations[pending.appId] ?? 0,
      features: Object.freeze([...lease.features]),
    });
    useMediaSessionStore.setState({ pending: null, active });
    pending.resolve({
      sessionId: active.sessionId,
      expiresAt: active.expiresAtNanoseconds,
      features: [...active.features],
    });
  } catch (error) {
    useMediaSessionStore.setState({ pending: null });
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

export function rejectPendingMediaSession(message = "Media access was not allowed"): void {
  const pending = useMediaSessionStore.getState().pending;
  if (!pending) return;
  useMediaSessionStore.setState({ pending: null });
  pending.reject(new KernelPolicyError("USER_INTERACTION_REQUIRED", message));
}

export async function closeActiveMediaSession(
  expected?: { appId?: string; endpointId?: string; sessionId?: string },
): Promise<void> {
  const active = useMediaSessionStore.getState().active;
  if (!active) return;
  if (expected?.appId && expected.appId !== active.appId) {
    throw new KernelPolicyError("INVALID_REQUEST", "That app does not own the active media session");
  }
  if (expected?.endpointId && expected.endpointId !== active.endpointId) {
    throw new KernelPolicyError("INVALID_REQUEST", "That app endpoint does not own the active media session");
  }
  if (expected?.sessionId && expected.sessionId !== active.sessionId) {
    throw new KernelPolicyError("INVALID_REQUEST", "The media session id does not match");
  }
  // Remove the frame synchronously. This is the browser-enforced track
  // teardown even when the child document is unresponsive.
  useMediaSessionStore.setState({ active: null });
  try {
    await (await getNeutronCan()).kernel_media_session_close(active.sessionId);
  } catch (error) {
    console.error("[neutron:media] backend lease close failed", {
      sessionId: active.sessionId,
      appId: active.appId,
      error,
    });
  }
}

export function cancelAllMediaSessionUi(reason: string): void {
  rejectPendingMediaSession(reason);
  void closeActiveMediaSession();
}

function parseOpenPayload(payload: JsonValue): {
  features: MediaFeature[];
  purpose: string;
  durationSeconds?: number;
} {
  if (!isJsonObject(payload)) throw new KernelPolicyError("INVALID_REQUEST", "Invalid media request");
  const keys = Object.keys(payload);
  if (keys.some((key) => !["features", "purpose", "durationSeconds"].includes(key))) {
    throw new KernelPolicyError("INVALID_REQUEST", "Invalid media request fields");
  }
  if (!Array.isArray(payload.features) || typeof payload.purpose !== "string") {
    throw new KernelPolicyError("INVALID_REQUEST", "Media features and purpose are required");
  }
  const featureSet = new Set<MediaFeature>();
  for (const value of payload.features) {
    if (value !== "camera" && value !== "microphone") {
      throw new KernelPolicyError("INVALID_REQUEST", "Unknown media feature");
    }
    featureSet.add(value);
  }
  if (featureSet.size < 1 || payload.purpose.length < 1 || payload.purpose.length > PURPOSE_MAX_LENGTH) {
    throw new KernelPolicyError("INVALID_REQUEST", "Media purpose or feature list is invalid");
  }
  const duration = payload.durationSeconds;
  if (duration !== undefined && (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 1)) {
    throw new KernelPolicyError("INVALID_REQUEST", "Media duration is invalid");
  }
  return {
    features: FEATURE_ORDER.filter((feature) => featureSet.has(feature)),
    purpose: payload.purpose,
    ...(duration === undefined ? {} : { durationSeconds: duration }),
  };
}

function parseBeginResult(raw: unknown): Omit<ActiveMediaSession, "endpointId" | "appName" | "appGeneration"> {
  if (!isJsonObject(raw)) throw new Error("Invalid media lease response");
  if ("err" in raw) {
    const kind = isJsonObject(raw.err) ? Object.keys(raw.err)[0] : "unknown";
    throw new Error(`Media session could not start (${kind})`);
  }
  if (!("ok" in raw) || !isJsonObject(raw.ok)) throw new Error("Invalid media lease response");
  const lease = raw.ok as Record<string, unknown>;
  const features = Array.isArray(lease.features)
    ? lease.features.map((feature) => {
        if (!isJsonObject(feature)) throw new Error("Invalid media lease feature");
        const key = Object.keys(feature)[0];
        if (key !== "camera" && key !== "microphone") throw new Error("Invalid media lease feature");
        return key;
      })
    : [];
  const text = (key: string) => {
    const value = lease[key];
    if (typeof value !== "string") throw new Error("Invalid media lease response");
    return value;
  };
  const natural = (key: string) => {
    const value = lease[key];
    if (typeof value !== "bigint" && typeof value !== "number") throw new Error("Invalid media lease response");
    return String(value);
  };
  const appVersionRaw = lease.app_version;
  const appVersion = typeof appVersionRaw === "bigint" ? Number(appVersionRaw) : appVersionRaw;
  if (!Number.isSafeInteger(appVersion)) throw new Error("Invalid media lease version");
  return {
    sessionId: text("session_id"),
    appId: text("app_id"),
    installationUid: natural("installation_uid"),
    appVersion: appVersion as number,
    planFingerprint: text("plan_fingerprint"),
    originNonce: text("origin_nonce"),
    entrypoint: text("entrypoint"),
    features,
    expiresAtNanoseconds: natural("expires_at"),
    authorityEpoch: natural("authority_epoch"),
  };
}

function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
