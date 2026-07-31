import { Principal } from "@dfinity/principal";
import {
  assertBoundedJson,
  isJsonObject,
  KernelPolicyError,
  type JsonObject,
  type JsonValue,
} from "neutron-tools/protocol";
import { CANISTER_METHOD_MAX_LENGTH } from "neutron-tools/src/physical_names.js";
import { backendCallReservationActionToCandid } from "neutron-tools/src/capabilities/backend_calls.js";
import {
  getRegisteredEndpoint,
  type RegisteredEndpoint,
} from "../frame_context.ts";
import { useAppsStore } from "../reducer/apps.ts";
import {
  immutableBackendCallArguments,
  immutableBackendCallSnapshot,
  requestBackendCallConsent,
  type BackendCallReservationAction,
  type BackendCallRequestSource,
  type BackendCallScope,
  type BackendCallScopeKind,
} from "../reducer/backend_calls.ts";
import type { CallBinaryFieldInspection } from "../reducer/request.ts";
import { declaredCapability } from "../capabilities/plan.ts";
import {
  assertEndpointAppScope,
  assertFrontendAuthorityCommitted,
} from "../runtime_authority.ts";

export type BackendCallReservation = {
  id: bigint;
  appId: string;
  installationUid: bigint;
  scopeKind: BackendCallScopeKind;
  principal: string | null;
  method: string | null;
  createdAt: bigint;
  createdBy: string;
};

type ExecuteSelfCall = (
  method: string,
  args: JsonValue[],
) => Promise<JsonValue>;

export type ValidatedSelfCall = {
  args: JsonValue[];
  binaryFields?: readonly CallBinaryFieldInspection[];
};

type BackendReservationTransport = {
  listReservations: () => Promise<BackendCallReservation[]>;
  applyReservations: (
    appId: string,
    actions: BackendCallReservationAction[],
  ) => Promise<BackendCallReservation[]>;
};

export type BackendAccessRequestRuntime = {
  /** Ownership and live-Candid argument validation. Must not execute the call. */
  validateSelfCall?: (
    method: string,
    args: JsonValue[],
  ) => Promise<void | ValidatedSelfCall>;
  /** Executes through the normal same-app path, which revalidates at execution. */
  executeSelfCall?: ExecuteSelfCall;
  authorize?: (request: NormalizedBackendAccessRequest) => Promise<boolean>;
  /** Test seam; production always uses the authenticated kernel actor. */
  transport?: BackendReservationTransport;
};

export type NormalizedBackendAccessRequest = {
  actions: BackendCallReservationAction[];
  call?: {
    method: string;
    args: JsonValue[];
    binaryFields?: readonly CallBinaryFieldInspection[];
  };
  endpoint: string;
  source: BackendCallRequestSource;
};

export async function requestBackendReservationForEndpoint(
  payload: JsonValue,
  endpoint: RegisteredEndpoint,
  runtime: BackendAccessRequestRuntime,
): Promise<JsonValue> {
  const declaration = requireDeclaration(endpoint);
  const record = requiredObject(payload, "backend access request");
  assertOnlyKeys(record, ["actions", "call"], "backend access request");
  const actions = normalizeActions(record.actions, declaration.reservation_scopes);
  const normalizedCall = normalizePostGrantCall(
    record.call,
    endpoint.context.appId,
  );
  const call = normalizedCall
    ? {
        method: normalizedCall.method,
        args: immutableBackendCallArguments(normalizedCall.args),
      }
    : undefined;
  if (actions.length === 0 && !call) {
    throw new Error("Backend access request has no actions");
  }
  const app = useAppsStore.getState().list[endpoint.context.appId];
  if (!app) throw new Error("Requesting app is not installed");

  let reviewedCall: ValidatedSelfCall | undefined;
  if (call) {
    if (!runtime.validateSelfCall || !runtime.executeSelfCall) {
      throw new Error(
        "Post-grant calls require the attachment-aware self-call transport",
      );
    }
    reviewedCall =
      (await runtime.validateSelfCall(call.method, call.args)) ?? {
        args: call.args,
      };
    assertValidatedSelfCall(reviewedCall);
    assertEndpointCurrent(endpoint, {
      ...(endpoint.sessionId ? { endpointSession: endpoint.sessionId } : {}),
    });
  }

  // Clone and freeze app-controlled arguments and trusted binary review data
  // before consent. The original attachment-aware call remains private to its
  // source-bound transport and is revalidated below.
  const initialSnapshot = immutableBackendCallSnapshot({
    endpoint: endpoint.endpointId,
    ...(endpoint.sessionId ? { endpointSession: endpoint.sessionId } : {}),
    appId: endpoint.context.appId,
    source: requestSource(endpoint),
    actions,
    limits: {
      maxConcurrency: declaration.max_concurrency,
      maxCyclesPerCall: declaration.max_cycles_per_call,
      maxCyclesPerDay: declaration.max_cycles_per_day,
    },
    ...(call
      ? {
          call: {
            method: call.method,
            args: reviewedCall!.args,
            ...(reviewedCall!.binaryFields
              ? { binaryFields: reviewedCall!.binaryFields }
              : {}),
          },
        }
      : {}),
  });

  const transport = runtime.transport ?? defaultReservationTransport;
  const currentReservations =
    initialSnapshot.actions.length > 0
      ? (await transport.listReservations()).filter(
          (reservation) => reservation.appId === endpoint.context.appId,
        )
      : [];
  assertEndpointCurrent(endpoint, initialSnapshot);
  const request = immutableBackendCallSnapshot({
    ...initialSnapshot,
    actions: initialSnapshot.actions.map((action) => ({
      ...action,
      reservationPresentAtRequest: currentReservations.some(
        (reservation) => scopesEqual(action.scope, reservationScope(reservation)),
      ),
    })),
  });

  const preapproved =
    (await runtime.authorize?.({
      actions: request.actions,
      ...(request.call ? { call: request.call } : {}),
      endpoint: request.endpoint,
      source: request.source,
    })) ?? false;
  assertEndpointCurrent(endpoint, request);
  if (!preapproved) {
    await requestBackendCallConsent(request);
    assertEndpointCurrent(endpoint, request);
  }

  // Consent may remain open for up to a minute. Recheck the exact retained call
  // before changing durable authority, then execute through a path that checks
  // ownership and live Candid once more at the point of invocation.
  if (call) {
    await runtime.validateSelfCall!(call.method, call.args);
    assertEndpointCurrent(endpoint, request);
  }
  // Preserve the backend API contract for call-only requests: applying an
  // empty action batch returns the app's current reservation snapshot.
  const reservations = await transport.applyReservations(
    endpoint.context.appId,
    request.actions,
  );

  let callResult: JsonValue | undefined;
  let callError: string | undefined;
  if (call) {
    try {
      callResult = await runtime.executeSelfCall!(call.method, call.args);
    } catch (error) {
      callError = errorMessage(error);
    }
  }

  const result: JsonObject = {
    reservations: reservations.map(reservationToJson),
    ...(callResult !== undefined ? { callResult } : {}),
    ...(callError ? { callError } : {}),
  };
  assertBoundedJson(result, "Backend access response");
  return result;
}

function assertValidatedSelfCall(
  value: ValidatedSelfCall,
): asserts value is ValidatedSelfCall {
  if (!Array.isArray(value.args)) {
    throw new Error("Invalid attachment-aware self-call review");
  }
  assertBoundedJson(value.args, "Post-grant argument review");
  if (value.binaryFields === undefined) return;
  if (
    !Array.isArray(value.binaryFields) ||
    value.binaryFields.length > 512 ||
    value.binaryFields.some(
      (field) =>
        typeof field !== "object" ||
        field === null ||
        typeof field.path !== "string" ||
        field.path.length < 1 ||
        field.path.length > 8_192 ||
        !Number.isSafeInteger(field.byteLength) ||
        field.byteLength < 0 ||
        !/^[a-f0-9]{64}$/u.test(field.sha256),
    )
  ) {
    throw new Error("Invalid attachment-aware self-call binary review");
  }
}

const defaultReservationTransport: BackendReservationTransport = {
  listReservations: listAllBackendReservations,
  async applyReservations(appId, actions) {
    const actor = await getKernelActor();
    const rawReservations = await actor.kernel_backend_reservations_apply({
      app_id: appId,
      actions: actions.map(backendCallReservationActionToCandid),
    });
    if (!Array.isArray(rawReservations)) {
      throw new Error("Invalid backend reservation response");
    }
    return rawReservations.map(normalizeBackendReservation);
  },
};

export async function listBackendReservationsForEndpoint(
  payload: JsonValue,
  endpoint: RegisteredEndpoint,
): Promise<JsonValue> {
  requireDeclaration(endpoint);
  optionalEmptyObject(payload, "backend access list");
  const binding = endpoint.sessionId
    ? { endpointSession: endpoint.sessionId }
    : {};
  const reservations = (await listAllBackendReservations()).filter(
    (reservation) =>
      reservation.appId === endpoint.context.appId &&
      reservation.installationUid.toString() ===
        endpoint.appScope?.installationUid,
  );
  assertEndpointCurrent(endpoint, binding);
  return { reservations: reservations.map(reservationToJson) };
}

export async function listAllBackendReservations(): Promise<
  BackendCallReservation[]
> {
  const actor = await getKernelActor();
  const raw = await actor.kernel_backend_reservations_snapshot(null);
  if (!Array.isArray(raw)) throw new Error("Invalid backend reservation response");
  return raw.map(normalizeBackendReservation);
}

export async function revokeBackendReservation(
  reservation: BackendCallReservation,
): Promise<void> {
  const actor = await getKernelActor();
  await actor.kernel_backend_reservations_apply({
    app_id: reservation.appId,
    actions: [
      backendCallReservationActionToCandid({
        kind: "release",
        scope: reservationScope(reservation),
      }),
    ],
  });
}

function requireDeclaration(endpoint: RegisteredEndpoint) {
  const declaration = declaredCapability(
    useAppsStore.getState().list[endpoint.context.appId],
    "backend_calls",
  );
  if (!declaration) {
    throw new Error("App does not declare the backend_calls capability");
  }
  return declaration;
}

function requestSource(endpoint: RegisteredEndpoint): BackendCallRequestSource {
  if (endpoint.context.role === "background") return { role: "background" };
  if (endpoint.context.role === "tray") {
    throw new KernelPolicyError(
      "USER_INTERACTION_REQUIRED",
      "Change backend access from an app tile or background request",
    );
  }
  return {
    role: "tile",
    tileId: endpoint.context.tileId,
    instanceId: endpoint.context.instanceId,
    workspace: endpoint.context.workspace,
  };
}

function assertEndpointCurrent(
  endpoint: RegisteredEndpoint,
  request: { endpointSession?: string },
): void {
  assertFrontendAuthorityCommitted();
  assertEndpointAppScope(endpoint);
  const current = getRegisteredEndpoint(endpoint.endpointId);
  if (
    current !== endpoint ||
    (current.sessionId ?? null) !== (request.endpointSession ?? null)
  ) {
    throw new Error("Requesting app endpoint is no longer active");
  }
}

function normalizeScope(value: unknown): BackendCallScope {
  const record = requiredObject(value, "reservation scope");
  const kind = requiredString(record.kind, "reservation scope kind");
  if (kind !== "exact" && kind !== "principal" && kind !== "method") {
    throw new Error("Invalid reservation scope kind");
  }
  assertOnlyKeys(
    record,
    kind === "exact"
      ? ["kind", "principal", "method"]
      : kind === "principal"
        ? ["kind", "principal"]
        : ["kind", "method"],
    "reservation scope",
  );
  const principal =
    kind === "exact" || kind === "principal"
      ? normalizePrincipal(record.principal)
      : undefined;
  const method =
    kind === "exact" || kind === "method"
      ? normalizeMethod(record.method)
      : undefined;
  if (kind === "exact") {
    return { kind, principal: principal!, method: method! };
  }
  if (kind === "principal") return { kind, principal: principal! };
  return { kind, method: method! };
}

function normalizeActions(
  value: unknown,
  allowedScopes: string[],
): BackendCallReservationAction[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error("Invalid backend reservation actions");
  }
  const seen = new Set<string>();
  return value.map((candidate) => {
    const record = requiredObject(candidate, "backend reservation action");
    assertOnlyKeys(
      record,
      ["kind", "scope"],
      "backend reservation action",
    );
    const kind = requiredString(record.kind, "backend reservation action kind");
    if (kind !== "reserve" && kind !== "release") {
      throw new Error("Invalid backend reservation action kind");
    }
    const scope = normalizeScope(record.scope);
    if (!allowedScopes.includes(scope.kind)) {
      throw new Error(`App does not declare ${scope.kind} reservations`);
    }
    const key = scopeKey(scope);
    if (seen.has(key)) throw new Error("Duplicate backend reservation action");
    seen.add(key);
    return { kind, scope };
  });
}

function normalizePostGrantCall(
  value: unknown,
  appId: string,
): { method: string; args: JsonValue[] } | undefined {
  if (value === undefined || value === null) return undefined;
  const record = requiredObject(value, "post-grant call");
  assertOnlyKeys(record, ["method", "args"], "post-grant call");
  const method = normalizeMethod(record.method);
  const methodEntry = useAppsStore
    .getState()
    .list[appId]?.functions?.find((candidate) => candidate.name === method);
  if (!methodEntry || methodEntry.type === "internal") {
    throw new Error("Post-grant method does not belong to the requesting app");
  }
  if (!Array.isArray(record.args)) throw new Error("Invalid post-grant arguments");
  assertBoundedJson(record.args, "Post-grant arguments");
  return { method, args: record.args as JsonValue[] };
}

export function reservationScope(
  reservation: BackendCallReservation,
): BackendCallScope {
  if (reservation.scopeKind === "principal") {
    if (!reservation.principal) throw new Error("Reservation principal is missing");
    return { kind: "principal", principal: reservation.principal };
  }
  if (reservation.scopeKind === "method") {
    if (!reservation.method) throw new Error("Reservation method is missing");
    return { kind: "method", method: reservation.method };
  }
  if (!reservation.principal || !reservation.method) {
    throw new Error("Exact reservation target is missing");
  }
  return {
    kind: "exact",
    principal: reservation.principal,
    method: reservation.method,
  };
}

function scopeKey(scope: BackendCallScope): string {
  return `${scope.kind}:${"principal" in scope ? scope.principal : ""}:${
    "method" in scope ? scope.method : ""
  }`;
}

function scopesEqual(left: BackendCallScope, right: BackendCallScope): boolean {
  return scopeKey(left) === scopeKey(right);
}

export function normalizeBackendReservation(
  value: unknown,
): BackendCallReservation {
  const record = requiredObject(value, "backend reservation");
  const scopeKind = requiredString(record.scope_kind, "reservation scope kind");
  if (
    scopeKind !== "exact" &&
    scopeKind !== "principal" &&
    scopeKind !== "method"
  ) {
    throw new Error("Invalid backend reservation scope");
  }
  return {
    id: requiredNat(record.id, "reservation id"),
    appId: requiredString(record.app_id, "reservation app"),
    installationUid: requiredNat(
      record.installation_uid,
      "reservation installation uid",
    ),
    scopeKind,
    principal: optionalPrincipal(record.principal),
    method: optionalMethod(record.method),
    createdAt: requiredNat(record.created_at, "reservation creation time"),
    createdBy: normalizePrincipal(record.created_by),
  };
}

function optionalMethod(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length === 1) return normalizeMethod(value[0]);
    throw new Error("Invalid optional backend method");
  }
  return normalizeMethod(value);
}

function reservationToJson(reservation: BackendCallReservation): JsonObject {
  return {
    id: reservation.id.toString(),
    appId: reservation.appId,
    installationUid: reservation.installationUid.toString(),
    scopeKind: reservation.scopeKind,
    principal: reservation.principal,
    method: reservation.method,
    createdAt: reservation.createdAt.toString(),
    createdBy: reservation.createdBy,
  };
}

function optionalPrincipal(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length === 1) return normalizePrincipal(value[0]);
    throw new Error("Invalid optional principal");
  }
  return normalizePrincipal(value);
}

function normalizePrincipal(value: unknown): string {
  try {
    const principalObject = value as { toText?: unknown };
    const text =
      typeof value === "string"
        ? value
        : value !== null &&
            typeof value === "object" &&
            typeof principalObject.toText === "function"
          ? String(principalObject.toText())
          : String(value);
    const principal = Principal.fromText(text);
    if (principal.isAnonymous()) throw new Error("anonymous");
    return principal.toText();
  } catch {
    throw new Error("Invalid backend destination principal");
  }
}

function normalizeMethod(value: unknown): string {
  const method = requiredString(value, "backend method");
  if (
    method.length > CANISTER_METHOD_MAX_LENGTH ||
    !/^[a-zA-Z0-9_]+$/.test(method)
  ) {
    throw new Error("Invalid backend method");
  }
  return method;
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`Invalid ${label}`);
  return value as JsonObject;
}

function optionalEmptyObject(value: JsonValue, label: string): void {
  if (value === null) return;
  const record = requiredObject(value, label);
  if (Object.keys(record).length > 0) throw new Error(`Invalid ${label}`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(`Invalid ${label}`);
  }
}

function requiredNat(value: unknown, label: string): bigint {
  try {
    const result = BigInt(value as bigint | number | string);
    if (result < 0n) throw new Error("negative");
    return result;
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getKernelActor(): Promise<any> {
  return (await import("../reducer/auth.ts")).getNeutronCan();
}
