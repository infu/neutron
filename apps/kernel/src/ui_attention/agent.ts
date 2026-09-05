import { create } from "zustand";
import {
  KernelPolicyError,
  assertBoundedJson,
  type AgentConsentChallenge,
  type AgentConsentDecision,
  type JsonObject,
  type MsgBusInvocationMetadata,
} from "neutron-tools/protocol";
import type { RegisteredEndpoint } from "../frame_context.ts";
import type { AppRegistry } from "neutron-compiler/src/install.js";
import { declaredCapability } from "../capabilities/plan.ts";
import {
  sameAppScope,
  type AppInstanceProjection,
} from "../app_scope.ts";
import {
  admitOwnerAttention,
  finishOwnerAttention,
} from "./owner.ts";
import {
  requestCancellationError,
  throwIfRequestCancelled,
} from "../request_cancel.ts";

const ROOT_TTL_MS = 5 * 60_000;
const DECISION_TTL_MS = 30_000;
const MAX_DEPTH = 8;
const MAX_CALLS = 64;
const MAX_PARALLEL_CHILDREN = 4;
const MAX_CHALLENGES = 6;
const MAX_NODE_CHALLENGES = 2;
const ROOT_START_SHORT_WINDOW_MS = 60_000;
const ROOT_START_LONG_WINDOW_MS = 10 * 60_000;
const MAX_ROOT_STARTS_SHORT_WINDOW = 6;
const MAX_ROOT_STARTS_LONG_WINDOW = 20;

export type AgentGrant = {
  id: string;
  appId: string;
  appName: string;
  version: number;
  installationUid: string;
  entrypoint: string;
  ownerPrincipal: string;
  grantedAt: number;
};

export type PendingAgentGrant = Omit<AgentGrant, "id" | "grantedAt">;

export type AgentRootSummary = {
  id: string;
  appId: string;
  installationUid: string;
  entrypoint: string;
  startedAt: number;
  expiresAt: number;
  calls: number;
  challenges: number;
  remainingCalls: number;
  remainingChallenges: number;
};

export type AgentDecisionAudit = {
  id: string;
  rootId: string;
  at: number;
  requesterAppId: string;
  kind: AgentConsentChallenge["kind"];
  persistence: AgentConsentChallenge["persistence"];
  decision: AgentConsentDecision["decision"];
  reason: string;
};

type AgentModeState = {
  grant: AgentGrant | null;
  pendingGrant: PendingAgentGrant | null;
  activeRoot: AgentRootSummary | null;
  decisions: AgentDecisionAudit[];
};

export const useAgentModeStore = create<AgentModeState>(() => ({
  grant: null,
  pendingGrant: null,
  activeRoot: null,
  decisions: [],
}));

export type InvocationNode = {
  id: string;
  rootId: string;
  parentId: string | null;
  capability: string;
  endpointId: string;
  endpointSessionId: string;
  appId: string;
  installationUid: string;
  role: "tile" | "background" | "tray";
  tool: string;
  depth: number;
  status: "active" | "permission_denied" | "complete" | "cancelled";
  startedAt: number;
  expiresAt: number;
  activeChildren: number;
  challengeCount: number;
};

export type AgentPermissionSummary = {
  kind: AgentConsentChallenge["kind"];
  persistence: AgentConsentChallenge["persistence"];
  risk: AgentConsentChallenge["risk"];
  action: JsonObject;
};

type RootRuntime = {
  nodeId: string;
  grantId: string;
  endpointId: string;
  endpointSessionId: string;
  calls: number;
  challenges: number;
  timeout: ReturnType<typeof setTimeout>;
};

type GrantCallbacks = {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

let grantCallbacks: GrantCallbacks | null = null;
let grantAttentionToken: string | null = null;
const nodesById = new Map<string, InvocationNode>();
const nodesByCapability = new Map<string, InvocationNode>();
const roots = new Map<string, RootRuntime>();
const rootStartAdmissions = new Map<string, number[]>();
const pendingDecisionRejects = new Map<string, (error: Error) => void>();
let rootCancelDispatcher:
  | ((root: { id: string; endpointId: string; endpointSessionId: string }) => void)
  | null = null;

export function setAgentRootCancelDispatcher(
  dispatcher: typeof rootCancelDispatcher,
): void {
  rootCancelDispatcher = dispatcher;
}

export function requestAgentGrant(
  input: PendingAgentGrant,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      requestCancellationError(
        signal,
        "The agent permission request was cancelled by the requesting app",
      ),
    );
  }
  if (grantCallbacks || useAgentModeStore.getState().pendingGrant) {
    return Promise.reject(
      policyError("UI_BUSY", "An agent permission request is already active"),
    );
  }
  const current = useAgentModeStore.getState().grant;
  if (
    current &&
    current.appId === input.appId &&
    current.version === input.version &&
    current.installationUid === input.installationUid &&
    current.entrypoint === input.entrypoint &&
    current.ownerPrincipal === input.ownerPrincipal
  ) {
    return Promise.resolve();
  }
  try {
    grantAttentionToken = admitOwnerAttention(input.appId, "agent_grant");
  } catch (error) {
    return Promise.reject(error);
  }
  useAgentModeStore.setState({ pendingGrant: { ...input } });
  return new Promise((resolve, reject) => {
    const callbacks: GrantCallbacks = {
      resolve,
      reject,
      ...(signal ? { signal } : {}),
    };
    const abort = (): void => {
      if (grantCallbacks !== callbacks) return;
      rejectPendingAgentGrant(
        requestCancellationError(
          signal,
          "The agent permission request was cancelled by the requesting app",
        ),
      );
    };
    if (signal) callbacks.abort = abort;
    grantCallbacks = callbacks;
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function approveAgentGrant(): void {
  const pending = useAgentModeStore.getState().pendingGrant;
  if (!pending || !grantCallbacks) return;
  const active = useAgentModeStore.getState().activeRoot;
  if (active) cancelAgentRoot(active.id, "Agent grant replaced");
  const callbacks = grantCallbacks;
  grantCallbacks = null;
  cleanupGrantCallbacks(callbacks);
  if (grantAttentionToken) finishOwnerAttention(grantAttentionToken);
  grantAttentionToken = null;
  useAgentModeStore.setState({
    pendingGrant: null,
    grant: { ...pending, id: randomId(), grantedAt: Date.now() },
  });
  callbacks.resolve();
}

export function rejectAgentGrant(): void {
  rejectPendingAgentGrant(
    policyError("REQUEST_CANCELLED", "Agent mode was not enabled"),
  );
}

export function disableAgentMode(reason = "Agent mode disabled"): void {
  const active = useAgentModeStore.getState().activeRoot;
  if (active) cancelAgentRoot(active.id, reason);
  const callbacks = grantCallbacks;
  grantCallbacks = null;
  if (callbacks) {
    cleanupGrantCallbacks(callbacks);
    callbacks.reject(policyError("AGENT_MODE_REVOKED", reason));
  }
  if (grantAttentionToken) finishOwnerAttention(grantAttentionToken);
  grantAttentionToken = null;
  useAgentModeStore.setState({
    grant: null,
    pendingGrant: null,
    activeRoot: null,
  });
}

export function removeAgentAppState(appId: string): void {
  for (const key of rootStartAdmissions.keys()) {
    if (key.startsWith(`${appId}:`)) rootStartAdmissions.delete(key);
  }
  const state = useAgentModeStore.getState();
  if (
    state.grant?.appId === appId ||
    state.pendingGrant?.appId === appId ||
    state.activeRoot?.appId === appId
  ) {
    disableAgentMode("App " + appId + " was removed");
  }
  for (const node of [...nodesById.values()]) {
    if (node.appId === appId) {
      cancelAgentRoot(node.rootId, "App " + appId + " was removed");
    }
  }
}

export function reconcileAgentGrant(
  apps: AppRegistry,
  appInstances: Readonly<Record<string, AppInstanceProjection>>,
): void {
  const grant = useAgentModeStore.getState().grant;
  if (!grant) return;
  const app = apps[grant.appId];
  if (
    !app ||
    appInstances[grant.appId]?.scope.installationUid !==
      grant.installationUid ||
    app.version !== grant.version ||
    !declaredCapability(app, "agent_entrypoints")?.entrypoints.includes(
      grant.entrypoint,
    )
  ) {
    disableAgentMode("Agent app changed");
  }
}

export function reconcileAgentEndpoints(
  resolve: (endpointId: string) => RegisteredEndpoint | null,
): void {
  const cancelled = new Set<string>();
  for (const node of [...nodesById.values()]) {
    if (cancelled.has(node.rootId)) continue;
    const endpoint = resolve(node.endpointId);
    if (
      !endpoint ||
      endpoint.sessionId !== node.endpointSessionId ||
      endpoint.appScope?.installationUid !== node.installationUid
    ) {
      cancelled.add(node.rootId);
      cancelAgentRoot(node.rootId, "Agent app surface disconnected");
    }
  }
}

export function beginAgentRoot(input: {
  caller: RegisteredEndpoint;
  target: RegisteredEndpoint;
  tool: string;
  ownerPrincipal: string;
  installedVersion: number;
}): InvocationNode | null {
  const grant = useAgentModeStore.getState().grant;
  if (!grant) return null;
  if (
    grant.appId !== input.caller.context.appId ||
    grant.appId !== input.target.context.appId ||
    !sameAppScope(input.caller.appScope, input.target.appScope) ||
    input.target.appScope?.installationUid !== grant.installationUid ||
    grant.entrypoint !== input.tool
  ) {
    return null;
  }
  if (
    input.caller.context.role !== "tile" ||
    input.target.context.role !== "background" ||
    !input.target.sessionId ||
    grant.ownerPrincipal !== input.ownerPrincipal ||
    grant.version !== input.installedVersion
  ) {
    throw policyError(
      "INVOCATION_INVALID",
      "Agent mode must start from its own tile and resident process",
    );
  }
  if (useAgentModeStore.getState().activeRoot) {
    throw policyError("AGENT_MODE_LIMIT", "Another agent turn is already running");
  }

  const now = Date.now();
  admitRootStart(`${grant.appId}:${grant.installationUid}`, now);
  const rootId = randomId();
  const node = createNode({
    id: rootId,
    rootId,
    parentId: null,
    endpoint: input.target,
    tool: input.tool,
    depth: 0,
    expiresAt: now + ROOT_TTL_MS,
  });
  const runtime: RootRuntime = {
    nodeId: node.id,
    grantId: grant.id,
    endpointId: node.endpointId,
    endpointSessionId: node.endpointSessionId,
    calls: 0,
    challenges: 0,
    timeout: setTimeout(
      () => cancelAgentRoot(rootId, "Agent turn expired"),
      ROOT_TTL_MS,
    ),
  };
  roots.set(rootId, runtime);
  useAgentModeStore.setState({ activeRoot: rootSummary(node, runtime) });
  return node;
}

export function resolveInvocation(
  caller: RegisteredEndpoint,
  metadata: MsgBusInvocationMetadata | undefined,
): InvocationNode | null {
  if (!metadata) return null;
  const node = nodesByCapability.get(metadata.capability);
  if (
    !node ||
    node.id !== metadata.id ||
    node.rootId !== metadata.rootId ||
    node.endpointId !== caller.endpointId ||
    node.endpointSessionId !== (caller.sessionId ?? "") ||
    node.installationUid !== caller.appScope?.installationUid ||
    node.status !== "active"
  ) {
    throw policyError("INVOCATION_INVALID", "Invalid invocation context");
  }
  const root = roots.get(node.rootId);
  const grant = useAgentModeStore.getState().grant;
  if (!root || !grant || root.grantId !== grant.id || node.expiresAt <= Date.now()) {
    cancelAgentRoot(node.rootId, "Agent invocation expired");
    throw policyError("AGENT_MODE_REVOKED", "Agent invocation is no longer active");
  }
  return node;
}

export function hasActiveInvocationForEndpoint(endpointId: string): boolean {
  return [...nodesById.values()].some(
    (node) => node.endpointId === endpointId && node.status === "active",
  );
}

export function hasActiveInvocationForApp(appId: string): boolean {
  return [...nodesById.values()].some(
    (node) => node.appId === appId && node.status === "active",
  );
}

export function isDirectAgentInvocation(node: InvocationNode | null): boolean {
  return node?.depth === 0 && node.status === "active";
}

export function createChildInvocation(
  parent: InvocationNode,
  target: RegisteredEndpoint,
  tool: string,
): InvocationNode {
  if (target.context.role === "tray") {
    throw policyError(
      "INVOCATION_INVALID",
      "Tray popouts cannot receive delegated agent calls",
    );
  }
  const root = requireRoot(parent);
  if (parent.depth + 1 > MAX_DEPTH) {
    throw policyError("AGENT_MODE_LIMIT", "Agent invocation depth exceeded");
  }
  if (root.calls >= MAX_CALLS) {
    throw policyError("AGENT_MODE_LIMIT", "Agent call budget exceeded");
  }
  if (parent.activeChildren >= MAX_PARALLEL_CHILDREN) {
    throw policyError("AGENT_MODE_LIMIT", "Too many parallel agent calls");
  }
  root.calls += 1;
  parent.activeChildren += 1;
  const node = createNode({
    id: randomId(),
    rootId: parent.rootId,
    parentId: parent.id,
    endpoint: target,
    tool,
    depth: parent.depth + 1,
    expiresAt: parent.expiresAt,
  });
  updateRootSummary(parent.rootId);
  return node;
}

export function completeInvocation(node: InvocationNode): void {
  if (node.status !== "active") return;
  node.status = "complete";
  removeNode(node);
  if (node.parentId) {
    const parent = nodesById.get(node.parentId);
    if (parent) parent.activeChildren = Math.max(0, parent.activeChildren - 1);
  } else {
    finishRoot(node.rootId);
  }
}

export function invocationMetadata(
  node: InvocationNode,
  agentConsent = false,
): MsgBusInvocationMetadata {
  return {
    id: node.id,
    rootId: node.rootId,
    capability: node.capability,
    ...(agentConsent ? { agentConsent: true } : {}),
  };
}

export async function requestAgentConsent(
  node: InvocationNode,
  summary: AgentPermissionSummary,
  dispatch: (
    challenge: AgentConsentChallenge,
    signal?: AbortSignal,
  ) => Promise<AgentConsentDecision>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfRequestCancelled(
    signal,
    "The agent permission decision was cancelled by the requesting app",
  );
  if (node.depth === 0) return;
  const root = requireRoot(node);
  if (node.status === "permission_denied") {
    throw policyError(
      "AGENT_CONSENT_DENIED",
      "This app call was already denied additional permission",
    );
  }
  if (pendingDecisionRejects.has(node.rootId)) {
    throw policyError(
      "AGENT_CONSENT_LIMIT",
      "Another agent permission decision is active",
    );
  }
  if (
    root.challenges >= MAX_CHALLENGES ||
    node.challengeCount >= MAX_NODE_CHALLENGES
  ) {
    throw policyError(
      "AGENT_CONSENT_LIMIT",
      "Agent permission decision budget exceeded",
    );
  }

  root.challenges += 1;
  node.challengeCount += 1;
  updateRootSummary(node.rootId);
  const challenge: AgentConsentChallenge = {
    version: 1,
    id: randomId(),
    rootId: node.rootId,
    expiresAt: Date.now() + DECISION_TTL_MS,
    requester: { appId: node.appId, role: node.role },
    chain: invocationChain(node).map((entry) => ({
      appId: entry.appId,
      tool: entry.tool,
    })),
    kind: summary.kind,
    persistence: summary.persistence,
    risk: summary.risk,
    action: summary.action,
  };
  assertBoundedJson(challenge, "Agent consent challenge");

  let timeout: ReturnType<typeof setTimeout> | null = null;
  let abort: (() => void) | null = null;
  try {
    throwIfRequestCancelled(
      signal,
      "The agent permission decision was cancelled by the requesting app",
    );
    const decision = normalizeDecision(
      await Promise.race([
        dispatch(challenge, signal),
        new Promise<AgentConsentDecision>((_resolve, reject) => {
          pendingDecisionRejects.set(node.rootId, reject);
          timeout = setTimeout(
            () =>
              reject(
                policyError(
                  "AGENT_CONSENT_TIMEOUT",
                  "Agent permission decision timed out",
                ),
              ),
            DECISION_TTL_MS,
          );
          if (signal) {
            abort = () =>
              reject(
                requestCancellationError(
                  signal,
                  "The agent permission decision was cancelled by the requesting app",
                ),
              );
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          }
        }),
      ]),
    );
    recordDecision(challenge, decision);
    if (decision.decision !== "allow") {
      node.status = "permission_denied";
      throw policyError(
        "AGENT_CONSENT_DENIED",
        decision.reason || "Agent denied the permission request",
      );
    }
    if (!roots.has(node.rootId) || node.status !== "active") {
      throw policyError("AGENT_MODE_REVOKED", "Agent turn ended before approval");
    }
  } catch (error) {
    if (
      error instanceof KernelPolicyError &&
      error.code !== "AGENT_CONSENT_DENIED" &&
      error.code !== "REQUEST_CANCELLED"
    ) {
      node.status = "permission_denied";
      recordDecision(challenge, {
        decision: "deny",
        reason: error.message.slice(0, 240),
      });
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && abort) signal.removeEventListener("abort", abort);
    pendingDecisionRejects.delete(node.rootId);
  }
}

function rejectPendingAgentGrant(error: Error): void {
  const callbacks = grantCallbacks;
  grantCallbacks = null;
  if (callbacks) {
    cleanupGrantCallbacks(callbacks);
    callbacks.reject(error);
  }
  if (grantAttentionToken) {
    finishOwnerAttention(grantAttentionToken);
  }
  grantAttentionToken = null;
  useAgentModeStore.setState({ pendingGrant: null });
}

function cleanupGrantCallbacks(callbacks: GrantCallbacks): void {
  if (callbacks.signal && callbacks.abort) {
    callbacks.signal.removeEventListener("abort", callbacks.abort);
  }
}

export function rootEndpoint(node: InvocationNode): {
  endpointId: string;
  endpointSessionId: string;
} {
  const root = requireRoot(node);
  return {
    endpointId: root.endpointId,
    endpointSessionId: root.endpointSessionId,
  };
}

export function cancelAgentRoot(rootId: string, reason: string): void {
  const root = roots.get(rootId);
  if (root && rootCancelDispatcher) {
    const endpoints = new Map<string, InvocationNode>();
    for (const node of nodesById.values()) {
      if (node.rootId === rootId) endpoints.set(node.endpointId, node);
    }
    for (const node of endpoints.values()) {
      rootCancelDispatcher({
        id: rootId,
        endpointId: node.endpointId,
        endpointSessionId: node.endpointSessionId,
      });
    }
  }
  pendingDecisionRejects.get(rootId)?.(
    policyError("AGENT_MODE_REVOKED", reason),
  );
  pendingDecisionRejects.delete(rootId);
  for (const node of [...nodesById.values()]) {
    if (node.rootId !== rootId) continue;
    node.status = "cancelled";
    removeNode(node);
  }
  finishRoot(rootId);
}

export function clearAgentModeForAuth(): void {
  disableAgentMode("Authorization changed");
  rootStartAdmissions.clear();
  useAgentModeStore.setState({ decisions: [] });
}

function createNode(input: {
  id: string;
  rootId: string;
  parentId: string | null;
  endpoint: RegisteredEndpoint;
  tool: string;
  depth: number;
  expiresAt: number;
}): InvocationNode {
  if (!input.endpoint.sessionId || !input.endpoint.appScope) {
    throw policyError(
      "INVOCATION_INVALID",
      "Endpoint is not connected to an installed app instance",
    );
  }
  const node: InvocationNode = {
    id: input.id,
    rootId: input.rootId,
    parentId: input.parentId,
    capability: randomHex(32),
    endpointId: input.endpoint.endpointId,
    endpointSessionId: input.endpoint.sessionId,
    appId: input.endpoint.context.appId,
    installationUid: input.endpoint.appScope.installationUid,
    role: input.endpoint.context.role,
    tool: input.tool,
    depth: input.depth,
    status: "active",
    startedAt: Date.now(),
    expiresAt: input.expiresAt,
    activeChildren: 0,
    challengeCount: 0,
  };
  nodesById.set(node.id, node);
  nodesByCapability.set(node.capability, node);
  return node;
}

function requireRoot(node: InvocationNode): RootRuntime {
  const root = roots.get(node.rootId);
  if (!root || node.status !== "active") {
    throw policyError("AGENT_MODE_REVOKED", "Agent invocation is not active");
  }
  return root;
}

function invocationChain(node: InvocationNode): InvocationNode[] {
  const chain: InvocationNode[] = [];
  let current: InvocationNode | undefined = node;
  while (current) {
    chain.push(current);
    current = current.parentId ? nodesById.get(current.parentId) : undefined;
  }
  return chain.reverse();
}

function removeNode(node: InvocationNode): void {
  nodesById.delete(node.id);
  nodesByCapability.delete(node.capability);
}

function finishRoot(rootId: string): void {
  const root = roots.get(rootId);
  if (root) clearTimeout(root.timeout);
  roots.delete(rootId);
  for (const node of [...nodesById.values()]) {
    if (node.rootId !== rootId) continue;
    if (node.status === "active") node.status = "cancelled";
    removeNode(node);
  }
  if (useAgentModeStore.getState().activeRoot?.id === rootId) {
    useAgentModeStore.setState({ activeRoot: null });
  }
}

function rootSummary(
  node: InvocationNode,
  root: RootRuntime,
): AgentRootSummary {
  return {
    id: node.rootId,
    appId: node.appId,
    installationUid: node.installationUid,
    entrypoint: node.tool,
    startedAt: node.startedAt,
    expiresAt: node.expiresAt,
    calls: root.calls,
    challenges: root.challenges,
    remainingCalls: Math.max(0, MAX_CALLS - root.calls),
    remainingChallenges: Math.max(0, MAX_CHALLENGES - root.challenges),
  };
}

function admitRootStart(appId: string, now: number): void {
  const admissions = rootStartAdmissions.get(appId) ?? [];
  pruneAdmissions(admissions, now - ROOT_START_LONG_WINDOW_MS);
  const recent = admissions.filter(
    (value) => value > now - ROOT_START_SHORT_WINDOW_MS,
  );
  if (recent.length >= MAX_ROOT_STARTS_SHORT_WINDOW) {
    throw policyError(
      "AGENT_MODE_LIMIT",
      "Agent turn start limit reached",
      Math.max(1, (recent[0] ?? now) + ROOT_START_SHORT_WINDOW_MS - now),
    );
  }
  if (admissions.length >= MAX_ROOT_STARTS_LONG_WINDOW) {
    throw policyError(
      "AGENT_MODE_LIMIT",
      "Agent turn start limit reached",
      Math.max(
        1,
        (admissions[0] ?? now) + ROOT_START_LONG_WINDOW_MS - now,
      ),
    );
  }
  admissions.push(now);
  rootStartAdmissions.set(appId, admissions);
}

function pruneAdmissions(values: number[], minimum: number): void {
  const first = values.findIndex((value) => value > minimum);
  if (first === -1) values.length = 0;
  else if (first > 0) values.splice(0, first);
}

function updateRootSummary(rootId: string): void {
  const root = roots.get(rootId);
  const node = root ? nodesById.get(root.nodeId) : null;
  if (root && node) useAgentModeStore.setState({ activeRoot: rootSummary(node, root) });
}

function normalizeDecision(value: AgentConsentDecision): AgentConsentDecision {
  if (
    (value.decision !== "allow" && value.decision !== "deny") ||
    typeof value.reason !== "string" ||
    value.reason.length > 240
  ) {
    throw policyError(
      "AGENT_CONSENT_DENIED",
      "Agent returned an invalid permission decision",
    );
  }
  return {
    decision: value.decision,
    reason: value.reason.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 240),
  };
}

function recordDecision(
  challenge: AgentConsentChallenge,
  decision: AgentConsentDecision,
): void {
  useAgentModeStore.setState((state) => ({
    decisions: [
      ...state.decisions,
      {
        id: challenge.id,
        rootId: challenge.rootId,
        at: Date.now(),
        requesterAppId: challenge.requester.appId,
        kind: challenge.kind,
        persistence: challenge.persistence,
        decision: decision.decision,
        reason: decision.reason,
      },
    ].slice(-100),
  }));
}

function policyError(
  code: ConstructorParameters<typeof KernelPolicyError>[0],
  message: string,
  retryAfterMs?: number,
): KernelPolicyError {
  return new KernelPolicyError(code, message, {
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function randomId(): string {
  return randomHex(16);
}

function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
