import {
  CANISTER_PRINCIPAL_TEXT_MAX_LENGTH,
  MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS,
  MSG_BUS_MAX_PROGRESS_BYTES,
  MSG_BUS_PROVIDER_APPROVAL_MAX_BYTES,
  KernelPolicyError,
  NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
  NEUTRON_TOOL_AUDIENCE_FOREGROUND_TILE,
  NEUTRON_TOOL_CONSENT_PROVIDER_ONCE,
  NEUTRON_TOOL_CONTROL_CANCEL,
  NEUTRON_TOOL_VISIBILITY_SAME_APP,
  assertBoundedJson,
  assertToolName,
  boundSerializedError,
  isExecEnvelope,
  isJsonObject,
  isJsonValue,
  isRequestCancelEnvelope,
  jsonPayloadBytes,
  kernelCallPayloadSchema,
  kernelSchemaPayloadSchema,
  msgBusLocalActions,
  normalizeToolDescriptor,
  serializeError,
  validateToolArguments,
  validateToolResult,
  type ExposedToolOptions,
  type AppStateChangeEnvelope,
  type JsonObject,
  type JsonValue,
  type KernelCallPayload,
  type KernelSchemaPayload,
  type MsgBusEndpointId,
  type MsgBusInvocationMetadata,
  type OpenAppTileResult,
  type MsgBusToolCall,
  type MsgBusToolDescriptor,
  type NeutronToolControlMode,
  type ResponseEnvelope,
  type TileViewEnvelope,
} from "neutron-tools/protocol";
import {
  executeExposedAction,
  execPort,
  expose,
  type ExposedActionContext,
} from "neutron-tools/kernel";
import {
  APP_ID_MAX_LENGTH,
  APP_ID_MIN_LENGTH,
  APP_ID_REPEATED_SEPARATOR_PATTERN,
  APP_ID_SAFE_SCHEMA_PATTERN,
  isValidAppId,
} from "neutron-tools/src/app_ids.js";
import { CANISTER_METHOD_MAX_LENGTH } from "neutron-tools/src/physical_names.js";
import { QueryResponseStatus } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { parseRepositorySetupUrl } from "neutron-tools/repository";
import { normalizeUntrustedText } from "neutron-tools/src/schema.js";
import icblast from "icblast";
import { getNeutronId } from "./config.ts";
import {
  endpointIdForContext,
  getRegisteredEndpoint,
  installFrameEndpointHandshake,
  listRegisteredEndpoints,
  resolveRegisteredEndpoint,
  subscribeEndpointChanges,
  subscribeEndpointPortMessages,
  subscribeEndpointPortRetirements,
  waitForFrameEndpointPort,
  type RegisteredEndpoint,
} from "./frame_context.ts";
import {
  install_app,
  useAppsStore,
  type AppInstallOfferReview,
} from "./reducer/apps.ts";
import { declaredCapability } from "./capabilities/plan.ts";
import {
  hasFrontendToolGrant,
  listMsgBusAudit,
  recordMsgBusAudit,
  requestFrontendToolPermission,
  type MsgBusCaller,
} from "./reducer/msg_bus.ts";
import {
  assertSignedCallEndpointCurrent,
  callRequest,
  captureSignedCallEndpoint,
  dispatchSignedCallWithReplyFence,
  type SignedCallEndpointBinding,
} from "./reducer/request.ts";
import { verifiedCallMode } from "./trusted_call_mode.ts";
import {
  useWorkspaceStore,
  visibleWorkspaceIds,
  workspaceTile,
  workspaceIds,
  workspaceStateById,
} from "./workspace/store.ts";
import {
  MAX_WORKSPACES,
  type InsertSide,
  type LayoutNode,
  type WorkspaceId,
} from "./workspace/types.ts";
import {
  inspectWorkspace,
  WORKSPACE_CONTROL_TOOL_OPTIONS,
  WORKSPACE_INSPECT_TOOL_OPTIONS,
} from "./workspace/tool_contract.ts";
import {
  acquireConnectionForEndpoint,
  disconnectConnectionForEndpoint,
  listConnectionsForEndpoint,
  requestConnectionForEndpoint,
} from "./connections/service.ts";
import {
  listBackendReservationsForEndpoint,
  requestBackendReservationForEndpoint,
  type NormalizedBackendAccessRequest,
} from "./backend_calls/service.ts";
import {
  beginEthereumProviderForEndpoint,
  endEthereumProviderForEndpoint,
  reconcileEthereumProviderSessions,
  requestEthereumProviderForEndpoint,
} from "./ethereum_provider/service.ts";
import { clipboardService } from "./clipboard/service.ts";
import {
  acquireAttachmentCapacity,
  attachmentBytes,
  attachmentError,
  assertAttachmentExecEnvelope,
  assertToolAttachmentArray,
  consumeAttachmentDelegation,
  execEndpointWithAttachments,
  handleAttachmentReply,
  isAttachmentWireMessage,
  issueAttachmentDelegation,
  parseToolAttachmentContract,
  postAttachmentProgress,
  postAttachmentResponse,
  validateToolAttachments,
  type AttachmentCallResult,
  type AttachmentCapacityReservation,
  type ToolAttachment,
} from "./attachment_bus.ts";
import {
  assertExternalCanisterCallTarget,
  assertSelfCallRawRequestBytes,
  CANISTER_RESULT_ERROR_NAME,
  classifyNullaryCanisterResultError,
  encodeSelfCallResult,
  inspectBoundSelfCallBlobs,
  isCanisterResultError,
  isSelfCallDomainErrorResult,
  materializeSelfCallArguments,
  normalizeCanisterCallResult,
  normalizeSelfCallResult,
  parseSelfCallWireBlobs,
  preflightSelfCallRequest,
  preflightSelfCallReply,
  requireConsentedSelfCall,
  requireSelfCallCandidMethod,
  requirePhysicalSelfCallMethod,
  requirePreapprovedSelfCall,
  selfCallBlobStats,
  selfCallReservationBytes,
  SELF_CALL_METADATA_MAX_BYTES,
  type PreapprovedSelfCallType,
  type SelfCallWireBlob,
} from "./self_calls.ts";
import {
  getSelfCallAgent,
  getSelfCallTarget,
  submitRawSelfUpdate,
} from "./self_call_transport.ts";
import { useAuthStore } from "./reducer/auth.ts";
import { sameAppScope } from "./app_scope.ts";
import {
  beginAgentRoot,
  clearAgentModeForAuth,
  completeInvocation,
  createChildInvocation,
  hasActiveInvocationForApp,
  invocationMetadata,
  isDirectAgentInvocation,
  requestAgentConsent,
  requestAgentGrant,
  reconcileAgentEndpoints,
  resolveInvocation,
  rootEndpoint,
  useAgentModeStore,
  disableAgentMode,
  setAgentRootCancelDispatcher,
  type AgentPermissionSummary,
  type InvocationNode,
} from "./ui_attention/agent.ts";
import {
  dismissTrayForEndpoint,
  setTrayStateForEndpoint,
} from "./tray/service.ts";
import {
  serializeVetKeysActionError,
  VetKeysBrowserBroker,
  unwrapVetKeysOperationResult,
  type VetKeysLifecycleAction,
  type VetKeysManifestProjection,
} from "./vetkeys/service.ts";
import {
  normalizeVetKeysIcblastFailure,
  normalizeVetKeysIcblastSuccess,
} from "./vetkeys/icblast_boundary.ts";
import {
  assertEndpointAppScope,
  assertFrontendAuthorityCommitted,
  isFrontendAuthorityPending,
} from "./runtime_authority.ts";
import { getRuntimeDeployment } from "./runtime_deployment.ts";
import { parseOfferedPackageUrl } from "./tools/package_url.ts";
import {
  reconcileInstallOffer,
  requestInstallOffer,
} from "./install_offers/service.ts";
import { safeInstallOfferUrl } from "./install_offers/InstallOfferDialog.tsx";
import {
  requestCancellationError,
  throwIfRequestCancelled,
} from "./request_cancel.ts";
import type {
  AttestedInstallOfferRequester,
  NormalizedInstallOffer,
} from "./install_offers/types.ts";
import { startRepositorySetupFromOffer } from "./repository/service.ts";
import { useRepositorySetupStore } from "./repository/store.ts";
import {
  SOURCE_FILES_TOOL_OPTIONS,
  SOURCE_READ_TOOL_OPTIONS,
  SOURCE_SEARCH_TOOL_OPTIONS,
} from "./source_inspection/tool_options.ts";

const neutron_id = getNeutronId();
installFrameEndpointHandshake();

type KernelToolHandler = (
  args: JsonObject,
  caller: RegisteredEndpoint,
  invocation: InvocationNode | null,
  invocationContext?: MsgBusInvocationMetadata,
  signal?: AbortSignal,
) => JsonValue | Promise<JsonValue>;

type RegisteredKernelTool = {
  descriptor: MsgBusToolDescriptor;
  handler: KernelToolHandler;
};

const kernelTools = new Map<string, RegisteredKernelTool>();
const binarySelfCallDomainErrorStats = Symbol("binarySelfCallDomainErrorStats");
type BinarySelfCallStats = { count: number; bytes: number };
type BinarySelfCallDomainError = Error & {
  readonly code: "binary_domain_error";
  readonly [binarySelfCallDomainErrorStats]: BinarySelfCallStats;
};

function protectedBinarySelfCallDomainError(
  stats: BinarySelfCallStats,
): BinarySelfCallDomainError {
  const error = new Error(
    "Canister call returned a protected binary domain error",
  ) as BinarySelfCallDomainError;
  error.name = CANISTER_RESULT_ERROR_NAME;
  Object.defineProperties(error, {
    code: {
      configurable: false,
      enumerable: true,
      value: "binary_domain_error",
    },
    [binarySelfCallDomainErrorStats]: {
      configurable: false,
      enumerable: false,
      value: Object.freeze({ ...stats }),
    },
  });
  return error;
}

function protectedBinarySelfCallStats(
  error: unknown,
): BinarySelfCallStats | null {
  if (!(error instanceof Error) || !(binarySelfCallDomainErrorStats in error)) {
    return null;
  }
  return (error as BinarySelfCallDomainError)[binarySelfCallDomainErrorStats];
}

const endpointMetadataOnlyTools = new WeakMap<
  RegisteredEndpoint,
  ReadonlySet<string>
>();
const inFlightByCaller = new Map<string, number>();
const controlInFlightByCaller = new Map<string, number>();
const endpointRequestControllers = new WeakMap<
  MessagePort,
  Map<number, AbortController>
>();
const MAX_ENDPOINT_TOOLS = 64;
const MAX_CONCURRENT_CALLS_PER_ENDPOINT = 64;
const MAX_CONCURRENT_CONTROL_CALLS_PER_ENDPOINT = 1;
const MAX_PENDING_PROVIDER_APPROVALS = 64;
const PROVIDER_APPROVAL_TTL_MS =
  MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS * 1_000;
const ENDPOINT_TOOL_DISCOVERY_TIMEOUT_SECONDS = 10;
const CONTROL_CALL_TIMEOUT_SECONDS = 5;
const MAX_PENDING_TILE_VIEWS = 16;
const MAX_RETAINED_STATE_APPS = 128;
const MAX_RETAINED_STATE_TOPICS_PER_APP = 64;
const TILE_VIEW_TTL_MS = 10_000;
const MAX_APP_TILES_PER_WORKSPACE = 24;
const MAX_APP_TILES_GLOBAL = 96;
const pendingTileViews = new Map<string, { view: string; expiresAt: number }>();
type PendingProviderApproval = {
  capability: string;
  caller: RegisteredEndpoint;
  callerSessionId: string;
  callerInstalledVersion: number;
  callerAppVersion: number | undefined;
  callerAppGeneration: number | undefined;
  callerInstallationUid: string | undefined;
  authLogged: boolean;
  authAuthorized: boolean;
  authPrincipal: string;
  authSessionGeneration: number;
  target: RegisteredEndpoint;
  targetSessionId: string;
  targetInstalledVersion: number;
  targetAppVersion: number | undefined;
  targetAppGeneration: number | undefined;
  targetInstallationUid: string | undefined;
  descriptor: MsgBusToolDescriptor;
  expiresAt: number;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  sourceSignal?: AbortSignal;
  sourceAbort?: () => void;
  state: "pending" | "deciding" | "completed" | "denied";
};
const pendingProviderApprovals = new Map<string, PendingProviderApproval>();
type RetainedAppStateChange = Readonly<{
  event: AppStateChangeEnvelope;
  appGeneration: number | undefined;
  publisherEndpointId: string;
}>;
const retainedAppStateChanges = new Map<
  string,
  Map<string, RetainedAppStateChange>
>();
const deliveredAppStateChanges = new WeakMap<
  Window,
  { appGeneration: number | undefined; revisions: Map<string, string> }
>();
const vetKeysBroker = new VetKeysBrowserBroker({
  backend: {
    list: (appId) =>
      callKernelVetKeys("kernel_vetkeys_list", [{ app_id: appId }]),
    binding: vetKeysSlotBinding,
    lifecycle: (appId, action) => callVetKeysLifecycle(appId, action),
    publicKey: (appId, slot, generation) =>
      callKernelVetKeys("kernel_vetkeys_public_key", [
        { app_id: appId, slot_id: slot, generation },
      ]),
    derive: (appId, slot, generation, transportPublicKey, expectedSlotUid) =>
      callKernelVetKeys("kernel_vetkeys_derive", [
        {
          app_id: appId,
          slot_id: slot,
          expected_slot_uid: expectedSlotUid,
          generation,
          transport_public_key: transportPublicKey,
        },
      ]),
  },
  manifest: vetKeysManifest,
  auth: () => {
    const auth = useAuthStore.getState();
    return {
      logged: auth.logged,
      authorized: auth.authorized,
      principal: auth.principal,
    };
  },
  endpoint: getRegisteredEndpoint,
  authorityCommitted: () => !isFrontendAuthorityPending(),
  authorizeLifecycle: async ({ endpoint, action }) => {
    await requestFrontendToolPermission({
      caller: callerContext(endpoint),
      callerSessionId: endpoint.sessionId ?? "unconnected",
      target: "kernel",
      targetSessionId: "kernel-session",
      tool: `vetkeys.${action.action}`,
      arguments: lifecycleDisclosure(action),
      onceOnly: true,
    });
  },
});
subscribeEndpointChanges(flushPendingTileViews);
subscribeEndpointChanges(replayRetainedAppStateChanges);
subscribeEndpointChanges(() => vetKeysBroker.reconcileEndpoints());
subscribeEndpointChanges(reconcileProviderApprovalEndpoints);
let currentAuthSessionGeneration =
  useAuthStore.getState().sessionGeneration;
useAuthStore.subscribe((auth) => {
  if (auth.sessionGeneration !== currentAuthSessionGeneration) {
    currentAuthSessionGeneration = auth.sessionGeneration;
    clearAgentModeForAuth();
  }
  reconcileProviderApprovalEndpoints();
});
subscribeEndpointChanges(() =>
  reconcileAgentEndpoints((endpointId) => getRegisteredEndpoint(endpointId)),
);
subscribeEndpointChanges(reconcileInstallOffer);
subscribeEndpointPortRetirements(cancelEndpointPortRequests);
subscribeEndpointChanges(() =>
  reconcileEthereumProviderSessions(
    (endpointId) => getRegisteredEndpoint(endpointId)?.sessionId,
  ),
);
setAgentRootCancelDispatcher((root) => {
  const endpoint = getRegisteredEndpoint(root.endpointId);
  if (!endpoint || endpoint.sessionId !== root.endpointSessionId) return;
  void execEndpoint(
    endpoint,
    msgBusLocalActions.agentTurnCancel,
    { rootId: root.id },
    2,
  ).catch(() => undefined);
});
const { explainMethodSchema, toState, validateMethodInput } =
  icblast as unknown as {
    explainMethodSchema(
      target: unknown,
      method: string,
      options?: Readonly<{ allowNumberedPrincipals?: boolean }>,
    ): unknown;
    toState(value: unknown): unknown;
    validateMethodInput(
      target: unknown,
      method: string,
      args: unknown[],
      options?: Readonly<{ allowNumberedPrincipals?: boolean }>,
    ): { ok: boolean; errors?: unknown };
  };

const emptyObjectSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
};

function defineKernelTool(
  name: string,
  options: ExposedToolOptions,
  handler: KernelToolHandler,
): void {
  const descriptor = normalizeToolDescriptor({ name, ...options });
  kernelTools.set(name, { descriptor, handler });
}

function assertSchemaPayload(payload: JsonValue): KernelSchemaPayload {
  if (
    !isJsonObject(payload) ||
    typeof payload.canister !== "string" ||
    typeof payload.method !== "string"
  ) {
    throw new Error("Invalid schema request payload");
  }
  return {
    canister: canonicalCanisterPrincipal(payload.canister),
    method: payload.method,
  };
}

function assertCallPayload(payload: JsonValue): KernelCallPayload {
  const schemaPayload = assertSchemaPayload(payload);
  if (
    isJsonObject(payload) &&
    "args" in payload &&
    payload.args !== undefined &&
    !Array.isArray(payload.args)
  ) {
    throw new Error("Invalid call request payload");
  }
  return {
    ...schemaPayload,
    ...(isJsonObject(payload) && Array.isArray(payload.args)
      ? { args: [...payload.args] }
      : {}),
  } as KernelCallPayload;
}

function canonicalCanisterPrincipal(value: string): string {
  if (value.length > 0 && value.length <= CANISTER_PRINCIPAL_TEXT_MAX_LENGTH) {
    try {
      const canonical = Principal.fromText(value).toText();
      if (canonical === value) return canonical;
    } catch {
      // The public error is intentionally independent of parser internals.
    }
  }
  throw new KernelPolicyError(
    "INVALID_REQUEST",
    "Canister principal must be canonical",
  );
}

function assertToolCall(payload: JsonValue): MsgBusToolCall {
  if (
    !isJsonObject(payload) ||
    typeof payload.target !== "string" ||
    !isEndpointId(payload.target) ||
    typeof payload.name !== "string" ||
    (payload.arguments !== undefined && !isJsonObject(payload.arguments))
  ) {
    throw new Error("Invalid frontend tool call");
  }
  assertToolName(payload.name);
  return payload as MsgBusToolCall;
}

function assertToolsListPayload(payload: JsonValue): MsgBusEndpointId {
  if (!isJsonObject(payload)) throw new Error("Invalid tools.list payload");
  const target = payload.target ?? "kernel";
  if (!isEndpointId(target)) throw new Error("Invalid tool target");
  return target;
}

function assertAppStateChangePayload(payload: JsonValue): {
  topic: string;
  revision: string;
} {
  if (
    !isJsonObject(payload) ||
    Object.keys(payload).some((key) => key !== "topic" && key !== "revision") ||
    typeof payload.topic !== "string" ||
    !/^[a-z][a-z0-9_.-]{0,63}$/u.test(payload.topic) ||
    typeof payload.revision !== "string" ||
    !/^(0|[1-9][0-9]{0,127})$/u.test(payload.revision)
  ) {
    throw new Error("Invalid app state change");
  }
  return { topic: payload.topic, revision: payload.revision };
}

function isEndpointId(value: unknown): value is MsgBusEndpointId {
  if (value === "kernel") return true;
  if (typeof value !== "string") return false;
  const match =
    /^app:([^:]+):(?:background|tray:instance:[a-zA-Z0-9_-]+|tile:[a-z_0-9]+:instance:[a-zA-Z0-9_-]+)$/.exec(
      value,
    );
  return match !== null && isValidAppId(match[1]);
}

function assertJsonResult(value: unknown): JsonValue {
  assertBoundedJson(value, "Canister call result");
  return value;
}

async function getNeutronJsonCanister(): Promise<any> {
  const { getNeutronDynamicCan } = await import("./reducer/auth.ts");
  return getNeutronDynamicCan();
}

async function callKernelVetKeys(
  method: string,
  args: JsonValue[],
): Promise<JsonValue> {
  const target = await getNeutronJsonCanister();
  assertValidCall(target, method, args);
  let raw: unknown;
  try {
    raw = await target[method](...args);
  } catch (error) {
    let state: unknown;
    try {
      state = toState(error);
    } catch {
      throw error;
    }
    const normalized = normalizeVetKeysIcblastFailure(method, state);
    if (normalized === null) throw error;
    return normalized;
  }
  return normalizeVetKeysIcblastSuccess(
    method,
    assertJsonResult(normalizeCanisterCallResult(toState(raw))),
  );
}

function callVetKeysLifecycle(
  appId: string,
  action: VetKeysLifecycleAction,
): Promise<JsonValue> {
  const common = { app_id: appId, slot_id: action.slot };
  switch (action.action) {
    case "reserve":
    case "enable":
    case "disable":
    case "rotate":
      return callKernelVetKeys(`kernel_vetkeys_${action.action}`, [common]);
    case "retireGeneration":
      return callKernelVetKeys("kernel_vetkeys_retire_generation", [
        { ...common, generation: action.generation },
      ]);
    case "transfer":
      return callKernelVetKeys("kernel_vetkeys_transfer", [
        { ...common, new_holder: action.newHolder },
      ]);
    case "retireSlot":
      return callKernelVetKeys("kernel_vetkeys_retire_slot", [common]);
  }
}

function vetKeysManifest(appId: string): VetKeysManifestProjection | null {
  const apps = useAppsStore.getState();
  const app = apps.list[appId];
  const instance = apps.appInstances[appId];
  const declaration = declaredCapability(app, "vetkeys");
  if (!app || !instance || !declaration) return null;
  return {
    version: app.version,
    installationUid: instance.scope.installationUid,
    slots: declaration.slots.map(({ id, purpose }) => ({ id, purpose })),
  };
}

function lifecycleDisclosure(action: VetKeysLifecycleAction): JsonObject {
  switch (action.action) {
    case "retireGeneration":
      return {
        action: action.action,
        slot: action.slot,
        generation: action.generation,
      };
    case "transfer":
      return {
        action: action.action,
        slot: action.slot,
        newHolder: action.newHolder,
      };
    default:
      return { action: action.action, slot: action.slot };
  }
}

async function vetKeysSlotBinding(
  appId: string,
  slot: string,
): Promise<string> {
  const uid = unwrapVetKeysOperationResult(
    await callKernelVetKeys("kernel_vetkeys_binding", [
      { app_id: appId, slot_id: slot },
    ]),
    "vetKeys slot binding",
  );
  const text =
    typeof uid === "string"
      ? uid
      : typeof uid === "number" && Number.isSafeInteger(uid) && uid >= 0
        ? String(uid)
        : null;
  if (
    text === null ||
    !/^[1-9][0-9]{0,19}$/u.test(text) ||
    BigInt(text) > 18_446_744_073_709_551_615n
  ) {
    throw new Error("Invalid vetKeys slot binding");
  }
  return text;
}

const EXTERNAL_ICBLAST_JSON_OPTIONS = Object.freeze({
  allowNumberedPrincipals: false,
});

function assertValidCall(
  target: any,
  method: string,
  args: unknown[],
  options?: Readonly<{ allowNumberedPrincipals: false }>,
): void {
  const validation = validateMethodInput(target, method, args, options);
  if (!validation.ok) {
    throw new Error(
      "Invalid call JSON: " + JSON.stringify(validation.errors || []),
    );
  }
}

function requireLegacyIcblastActorMethod(
  target: any,
  method: string,
): (...args: unknown[]) => Promise<unknown> {
  const registered = target?.$methods?.get?.(method);
  if (typeof registered === "function") return registered;
  if (
    !Object.hasOwn(target ?? {}, method) ||
    typeof target[method] !== "function"
  ) {
    throw new Error(`Unknown canister method: ${method}`);
  }
  return target[method];
}

type StrictIcblastMethod = ((...args: unknown[]) => Promise<unknown>) & {
  prepare?: (...args: unknown[]) => Promise<unknown>;
};

function requireStrictIcblastActorMethod(
  target: any,
  method: string,
): StrictIcblastMethod {
  const methodTable = target?.$methods;
  if (typeof methodTable?.get !== "function") {
    throw new Error("Canister actor has no closed method registry");
  }
  const registered = methodTable.get(method);
  if (typeof registered !== "function") {
    throw new Error(`Unknown canister method: ${method}`);
  }
  return registered;
}

type PreparedExternalCall = Readonly<{
  reviewArgs: JsonValue[];
  invoke: () => Promise<unknown>;
}>;

type ExternalCanisterPolicy = Readonly<{
  description: string;
  loadSchemaTarget: (
    canister: string,
    assertAuthority: () => void,
    signal?: AbortSignal,
  ) => Promise<any>;
  loadCallTarget: (
    canister: string,
    assertAuthority: () => void,
    signal?: AbortSignal,
  ) => Promise<any>;
  methodSchema: (target: any, method: string) => JsonValue;
  prepareCall: (
    target: any,
    method: string,
    args: JsonValue[],
    assertAuthority: () => void,
  ) => Promise<PreparedExternalCall>;
  canonicalReview: boolean;
}>;

async function loadLegacyExternalTarget(
  canister: string,
  assertAuthority: () => void,
): Promise<any> {
  const { getLegacyExternalDynamicCan } = await import("./reducer/auth.ts");
  return getLegacyExternalDynamicCan(canister, assertAuthority);
}

async function loadStrictExternalTarget(
  canister: string,
  assertAuthority: () => void,
  signal?: AbortSignal,
): Promise<any> {
  const { getStrictExternalDynamicCan } = await import("./reducer/auth.ts");
  return getStrictExternalDynamicCan(canister, assertAuthority, signal);
}

async function loadStrictExternalDiscoveryTarget(
  canister: string,
  assertAuthority: () => void,
  signal?: AbortSignal,
): Promise<any> {
  const { getStrictExternalDiscoveryCan } = await import("./reducer/auth.ts");
  return getStrictExternalDiscoveryCan(canister, assertAuthority, signal);
}

async function prepareLegacyExternalCall(
  target: any,
  method: string,
  args: JsonValue[],
  assertAuthority: () => void,
): Promise<PreparedExternalCall> {
  assertValidCall(target, method, args);
  const targetMethod = requireLegacyIcblastActorMethod(target, method);
  assertAuthority();
  return Object.freeze({
    reviewArgs: args,
    invoke: () => targetMethod(...args),
  });
}

async function prepareStrictExternalCall(
  target: any,
  method: string,
  args: JsonValue[],
  assertAuthority: () => void,
): Promise<PreparedExternalCall> {
  assertValidCall(target, method, args, EXTERNAL_ICBLAST_JSON_OPTIONS);
  const targetMethod = requireStrictIcblastActorMethod(target, method);
  if (typeof targetMethod.prepare !== "function") {
    throw new Error("Canister actor does not support prepared calls");
  }
  assertAuthority();
  const rawPrepared = await targetMethod.prepare(...args);
  assertAuthority();
  if (
    rawPrepared === null ||
    typeof rawPrepared !== "object" ||
    !Array.isArray((rawPrepared as { args?: unknown }).args) ||
    typeof (rawPrepared as { invoke?: unknown }).invoke !== "function"
  ) {
    throw new Error("Canister actor returned an invalid prepared call");
  }
  const prepared = rawPrepared as {
    args: unknown[];
    invoke: () => Promise<unknown>;
  };
  const reviewArgs = assertJsonResult(prepared.args);
  if (!Array.isArray(reviewArgs)) {
    throw new Error("Prepared canister arguments must be an array");
  }
  return Object.freeze({
    reviewArgs,
    invoke: () => prepared.invoke(),
  });
}

const legacyExternalCanisterPolicy: ExternalCanisterPolicy = Object.freeze({
  description:
    "Ask the user to approve and execute one owner-authenticated canister method using the compatible JSON conversion contract.",
  loadSchemaTarget: loadLegacyExternalTarget,
  loadCallTarget: loadLegacyExternalTarget,
  methodSchema: (target, method) =>
    assertJsonResult(explainMethodSchema(target, method)),
  prepareCall: prepareLegacyExternalCall,
  canonicalReview: false,
});

const strictExternalCanisterPolicy: ExternalCanisterPolicy = Object.freeze({
  description:
    "Discover external Candid anonymously, canonically prepare the arguments, then ask the user to approve one owner-authenticated canister method.",
  loadSchemaTarget: loadStrictExternalDiscoveryTarget,
  loadCallTarget: loadStrictExternalTarget,
  methodSchema: (target, method) =>
    assertJsonResult(
      explainMethodSchema(target, method, EXTERNAL_ICBLAST_JSON_OPTIONS),
    ),
  prepareCall: prepareStrictExternalCall,
  canonicalReview: true,
});

function verifiedEndpoint(context: ExposedActionContext): RegisteredEndpoint {
  const endpoint = resolveRegisteredEndpoint(context.source);
  if (!endpoint) throw new Error("Unknown app endpoint");
  if (endpoint.origin && endpoint.origin !== context.origin) {
    throw new Error("App endpoint origin mismatch");
  }
  assertCurrentEndpointVersion(endpoint);
  return endpoint;
}

function assertCurrentEndpointVersion(endpoint: RegisteredEndpoint): void {
  assertFrontendAuthorityCommitted();
  assertEndpointAppScope(endpoint);
  // Kernel-owned surfaces carry installation scope, manifest version, and a
  // frontend registry generation. Scope is the authoritative reinstall
  // boundary; version/generation also revoke compatible in-place UI changes.
  if (endpoint.appVersion === undefined && endpoint.appGeneration === undefined)
    return;
  const apps = useAppsStore.getState();
  const app = apps.list[endpoint.context.appId];
  if (!app) throw new Error("App endpoint is no longer installed");
  const installedVersion = app.version;
  if (
    endpoint.appVersion !== undefined &&
    endpoint.appVersion !== installedVersion
  ) {
    throw new Error("App endpoint version is no longer current");
  }
  if (
    endpoint.appGeneration !== undefined &&
    endpoint.appGeneration !==
      (apps.runtimeGenerations[endpoint.context.appId] ?? 0)
  ) {
    throw new Error("App endpoint generation is no longer current");
  }
}

type EndpointDispatchBinding = Readonly<{
  endpoint: RegisteredEndpoint;
  sessionId: string | null;
  port: MessagePort | null;
}>;

function assertRegisteredEndpointCurrent(
  endpoint: RegisteredEndpoint,
): void {
  if (getRegisteredEndpoint(endpoint.endpointId) !== endpoint) {
    throw new KernelPolicyError(
      "REQUEST_CANCELLED",
      "An app endpoint changed before dispatch",
    );
  }
  assertCurrentEndpointVersion(endpoint);
}

function bindEndpointDispatch(
  endpoint: RegisteredEndpoint,
): EndpointDispatchBinding {
  assertRegisteredEndpointCurrent(endpoint);
  return {
    endpoint,
    sessionId: endpoint.sessionId ?? null,
    port: endpoint.port ?? null,
  };
}

function assertEndpointDispatchCurrent(
  binding: EndpointDispatchBinding,
): void {
  const { endpoint } = binding;
  assertRegisteredEndpointCurrent(endpoint);
  if (
    (endpoint.sessionId ?? null) !== binding.sessionId ||
    (endpoint.port ?? null) !== binding.port
  ) {
    throw new KernelPolicyError(
      "REQUEST_CANCELLED",
      "An app endpoint session changed before dispatch",
    );
  }
}

function assertCurrentSignedCallEndpoint(
  binding: SignedCallEndpointBinding,
  auth: Readonly<{
    logged: boolean;
    authorized: boolean;
    principal: string;
  }>,
): RegisteredEndpoint {
  const endpoint = assertSignedCallEndpointCurrent(binding);
  assertCurrentEndpointVersion(endpoint);
  const currentAuth = useAuthStore.getState();
  if (
    currentAuth.logged !== auth.logged ||
    currentAuth.authorized !== auth.authorized ||
    currentAuth.principal !== auth.principal
  ) {
    throw new KernelPolicyError(
      "REQUEST_CANCELLED",
      "Authorization changed while the signature request was pending",
    );
  }
  return endpoint;
}

function callerContext(endpoint: RegisteredEndpoint): MsgBusCaller {
  return {
    endpoint: endpoint.endpointId,
    appId: endpoint.context.appId,
    role: endpoint.context.role,
    ...(endpoint.sessionId ? { sessionId: endpoint.sessionId } : {}),
  };
}

function agentStatus(appId: string): JsonObject {
  const state = useAgentModeStore.getState();
  const app = useAppsStore.getState().list[appId];
  const entrypoints =
    declaredCapability(app, "agent_entrypoints")?.entrypoints ?? [];
  return {
    eligible: entrypoints.length > 0,
    enabled: state.grant?.appId === appId,
    running: state.activeRoot?.appId === appId,
    entrypoints,
  };
}

function kernelToolSupportsRequestCancellation(name: string): boolean {
  return (
    name === "canister.schema_v2" ||
    name === "canister.call_dialog_v2" ||
    name === "permissions.request" ||
    name === "source.files" ||
    name === "source.search" ||
    name === "source.read"
  );
}

function defineCanisterSchemaTool(
  name: "canister.schema" | "canister.schema_v2",
  policy: ExternalCanisterPolicy,
): void {
  defineKernelTool(
    name,
    {
      title: "Canister Method Schema",
      description:
        "Return the kernel-derived JSON schema for a canister method.",
      inputSchema: kernelSchemaPayloadSchema as JsonObject,
    },
    async (args, caller, invocation, invocationContext, signal) => {
      const requestSignal = kernelToolSupportsRequestCancellation(name)
        ? signal
        : undefined;
      const { assertAuthority } = captureSelfCallAuthority(
        caller,
        invocationContext,
        invocation,
        requestSignal,
      );
      assertAuthority();
      const { canister, method: logicalMethod } = assertSchemaPayload(args);
      if (canister !== neutron_id) {
        assertExternalCanisterCallTarget(canister, neutron_id);
        const target = await policy.loadSchemaTarget(
          canister,
          assertAuthority,
          requestSignal,
        );
        assertAuthority();
        return policy.methodSchema(target, logicalMethod);
      }
      const app = useAppsStore.getState().list[caller.context.appId];
      if (!app) throw new Error("Requesting app is not installed");
      const entry = requireConsentedSelfCall(app, logicalMethod);
      const target = await getNeutronJsonCanister();
      assertAuthority();
      return assertJsonResult(
        explainMethodSchema(
          target,
          requirePhysicalSelfCallMethod(caller.context.appId, entry),
        ),
      );
    },
  );
}

function defineCanisterCallDialogTool(
  name: "canister.call_dialog" | "canister.call_dialog_v2",
  policy: ExternalCanisterPolicy,
): void {
  defineKernelTool(
    name,
    {
      title: "Approved Canister Call",
      description: policy.description,
      inputSchema: kernelCallPayloadSchema as JsonObject,
      annotations: {
        "neutron:effects": ["signature_request", "network", "write"],
      },
    },
    createCanisterCallDialogHandler(name, policy),
  );
}

export function preparedCanisterCallAgentAction(
  canister: string,
  method: string,
  reviewArgs: JsonValue[],
  canonicalReview: boolean,
): JsonObject {
  return {
    canister,
    method,
    argumentCount: reviewArgs.length,
    argumentBytes: jsonPayloadBytes(reviewArgs),
    ...(canonicalReview ? { arguments: reviewArgs } : {}),
  };
}

function createCanisterCallDialogHandler(
  name: "canister.call_dialog" | "canister.call_dialog_v2",
  policy: ExternalCanisterPolicy,
): KernelToolHandler {
  return async (args, caller, invocation, invocationContext, signal) => {
    const requestSignal = kernelToolSupportsRequestCancellation(name)
      ? signal
      : undefined;
    const { callerBinding, assertAuthority } = captureSelfCallAuthority(
      caller,
      invocationContext,
      invocation,
      requestSignal,
    );
    assertAuthority();
    // The compatibility route reviews pre-conversion JSON. Agent decisions
    // require the exact arguments that dispatch, so fail before live discovery.
    if (invocation !== null && !policy.canonicalReview) {
      throw new KernelPolicyError(
        "INVALID_REQUEST",
        "Agent-scoped signed calls require canister.call_dialog_v2",
      );
    }
    const {
      canister,
      method: logicalMethod,
      args: methodArgs = [],
    } = assertCallPayload(args);
    if (canister === neutron_id) {
      throw new KernelPolicyError(
        "INVALID_REQUEST",
        "Same-canister calls require the attachment-aware API-1 self-call transport",
      );
    }
    assertExternalCanisterCallTarget(canister, neutron_id);
    if (!isJsonValue(methodArgs)) {
      throw new KernelPolicyError(
        "INVALID_REQUEST",
        "External canister arguments must be JSON values",
      );
    }
    const target = await policy.loadCallTarget(
      canister,
      assertAuthority,
      requestSignal,
    );
    assertAuthority();
    const prepared = await policy.prepareCall(
      target,
      logicalMethod,
      methodArgs as JsonValue[],
      assertAuthority,
    );
    assertAuthority();
    const agentApproved = await authorizeAgentPermission(
      caller,
      invocation,
      {
        kind: "signed_canister_call",
        persistence: "none",
        risk: "high",
        action: preparedCanisterCallAgentAction(
          canister,
          logicalMethod,
          prepared.reviewArgs,
          policy.canonicalReview,
        ),
      },
      requestSignal,
    );
    assertAuthority();
    if (!agentApproved) {
      const mode = verifiedCallMode(target, logicalMethod);
      await callRequest({
        canister,
        method: logicalMethod,
        ...(mode ? { mode } : {}),
        args: prepared.reviewArgs,
        canonicalArgs: policy.canonicalReview,
        binding: callerBinding,
        ...(requestSignal ? { signal: requestSignal } : {}),
      });
    }
    // Consent is only authorization to attempt this exact call. The source
    // endpoint, private session, installation scope, registry generation,
    // and global frontend authority must all still be current at dispatch.
    assertAuthority();
    // A revoked caller receives neither successful nor rejected reply data.
    // The call may still have executed, so the replacement error is explicit
    // that its outcome is unknown.
    const rawResult = await dispatchSignedCallWithReplyFence(() => {
      assertAuthority();
      return prepared.invoke();
    }, assertAuthority);
    return assertJsonResult(normalizeCanisterCallResult(toState(rawResult)));
  };
}

defineCanisterSchemaTool("canister.schema", legacyExternalCanisterPolicy);
defineCanisterSchemaTool("canister.schema_v2", strictExternalCanisterPolicy);
defineCanisterCallDialogTool(
  "canister.call_dialog",
  legacyExternalCanisterPolicy,
);
defineCanisterCallDialogTool(
  "canister.call_dialog_v2",
  strictExternalCanisterPolicy,
);

defineKernelTool(
  "backend_calls.request",
  {
    title: "Change Backend Access",
    description: "Ask the owner to apply backend access changes for this app.",
    inputSchema: {
      type: "object",
      required: ["actions"],
      properties: {
        actions: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            required: ["kind", "scope"],
            properties: {
              kind: { type: "string", enum: ["reserve", "release"] },
              scope: {
                type: "object",
                required: ["kind"],
                properties: {
                  kind: {
                    type: "string",
                    enum: ["exact", "principal", "method"],
                  },
                  principal: { type: "string", minLength: 3, maxLength: 80 },
                  method: {
                    type: "string",
                    minLength: 1,
                    maxLength: CANISTER_METHOD_MAX_LENGTH,
                    pattern: "^[a-zA-Z0-9_]+$",
                  },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    annotations: {
      "neutron:effects": [
        "persistent_permission",
        "network",
        "user_visible_ui",
        "write",
      ],
    },
  },
  (args, caller, invocation) =>
    requestBackendReservationForEndpoint(args, caller, {
      authorize: (request, signal) =>
        authorizeBackendAccess(caller, invocation, request, signal),
    }),
);

function authorizeBackendAccess(
  caller: RegisteredEndpoint,
  invocation: InvocationNode | null,
  request: NormalizedBackendAccessRequest,
  signal?: AbortSignal,
): Promise<boolean> {
  const { actions } = request;
  let risk: AgentPermissionSummary["risk"] = "medium";
  if (
    actions.some(
      (action) => action.kind === "reserve" && action.scope.kind !== "exact",
    )
  ) {
    risk = "high";
  }
  return authorizeAgentPermission(
    caller,
    invocation,
    {
      kind: "backend_access",
      persistence: actions.some((action) => action.kind === "reserve")
        ? "durable"
        : "none",
      risk,
      action: backendAccessAgentAction(request),
    },
    signal,
  );
}

export function backendAccessAgentAction(
  request: NormalizedBackendAccessRequest,
): JsonObject {
  return {
    endpoint: request.endpoint,
    requestingSurface: { ...request.source },
    actions: request.actions.map((action) => ({
      kind: action.kind,
      scope: {
        kind: action.scope.kind,
        ...(action.scope.principal
          ? { principal: action.scope.principal }
          : {}),
        ...(action.scope.method ? { method: action.scope.method } : {}),
      },
      ...(action.reservationPresentAtRequest !== undefined
        ? {
            reservationPresentAtRequest: action.reservationPresentAtRequest,
          }
        : {}),
    })),
    ...(request.call
      ? {
          thenCall: {
            method: request.call.method,
            args: request.call.args,
            ...(request.call.binaryFields &&
            request.call.binaryFields.length > 0
              ? {
                  binaryFields: request.call.binaryFields.map((field) => ({
                    path: field.path,
                    byteLength: field.byteLength,
                    sha256: field.sha256,
                  })),
                }
              : {}),
          },
        }
      : {}),
  };
}

defineKernelTool(
  "backend_calls.list",
  {
    title: "List Backend Access",
    description: "List backend-call reservations owned by this app.",
    inputSchema: emptyObjectSchema,
    annotations: { "neutron:effects": ["read"] },
  },
  (args, caller) => listBackendReservationsForEndpoint(args, caller),
);

defineKernelTool(
  "apps.list",
  {
    title: "List Installed Apps",
    description: "List installed app ids and short untrusted descriptions.",
    inputSchema: emptyObjectSchema,
    outputSchema: {
      type: "object",
      required: ["apps"],
      properties: {
        apps: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "description"],
            properties: {
              id: { type: "string" },
              description: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    annotations: { "neutron:effects": ["read"] },
  },
  () => ({
    apps: Object.entries(useAppsStore.getState().list).map(([id, app]) => ({
      id,
      description: safeDiscoveryText(app.description ?? app.name, 280),
    })),
  }),
);

defineKernelTool(
  "apps.describe",
  {
    title: "Describe Installed App",
    description:
      "Return tile, tray, and background metadata for one installed app.",
    inputSchema: {
      type: "object",
      required: ["appId"],
      properties: {
        appId: {
          type: "string",
          minLength: APP_ID_MIN_LENGTH,
          maxLength: APP_ID_MAX_LENGTH,
          pattern: APP_ID_SAFE_SCHEMA_PATTERN,
          not: { pattern: APP_ID_REPEATED_SEPARATOR_PATTERN },
        },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["id", "name", "tiles"] },
    annotations: { "neutron:effects": ["read"] },
  },
  (args) => describeInstalledApp(String(args.appId)),
);

for (const [name, options, operation] of [
  ["source.files", SOURCE_FILES_TOOL_OPTIONS, "list"],
  ["source.search", SOURCE_SEARCH_TOOL_OPTIONS, "search"],
  ["source.read", SOURCE_READ_TOOL_OPTIONS, "read"],
] as const) {
  defineKernelTool(
    name,
    options,
    async (args, caller, invocation, invocationContext, signal) => {
      const assertActiveRoot = (): void => {
        if (
          !isDirectAgentInvocation(invocation) ||
          resolveInvocation(caller, invocationContext) !== invocation
        ) {
          throw new KernelPolicyError(
            "INVOCATION_INVALID",
            "Installed source inspection is available only to the active Agent root",
          );
        }
      };
      assertActiveRoot();
      const { installedArtifactInspector } =
        await import("./source_inspection/runtime.ts");
      const result = await installedArtifactInspector[operation](args, signal);
      assertActiveRoot();
      return result;
    },
  );
}

defineKernelTool(
  "apps.install_offer",
  {
    title: "Offer an App Installation",
    description:
      "Ask the owner to review a .neutron package URL or a certified repository setup URL. This only presents a Kernel-owned prompt; installation still requires the normal final review.",
    inputSchema: {
      oneOf: [
        {
          type: "object",
          required: ["kind", "url"],
          properties: {
            kind: { const: "package_url" },
            url: { type: "string", minLength: 1, maxLength: 4_096 },
          },
          additionalProperties: false,
        },
        {
          type: "object",
          required: ["kind", "url"],
          properties: {
            kind: { const: "repository_setup_url" },
            url: { type: "string", minLength: 1, maxLength: 2_048 },
          },
          additionalProperties: false,
        },
      ],
    },
    outputSchema: {
      type: "object",
      required: ["presented", "requestId"],
      properties: {
        presented: { const: true },
        requestId: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      "neutron:effects": ["user_visible_ui", "network", "write"],
    },
  },
  async (args, caller, invocation) => {
    const auth = useAuthStore.getState();
    if (auth.loading || !auth.logged || !auth.authorized) {
      throw new KernelPolicyError(
        "OWNER_REQUIRED",
        "An authorized owner session is required to offer software",
      );
    }
    const app = useAppsStore.getState().list[caller.context.appId];
    if (!app) throw new Error("The requesting app is no longer installed");

    if (!invocation) {
      if (hasActiveInvocationForApp(caller.context.appId)) {
        throw new KernelPolicyError(
          "SCOPED_CONTEXT_REQUIRED",
          "Agent calls must use their scoped Kernel context",
        );
      }
      if (
        (caller.context.role !== "tile" && caller.context.role !== "tray") ||
        (!isFocusedTileCaller(caller) && !isFocusedTrayCaller(caller)) ||
        !hasTransientUserActivation()
      ) {
        throw new KernelPolicyError(
          "USER_INTERACTION_REQUIRED",
          "An install offer must come from a focused app button or an active agent invocation",
        );
      }
    }
    assertInstallOfferFlowsIdle();

    const rawUrl = String(args.url);
    const offer = normalizeInstallOffer(String(args.kind), rawUrl);
    const agentRoot = invocation
      ? useAgentModeStore.getState().activeRoot
      : null;
    if (invocation && (!agentRoot || agentRoot.id !== invocation.rootId)) {
      throw new KernelPolicyError(
        "INVOCATION_INVALID",
        "The agent root is no longer active",
      );
    }
    const rootAgentApp = agentRoot
      ? useAppsStore.getState().list[agentRoot.appId]
      : null;
    if (invocation && !rootAgentApp) {
      throw new KernelPolicyError(
        "INVOCATION_INVALID",
        "The agent app is no longer installed",
      );
    }
    const requester: AttestedInstallOfferRequester = invocation
      ? {
          kind: "agent",
          appId: caller.context.appId,
          appName: safeDiscoveryText(app.name, 120),
          rootAppId: agentRoot!.appId,
          rootAppName: safeDiscoveryText(rootAgentApp!.name, 120),
          entrypoint: agentRoot!.entrypoint,
          tool: invocation.tool,
          rootId: invocation.rootId,
        }
      : {
          kind: "app",
          appId: caller.context.appId,
          appName: safeDiscoveryText(app.name, 120),
          surface: caller.context.role,
        };
    const owner = {
      logged: auth.logged,
      authorized: auth.authorized,
      principal: auth.principal,
    };
    const endpointSource = caller.source;
    const endpointSessionId = caller.sessionId;
    const assertCurrent = (): void => {
      const current = getRegisteredEndpoint(caller.endpointId);
      if (
        current !== caller ||
        current?.source !== endpointSource ||
        current?.sessionId !== endpointSessionId ||
        caller.sessionId !== endpointSessionId
      ) {
        throw new KernelPolicyError(
          "REQUEST_CANCELLED",
          "The requesting app endpoint is no longer active",
        );
      }
      assertCurrentEndpointVersion(caller);
      const currentAuth = useAuthStore.getState();
      if (
        currentAuth.loading ||
        currentAuth.logged !== owner.logged ||
        currentAuth.authorized !== owner.authorized ||
        currentAuth.principal !== owner.principal
      ) {
        throw new KernelPolicyError(
          "REQUEST_CANCELLED",
          "Owner authorization changed while the install offer was open",
        );
      }
      if (
        invocation &&
        resolveInvocation(caller, invocationMetadata(invocation)) !== invocation
      ) {
        throw new KernelPolicyError(
          "INVOCATION_INVALID",
          "The agent invocation is no longer active",
        );
      }
      assertInstallOfferFlowsIdle();
    };
    const review: AppInstallOfferReview = {
      source: safeInstallOfferUrl(offer.url),
      requester,
    };
    const handle = requestInstallOffer({
      offer,
      requester,
      assertCurrent,
      onApprove() {
        if (offer.kind === "package_url") {
          void install_app(
            { kind: "url", url: offer.url },
            { installOnly: true, offer: review },
          ).catch(() => undefined);
          return;
        }
        startRepositorySetupFromOffer(offer.reference, requester);
      },
    });
    await handle.completion;
    return { presented: true, requestId: handle.requestId };
  },
);

defineKernelTool(
  "endpoints.list",
  {
    title: "List Live App Endpoints",
    description: "List the kernel and currently live app surface endpoints.",
    inputSchema: emptyObjectSchema,
    outputSchema: { type: "object", required: ["endpoints"] },
    annotations: { "neutron:effects": ["read"] },
  },
  () => ({
    endpoints: [
      { endpoint: "kernel", role: "kernel", connected: true },
      ...listRegisteredEndpoints().map((endpoint) => ({
        endpoint: endpoint.endpointId,
        appId: endpoint.context.appId,
        role: endpoint.context.role,
        connected: Boolean(endpoint.port),
        ...(endpoint.context.role === "tile"
          ? {
              tileId: endpoint.context.tileId,
              instanceId: endpoint.context.instanceId,
              workspace: endpoint.context.workspace,
            }
          : endpoint.context.role === "tray"
            ? { instanceId: endpoint.context.instanceId }
            : {}),
      })),
    ],
  }),
);

defineKernelTool(
  "attachments.delegate",
  {
    title: "Delegate One Attachment Call",
    description:
      "Create a short-lived one-use bridge from the current scoped invocation to one private-port attachment call.",
    inputSchema: emptyObjectSchema,
    outputSchema: {
      type: "object",
      required: ["token", "expiresAt"],
      properties: {
        token: {
          oneOf: [
            { type: "string", pattern: "^[a-f0-9]{48}$" },
            { type: "null" },
          ],
        },
        expiresAt: {
          oneOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
        },
      },
      additionalProperties: false,
    },
    annotations: { "neutron:effects": ["read"] },
  },
  (_args, caller, invocation) => {
    if (!invocation) return { token: null, expiresAt: null };
    return issueAttachmentDelegation(
      caller,
      invocationMetadata(invocation, invocation.depth === 0),
    );
  },
);

defineKernelTool(
  "permissions.request",
  {
    title: "Request App Tool Access",
    description:
      "Ask the user for a session grant to call another app endpoint.",
    inputSchema: {
      type: "object",
      required: ["target", "tool"],
      properties: {
        target: { type: "string", minLength: 1, maxLength: 240 },
        tool: { type: "string", minLength: 1, maxLength: 128 },
        arguments: { type: "object" },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["granted"],
      properties: { granted: { type: "boolean" } },
      additionalProperties: false,
    },
    annotations: { "neutron:effects": ["user_visible_ui"] },
  },
  async (args, caller, invocation, _invocationContext, signal) => {
    const target = String(args.target);
    const tool = String(args.tool);
    if (tool !== "*") assertToolName(tool);
    if (!isEndpointId(target) || target === "kernel") {
      throw new Error("Permission target must be a live app endpoint");
    }
    const targetEndpoint = getRegisteredEndpoint(target);
    if (!targetEndpoint) throw new Error(`Unknown endpoint '${target}'`);
    const callerDispatch = bindEndpointDispatch(caller);
    const targetDispatch = bindEndpointDispatch(targetEndpoint);
    const assertEndpointsCurrent = (): void => {
      throwIfRequestCancelled(signal);
      assertEndpointDispatchCurrent(callerDispatch);
      assertEndpointDispatchCurrent(targetDispatch);
    };
    assertEndpointsCurrent();
    if (targetEndpoint.context.appId === caller.context.appId) {
      return { granted: true };
    }
    const agentApproved = await authorizeAgentPermission(
      caller,
      invocation,
      {
        kind: "frontend_tool",
        persistence: "none",
        risk: "medium",
        action: {
          targetAppId: targetEndpoint.context.appId,
          targetRole: targetEndpoint.context.role,
          tool,
        },
      },
      signal,
    );
    assertEndpointsCurrent();
    if (!agentApproved) {
      await requestFrontendToolPermission({
        caller: callerContext(caller),
        ...(caller.sessionId ? { callerSessionId: caller.sessionId } : {}),
        target,
        ...(targetEndpoint.sessionId
          ? { targetSessionId: targetEndpoint.sessionId }
          : {}),
        tool,
        arguments: isJsonObject(args.arguments) ? args.arguments : {},
        sessionOnly: true,
        ...(signal ? { signal } : {}),
      });
      assertEndpointsCurrent();
    }
    return { granted: true };
  },
);

defineKernelTool(
  "audit.list",
  {
    title: "List App Tool Activity",
    description: "List recent message-bus calls made by the requesting app.",
    inputSchema: emptyObjectSchema,
    outputSchema: { type: "object", required: ["entries"] },
    annotations: { "neutron:effects": ["read"] },
  },
  (_args, caller) => ({
    entries: listMsgBusAudit().filter(
      (entry) => entry.caller.appId === caller.context.appId,
    ),
  }),
);

defineKernelTool(
  "workspace.inspect",
  WORKSPACE_INSPECT_TOOL_OPTIONS,
  (_args, caller, invocation) => {
    assertWorkspaceController(caller, invocation);
    return inspectWorkspace();
  },
);

defineKernelTool(
  "workspace.control",
  WORKSPACE_CONTROL_TOOL_OPTIONS,
  (args, caller, invocation) => {
    assertWorkspaceController(caller, invocation);
    const result = controlWorkspace(args, invocation);
    return { result, snapshot: inspectWorkspace() };
  },
);

defineKernelTool(
  "workspace.open_tile",
  {
    title: "Open App Tile",
    description: "Focus an existing installed app tile or open a new one.",
    inputSchema: {
      type: "object",
      required: ["appId", "tileId"],
      properties: {
        appId: {
          type: "string",
          minLength: APP_ID_MIN_LENGTH,
          maxLength: APP_ID_MAX_LENGTH,
          pattern: APP_ID_SAFE_SCHEMA_PATTERN,
          not: { pattern: APP_ID_REPEATED_SEPARATOR_PATTERN },
        },
        tileId: { type: "string", pattern: "^[a-z_0-9]+$" },
        workspace: {
          type: "integer",
          minimum: 1,
          maximum: MAX_WORKSPACES,
        },
        reuseExisting: { type: "boolean" },
        view: {
          type: "string",
          pattern: "^[a-z][a-z0-9_/-]{0,63}$",
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["instanceId", "workspace", "opened"],
      properties: {
        instanceId: { type: "string" },
        workspace: { type: "integer" },
        opened: { type: "boolean" },
      },
      additionalProperties: false,
    },
    annotations: { "neutron:effects": ["user_visible_ui", "write"] },
  },
  async (args, caller, invocation) => {
    const appId = String(args.appId);
    const tileId = String(args.tileId);
    requireInstalledAppTile(appId, tileId);
    const requestedWorkspace = Number(args.workspace ?? 0);
    const hasRequestedWorkspace = args.workspace !== undefined;
    const defaultWorkspace = useWorkspaceStore.getState().activeWorkspaceId;
    const workspaceValue = hasRequestedWorkspace
      ? requestedWorkspace
      : defaultWorkspace;
    if (!workspaceIds.includes(workspaceValue as WorkspaceId)) {
      throw new Error("Invalid workspace id");
    }
    const workspace = workspaceValue as WorkspaceId;
    if (workspace !== defaultWorkspace) {
      throw new KernelPolicyError(
        "OWNER_REQUIRED",
        "Apps can open tiles only in the current workspace",
      );
    }
    const reuseExisting = true;
    const view = typeof args.view === "string" ? args.view : null;

    const existing = findOpenAppTile(appId, tileId, workspace);
    assertAppTileCapacity(workspace, Boolean(existing), invocation);
    const challengedAgentReuse =
      Boolean(existing) &&
      invocation !== null &&
      !isDirectAgentInvocation(invocation);
    if (invocation) {
      await authorizeAgentPermission(caller, invocation, {
        kind: "workspace_open",
        persistence: "none",
        risk: "low",
        action: {
          appId,
          tileId,
          workspace,
          reuseExisting,
          createsTile: !existing,
        },
      });
    } else {
      assertScopedContextForActiveAppInvocation(caller, null);
    }
    if (useWorkspaceStore.getState().activeWorkspaceId !== workspace) {
      throw new KernelPolicyError(
        "REQUEST_CANCELLED",
        "The active workspace changed while navigation was pending",
      );
    }
    const currentExisting = findOpenAppTile(appId, tileId, workspace);
    if (
      challengedAgentReuse &&
      currentExisting?.instanceId !== existing?.instanceId
    ) {
      throw new KernelPolicyError(
        "REQUEST_CANCELLED",
        "The tile approved for focus is no longer open",
      );
    }
    return openOrFocusAppTile(appId, tileId, workspace, view, invocation);
  },
);

function requireInstalledAppTile(appId: string, tileId: string) {
  const app = useAppsStore.getState().list[appId];
  const tile = app?.tiles.find((candidate) => candidate.id === tileId);
  if (!app || !tile) throw new Error(`Unknown app tile '${appId}/${tileId}'`);
  return tile;
}

function openOrFocusAppTile(
  appId: string,
  tileId: string,
  workspace: WorkspaceId,
  view: string | null,
  invocation: InvocationNode | null,
): OpenAppTileResult {
  return openWorkspaceAppTile({
    appId,
    tileId,
    workspace,
    view,
    reuseExisting: true,
    invocation,
  });
}

type WorkspaceOpenRequest = {
  appId: string;
  tileId: string;
  workspace: WorkspaceId;
  view: string | null;
  reuseExisting: boolean;
  invocation: InvocationNode | null;
  relativeTo?: string;
  side?: InsertSide;
  size?: number;
};

function openWorkspaceAppTile({
  appId,
  tileId,
  workspace,
  view,
  reuseExisting,
  invocation,
  relativeTo,
  side,
  size,
}: WorkspaceOpenRequest): OpenAppTileResult {
  const tile = requireInstalledAppTile(appId, tileId);
  const existing = reuseExisting
    ? findOpenAppTile(appId, tileId, workspace)
    : null;
  assertAppTileCapacity(workspace, Boolean(existing), invocation);
  if (existing) {
    if (relativeTo && relativeTo !== existing.instanceId) {
      requireTileInWorkspace(relativeTo, workspace);
      useWorkspaceStore
        .getState()
        .moveTile(
          existing.instanceId,
          relativeTo,
          side ?? "right",
          size,
          workspace,
        );
    }
    focusOpenAppTile(existing.workspace, existing.instanceId);
    if (view) queueTileView(appId, tileId, existing.instanceId, view);
    return {
      instanceId: existing.instanceId,
      workspace: existing.workspace,
      opened: false,
    };
  }
  if (relativeTo) requireTileInWorkspace(relativeTo, workspace);
  const instance = useWorkspaceStore.getState().openTile(
    {
      appId,
      tileId,
      title: tile.title,
      path: tile.path,
      icon: tile.icon,
    },
    {
      workspaceId: workspace,
      ...(relativeTo ? { relativeTo } : {}),
      ...(side ? { side } : {}),
      ...(size !== undefined ? { size } : {}),
    },
  );
  if (useWorkspaceStore.getState().activeWorkspaceId === workspace) {
    focusTileElement(instance.id);
  } else {
    focusOpenAppTile(workspace, instance.id);
  }
  if (view) queueTileView(appId, tileId, instance.id, view);
  return { instanceId: instance.id, workspace, opened: true };
}

function findOpenAppTile(
  appId: string,
  tileId: string,
  requestedWorkspace: WorkspaceId | null,
): { instanceId: string; workspace: WorkspaceId } | null {
  const state = useWorkspaceStore.getState();
  const order = requestedWorkspace
    ? [requestedWorkspace]
    : [
        state.activeWorkspaceId,
        ...visibleWorkspaceIds(state).filter(
          (id) => id !== state.activeWorkspaceId,
        ),
      ];
  for (const workspace of order) {
    const instance = workspaceStateById(state.workspaces, workspace).tiles.find(
      (candidate) => candidate.appId === appId && candidate.tileId === tileId,
    );
    if (instance) return { instanceId: instance.id, workspace };
  }
  return null;
}

function assertWorkspaceController(
  caller: RegisteredEndpoint,
  invocation: InvocationNode | null,
): void {
  const app = useAppsStore.getState().list[caller.context.appId];
  const entrypoints =
    declaredCapability(app, "agent_entrypoints")?.entrypoints ?? [];
  if (
    caller.context.role !== "background" ||
    !app?.background ||
    entrypoints.length === 0
  ) {
    throw new KernelPolicyError(
      "OWNER_REQUIRED",
      "Workspace control is available only to a declared resident agent",
    );
  }
  if (invocation && !isDirectAgentInvocation(invocation)) {
    throw new KernelPolicyError(
      "INVOCATION_INVALID",
      "Delegated agents cannot control the workspace",
    );
  }
  assertScopedContextForActiveAppInvocation(caller, invocation);
}

function controlWorkspace(
  args: JsonObject,
  invocation: InvocationNode | null,
): JsonObject {
  const op = String(args.op);
  if (op === "open") {
    const workspace =
      args.workspace === undefined
        ? useWorkspaceStore.getState().activeWorkspaceId
        : requireVisibleWorkspace(Number(args.workspace));
    const result = openWorkspaceAppTile({
      appId: String(args.appId),
      tileId: String(args.tileId),
      workspace,
      view: typeof args.view === "string" ? args.view : null,
      reuseExisting: args.reuseExisting !== false,
      invocation,
      ...(typeof args.relativeTo === "string"
        ? { relativeTo: args.relativeTo }
        : {}),
      ...(typeof args.side === "string"
        ? { side: args.side as InsertSide }
        : {}),
      ...(typeof args.size === "number" ? { size: args.size } : {}),
    });
    return { op, ...result };
  }

  if (op === "focus") {
    const target = requireWorkspaceTile(String(args.instanceId));
    focusOpenAppTile(target.workspaceId, target.tile.id);
    return {
      op,
      instanceId: target.tile.id,
      workspace: target.workspaceId,
    };
  }

  if (op === "close") {
    const target = requireWorkspaceTile(String(args.instanceId));
    useWorkspaceStore.getState().closeTile(target.tile.id);
    return {
      op,
      instanceId: target.tile.id,
      workspace: target.workspaceId,
    };
  }

  if (op === "place") {
    const target = requireWorkspaceTile(String(args.instanceId));
    const relative = requireWorkspaceTile(String(args.relativeTo));
    if (target.workspaceId !== relative.workspaceId) {
      throw new Error("Tiles must be in the same workspace; use move instead");
    }
    if (target.tile.id === relative.tile.id) {
      throw new Error("A tile cannot be placed relative to itself");
    }
    useWorkspaceStore
      .getState()
      .moveTile(
        target.tile.id,
        relative.tile.id,
        args.side as InsertSide,
        typeof args.size === "number" ? args.size : undefined,
        target.workspaceId,
      );
    return {
      op,
      instanceId: target.tile.id,
      workspace: target.workspaceId,
    };
  }

  if (op === "resize") {
    const splitId = String(args.splitId);
    const workspace = requireWorkspaceForSplit(splitId);
    useWorkspaceStore
      .getState()
      .resizeSplits([{ splitId, ratio: Number(args.ratio) }], workspace);
    return { op, workspace };
  }

  if (op === "move") {
    const target = requireWorkspaceTile(String(args.instanceId));
    const workspace = requireVisibleWorkspace(Number(args.workspace));
    const relativeTo =
      typeof args.relativeTo === "string" ? args.relativeTo : undefined;
    if (relativeTo) {
      const relative = requireWorkspaceTile(relativeTo);
      if (relative.workspaceId !== workspace) {
        throw new Error("Relative tile is not in the target workspace");
      }
      if (relative.tile.id === target.tile.id) {
        throw new Error("A tile cannot be moved relative to itself");
      }
    }
    if (target.workspaceId === workspace) {
      if (relativeTo) {
        useWorkspaceStore
          .getState()
          .moveTile(
            target.tile.id,
            relativeTo,
            (args.side as InsertSide | undefined) ?? "right",
            typeof args.size === "number" ? args.size : undefined,
            workspace,
          );
      }
    } else {
      assertAppTileCapacity(workspace, false, invocation, false);
      useWorkspaceStore.getState().moveTileToWorkspace(
        target.workspaceId,
        target.tile.id,
        workspace,
        {
          ...(relativeTo ? { relativeTo } : {}),
          ...(typeof args.side === "string"
            ? { side: args.side as InsertSide }
            : {}),
          ...(typeof args.size === "number" ? { size: args.size } : {}),
        },
        false,
      );
    }
    return { op, instanceId: target.tile.id, workspace };
  }

  if (op === "switch") {
    const workspace = requireVisibleWorkspace(Number(args.workspace));
    useWorkspaceStore.getState().switchWorkspace(workspace);
    const focused = workspaceStateById(
      useWorkspaceStore.getState().workspaces,
      workspace,
    ).focusedTileId;
    if (focused) focusTileElement(focused);
    return { op, workspace };
  }

  if (op === "expand") {
    const target = requireWorkspaceTile(String(args.instanceId));
    focusOpenAppTile(target.workspaceId, target.tile.id);
    useWorkspaceStore.getState().setExpandedTile({
      workspaceId: target.workspaceId,
      instanceId: target.tile.id,
    });
    return {
      op,
      instanceId: target.tile.id,
      workspace: target.workspaceId,
    };
  }

  if (op === "restore") {
    useWorkspaceStore.getState().setExpandedTile(null);
    return { op };
  }

  throw new Error(`Unknown workspace operation '${op}'`);
}

function requireVisibleWorkspace(value: number): WorkspaceId {
  if (
    !workspaceIds.includes(value as WorkspaceId) ||
    !visibleWorkspaceIds(useWorkspaceStore.getState()).includes(
      value as WorkspaceId,
    )
  ) {
    throw new Error("Workspace is not available");
  }
  return value as WorkspaceId;
}

function requireWorkspaceTile(instanceId: string) {
  const target = workspaceTile(useWorkspaceStore.getState(), instanceId);
  if (!target) throw new Error(`Unknown tile instance '${instanceId}'`);
  return target;
}

function requireTileInWorkspace(
  instanceId: string,
  workspaceId: WorkspaceId,
): void {
  const target = requireWorkspaceTile(instanceId);
  if (target.workspaceId !== workspaceId) {
    throw new Error("Relative tile is not in the target workspace");
  }
}

function requireWorkspaceForSplit(splitId: string): WorkspaceId {
  const state = useWorkspaceStore.getState();
  for (const workspaceId of visibleWorkspaceIds(state)) {
    const layout = workspaceStateById(state.workspaces, workspaceId).layout;
    if (layout && layoutContainsSplit(layout, splitId)) return workspaceId;
  }
  throw new Error(`Unknown workspace split '${splitId}'`);
}

function layoutContainsSplit(layout: LayoutNode, splitId: string): boolean {
  if (layout.type === "tile") return false;
  return (
    layout.id === splitId ||
    layoutContainsSplit(layout.first, splitId) ||
    layoutContainsSplit(layout.second, splitId)
  );
}

function normalizeInstallOffer(
  kind: string,
  rawUrl: string,
): NormalizedInstallOffer {
  if (kind === "package_url") {
    const url = parseOfferedPackageUrl(rawUrl);
    return Object.freeze({ kind, url: url.href });
  }
  if (kind === "repository_setup_url") {
    const reference = parseRepositorySetupUrl(rawUrl, {
      allowLoopbackHttp: getRuntimeDeployment().allowLoopbackHttp,
    });
    const url = new URL(rawUrl.trim());
    return Object.freeze({
      kind,
      url: url.href,
      reference: Object.freeze({ ...reference }),
    });
  }
  throw new KernelPolicyError("INVALID_REQUEST", "Unknown install offer kind");
}

function assertInstallOfferFlowsIdle(): void {
  const apps = useAppsStore.getState();
  if (
    apps.operationBusy ||
    apps.operation ||
    apps.request ||
    apps.uninstallRequest ||
    apps.installError ||
    apps.pendingInstallRecovery ||
    apps.runtimeAuthorityFence
  ) {
    throw new KernelPolicyError("UI_BUSY", "Another app operation is active");
  }
  const repository = useRepositorySetupStore.getState();
  if (repository.phase !== "idle" || repository.reference) {
    throw new KernelPolicyError(
      "UI_BUSY",
      "A repository setup is already active",
    );
  }
}

function isFocusedTileCaller(caller: RegisteredEndpoint): boolean {
  if (caller.context.role !== "tile") return false;
  if (
    typeof document !== "undefined" &&
    typeof HTMLIFrameElement !== "undefined"
  ) {
    const active = document.activeElement;
    return (
      active instanceof HTMLIFrameElement &&
      active.contentWindow === caller.source
    );
  }
  const state = useWorkspaceStore.getState();
  return (
    state.activeWorkspaceId === caller.context.workspace &&
    workspaceStateById(state.workspaces, state.activeWorkspaceId)
      .focusedTileId === caller.context.instanceId
  );
}

function isFocusedTrayCaller(caller: RegisteredEndpoint): boolean {
  if (
    caller.context.role !== "tray" ||
    typeof document === "undefined" ||
    typeof HTMLIFrameElement === "undefined"
  ) {
    return false;
  }
  const active = document.activeElement;
  return (
    active instanceof HTMLIFrameElement &&
    active.contentWindow === caller.source
  );
}

function hasTransientUserActivation(): boolean {
  if (typeof navigator === "undefined") return false;
  return navigator.userActivation?.isActive === true;
}

function focusOpenAppTile(
  workspace: WorkspaceId,
  instanceId: string,
): void {
  const store = useWorkspaceStore.getState();
  if (
    store.expandedTile?.workspaceId !== workspace ||
    store.expandedTile.instanceId !== instanceId
  ) {
    store.setExpandedTile(null);
  }
  if (store.activeWorkspaceId !== workspace) store.switchWorkspace(workspace);
  useWorkspaceStore.getState().focusTile(instanceId);
  focusTileElement(instanceId);
}

function focusTileElement(instanceId: string, attempt = 0): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const workspaceState = useWorkspaceStore.getState();
  if (
    workspaceStateById(
      workspaceState.workspaces,
      workspaceState.activeWorkspaceId,
    ).focusedTileId !== instanceId
  ) {
    // Opening a tile records the navigation target before its iframe mounts.
    // Stop delayed focus work if the owner selects somewhere else meanwhile.
    return;
  }
  const frame = [
    ...document.querySelectorAll<HTMLIFrameElement>("iframe.tile-iframe"),
  ].find((candidate) => candidate.dataset.instanceId === instanceId);
  const workspaceLayer = frame?.closest?.<HTMLElement>(
    ".kernel-workspace-layer",
  );
  const workspaceReady =
    !workspaceLayer ||
    (workspaceLayer.dataset.active === "true" &&
      !workspaceLayer.hasAttribute("inert"));
  if (frame && workspaceReady) {
    frame.focus();
    if (document.activeElement === frame) {
      frame.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
  }
  if (attempt < 30) {
    globalThis.setTimeout(
      () => focusTileElement(instanceId, attempt + 1),
      16,
    );
  }
}

function waitForRegisteredEndpoint(
  endpointId: MsgBusEndpointId,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<RegisteredEndpoint> {
  const existing = getRegisteredEndpoint(endpointId);
  if (existing) return Promise.resolve(existing);
  if (signal?.aborted) {
    return Promise.reject(
      requestCancellationError(signal, "Endpoint registration was cancelled"),
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      result: { endpoint: RegisteredEndpoint } | { error: Error },
    ): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      unsubscribe();
      signal?.removeEventListener("abort", abort);
      if ("endpoint" in result) resolve(result.endpoint);
      else reject(result.error);
    };
    const timeout = globalThis.setTimeout(
      () =>
        finish({
          error: new Error(
            `Endpoint '${endpointId}' did not register after ${timeoutSeconds} seconds`,
          ),
        }),
      timeoutSeconds * 1_000,
    );
    const abort = (): void =>
      finish({
        error: requestCancellationError(
          signal,
          "Endpoint registration was cancelled",
        ),
      });
    const check = (): void => {
      const endpoint = getRegisteredEndpoint(endpointId);
      if (endpoint) finish({ endpoint });
    };
    const unsubscribe = subscribeEndpointChanges(check);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    check();
  });
}

function queueTileView(
  appId: string,
  tileId: string,
  instanceId: string,
  view: string,
): void {
  const endpointId = `app:${appId}:tile:${tileId}:instance:${instanceId}`;
  if (pendingTileViews.size >= MAX_PENDING_TILE_VIEWS) {
    const oldest = pendingTileViews.keys().next().value as string | undefined;
    if (oldest) pendingTileViews.delete(oldest);
  }
  pendingTileViews.set(endpointId, {
    view,
    expiresAt: Date.now() + TILE_VIEW_TTL_MS,
  });
  flushPendingTileViews();
}

function flushPendingTileViews(): void {
  const now = Date.now();
  for (const [endpointId, pending] of pendingTileViews) {
    if (pending.expiresAt <= now) {
      pendingTileViews.delete(endpointId);
      continue;
    }
    const endpoint = getRegisteredEndpoint(endpointId);
    if (!endpoint?.port) continue;
    endpoint.port.postMessage({
      type: "neutron:tile:view",
      version: 1,
      view: pending.view,
    } satisfies TileViewEnvelope);
    pendingTileViews.delete(endpointId);
  }
}

function describeInstalledApp(appId: string): JsonObject {
  const app = useAppsStore.getState().list[appId];
  if (!app) throw new Error(`Unknown app '${appId}'`);
  return {
    id: appId,
    name: safeDiscoveryText(app.name, 80),
    ...(app.description
      ? { description: safeDiscoveryText(app.description, 280) }
      : {}),
    version: app.version,
    tiles: app.tiles.map((tile) => ({
      id: tile.id,
      title: safeDiscoveryText(tile.title, 80),
      ...(tile.description
        ? { description: safeDiscoveryText(tile.description, 280) }
        : {}),
    })),
    background: app.background
      ? {
          ...(app.background.description
            ? {
                description: safeDiscoveryText(app.background.description, 280),
              }
            : {}),
        }
      : null,
    tray: app.tray
      ? {
          title: safeDiscoveryText(app.tray.title, 80),
        }
      : null,
    untrustedMetadata: true,
  };
}

function safeDiscoveryText(value: string, maximum: number): string {
  return normalizeUntrustedText(value, "installed app metadata", {
    maximumLength: maximum,
  });
}

function requireInstalledAppVersion(appId: string): number {
  const app = useAppsStore.getState().list[appId];
  if (!app) throw new Error(`App '${appId}' is no longer installed`);
  return app.version;
}

type PreparedBinarySelfMethod = {
  method: string;
  logicalMethod: string;
  mode: PreapprovedSelfCallType;
  candidMethod: IDL.FuncClass;
  reviewArgs: JsonValue[];
  boundBlobs: SelfCallWireBlob[];
  inputBinary: { count: number; bytes: number };
  rawInput: Uint8Array;
};

type BinarySelfCallResult = {
  value: JsonValue;
  blobs: SelfCallWireBlob[];
  inputBinary: { count: number; bytes: number };
  outputBinary: { count: number; bytes: number };
  mode: PreapprovedSelfCallType;
};

async function prepareBinarySelfMethod(
  caller: RegisteredEndpoint,
  tool:
    | "canister.query_self"
    | "canister.update_self"
    | "canister.call_dialog"
    | "backend_calls.request",
  logicalMethod: string,
  encodedArgs: JsonValue[],
  blobs: SelfCallWireBlob[],
  assertAuthority: () => void,
): Promise<PreparedBinarySelfMethod> {
  assertBoundedJson(
    encodedArgs,
    "Self-call metadata",
    SELF_CALL_METADATA_MAX_BYTES,
  );
  assertAuthority();
  const app = useAppsStore.getState().list[caller.context.appId];
  if (!app) throw new Error("Requesting app is not installed");
  const entry =
    tool === "canister.call_dialog" || tool === "backend_calls.request"
      ? requireConsentedSelfCall(app, logicalMethod)
      : requirePreapprovedSelfCall(
          app,
          logicalMethod,
          tool === "canister.query_self" ? "query" : "update",
        );
  if (entry.type === "internal") {
    throw new Error("Internal app methods cannot use the self-call transport");
  }
  const mode: PreapprovedSelfCallType = entry.type;
  const physicalMethod = requirePhysicalSelfCallMethod(
    caller.context.appId,
    entry,
  );
  const target = await getSelfCallTarget();
  assertAuthority();
  const idlFactory = target?.$idlFactory;
  if (typeof idlFactory !== "function") {
    throw new Error("Live Neutron Candid interface is unavailable");
  }
  const service = idlFactory({ IDL }) as IDL.ServiceClass;
  const candidMethod = requireSelfCallCandidMethod(
    service,
    physicalMethod,
    mode,
  );
  const materialized = materializeSelfCallArguments(
    encodedArgs,
    blobs,
    candidMethod.argTypes,
  );
  // The private self-call boundary is validated against the exact installed
  // live-Candid method. Public icblast JSON schemas intentionally project some
  // records into scalar shorthands, so applying that public schema here would
  // reject valid structural Candid values.
  const rawInput = Uint8Array.from(
    await target[`${physicalMethod}$`](...materialized.args),
  );
  assertAuthority();
  const measuredInput = preflightSelfCallRequest(
    rawInput,
    candidMethod.argTypes,
  );
  assertSelfCallRawRequestBytes(rawInput.byteLength, measuredInput.blobBytes);
  if (
    measuredInput.blobCount !== materialized.binary.count ||
    measuredInput.blobBytes !== materialized.binary.bytes
  ) {
    throw new Error("Self-call binary sidecars changed during Candid encoding");
  }
  return {
    method: physicalMethod,
    logicalMethod,
    mode,
    candidMethod,
    reviewArgs: materialized.metadata,
    boundBlobs: materialized.boundBlobs,
    inputBinary: {
      count: measuredInput.blobCount,
      bytes: measuredInput.blobBytes,
    },
    rawInput,
  };
}

async function executeBinarySelfMethod(
  caller: RegisteredEndpoint,
  request: {
    tool:
      | "canister.query_self"
      | "canister.update_self"
      | "canister.call_dialog"
      | "backend_calls.request";
    method: string;
    args: JsonValue[];
    blobs: SelfCallWireBlob[];
  },
  reservation: AttachmentCapacityReservation,
  invocationContext?: MsgBusInvocationMetadata,
  boundInvocation: InvocationNode | null = null,
  signal?: AbortSignal,
): Promise<BinarySelfCallResult> {
  const { callerBinding, assertAuthority } = captureSelfCallAuthority(
    caller,
    invocationContext,
    boundInvocation,
    signal,
  );
  assertAuthority();
  if (request.tool === "canister.call_dialog") {
    assertScopedContextForActiveAppInvocation(caller, boundInvocation);
  }
  const prepared = await prepareBinarySelfMethod(
    caller,
    request.tool,
    request.method,
    request.args,
    request.blobs,
    assertAuthority,
  );
  reservation.resize(selfCallReservationBytes(prepared.inputBinary.bytes));
  reservation.retainUntilSettlement();

  if (request.tool === "canister.call_dialog") {
    if (invocationContext !== undefined || boundInvocation !== null) {
      throw new KernelPolicyError(
        "USER_INTERACTION_REQUIRED",
        "Agents cannot invoke app backend methods through the self-call dialog",
      );
    }
    const inspections = await inspectBoundSelfCallBlobs(prepared.boundBlobs);
    assertAuthority();
    await callRequest({
      canister: neutron_id,
      method: prepared.logicalMethod,
      mode: prepared.mode,
      args: prepared.reviewArgs,
      ...(inspections.length > 0
        ? {
            binaryFields: inspections.map(({ path, byteLength, sha256 }) => ({
              path,
              byteLength,
              sha256,
            })),
          }
        : {}),
      binding: callerBinding,
      ...(signal ? { signal } : {}),
    });
    assertAuthority();
  }

  const agent = await getSelfCallAgent();
  assertAuthority();
  let rawReply: Uint8Array;
  if (prepared.mode === "query") {
    const response = await dispatchSignedCallWithReplyFence(() => {
      assertAuthority();
      return agent.query(neutron_id, {
        methodName: prepared.method,
        arg: prepared.rawInput,
      });
    }, assertAuthority);
    if (response.status !== QueryResponseStatus.Replied) {
      throw new Error("Self-call query was rejected by the canister");
    }
    rawReply = response.reply.arg;
  } else {
    rawReply = await dispatchSignedCallWithReplyFence(() => {
      assertAuthority();
      return submitRawSelfUpdate(
        agent,
        neutron_id,
        prepared.method,
        prepared.rawInput,
      );
    }, assertAuthority);
  }

  const measured = preflightSelfCallReply(
    rawReply,
    prepared.candidMethod.retTypes[0]!,
  );
  const decoded = IDL.decode(prepared.candidMethod.retTypes, rawReply);
  if (decoded.length !== 1) {
    throw new Error("Self-call reply must contain exactly one Candid value");
  }
  if (
    measured.blobCount > 0 &&
    isSelfCallDomainErrorResult(decoded[0], prepared.candidMethod.retTypes[0]!)
  ) {
    throw protectedBinarySelfCallDomainError({
      count: measured.blobCount,
      bytes: measured.blobBytes,
    });
  }
  let normalized: unknown;
  try {
    normalized = normalizeSelfCallResult(
      decoded[0],
      prepared.candidMethod.retTypes[0]!,
    );
  } catch (error) {
    throw classifyNullaryCanisterResultError(error) ?? error;
  }
  const encoded = encodeSelfCallResult(normalized);
  const outputBinary = selfCallBlobStats(encoded.blobs);
  if (
    outputBinary.count !== measured.blobCount ||
    outputBinary.bytes !== measured.blobBytes
  ) {
    throw new Error("Self-call binary result changed during Candid decoding");
  }
  assertAuthority();
  return {
    value: encoded.value,
    blobs: encoded.blobs,
    inputBinary: prepared.inputBinary,
    outputBinary,
    mode: prepared.mode,
  };
}

function captureSelfCallAuthority(
  caller: RegisteredEndpoint,
  invocationContext?: MsgBusInvocationMetadata,
  boundInvocation: InvocationNode | null = null,
  signal?: AbortSignal,
): {
  callerBinding: SignedCallEndpointBinding;
  assertAuthority: () => void;
} {
  const callerBinding = captureSignedCallEndpoint(caller);
  const callerAuth = useAuthStore.getState();
  const authBinding = Object.freeze({
    logged: callerAuth.logged,
    authorized: callerAuth.authorized,
    principal: callerAuth.principal,
  });
  const assertAuthority = (): void => {
    throwIfRequestCancelled(signal);
    assertCurrentSignedCallEndpoint(callerBinding, authBinding);
    if ((invocationContext === undefined) !== (boundInvocation === null)) {
      throw new KernelPolicyError(
        "INVOCATION_INVALID",
        "The agent invocation binding is incomplete",
      );
    }
    if (
      invocationContext !== undefined &&
      resolveInvocation(caller, invocationContext) !== boundInvocation
    ) {
      throw new KernelPolicyError(
        "INVOCATION_INVALID",
        "The agent invocation is no longer active",
      );
    }
  };
  return { callerBinding, assertAuthority };
}

async function executeBinaryBackendAccessRequest(
  caller: RegisteredEndpoint,
  request: SelfCallWireRequest,
  reservation: AttachmentCapacityReservation,
  invocationContext?: MsgBusInvocationMetadata,
  boundInvocation: InvocationNode | null = null,
  signal?: AbortSignal,
): Promise<BinarySelfCallResult> {
  if (
    request.tool !== "backend_calls.request" ||
    request.actions === undefined
  ) {
    throw new Error("Invalid attachment-aware backend access request");
  }
  const { assertAuthority } = captureSelfCallAuthority(
    caller,
    invocationContext,
    boundInvocation,
    signal,
  );
  let inputBinary = selfCallBlobStats(request.blobs);
  let outputBinary = { count: 0, bytes: 0 };
  let outputBlobs: SelfCallWireBlob[] = [];
  let mode: PreapprovedSelfCallType | null = null;

  const validate = async (method: string, args: JsonValue[]) => {
    if (method !== request.method) {
      throw new Error("Attachment-aware backend call binding changed");
    }
    const prepared = await prepareBinarySelfMethod(
      caller,
      request.tool,
      request.method,
      args,
      request.blobs,
      assertAuthority,
    );
    inputBinary = prepared.inputBinary;
    mode = prepared.mode;
    reservation.resize(selfCallReservationBytes(inputBinary.bytes));
    reservation.retainUntilSettlement();
    const inspections = await inspectBoundSelfCallBlobs(prepared.boundBlobs);
    assertAuthority();
    return {
      args: prepared.reviewArgs,
      ...(inspections.length > 0
        ? {
            binaryFields: inspections.map(({ path, byteLength, sha256 }) => ({
              path,
              byteLength,
              sha256,
            })),
          }
        : {}),
    };
  };

  const value = await requestBackendReservationForEndpoint(
    {
      actions: request.actions,
      call: { method: request.method, args: request.args },
    },
    caller,
    {
      validateSelfCall: validate,
      executeSelfCall: async (method, args) => {
        if (method !== request.method) {
          throw new Error("Attachment-aware backend call binding changed");
        }
        try {
          const result = await executeBinarySelfMethod(
            caller,
            { ...request, args },
            reservation,
            invocationContext,
            boundInvocation,
            signal,
          );
          mode = result.mode;
          outputBinary = result.outputBinary;
          outputBlobs = result.blobs.map((blob) => ({
            ...blob,
            path: ["callResult", ...blob.path],
          }));
          return result.value;
        } catch (error) {
          outputBinary = protectedBinarySelfCallStats(error) ?? {
            count: 0,
            bytes: 0,
          };
          throw error;
        }
      },
      authorize: (normalized, requestSignal) =>
        authorizeBackendAccess(
          caller,
          boundInvocation,
          normalized,
          requestSignal,
        ),
    },
    signal,
  );
  if (mode === null) {
    throw new Error("Attachment-aware backend call mode was not resolved");
  }
  return {
    value,
    blobs: outputBlobs,
    inputBinary,
    outputBinary,
    mode,
  };
}

async function invokeKernelTool(
  name: string,
  args: JsonObject,
  caller: RegisteredEndpoint,
  invocation: InvocationNode | null = null,
  invocationContext?: MsgBusInvocationMetadata,
  signal?: AbortSignal,
): Promise<JsonValue> {
  throwIfRequestCancelled(signal);
  const tool = kernelTools.get(name);
  if (!tool) throw new Error(`Unknown kernel tool '${name}'`);
  validateToolArguments(tool.descriptor, args);
  const result = await tool.handler(
    args,
    caller,
    invocation,
    invocationContext,
    signal,
  );
  throwIfRequestCancelled(signal);
  assertBoundedJson(result, `Kernel tool '${name}' result`);
  validateToolResult(tool.descriptor, result);
  return result;
}

export async function listTargetTools(
  target: MsgBusEndpointId,
  caller: RegisteredEndpoint,
  invocation: InvocationNode | null = null,
  signal?: AbortSignal,
): Promise<MsgBusToolDescriptor[]> {
  throwIfRequestCancelled(signal);
  if (target === "kernel") {
    return [...kernelTools.values()].map(({ descriptor }) => descriptor);
  }
  const endpoint = getRegisteredEndpoint(target);
  if (!endpoint) throw new Error(`Unknown endpoint '${target}'`);
  const callerDispatch = bindEndpointDispatch(caller);
  assertRegisteredEndpointCurrent(endpoint);
  if (invocation && endpoint.context.role === "tray") {
    throw new KernelPolicyError(
      "INVOCATION_INVALID",
      "Tray popouts are unavailable to delegated agent calls",
    );
  }
  const descriptors = await readEndpointTools(endpoint, signal);
  const targetDispatch = bindEndpointDispatch(endpoint);
  const visible = descriptors.filter((descriptor) =>
    endpointToolVisibleToCaller(descriptor, caller, endpoint, invocation),
  );
  assertEndpointDispatchCurrent(callerDispatch);
  if (visible.length === 0) return [];
  await authorizeEndpointAccess(
    caller,
    endpoint,
    "*",
    {},
    invocation,
    undefined,
    signal,
  );
  assertEndpointDispatchCurrent(callerDispatch);
  assertEndpointDispatchCurrent(targetDispatch);
  return visible;
}

function captureInvocationContext(
  metadata: MsgBusInvocationMetadata | undefined,
): MsgBusInvocationMetadata | undefined {
  if (metadata === undefined) return undefined;
  if (
    !isJsonObject(metadata) ||
    Object.keys(metadata).some(
      (key) =>
        key !== "id" &&
        key !== "rootId" &&
        key !== "capability" &&
        key !== "agentConsent",
    ) ||
    typeof metadata.id !== "string" ||
    typeof metadata.rootId !== "string" ||
    typeof metadata.capability !== "string" ||
    (metadata.agentConsent !== undefined &&
      typeof metadata.agentConsent !== "boolean")
  ) {
    throw new KernelPolicyError(
      "INVOCATION_INVALID",
      "Invalid invocation context",
    );
  }
  return Object.freeze({
    id: metadata.id,
    rootId: metadata.rootId,
    capability: metadata.capability,
    ...(metadata.agentConsent !== undefined
      ? { agentConsent: metadata.agentConsent }
      : {}),
  });
}

export async function routeToolCall(
  call: MsgBusToolCall,
  caller: RegisteredEndpoint,
  reportProgress?: (value: JsonValue) => void,
  metadata?: MsgBusInvocationMetadata,
  control?: NeutronToolControlMode,
  signal?: AbortSignal,
): Promise<JsonValue> {
  throwIfRequestCancelled(signal);
  assertCurrentEndpointVersion(caller);
  const invocationContext = captureInvocationContext(metadata);
  const requestSignal =
    call.target !== "kernel" || kernelToolSupportsRequestCancellation(call.name)
      ? signal
      : undefined;
  if (control && call.target === "kernel") {
    throw new Error("Kernel tools are unavailable through the control lane");
  }
  return withCallerConcurrency(
    caller,
    async () => {
      const invocation = resolveInvocation(caller, invocationContext);
      const startedAt = performance.now();
      const args = call.arguments ?? {};
      try {
        const result =
          call.target === "kernel"
            ? await invokeKernelTool(
                call.name,
                args,
                caller,
                invocation,
                invocationContext,
                requestSignal,
              )
            : await invokeEndpointTool(
                call.target,
                call.name,
                args,
                caller,
                reportProgress,
                invocation,
                control,
                requestSignal,
              );
        throwIfRequestCancelled(requestSignal);
        const metadataOnly = toolUsesMetadataOnlyAudit(call);
        recordMsgBusAudit({
          caller: callerContext(caller),
          target: call.target,
          tool: call.name,
          status: "ok",
          durationMs: Math.round(performance.now() - startedAt),
          arguments: auditToolArguments(call, args, metadataOnly),
          ...(metadataOnly
            ? {
                metadataBytes: {
                  input: jsonPayloadBytes(args),
                  output: jsonPayloadBytes(result),
                },
              }
            : {}),
          ...(!metadataOnly
            ? {
                result:
                  call.target === "kernel" &&
                  call.name === "attachments.delegate"
                    ? {
                        delegationIssued:
                          isJsonObject(result) &&
                          typeof result.token === "string",
                      }
                    : result,
              }
            : {}),
        });
        return result;
      } catch (error) {
        const metadataOnly = toolUsesMetadataOnlyAudit(call);
        recordMsgBusAudit({
          caller: callerContext(caller),
          target: call.target,
          tool: call.name,
          status: "error",
          durationMs: Math.round(performance.now() - startedAt),
          arguments: auditToolArguments(call, args, metadataOnly),
          ...(metadataOnly
            ? {
                metadataBytes: {
                  input: jsonPayloadBytes(args),
                  output: 0,
                },
              }
            : {}),
          error: metadataOnly
            ? "Metadata-only tool call failed"
            : errorMessage(error),
        });
        throw error;
      }
    },
    control ? "control" : "ordinary",
  );
}

function auditToolArguments(
  call: Pick<MsgBusToolCall, "target" | "name">,
  args: JsonObject,
  metadataOnly = false,
): JsonObject {
  if (metadataOnly) {
    const metadataBytes = new TextEncoder().encode(
      JSON.stringify(args),
    ).byteLength;
    if (
      call.target === "kernel" &&
      (call.name === "canister.query_self" ||
        call.name === "canister.update_self")
    ) {
      return {
        method: typeof args.method === "string" ? args.method : "invalid",
        mode: call.name.includes("query") ? "query" : "update",
        metadataBytes,
      };
    }
    return { metadataBytes };
  }
  if (call.target !== "kernel" || call.name !== "apps.install_offer") {
    return args;
  }
  return {
    kind: typeof args.kind === "string" ? args.kind : "invalid",
    source:
      typeof args.url === "string"
        ? safeInstallOfferUrl(args.url)
        : "Invalid source URL",
  };
}

function toolUsesMetadataOnlyAudit(
  call: Pick<MsgBusToolCall, "target" | "name">,
): boolean {
  if (call.target === "kernel") {
    return (
      kernelTools.get(call.name)?.descriptor.annotations?.["neutron:audit"] ===
      "metadata_only"
    );
  }
  const endpoint = getRegisteredEndpoint(call.target);
  return Boolean(
    endpoint && endpointMetadataOnlyTools.get(endpoint)?.has(call.name),
  );
}

export async function routeAttachmentToolCall(
  call: MsgBusToolCall,
  caller: RegisteredEndpoint,
  attachments: ToolAttachment[],
  reportProgress?: (value: JsonValue) => void,
  metadata?: MsgBusInvocationMetadata,
  reservation?: AttachmentCapacityReservation,
): Promise<AttachmentCallResult> {
  assertCurrentEndpointVersion(caller);
  assertToolAttachmentArray(attachments);
  const ownedReservation =
    reservation ??
    acquireAttachmentCapacity(caller, attachmentBytes(attachments));
  try {
    return await withCallerConcurrency(caller, async () => {
      const invocation = resolveInvocation(caller, metadata);
      const startedAt = performance.now();
      const args = call.arguments ?? {};
      try {
        const result =
          call.target === "kernel"
            ? (() => {
                throw attachmentError(
                  "ATTACHMENT_UNDECLARED",
                  "Kernel tools do not accept generic tool attachments",
                );
              })()
            : await invokeEndpointAttachmentTool(
                call.target,
                call.name,
                args,
                attachments,
                caller,
                ownedReservation,
                reportProgress,
                invocation,
              );
        const metadataOnly = toolUsesMetadataOnlyAudit(call);
        recordMsgBusAudit({
          caller: callerContext(caller),
          target: call.target,
          tool: call.name,
          status: "ok",
          durationMs: Math.round(performance.now() - startedAt),
          arguments: auditToolArguments(call, args, metadataOnly),
          ...(metadataOnly
            ? {
                metadataBytes: {
                  input: jsonPayloadBytes(args),
                  output: jsonPayloadBytes(result.value),
                },
              }
            : {}),
          ...(!metadataOnly ? { result: result.value } : {}),
          attachmentBytes: {
            input: attachmentBytes(attachments),
            output: attachmentBytes(result.attachments),
          },
        });
        return result;
      } catch (error) {
        const metadataOnly = toolUsesMetadataOnlyAudit(call);
        recordMsgBusAudit({
          caller: callerContext(caller),
          target: call.target,
          tool: call.name,
          status: "error",
          durationMs: Math.round(performance.now() - startedAt),
          arguments: auditToolArguments(call, args, metadataOnly),
          ...(metadataOnly
            ? {
                metadataBytes: {
                  input: jsonPayloadBytes(args),
                  output: 0,
                },
              }
            : {}),
          error: metadataOnly
            ? "Metadata-only tool call failed"
            : errorMessage(error),
          attachmentBytes: {
            input: attachmentBytes(attachments),
            output: 0,
          },
        });
        throw error;
      }
    });
  } finally {
    if (!reservation) ownedReservation.release();
  }
}

async function invokeEndpointTool(
  target: Exclude<MsgBusEndpointId, "kernel">,
  name: string,
  args: JsonObject,
  caller: RegisteredEndpoint,
  reportProgress?: (value: JsonValue) => void,
  invocation: InvocationNode | null = null,
  control?: NeutronToolControlMode,
  signal?: AbortSignal,
): Promise<JsonValue> {
  throwIfRequestCancelled(signal);
  const endpoint = getRegisteredEndpoint(target);
  if (!endpoint) throw new Error(`Unknown endpoint '${target}'`);
  const callerDispatch = bindEndpointDispatch(caller);
  assertRegisteredEndpointCurrent(endpoint);
  if (
    control &&
    (caller.context.appId !== endpoint.context.appId ||
      !sameAppScope(caller.appScope, endpoint.appScope))
  ) {
    throw new Error(
      "Control tool calls must remain within one app installation",
    );
  }
  let targetInvocation: InvocationNode | null = null;
  let providerApproval: PendingProviderApproval | null = null;
  if (!invocation && !control) {
    targetInvocation = beginAgentRoot({
      caller,
      target: endpoint,
      tool: name,
      ownerPrincipal: useAuthStore.getState().principal,
      installedVersion: requireInstalledAppVersion(endpoint.context.appId),
    });
  }
  try {
    const descriptors = await readEndpointTools(endpoint, signal);
    throwIfRequestCancelled(signal);
    const targetDispatch = bindEndpointDispatch(endpoint);
    const descriptor = descriptors.find((candidate) => candidate.name === name);
    if (
      !descriptor ||
      !endpointToolVisibleToCaller(descriptor, caller, endpoint, invocation)
    ) {
      throw new Error(`Unknown tool '${name}' on '${target}'`);
    }
    const agentRootAudience =
      descriptor.annotations?.["neutron:audience"] ===
      NEUTRON_TOOL_AUDIENCE_AGENT_ROOT;
    if (control && descriptor.annotations?.["neutron:control"] !== control) {
      throw new Error(`Tool '${name}' is not declared as ${control} control`);
    }
    const attachmentContract = parseToolAttachmentContract(descriptor);
    if (attachmentContract) {
      throw attachmentError(
        "ATTACHMENT_API_REQUIRED",
        `Tool '${name}' requires the binary attachment API`,
      );
    }
    validateToolArguments(descriptor, args);
    const effectiveInvocation = invocation ?? targetInvocation;
    const providerOnce =
      caller.context.appId !== endpoint.context.appId &&
      descriptor.annotations?.["neutron:consent"] ===
        NEUTRON_TOOL_CONSENT_PROVIDER_ONCE;
    if (providerOnce && !effectiveInvocation) {
      assertScopedContextForActiveAppInvocation(caller, null);
    }
    if (providerOnce && effectiveInvocation) {
      throw new KernelPolicyError(
        "INVOCATION_INVALID",
        "Provider-confirmed tools are unavailable to Agent invocations",
      );
    }
    if (!providerOnce) {
      await authorizeEndpointAccess(
        caller,
        endpoint,
        descriptor,
        args,
        effectiveInvocation,
        undefined,
        signal,
      );
      throwIfRequestCancelled(signal);
    }
    assertEndpointDispatchCurrent(callerDispatch);
    assertEndpointDispatchCurrent(targetDispatch);
    if (invocation) {
      targetInvocation = createChildInvocation(invocation, endpoint, name);
    }
    if (providerOnce) {
      providerApproval = createProviderApproval(
        caller,
        endpoint,
        descriptor,
        signal,
      );
    }
    const result = await execEndpoint(
      endpoint,
      msgBusLocalActions.toolsCall,
      {
        name,
        arguments: args,
        caller: callerContext(caller),
        ...(providerApproval
          ? {
              providerApproval: {
                capability: providerApproval.capability,
              },
              providerUi: true,
            }
          : {}),
        ...(agentRootAudience
          ? { audience: NEUTRON_TOOL_AUDIENCE_AGENT_ROOT }
          : {}),
      },
      control
        ? CONTROL_CALL_TIMEOUT_SECONDS
        : targetInvocation?.depth === 0 ? 0 : MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS,
      reportProgress,
      targetInvocation
        ? invocationMetadata(targetInvocation, targetInvocation.depth === 0)
        : undefined,
      providerApproval?.controller.signal ?? signal,
    );
    if (providerApproval) {
      assertProviderApprovalCurrent(providerApproval);
      if (providerApproval.state !== "completed") {
        throw new KernelPolicyError(
          "INVALID_REQUEST",
          "Provider-confirmed tool returned without completing its one-shot interaction",
        );
      }
    }
    throwIfRequestCancelled(signal);
    assertBoundedJson(result, `Tool '${name}' result`);
    validateToolResult(descriptor, result);
    return result;
  } finally {
    if (providerApproval) disposeProviderApproval(providerApproval);
    if (targetInvocation) completeInvocation(targetInvocation);
  }
}

function createProviderApproval(
  caller: RegisteredEndpoint,
  target: RegisteredEndpoint,
  descriptor: MsgBusToolDescriptor,
  signal?: AbortSignal,
): PendingProviderApproval {
  throwIfRequestCancelled(signal);
  if (pendingProviderApprovals.size >= MAX_PENDING_PROVIDER_APPROVALS) {
    throw new KernelPolicyError(
      "UI_BUSY",
      "Too many provider-confirmed requests are active",
    );
  }
  if (
    [...pendingProviderApprovals.values()].some(
      (pending) =>
        !pending.controller.signal.aborted &&
        pending.caller.endpointId === caller.endpointId &&
        pending.callerSessionId === (caller.sessionId ?? ""),
    )
  ) {
    throw new KernelPolicyError(
      "UI_BUSY",
      "This app surface already has a provider-confirmed request",
    );
  }
  assertCurrentEndpointVersion(caller);
  assertCurrentEndpointVersion(target);
  const auth = useAuthStore.getState();
  const controller = new AbortController();
  const capability = randomProviderApprovalCapability();
  const binding: PendingProviderApproval = {
    capability,
    caller,
    callerSessionId: caller.sessionId ?? "",
    callerInstalledVersion: requireInstalledAppVersion(caller.context.appId),
    callerAppVersion: caller.appVersion,
    callerAppGeneration: caller.appGeneration,
    callerInstallationUid: caller.appScope?.installationUid,
    authLogged: auth.logged,
    authAuthorized: auth.authorized,
    authPrincipal: auth.principal,
    authSessionGeneration: auth.sessionGeneration,
    target,
    targetSessionId: target.sessionId ?? "",
    targetInstalledVersion: requireInstalledAppVersion(target.context.appId),
    targetAppVersion: target.appVersion,
    targetAppGeneration: target.appGeneration,
    targetInstallationUid: target.appScope?.installationUid,
    descriptor,
    expiresAt: Date.now() + PROVIDER_APPROVAL_TTL_MS,
    controller,
    state: "pending",
  };
  if (signal) {
    binding.sourceSignal = signal;
    binding.sourceAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", binding.sourceAbort, { once: true });
    if (signal.aborted) binding.sourceAbort();
  }
  binding.timer = setTimeout(
    () =>
      controller.abort(
        new KernelPolicyError(
          "REQUEST_EXPIRED",
          "Provider-confirmed request expired",
        ),
      ),
    PROVIDER_APPROVAL_TTL_MS,
  );
  pendingProviderApprovals.set(capability, binding);
  return binding;
}

function disposeProviderApproval(binding: PendingProviderApproval): void {
  if (pendingProviderApprovals.get(binding.capability) === binding) {
    pendingProviderApprovals.delete(binding.capability);
  }
  if (binding.timer) clearTimeout(binding.timer);
  if (binding.sourceSignal && binding.sourceAbort) {
    binding.sourceSignal.removeEventListener("abort", binding.sourceAbort);
  }
  if (!binding.controller.signal.aborted) {
    binding.controller.abort(
      new KernelPolicyError(
        "REQUEST_CANCELLED",
        "Provider-confirmed request completed",
      ),
    );
  }
}

function assertProviderApprovalCurrent(binding: PendingProviderApproval): void {
  throwIfRequestCancelled(binding.controller.signal);
  if (
    pendingProviderApprovals.get(binding.capability) !== binding ||
    binding.expiresAt <= Date.now()
  ) {
    throw new KernelPolicyError(
      "REQUEST_EXPIRED",
      "Provider approval capability is no longer active",
    );
  }
  const caller = getRegisteredEndpoint(binding.caller.endpointId);
  const target = getRegisteredEndpoint(binding.target.endpointId);
  const auth = useAuthStore.getState();
  if (
    caller !== binding.caller ||
    target !== binding.target ||
    (caller.sessionId ?? "") !== binding.callerSessionId ||
    (target.sessionId ?? "") !== binding.targetSessionId ||
    caller.appVersion !== binding.callerAppVersion ||
    target.appVersion !== binding.targetAppVersion ||
    caller.appGeneration !== binding.callerAppGeneration ||
    target.appGeneration !== binding.targetAppGeneration ||
    caller.appScope?.installationUid !== binding.callerInstallationUid ||
    target.appScope?.installationUid !== binding.targetInstallationUid ||
    auth.logged !== binding.authLogged ||
    auth.authorized !== binding.authAuthorized ||
    auth.principal !== binding.authPrincipal ||
    auth.sessionGeneration !== binding.authSessionGeneration ||
    requireInstalledAppVersion(caller.context.appId) !==
      binding.callerInstalledVersion ||
    requireInstalledAppVersion(target.context.appId) !==
      binding.targetInstalledVersion
  ) {
    throw new KernelPolicyError(
      "REQUEST_CANCELLED",
      "An app surface changed during provider confirmation",
    );
  }
  assertCurrentEndpointVersion(caller);
  assertCurrentEndpointVersion(target);
}

function reconcileProviderApprovalEndpoints(): void {
  for (const binding of pendingProviderApprovals.values()) {
    if (binding.controller.signal.aborted) continue;
    try {
      assertProviderApprovalCurrent(binding);
    } catch (error) {
      binding.controller.abort(error);
    }
  }
}

function randomProviderApprovalCapability(): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const capability = [...bytes]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    if (!pendingProviderApprovals.has(capability)) return capability;
  }
  throw new Error("Unable to allocate provider approval capability");
}

async function requestProviderApprovalForEndpoint(
  payload: JsonValue,
  provider: RegisteredEndpoint,
  callbackInvocation: InvocationNode | null,
  signal?: AbortSignal,
): Promise<JsonValue> {
  const binding = pendingProviderInteraction(payload, provider);
  return consumeProviderInteraction(
    binding,
    callbackInvocation,
    signal,
    async () => {
      const request = payload as JsonObject;
      if (Object.keys(request).length !== 2 || !isJsonObject(request.review)) {
        throw new KernelPolicyError(
          "INVALID_REQUEST",
          "Provider approval review must be one closed JSON object",
        );
      }
      const review = request.review;
      assertBoundedJson(
        review,
        "Provider approval review",
        MSG_BUS_PROVIDER_APPROVAL_MAX_BYTES,
      );
      await requestFrontendToolPermission({
        caller: callerContext(binding.caller),
        callerSessionId: binding.callerSessionId,
        target: binding.target.endpointId,
        targetSessionId: binding.targetSessionId,
        tool: binding.descriptor.name,
        ...(binding.descriptor.title
          ? { toolTitle: binding.descriptor.title }
          : {}),
        ...(binding.descriptor.description
          ? { toolDescription: binding.descriptor.description }
          : {}),
        arguments: {},
        providerReview: review,
        onceOnly: true,
        requireFreshDecision: true,
        signal: binding.controller.signal,
      });
      assertProviderApprovalCurrent(binding);
      return { approved: true };
    },
  );
}

function pendingProviderInteraction(
  payload: JsonValue,
  provider: RegisteredEndpoint,
): PendingProviderApproval {
  if (!isJsonObject(payload) || typeof payload.capability !== "string") {
    throw new KernelPolicyError(
      "INVALID_REQUEST",
      "Invalid provider interaction request",
    );
  }
  const binding = pendingProviderApprovals.get(payload.capability);
  if (!binding || binding.target !== provider) {
    throw new KernelPolicyError(
      "INVALID_REQUEST",
      "Invalid provider interaction capability",
    );
  }
  if (binding.state !== "pending") {
    throw new KernelPolicyError(
      "INVALID_REQUEST",
      "Provider interaction capability was already consumed",
    );
  }
  return binding;
}

async function consumeProviderInteraction<T>(
  binding: PendingProviderApproval,
  callbackInvocation: InvocationNode | null,
  signal: AbortSignal | undefined,
  interact: () => Promise<T>,
): Promise<T> {
  throwIfRequestCancelled(signal);
  assertProviderApprovalCurrent(binding);
  if (callbackInvocation !== null) {
    throw new KernelPolicyError(
      "INVOCATION_INVALID",
      "Provider interactions are unavailable to Agent invocations",
    );
  }
  binding.state = "deciding";
  const abortFromRequest = (): void => binding.controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromRequest, { once: true });
  if (signal?.aborted) abortFromRequest();
  try {
    const result = await interact();
    assertProviderApprovalCurrent(binding);
    binding.state = "completed";
    return result;
  } catch (error) {
    binding.state = "denied";
    if (!binding.controller.signal.aborted) binding.controller.abort(error);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortFromRequest);
  }
}

async function presentProviderUiForEndpoint(
  payload: JsonValue,
  provider: RegisteredEndpoint,
  callbackInvocation: InvocationNode | null,
  signal?: AbortSignal,
): Promise<JsonValue> {
  const binding = pendingProviderInteraction(payload, provider);
  return consumeProviderInteraction(
    binding,
    callbackInvocation,
    signal,
    async () => {
      if (
        !isJsonObject(payload) ||
        Object.keys(payload).length !== 4 ||
        typeof payload.tileId !== "string" ||
        !/^[a-z_0-9]+$/u.test(payload.tileId) ||
        typeof payload.tool !== "string" ||
        !isJsonObject(payload.arguments)
      ) {
        throw new KernelPolicyError(
          "INVALID_REQUEST",
          "Invalid provider presentation request",
        );
      }
      assertToolName(payload.tool);
      assertBoundedJson(
        payload,
        "Provider presentation request",
        MSG_BUS_PROVIDER_APPROVAL_MAX_BYTES,
      );
      const tileId = payload.tileId;
      const toolName = payload.tool;
      const args = payload.arguments;
      const appId = binding.target.context.appId;
      const workspace = useWorkspaceStore.getState().activeWorkspaceId;
      const opened = openOrFocusAppTile(
        appId,
        tileId,
        workspace,
        null,
        null,
      );
      const endpointId = endpointIdForContext({
        role: "tile",
        appId,
        tileId,
        instanceId: opened.instanceId,
        workspace: opened.workspace,
      }) as MsgBusEndpointId;
      const tile = await waitForRegisteredEndpoint(
        endpointId,
        MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS,
        binding.controller.signal,
      );
      assertProviderPresentationTileCurrent(
        binding,
        tile,
        endpointId,
        tileId,
        opened.instanceId,
        workspace,
        true,
      );
      await waitForFrameEndpointPort(
        tile,
        ENDPOINT_TOOL_DISCOVERY_TIMEOUT_SECONDS,
        binding.controller.signal,
      );
      const tileDispatch = bindEndpointDispatch(tile);
      const descriptors = await readEndpointTools(
        tile,
        binding.controller.signal,
      );
      assertEndpointDispatchCurrent(tileDispatch);
      assertProviderPresentationTileCurrent(
        binding,
        tile,
        endpointId,
        tileId,
        opened.instanceId,
        workspace,
        true,
      );
      const descriptor = descriptors.find(
        (candidate) => candidate.name === toolName,
      );
      if (
        !descriptor ||
        descriptor.annotations?.["neutron:visibility"] !==
          NEUTRON_TOOL_VISIBILITY_SAME_APP ||
        descriptor.annotations?.["neutron:audience"] !==
          NEUTRON_TOOL_AUDIENCE_FOREGROUND_TILE
      ) {
        throw new KernelPolicyError(
          "INVALID_REQUEST",
          `Unknown provider presentation tool '${toolName}'`,
        );
      }
      validateToolArguments(descriptor, args);
      assertEndpointDispatchCurrent(tileDispatch);
      assertProviderPresentationTileCurrent(
        binding,
        tile,
        endpointId,
        tileId,
        opened.instanceId,
        workspace,
        true,
      );
      const result = await execEndpoint(
        tile,
        msgBusLocalActions.toolsCall,
        {
          name: toolName,
          arguments: args,
          caller: callerContext(binding.caller),
          audience: NEUTRON_TOOL_AUDIENCE_FOREGROUND_TILE,
        },
        MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS,
        undefined,
        undefined,
        binding.controller.signal,
      );
      assertEndpointDispatchCurrent(tileDispatch);
      assertProviderPresentationTileCurrent(
        binding,
        tile,
        endpointId,
        tileId,
        opened.instanceId,
        workspace,
        false,
      );
      assertBoundedJson(result, `Tool '${toolName}' result`);
      validateToolResult(descriptor, result);
      return result;
    },
  );
}

function assertProviderPresentationTileCurrent(
  binding: PendingProviderApproval,
  tile: RegisteredEndpoint,
  endpointId: MsgBusEndpointId,
  tileId: string,
  instanceId: string,
  workspace: WorkspaceId,
  requireMounted: boolean,
): void {
  assertProviderApprovalCurrent(binding);
  if (
    getRegisteredEndpoint(endpointId) !== tile ||
    tile.context.role !== "tile" ||
    tile.context.appId !== binding.target.context.appId ||
    tile.context.tileId !== tileId ||
    tile.context.instanceId !== instanceId ||
    !sameAppScope(binding.target.appScope, tile.appScope)
  ) {
    throw new KernelPolicyError(
      "REQUEST_CANCELLED",
      "Provider tile authority does not match the resident provider",
    );
  }
  if (requireMounted) {
    const instance = workspaceStateById(
      useWorkspaceStore.getState().workspaces,
      workspace,
    ).tiles.find((candidate) => candidate.id === instanceId);
    if (
      instance?.appId !== binding.target.context.appId ||
      instance.tileId !== tileId
    ) {
      throw new KernelPolicyError(
        "REQUEST_CANCELLED",
        "Provider tile is no longer open",
      );
    }
  }
  assertCurrentEndpointVersion(tile);
}

async function invokeEndpointAttachmentTool(
  target: Exclude<MsgBusEndpointId, "kernel">,
  name: string,
  args: JsonObject,
  attachments: ToolAttachment[],
  caller: RegisteredEndpoint,
  reservation: AttachmentCapacityReservation,
  reportProgress?: (value: JsonValue) => void,
  invocation: InvocationNode | null = null,
): Promise<AttachmentCallResult> {
  const endpoint = getRegisteredEndpoint(target);
  if (!endpoint) throw new Error(`Unknown endpoint '${target}'`);
  const callerDispatch = bindEndpointDispatch(caller);
  assertRegisteredEndpointCurrent(endpoint);
  if (!endpoint.port) {
    throw attachmentError(
      "ATTACHMENT_PRIVATE_PORT_REQUIRED",
      "Binary attachments require a connected private MessagePort",
    );
  }
  let targetInvocation: InvocationNode | null = null;
  if (!invocation) {
    targetInvocation = beginAgentRoot({
      caller,
      target: endpoint,
      tool: name,
      ownerPrincipal: useAuthStore.getState().principal,
      installedVersion: requireInstalledAppVersion(endpoint.context.appId),
    });
  }
  try {
    const descriptors = await raceWithAbort(
      readEndpointTools(endpoint),
      reservation.signal,
    );
    const targetDispatch = bindEndpointDispatch(endpoint);
    const descriptor = descriptors.find((candidate) => candidate.name === name);
    if (
      !descriptor ||
      !endpointToolVisibleToCaller(descriptor, caller, endpoint, invocation)
    ) {
      throw new Error(`Unknown tool '${name}' on '${target}'`);
    }
    const contract = parseToolAttachmentContract(descriptor);
    if (!contract) {
      throw attachmentError(
        "ATTACHMENT_UNDECLARED",
        `Tool '${name}' does not declare binary attachments`,
      );
    }
    validateToolAttachments(attachments, contract.input, "input");
    validateToolArguments(descriptor, args);
    reservation.bindEndpoint(endpoint);
    reservation.resize(
      attachmentBytes(attachments) + (contract.output?.maxBytes ?? 0),
    );

    const effectiveInvocation = invocation ?? targetInvocation;
    await raceWithAbort(
      authorizeEndpointAccess(
        caller,
        endpoint,
        descriptor,
        args,
        effectiveInvocation,
        {
          input: attachmentBytes(attachments),
          maximumOutput: contract.output?.maxBytes ?? 0,
        },
      ),
      reservation.signal,
    );
    assertEndpointDispatchCurrent(callerDispatch);
    assertEndpointDispatchCurrent(targetDispatch);
    if (invocation) {
      targetInvocation = createChildInvocation(invocation, endpoint, name);
    }
    const result = await execEndpointWithAttachments(
      endpoint,
      msgBusLocalActions.toolsCall,
      {
        name,
        arguments: args,
        caller: callerContext(caller),
      },
      attachments,
      {
        timeoutSeconds: MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS,
        ...(reportProgress ? { onProgress: reportProgress } : {}),
        ...(targetInvocation
          ? {
              invocation: invocationMetadata(
                targetInvocation,
                targetInvocation.depth === 0,
              ),
            }
          : {}),
        signal: reservation.signal,
      },
    );
    assertBoundedJson(result.value, `Tool '${name}' result`);
    validateToolResult(descriptor, result.value);
    validateToolAttachments(result.attachments, contract.output, "output");
    return result;
  } finally {
    if (targetInvocation) completeInvocation(targetInvocation);
  }
}

function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : attachmentError(
            "ATTACHMENT_CANCELLED",
            "Attachment call was cancelled",
          ),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : attachmentError(
              "ATTACHMENT_CANCELLED",
              "Attachment call was cancelled",
            ),
      );
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function readEndpointTools(
  endpoint: RegisteredEndpoint,
  signal?: AbortSignal,
): Promise<MsgBusToolDescriptor[]> {
  const value = await execEndpoint(
    endpoint,
    msgBusLocalActions.toolsList,
    null,
    ENDPOINT_TOOL_DISCOVERY_TIMEOUT_SECONDS,
    undefined,
    undefined,
    signal,
  );
  if (!Array.isArray(value) || value.length > MAX_ENDPOINT_TOOLS) {
    throw new Error("Invalid endpoint tool list");
  }
  const descriptors = value.map((descriptor) => {
    if (!isJsonObject(descriptor))
      throw new Error("Invalid endpoint tool descriptor");
    return normalizeToolDescriptor(descriptor as MsgBusToolDescriptor);
  });
  rememberEndpointAuditProfiles(endpoint, descriptors);
  return descriptors;
}

function rememberEndpointAuditProfiles(
  endpoint: RegisteredEndpoint,
  descriptors: readonly MsgBusToolDescriptor[],
): void {
  endpointMetadataOnlyTools.set(
    endpoint,
    new Set(
      descriptors
        .filter(
          (descriptor) =>
            descriptor.annotations?.["neutron:audit"] === "metadata_only",
        )
        .map((descriptor) => descriptor.name),
    ),
  );
}

function endpointToolVisibleToCaller(
  descriptor: MsgBusToolDescriptor,
  caller: RegisteredEndpoint,
  endpoint: RegisteredEndpoint,
  invocation: InvocationNode | null,
): boolean {
  const audience = descriptor.annotations?.["neutron:audience"];
  if (audience === NEUTRON_TOOL_AUDIENCE_FOREGROUND_TILE) return false;
  if (audience === NEUTRON_TOOL_AUDIENCE_AGENT_ROOT) {
    return isDirectAgentInvocation(invocation);
  }
  if (
    descriptor.annotations?.["neutron:visibility"] !==
    NEUTRON_TOOL_VISIBILITY_SAME_APP
  ) {
    return true;
  }
  return (
    caller.context.appId === endpoint.context.appId &&
    sameAppScope(caller.appScope, endpoint.appScope)
  );
}

async function authorizeEndpointAccess(
  caller: RegisteredEndpoint,
  target: RegisteredEndpoint,
  descriptor: MsgBusToolDescriptor | string,
  args: JsonObject,
  invocation: InvocationNode | null = null,
  attachmentBytes?: { input: number; maximumOutput: number },
  signal?: AbortSignal,
): Promise<void> {
  throwIfRequestCancelled(signal);
  const callerDispatch = bindEndpointDispatch(caller);
  const targetDispatch = bindEndpointDispatch(target);
  const tool = typeof descriptor === "string" ? descriptor : descriptor.name;
  if (caller.context.appId === target.context.appId) return;
  const agentPermission: AgentPermissionSummary = {
    kind: "frontend_tool",
    persistence: "none",
    risk: "medium",
    action: {
      targetAppId: target.context.appId,
      targetRole: target.context.role,
      tool,
      argumentCount: Object.keys(args).length,
      argumentBytes: JSON.stringify(args).length,
      ...(attachmentBytes
        ? {
            attachmentInputBytes: attachmentBytes.input,
            attachmentMaximumOutputBytes: attachmentBytes.maximumOutput,
          }
        : {}),
    },
  };
  if (invocation) {
    await authorizeAgentPermission(
      caller,
      invocation,
      agentPermission,
      signal,
    );
    throwIfRequestCancelled(signal);
    assertEndpointDispatchCurrent(callerDispatch);
    assertEndpointDispatchCurrent(targetDispatch);
    return;
  }
  if (
    hasFrontendToolGrant(
      callerContext(caller),
      caller.sessionId,
      target.endpointId,
      target.sessionId,
      tool,
    )
  ) {
    assertEndpointDispatchCurrent(callerDispatch);
    assertEndpointDispatchCurrent(targetDispatch);
    return;
  }
  const agentApproved = await authorizeAgentPermission(
    caller,
    null,
    agentPermission,
    signal,
  );
  throwIfRequestCancelled(signal);
  if (agentApproved) {
    assertEndpointDispatchCurrent(callerDispatch);
    assertEndpointDispatchCurrent(targetDispatch);
    return;
  }
  await requestFrontendToolPermission({
    caller: callerContext(caller),
    ...(caller.sessionId ? { callerSessionId: caller.sessionId } : {}),
    target: target.endpointId,
    ...(target.sessionId ? { targetSessionId: target.sessionId } : {}),
    tool,
    ...(typeof descriptor !== "string" && descriptor.title
      ? { toolTitle: descriptor.title }
      : {}),
    ...(typeof descriptor !== "string" && descriptor.description
      ? { toolDescription: descriptor.description }
      : {}),
    arguments: args,
    ...(attachmentBytes ? { attachmentBytes } : {}),
    ...(signal ? { signal } : {}),
  });
  throwIfRequestCancelled(signal);
  assertEndpointDispatchCurrent(callerDispatch);
  assertEndpointDispatchCurrent(targetDispatch);
}

async function authorizeAgentPermission(
  caller: RegisteredEndpoint,
  invocation: InvocationNode | null,
  summary: AgentPermissionSummary,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfRequestCancelled(signal);
  if (invocation) {
    if (isDirectAgentInvocation(invocation)) return true;
    await requestAgentConsent(
      invocation,
      summary,
      (challenge, decisionSignal) =>
        dispatchAgentConsent(invocation, challenge, decisionSignal),
      signal,
    );
    throwIfRequestCancelled(signal);
    return true;
  }
  assertScopedContextForActiveAppInvocation(caller, invocation);
  if (caller.context.role === "background") {
    const category =
      summary.kind === "frontend_tool"
        ? "frontend_tool"
        : summary.kind === "signed_canister_call"
          ? "signed_canister_call"
          : summary.kind === "backend_access"
            ? "backend_access"
            : summary.kind === "connection"
              ? "connection"
              : null;
    const declared = declaredCapability(
      useAppsStore.getState().list[caller.context.appId],
      "background_ui_requests",
    )?.categories;
    if (!category || !declared?.includes(category)) {
      throw new KernelPolicyError(
        "OWNER_REQUIRED",
        "This background process did not declare this UI request",
      );
    }
  }
  return false;
}

function assertScopedContextForActiveAppInvocation(
  caller: RegisteredEndpoint,
  invocation: InvocationNode | null,
): void {
  if (invocation || !hasActiveInvocationForApp(caller.context.appId)) return;
  throw new KernelPolicyError(
    "SCOPED_CONTEXT_REQUIRED",
    "Nested app calls must use context.kernel",
  );
}

function assertAppTileCapacity(
  workspace: WorkspaceId,
  reusesExisting: boolean,
  invocation: InvocationNode | null,
  increasesGlobalCount = true,
): void {
  if (reusesExisting) return;
  const state = useWorkspaceStore.getState();
  const workspaceCount = workspaceStateById(state.workspaces, workspace).tiles
    .length;
  const globalCount = visibleWorkspaceIds(state).reduce(
    (count, id) =>
      count + workspaceStateById(state.workspaces, id).tiles.length,
    0,
  );
  if (
    workspaceCount < MAX_APP_TILES_PER_WORKSPACE &&
    (!increasesGlobalCount || globalCount < MAX_APP_TILES_GLOBAL)
  ) {
    return;
  }
  throw new KernelPolicyError(
    invocation ? "AGENT_MODE_LIMIT" : "UI_BUSY",
    workspaceCount >= MAX_APP_TILES_PER_WORKSPACE
      ? "Current workspace tile capacity reached"
      : "Workspace tile capacity reached",
  );
}

async function dispatchAgentConsent(
  invocation: InvocationNode,
  challenge: import("neutron-tools/protocol").AgentConsentChallenge,
  signal?: AbortSignal,
): Promise<import("neutron-tools/protocol").AgentConsentDecision> {
  const root = rootEndpoint(invocation);
  const endpoint = getRegisteredEndpoint(root.endpointId);
  if (!endpoint || endpoint.sessionId !== root.endpointSessionId) {
    throw new KernelPolicyError(
      "AGENT_MODE_REVOKED",
      "Agent resident process is no longer connected",
    );
  }
  const result = await execEndpoint(
    endpoint,
    msgBusLocalActions.agentConsentDecide,
    challenge,
    30,
    undefined,
    undefined,
    signal,
  );
  if (
    !isJsonObject(result) ||
    (result.decision !== "allow" && result.decision !== "deny") ||
    typeof result.reason !== "string"
  ) {
    throw new KernelPolicyError(
      "AGENT_CONSENT_DENIED",
      "Agent returned an invalid permission decision",
    );
  }
  return { decision: result.decision, reason: result.reason };
}

async function execEndpoint(
  endpoint: RegisteredEndpoint,
  action: string,
  payload: JsonValue,
  timeout: number,
  reportProgress?: (value: JsonValue) => void,
  metadata?: MsgBusInvocationMetadata,
  signal?: AbortSignal,
): Promise<JsonValue> {
  assertRegisteredEndpointCurrent(endpoint);
  const options =
    reportProgress || metadata || signal
      ? {
          timeout,
          ...(reportProgress ? { onProgress: reportProgress } : {}),
          ...(metadata ? { transportContext: { invocation: metadata } } : {}),
          ...(signal ? { signal } : {}),
        }
      : timeout;
  if (endpoint.port) {
    const dispatch = bindEndpointDispatch(endpoint);
    if (!dispatch.port) {
      throw new KernelPolicyError(
        "REQUEST_CANCELLED",
        "An app endpoint disconnected before dispatch",
      );
    }
    assertEndpointDispatchCurrent(dispatch);
    return execPort(dispatch.port, action, payload, options);
  }
  const port = await waitForFrameEndpointPort(endpoint, timeout || MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS, signal);
  const dispatch = bindEndpointDispatch(endpoint);
  if (dispatch.port !== port) {
    throw new KernelPolicyError(
      "REQUEST_CANCELLED",
      "An app endpoint session changed before dispatch",
    );
  }
  assertEndpointDispatchCurrent(dispatch);
  return execPort(port, action, payload, options);
}

async function withCallerConcurrency<T>(
  caller: RegisteredEndpoint,
  operation: () => Promise<T>,
  lane: "ordinary" | "control" = "ordinary",
): Promise<T> {
  const calls = lane === "control" ? controlInFlightByCaller : inFlightByCaller;
  const maximum =
    lane === "control"
      ? MAX_CONCURRENT_CONTROL_CALLS_PER_ENDPOINT
      : MAX_CONCURRENT_CALLS_PER_ENDPOINT;
  const active = calls.get(caller.endpointId) ?? 0;
  if (active >= maximum) {
    throw new Error(
      lane === "control"
        ? "Too many concurrent frontend control calls"
        : "Too many concurrent frontend tool calls",
    );
  }
  calls.set(caller.endpointId, active + 1);
  try {
    return await operation();
  } finally {
    const remaining = (calls.get(caller.endpointId) ?? 1) - 1;
    if (remaining > 0) calls.set(caller.endpointId, remaining);
    else calls.delete(caller.endpointId);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isJsonObject(error) && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

expose("tools.call", async (payload, context) =>
  routeToolCall(
    assertToolCall(payload),
    verifiedEndpoint(context),
    context.reportProgress,
    context.invocation,
    undefined,
    context.signal,
  ),
);

expose("tools.call.control", async (payload, context) => {
  const caller = verifiedEndpoint(context);
  if (context.invocation) {
    throw new KernelPolicyError(
      "INVOCATION_INVALID",
      "Delegated calls cannot use the frontend control lane",
    );
  }
  return routeToolCall(
    assertToolCall(payload),
    caller,
    context.reportProgress,
    undefined,
    NEUTRON_TOOL_CONTROL_CANCEL,
    context.signal,
  );
});

expose("tools.list", async (payload, context) => {
  const endpoint = verifiedEndpoint(context);
  const invocation = resolveInvocation(endpoint, context.invocation);
  return withCallerConcurrency(endpoint, () =>
    listTargetTools(
      assertToolsListPayload(payload),
      endpoint,
      invocation,
      context.signal,
    ),
  );
});

for (const action of [
  "apps.list",
  "apps.describe",
  "endpoints.list",
] as const) {
  expose(action, async (payload, context) => {
    const endpoint = verifiedEndpoint(context);
    if (!isJsonObject(payload)) throw new Error(`Invalid ${action} payload`);
    return invokeKernelTool(
      action,
      payload,
      endpoint,
      resolveInvocation(endpoint, context.invocation),
      context.invocation,
      context.signal,
    );
  });
}

expose("permissions.request", async (payload, context) => {
  const endpoint = verifiedEndpoint(context);
  if (!isJsonObject(payload)) {
    throw new Error("Invalid permissions.request payload");
  }
  return invokeKernelTool(
    "permissions.request",
    payload,
    endpoint,
    resolveInvocation(endpoint, context.invocation),
    context.invocation,
    context.signal,
  );
});

// Provider approval is a private, one-use callback available only to the exact
// annotated tool handler that received its capability. It is not discoverable
// through kernel tools and never accepts caller or provider identity in args.
expose("provider_approval.request", async (payload, context) => {
  const provider = verifiedEndpoint(context);
  return requestProviderApprovalForEndpoint(
    payload,
    provider,
    resolveInvocation(provider, context.invocation),
    context.signal,
  );
});

// New provider-owned flows use the same one-shot capability to open the
// provider's own tile. The Kernel binds and routes opaque arguments but never
// interprets or renders the provider's domain-specific review.
expose("provider_ui.present", async (payload, context) => {
  const provider = verifiedEndpoint(context);
  return presentProviderUiForEndpoint(
    payload,
    provider,
    resolveInvocation(provider, context.invocation),
    context.signal,
  );
});

// Agent mode is source-bound kernel control, not a model-visible kernel tool.
expose("agent.mode.request", async (payload, context) => {
  const endpoint = verifiedEndpoint(context);
  if (
    endpoint.context.role !== "tile" ||
    !isJsonObject(payload) ||
    typeof payload.entrypoint !== "string"
  ) {
    throw new Error("Invalid agent mode request");
  }
  const app = useAppsStore.getState().list[endpoint.context.appId];
  const entrypoints =
    declaredCapability(app, "agent_entrypoints")?.entrypoints ?? [];
  if (
    !app ||
    !app.background ||
    !entrypoints.includes(payload.entrypoint) ||
    !isFocusedTileCaller(endpoint) ||
    !hasTransientUserActivation()
  ) {
    throw new KernelPolicyError(
      "OWNER_REQUIRED",
      "Enable agent mode from the focused agent tile",
    );
  }
  await requestAgentGrant(
    {
      appId: endpoint.context.appId,
      appName: app.name,
      version: app.version,
      installationUid: endpoint.appScope!.installationUid,
      entrypoint: payload.entrypoint,
      ownerPrincipal: useAuthStore.getState().principal,
    },
    context.signal,
  );
  return agentStatus(endpoint.context.appId);
});

expose("agent.mode.status", (_payload, context) =>
  agentStatus(verifiedEndpoint(context).context.appId),
);

expose("agent.mode.disable", (_payload, context) => {
  const endpoint = verifiedEndpoint(context);
  if (useAgentModeStore.getState().grant?.appId === endpoint.context.appId) {
    disableAgentMode("Disabled by agent tile");
  }
  return agentStatus(endpoint.context.appId);
});

// App-isolated vetKeys are private, source-bound kernel transport. They are
// deliberately absent from tool discovery and model-visible audit records.
expose("vetkeys.list", (payload, context) => {
  const endpoint = verifiedEndpoint(context);
  return withCallerConcurrency(endpoint, () =>
    vetKeysBroker.list(payload, endpoint),
  );
});

expose("vetkeys.request", (payload, context) => {
  const endpoint = verifiedEndpoint(context);
  const invocation = resolveInvocation(endpoint, context.invocation);
  return withCallerConcurrency(endpoint, () =>
    vetKeysBroker.request(payload, endpoint, {
      focused: isFocusedTileCaller(endpoint),
      delegated: invocation !== null,
      agentActive: hasActiveInvocationForApp(endpoint.context.appId),
    }),
  );
});

expose("vetkeys.publicKey", (payload, context) => {
  const endpoint = verifiedEndpoint(context);
  return withCallerConcurrency(endpoint, () =>
    vetKeysBroker.publicKey(payload, endpoint),
  );
});

expose("vetkeys.derive.begin", (payload, context) => {
  const endpoint = verifiedEndpoint(context);
  const invocation = resolveInvocation(endpoint, context.invocation);
  return withCallerConcurrency(endpoint, () =>
    vetKeysBroker.begin(payload, endpoint, context.reportProgress, {
      delegated: invocation !== null,
      agentActive: hasActiveInvocationForApp(endpoint.context.appId),
    }),
  );
});

expose("vetkeys.derive.approve", (payload, context) => {
  const endpoint = verifiedEndpoint(context);
  const invocation = resolveInvocation(endpoint, context.invocation);
  return vetKeysBroker.approve(payload, endpoint, {
    focused: isFocusedTileCaller(endpoint),
    userActivated: hasTransientUserActivation(),
    delegated: invocation !== null,
    agentActive: hasActiveInvocationForApp(endpoint.context.appId),
  });
});

// App state invalidation is source-bound and same-app only. It is transport
// control on the existing message bus, not a model-visible kernel tool.
expose("app.state.publish", (payload, context) => {
  const publisher = verifiedEndpoint(context);
  const change = assertAppStateChangePayload(payload);
  const event: AppStateChangeEnvelope = {
    type: "neutron:app:state",
    version: 1,
    topic: change.topic,
    revision: change.revision,
  };
  retainAppStateChange(publisher, event);
  let delivered = 0;
  for (const endpoint of listRegisteredEndpoints()) {
    if (
      endpoint === publisher ||
      endpoint.context.appId !== publisher.context.appId
    ) {
      continue;
    }
    if (postAppStateChange(endpoint, event)) {
      recordAppStateDelivery(endpoint, event);
      delivered += 1;
    }
  }
  return { delivered };
});

function retainAppStateChange(
  publisher: RegisteredEndpoint,
  event: AppStateChangeEnvelope,
): void {
  const appId = publisher.context.appId;
  let topics = retainedAppStateChanges.get(appId);
  if (!topics) {
    topics = new Map();
  } else {
    retainedAppStateChanges.delete(appId);
  }
  topics.delete(event.topic);
  topics.set(event.topic, {
    event,
    appGeneration: publisher.appGeneration,
    publisherEndpointId: publisher.endpointId,
  });
  while (topics.size > MAX_RETAINED_STATE_TOPICS_PER_APP) {
    const oldest = topics.keys().next().value;
    if (oldest === undefined) break;
    topics.delete(oldest);
  }
  retainedAppStateChanges.set(appId, topics);
  while (retainedAppStateChanges.size > MAX_RETAINED_STATE_APPS) {
    const oldest = retainedAppStateChanges.keys().next().value;
    if (oldest === undefined) break;
    retainedAppStateChanges.delete(oldest);
  }
}

function replayRetainedAppStateChanges(): void {
  for (const endpoint of listRegisteredEndpoints()) {
    if (!endpoint.port || !endpoint.sessionId) continue;
    const topics = retainedAppStateChanges.get(endpoint.context.appId);
    if (!topics) continue;
    for (const retained of topics.values()) {
      if (
        retained.publisherEndpointId === endpoint.endpointId ||
        retained.appGeneration !== endpoint.appGeneration ||
        appStateDeliveryIsCurrent(endpoint, retained.event)
      ) {
        continue;
      }
      endpoint.port.postMessage(retained.event);
      recordAppStateDelivery(endpoint, retained.event);
    }
  }
}

function appStateDeliveryIsCurrent(
  endpoint: RegisteredEndpoint,
  event: AppStateChangeEnvelope,
): boolean {
  const delivered = deliveredAppStateChanges.get(endpoint.source);
  return (
    delivered?.appGeneration === endpoint.appGeneration &&
    delivered?.revisions.get(event.topic) === event.revision
  );
}

function recordAppStateDelivery(
  endpoint: RegisteredEndpoint,
  event: AppStateChangeEnvelope,
): void {
  if (!endpoint.port || !endpoint.sessionId) return;
  let delivered = deliveredAppStateChanges.get(endpoint.source);
  if (!delivered || delivered.appGeneration !== endpoint.appGeneration) {
    delivered = {
      appGeneration: endpoint.appGeneration,
      revisions: new Map(),
    };
    deliveredAppStateChanges.set(endpoint.source, delivered);
  }
  delivered.revisions.delete(event.topic);
  delivered.revisions.set(event.topic, event.revision);
  while (delivered.revisions.size > MAX_RETAINED_STATE_TOPICS_PER_APP) {
    const oldest = delivered.revisions.keys().next().value;
    if (oldest === undefined) break;
    delivered.revisions.delete(oldest);
  }
}

function postAppStateChange(
  endpoint: RegisteredEndpoint,
  event: AppStateChangeEnvelope,
): boolean {
  if (!endpoint.port) return false;
  endpoint.port.postMessage(event);
  return true;
}

// Tray state is private, source-bound shell transport. It is intentionally
// absent from model-visible kernel tools and can mutate only a numeric badge.
expose("tray.set_state", (payload, context) =>
  setTrayStateForEndpoint(
    payload,
    verifiedEndpoint(context),
    useAppsStore.getState().list,
  ),
);

expose("tray.dismiss", (payload, context) =>
  dismissTrayForEndpoint(
    payload,
    verifiedEndpoint(context),
    useAppsStore.getState().list,
  ),
);

// Clipboard access stays in the trusted top-level page. This private action is
// source-bound and absent from app/agent tool discovery.
expose("clipboard.write_text", (payload, context) => {
  const endpoint = verifiedEndpoint(context);
  const auth = useAuthStore.getState();
  const invocation = resolveInvocation(endpoint, context.invocation);
  return withCallerConcurrency(endpoint, () =>
    clipboardService.writeFromApp(payload, {
      role: endpoint.context.role,
      focused: isFocusedTileCaller(endpoint),
      userActivated: hasTransientUserActivation(),
      ownerAuthorized: auth.logged && auth.authorized,
      delegated: invocation !== null,
    }),
  );
});

// Browser-wallet providers stay in the trusted top-level page. Apps receive
// only endpoint-bound JSON RPC sessions through these private actions.
expose("ethereum_provider.begin", (payload, context) => {
  const endpoint = verifiedEndpoint(context);
  const auth = useAuthStore.getState();
  const invocation = resolveInvocation(endpoint, context.invocation);
  if (invocation || hasActiveInvocationForApp(endpoint.context.appId)) {
    throw new KernelPolicyError(
      "USER_INTERACTION_REQUIRED",
      "Browser wallet access cannot be delegated to an agent",
    );
  }
  return withCallerConcurrency(endpoint, () =>
    beginEthereumProviderForEndpoint(payload, endpoint, {
      focused: isFocusedTileCaller(endpoint),
      userActivated: hasTransientUserActivation(),
      ownerAuthorized: auth.logged && auth.authorized,
      ownerPrincipal: auth.principal,
    }),
  );
});

expose("ethereum_provider.request", (payload, context) => {
  const endpoint = verifiedEndpoint(context);
  const auth = useAuthStore.getState();
  const invocation = resolveInvocation(endpoint, context.invocation);
  if (invocation || hasActiveInvocationForApp(endpoint.context.appId)) {
    throw new KernelPolicyError(
      "USER_INTERACTION_REQUIRED",
      "Browser wallet access cannot be delegated to an agent",
    );
  }
  return withCallerConcurrency(endpoint, () =>
    requestEthereumProviderForEndpoint(payload, endpoint, {
      focused: isFocusedTileCaller(endpoint),
      ownerAuthorized: auth.logged && auth.authorized,
      ownerPrincipal: auth.principal,
    }),
  );
});

expose("ethereum_provider.end", (payload, context) =>
  endEthereumProviderForEndpoint(payload, verifiedEndpoint(context)),
);

// Connections are private source-bound actions. They are deliberately absent
// from kernelTools, tools.list, tools.call, and model-visible audit records.
expose("connections.request", (payload, context) => {
  const endpoint = verifiedEndpoint(context);
  const invocation = resolveInvocation(endpoint, context.invocation);
  return withCallerConcurrency(endpoint, () =>
    requestConnectionForEndpoint(payload, endpoint, async (request) => {
      if (invocation) {
        throw new KernelPolicyError(
          "USER_INTERACTION_REQUIRED",
          "Connecting a provider requires owner interaction",
        );
      }
      await authorizeAgentPermission(endpoint, null, {
        kind: "connection",
        persistence: "durable",
        risk: "high",
        action: request,
      });
    }),
  );
});

expose("connections.list", (payload, context) => {
  const endpoint = verifiedEndpoint(context);
  return withCallerConcurrency(endpoint, () =>
    listConnectionsForEndpoint(payload, endpoint),
  );
});

expose("connections.acquire", (payload, context) => {
  const endpoint = verifiedEndpoint(context);
  return withCallerConcurrency(endpoint, () =>
    acquireConnectionForEndpoint(payload, endpoint),
  );
});

expose("connections.disconnect", (payload, context) => {
  const endpoint = verifiedEndpoint(context);
  const invocation = resolveInvocation(endpoint, context.invocation);
  return withCallerConcurrency(endpoint, () =>
    disconnectConnectionForEndpoint(payload, endpoint, (request) =>
      authorizeAgentPermission(endpoint, invocation, {
        kind: "connection",
        persistence: "durable",
        risk: "medium",
        action: request,
      }),
    ),
  );
});

subscribeEndpointPortMessages(({ endpoint, event }) => {
  if (isRequestCancelEnvelope(event.data)) {
    if (endpoint.port) cancelEndpointPortRequest(endpoint.port, event.data.id);
    return;
  }
  if (isSelfCallWireMessage(event.data)) {
    if (endpoint.port) void handleEndpointSelfCallRequest(endpoint, event.data);
    return;
  }
  if (handleAttachmentReply(endpoint, event.data)) return;
  if (isAttachmentWireMessage(event.data)) {
    if (endpoint.port) {
      void handleEndpointAttachmentRequest(endpoint, event.data);
    }
    return;
  }
  if (!isExecEnvelope(event.data) || !endpoint.port) return;
  void handleEndpointPortRequest(endpoint, event.data);
});

function registerEndpointPortRequest(
  port: MessagePort,
  id: number,
): AbortController | null {
  const requests = endpointRequestControllers.get(port) ?? new Map();
  if (requests.has(id)) return null;
  const controller = new AbortController();
  requests.set(id, controller);
  endpointRequestControllers.set(port, requests);
  return controller;
}

function unregisterEndpointPortRequest(
  port: MessagePort,
  id: number,
  controller: AbortController,
): void {
  const requests = endpointRequestControllers.get(port);
  if (requests?.get(id) !== controller) return;
  requests.delete(id);
  if (requests.size === 0) endpointRequestControllers.delete(port);
}

function cancelEndpointPortRequest(port: MessagePort, id: number): void {
  endpointRequestControllers
    .get(port)
    ?.get(id)
    ?.abort(
      new KernelPolicyError(
        "REQUEST_CANCELLED",
        "Message-bus request was cancelled by the requesting app",
      ),
    );
}

function cancelEndpointPortRequests(port: MessagePort): void {
  const requests = endpointRequestControllers.get(port);
  if (!requests) return;
  endpointRequestControllers.delete(port);
  for (const controller of requests.values()) {
    controller.abort(
      new KernelPolicyError(
        "REQUEST_CANCELLED",
        "Message-bus endpoint was retired",
      ),
    );
  }
}

type SelfCallWireRequest = {
  type: "neutron:self-call:exec";
  version: 1;
  id: number;
  tool:
    | "canister.query_self"
    | "canister.update_self"
    | "canister.call_dialog"
    | "backend_calls.request";
  method: string;
  args: JsonValue[];
  blobs: SelfCallWireBlob[];
  actions?: JsonValue[];
  context?: { invocation: MsgBusInvocationMetadata };
};

function isSelfCallWireMessage(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "neutron:self-call:exec"
  );
}

function parseSelfCallWireRequest(raw: unknown): SelfCallWireRequest {
  const backendAccess =
    isJsonObject(raw) && raw.tool === "backend_calls.request";
  if (
    !isJsonObject(raw) ||
    Object.keys(raw).some(
      (key) =>
        key !== "type" &&
        key !== "version" &&
        key !== "id" &&
        key !== "tool" &&
        key !== "method" &&
        key !== "args" &&
        key !== "blobs" &&
        (key !== "actions" || !backendAccess) &&
        key !== "context",
    ) ||
    raw.type !== "neutron:self-call:exec" ||
    raw.version !== 1 ||
    !Number.isSafeInteger(raw.id) ||
    Number(raw.id) < 1 ||
    (raw.tool !== "canister.query_self" &&
      raw.tool !== "canister.update_self" &&
      raw.tool !== "canister.call_dialog" &&
      raw.tool !== "backend_calls.request") ||
    typeof raw.method !== "string" ||
    !/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/u.test(raw.method) ||
    !Array.isArray(raw.args) ||
    !raw.args.every(isJsonValue) ||
    (backendAccess &&
      (!Array.isArray(raw.actions) ||
        raw.actions.length > 64 ||
        !raw.actions.every(isJsonValue))) ||
    (raw.context !== undefined &&
      (!isJsonObject(raw.context) ||
        Object.keys(raw.context).length !== 1 ||
        !Object.hasOwn(raw.context, "invocation") ||
        !isExecEnvelope({
          type: "exec",
          id: Number(raw.id),
          payload: {
            action: "self.call",
            payload: null,
            context: raw.context,
          },
        })))
  ) {
    throw new Error("Invalid self-call request envelope");
  }
  assertBoundedJson(
    raw.args,
    "Self-call metadata",
    SELF_CALL_METADATA_MAX_BYTES,
  );
  if (backendAccess) {
    assertBoundedJson(
      raw.actions as JsonValue[],
      "Backend access metadata",
      SELF_CALL_METADATA_MAX_BYTES,
    );
  }
  return {
    type: "neutron:self-call:exec",
    version: 1,
    id: Number(raw.id),
    tool: raw.tool,
    method: raw.method,
    args: raw.args as JsonValue[],
    blobs: parseSelfCallWireBlobs(raw.blobs),
    ...(backendAccess ? { actions: raw.actions as JsonValue[] } : {}),
    ...(raw.context
      ? {
          context: raw.context as {
            invocation: MsgBusInvocationMetadata;
          },
        }
      : {}),
  };
}

async function handleEndpointSelfCallRequest(
  endpoint: RegisteredEndpoint,
  raw: unknown,
): Promise<void> {
  const port = endpoint.port;
  if (!port) return;
  const possibleId =
    isJsonObject(raw) && Number.isSafeInteger(raw.id) && Number(raw.id) > 0
      ? Number(raw.id)
      : null;
  const controller =
    possibleId === null ? null : registerEndpointPortRequest(port, possibleId);
  // Keep the first request authoritative for this source port and id.
  if (possibleId !== null && !controller) return;
  let reservation: AttachmentCapacityReservation | undefined;
  const startedAt = performance.now();
  let request: SelfCallWireRequest | undefined;
  try {
    assertCurrentEndpointVersion(endpoint);
    request = parseSelfCallWireRequest(raw);
    const invocationMetadataValue = request.context?.invocation;
    const invocation = resolveInvocation(endpoint, invocationMetadataValue);
    const inputBinary = selfCallBlobStats(request.blobs);
    reservation = acquireAttachmentCapacity(endpoint, 0);
    reservation.resize(selfCallReservationBytes(inputBinary.bytes));
    const result = await withCallerConcurrency(endpoint, () =>
      request!.tool === "backend_calls.request"
        ? executeBinaryBackendAccessRequest(
            endpoint,
            request!,
            reservation!,
            invocationMetadataValue,
            invocation,
            controller?.signal,
          )
        : executeBinarySelfMethod(
            endpoint,
            request!,
            reservation!,
            invocationMetadataValue,
            invocation,
            controller?.signal,
          ),
    );
    recordMsgBusAudit({
      caller: callerContext(endpoint),
      target: "kernel",
      tool: request.tool,
      status: "ok",
      durationMs: Math.round(performance.now() - startedAt),
      arguments: {
        method: request.method,
        mode: result.mode,
        metadataBytes: jsonPayloadBytes(request.args),
      },
      metadataBytes: {
        input: jsonPayloadBytes(request.args),
        output: jsonPayloadBytes(result.value),
      },
      binaryFields: {
        input: result.inputBinary,
        output: result.outputBinary,
      },
    });
    const response = {
      type: "neutron:self-call:response",
      version: 1,
      id: request.id,
      ok: result.value,
      blobs: result.blobs,
    };
    port.postMessage(
      response,
      result.blobs.map((blob) => blob.data),
    );
  } catch (error) {
    const protectedOutput = protectedBinarySelfCallStats(error);
    if (request) {
      recordMsgBusAudit({
        caller: callerContext(endpoint),
        target: "kernel",
        tool: request.tool,
        status: "error",
        durationMs: Math.round(performance.now() - startedAt),
        arguments: {
          method: request.method,
          mode:
            request.tool === "canister.query_self"
              ? "query"
              : request.tool === "canister.update_self"
                ? "update"
                : "consented",
          metadataBytes: jsonPayloadBytes(request.args),
        },
        metadataBytes: {
          input: jsonPayloadBytes(request.args),
          output: 0,
        },
        binaryFields: {
          input: selfCallBlobStats(request.blobs),
          output: protectedOutput ?? { count: 0, bytes: 0 },
        },
        error: "Metadata-only self call failed",
      });
    }
    if (possibleId !== null) {
      try {
        port.postMessage({
          type: "neutron:self-call:response",
          version: 1,
          id: possibleId,
          error: serializeActionError(error),
        });
      } catch {
        // A disconnected/replaced endpoint cannot retain router resources.
      }
    }
  } finally {
    reservation?.release();
    if (controller && possibleId !== null) {
      unregisterEndpointPortRequest(port, possibleId, controller);
    }
  }
}

async function handleEndpointAttachmentRequest(
  endpoint: RegisteredEndpoint,
  rawRequest: unknown,
): Promise<void> {
  const port = endpoint.port;
  if (!port) return;
  const possibleId =
    typeof rawRequest === "object" &&
    rawRequest !== null &&
    "id" in rawRequest &&
    typeof rawRequest.id === "number" &&
    Number.isSafeInteger(rawRequest.id) &&
    rawRequest.id > 0
      ? rawRequest.id
      : null;
  let reservation: AttachmentCapacityReservation | undefined;
  try {
    assertCurrentEndpointVersion(endpoint);
    const request = assertAttachmentExecEnvelope(rawRequest);
    if (request.payload.action !== "tools.call") {
      throw attachmentError(
        "ATTACHMENT_ACTION_INVALID",
        "Apps may only invoke tools.call through the attachment protocol",
      );
    }
    const call = assertToolCall(request.payload.payload);
    const delegatedMetadata = request.delegationToken
      ? consumeAttachmentDelegation(endpoint, request.delegationToken)
      : undefined;
    if (delegatedMetadata && request.payload.context?.invocation) {
      throw attachmentError(
        "ATTACHMENT_DELEGATION_INVALID",
        "Attachment calls cannot combine delegation and invocation metadata",
      );
    }
    const effectiveMetadata =
      delegatedMetadata ?? request.payload.context?.invocation;
    reservation = acquireAttachmentCapacity(
      endpoint,
      attachmentBytes(request.attachments),
    );
    const result = await routeAttachmentToolCall(
      call,
      endpoint,
      request.attachments,
      (value) => postAttachmentProgress(port, request.id, value),
      effectiveMetadata,
      reservation,
    );
    postAttachmentResponse(port, request.id, {
      ok: result.value,
      ...(result.attachments.length > 0
        ? { attachments: result.attachments }
        : {}),
    });
  } catch (error) {
    if (possibleId !== null) {
      try {
        postAttachmentResponse(port, possibleId, {
          error: serializeActionError(error),
        });
      } catch {
        // A disconnected/replaced endpoint cannot retain router resources.
      }
    }
  } finally {
    reservation?.release();
  }
}

async function handleEndpointPortRequest(
  endpoint: RegisteredEndpoint,
  request: ReturnType<typeof assertExecEnvelope>,
): Promise<void> {
  const port = endpoint.port;
  if (!port) return;
  const controller = registerEndpointPortRequest(port, request.id);
  // Keep the first request authoritative for this source port and id.
  if (!controller) return;
  let response: ResponseEnvelope;
  try {
    assertCurrentEndpointVersion(endpoint);
    const result = await executeExposedAction(
      request.payload.action,
      request.payload.payload,
      {
        source: endpoint.source,
        origin: endpoint.origin ?? "",
        ...(request.payload.context?.invocation
          ? { invocation: request.payload.context.invocation }
          : {}),
        signal: controller.signal,
        reportProgress: (value) => {
          assertBoundedJson(
            value,
            "Progress payload",
            MSG_BUS_MAX_PROGRESS_BYTES,
          );
          port.postMessage({ type: "progress", id: request.id, value });
        },
      },
    );
    assertBoundedJson(result, `Action '${request.payload.action}' result`);
    response = { type: "response", id: request.id, ok: result };
  } catch (error) {
    response = {
      type: "response",
      id: request.id,
      error: serializeActionError(error, request.payload.action),
    };
  } finally {
    unregisterEndpointPortRequest(port, request.id, controller);
  }
  port.postMessage(response);
}

function serializeActionError(error: unknown, action?: string): JsonValue {
  let serialized: JsonValue;
  if (action?.startsWith("vetkeys.")) {
    serialized = serializeVetKeysActionError(error);
  } else if (isCanisterResultError(error)) {
    serialized = {
      name: error.name,
      message: error.message,
      code: error.code,
    };
  } else if (error instanceof Error) {
    serialized = serializeError(error);
  } else {
    try {
      serialized = serializeError(toState(error));
    } catch {
      serialized = serializeError(error);
    }
  }
  return boundSerializedError(
    serialized,
    "Request failed with an oversized protected error",
  );
}

function assertExecEnvelope(value: unknown) {
  if (!isExecEnvelope(value)) throw new Error("Invalid exec envelope");
  return value;
}
