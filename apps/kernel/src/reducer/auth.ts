import { create } from "zustand";
import icblastDefault, { InternetIdentity } from "icblast";
import {
  Actor,
  HttpAgent,
  type ActorSubclass,
  type Identity,
} from "@dfinity/agent";
import type { Principal } from "@dfinity/principal";
import { clearPendingRepositorySetup } from "neutron-tools/repository";
import { getNeutronId } from "../config.ts";
import type {
  DeploymentReference,
  InstallJournal,
  InstallJournalStatus,
  KernelInstallCodeChunkedRequest,
  KernelInstallCommitResult,
  KernelInstallReservationsPrepareRequest,
  KernelInstallWasmChunkRequest,
  KernelRuntimeInfo,
} from "neutron-compiler/src/install.js";
import type {
  KernelAccessSnapshotWire,
  KernelAppUsageSnapshotWire,
  KernelMemorySnapshot,
  KernelSettingsSnapshot,
  ScheduledTaskSummary,
} from "../settings/model.ts";
import type {
  CapabilityPageInputWire,
  CapabilityPageWire,
  CapabilitySetEnabledInputWire,
  CapabilitySummaryWire,
} from "../settings/capability_registry.ts";
import type { CertifiedAssetsSettingsActor } from "../settings/certified_assets_settings.ts";
import { certifiedAssetsSettingsIdl } from "../settings/certified_assets_settings_idl.ts";
import { clearTrayState } from "../tray/service.ts";
import { clearConnectionRequestsForAuth } from "./connections.ts";
import { removeAllCallRequests } from "./request.ts";
import { AuthGeneration } from "./auth_generation.ts";
import { kernelSetupStorage } from "../bootstrap.ts";
import { getRuntimeDeployment } from "../runtime_deployment.ts";
import { takePendingActivation } from "../activation_handoff.ts";
import {
  redeemActivation,
  type ActivationResult,
} from "./activation.ts";

type IcblastFactory = (options?: Record<string, unknown>) => any;
type IcblastClient = (canister: string, candid?: string) => Promise<any>;

export type KernelActor = CertifiedAssetsSettingsActor & {
  kernel_check_authorized(req: null): Promise<boolean>;
  kernel_install_code(req: {
    wasm: Uint8Array;
    candid: string;
    deployment_id: string;
  }): Promise<null>;
  kernel_install_wasm_chunks_clear(
    req: DeploymentReference,
  ): Promise<null>;
  kernel_install_wasm_chunk(
    req: KernelInstallWasmChunkRequest,
  ): Promise<null>;
  kernel_install_code_chunked(
    req: KernelInstallCodeChunkedRequest,
  ): Promise<null>;
  kernel_install_begin_checked(req: {
    journal: InstallJournal;
    expected_deployment_id: string;
  }): Promise<null>;
  kernel_install_reservations_prepare(
    req: KernelInstallReservationsPrepareRequest,
  ): Promise<null>;
  kernel_install_status(req: null): Promise<[] | [InstallJournalStatus]>;
  kernel_install_commit(
    req: DeploymentReference,
  ): Promise<KernelInstallCommitResult>;
  kernel_install_pending_reservation_blockers(req: {
    deployment_id: string;
  }): Promise<unknown>;
  kernel_install_pending_reservation_release(req: {
    deployment_id: string;
    reservation_id: bigint;
  }): Promise<boolean>;
  kernel_install_abort(req: DeploymentReference): Promise<null>;
  kernel_runtime_info(): Promise<KernelRuntimeInfo>;
  kernel_app_usage_snapshot(
    req: null,
  ): Promise<KernelAppUsageSnapshotWire>;
  kernel_memory_snapshot(req: null): Promise<KernelMemorySnapshot>;
  kernel_settings_snapshot(req: null): Promise<KernelSettingsSnapshot>;
  kernel_scheduled_tasks_snapshot(req: null): Promise<ScheduledTaskSummary[]>;
  kernel_capabilities_page(
    req: CapabilityPageInputWire,
  ): Promise<CapabilityPageWire>;
  kernel_capability_set_enabled(
    req: CapabilitySetEnabledInputWire,
  ): Promise<CapabilitySummaryWire>;
  kernel_access_snapshot(req: null): Promise<KernelAccessSnapshotWire>;
  kernel_authorized_add(req: Principal): Promise<null>;
  kernel_authorized_rem(req: Principal): Promise<null>;
  kernel_activation(
    req: { use: Uint8Array } | { set: Uint8Array },
  ): Promise<ActivationResult>;
  kernel_controller_add(req: Principal): Promise<KernelAccessSnapshotWire>;
  kernel_controller_rem(req: Principal): Promise<KernelAccessSnapshotWire>;
  kernel_static(req: unknown): Promise<null>;
  kernel_static_query(req: { list: { prefix: string } }): Promise<string[]>;
  kernel_connections_begin(req: {
    app_id: string;
    provider: string;
    callback_base: string;
  }): Promise<unknown>;
  kernel_connections_complete(req: {
    flow_id: string;
    code: string;
  }): Promise<unknown>;
  kernel_connections_list(req: {
    app_id: string;
    provider: string | null;
  }): Promise<unknown>;
  kernel_connections_acquire(req: {
    app_id: string;
    provider: string;
  }): Promise<unknown>;
  kernel_connections_disconnect(req: {
    app_id: string;
    provider: string;
  }): Promise<unknown>;
  kernel_backend_reservations_snapshot(req: null): Promise<unknown>;
  kernel_backend_reservations_apply(req: {
    app_id: string;
    actions: unknown[];
  }): Promise<unknown>;
  kernel_media_session_begin(req: {
    app_id: string;
    request_id: string;
    features: Array<{ camera: null } | { microphone: null }>;
    duration_seconds: bigint;
  }): Promise<unknown>;
  kernel_media_session_close(sessionId: string): Promise<unknown>;
  kernel_vetkeys_admin_snapshot(req: null): Promise<unknown>;
  kernel_vetkeys_binding(req: {
    app_id: string;
    slot_id: string;
  }): Promise<unknown>;
  kernel_vetkeys_enable(req: { app_id: string; slot_id: string }): Promise<unknown>;
  kernel_vetkeys_disable(req: { app_id: string; slot_id: string }): Promise<unknown>;
  kernel_vetkeys_rotate(req: { app_id: string; slot_id: string }): Promise<unknown>;
  kernel_vetkeys_retire_generation(req: {
    app_id: string;
    slot_id: string;
    generation: bigint;
  }): Promise<unknown>;
  kernel_vetkeys_transfer(req: {
    app_id: string;
    slot_id: string;
    new_holder: Principal;
  }): Promise<unknown>;
  kernel_vetkeys_retire_slot(req: {
    app_id: string;
    slot_id: string;
  }): Promise<unknown>;
};

type AuthState = {
  logged: boolean;
  authorized: boolean;
  principal: string;
  sessionGeneration: number;
  loading: boolean;
  authError: string | null;
  setAuth: (auth: {
    logged: boolean;
    authorized: boolean;
    principal: string;
    authError?: string | null;
  }) => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  logged: false,
  authorized: false,
  principal: "2vxsx-fae",
  sessionGeneration: 0,
  loading: true,
  authError: null,
  setAuth: ({ logged, authorized, principal, authError = null }) =>
    set((state) => ({
      logged,
      authorized,
      principal,
      sessionGeneration: state.sessionGeneration + 1,
      authError,
      loading: false,
    })),
}));

const createIcblast = icblastDefault as unknown as IcblastFactory;
const ANONYMOUS_PRINCIPAL = "2vxsx-fae";

let ic: IcblastClient | null = null;
let neutronCan: KernelActor | null = null;
let neutronDynamicCan: any = null;
let neutronDynamicCanPromise: Promise<any> | null = null;
let neutronBootstrapCan: ActorSubclass<KernelActor> | null = null;
let neutronCanGeneration = 0;
let activeIdentity: Identity | null = null;
const identityActivation = new AuthGeneration();
const internetIdentityReady = InternetIdentity.create();
let logoutActive = false;
const proxyNonMethods = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
  "inspect",
]);
type LoginOptions = {
  openAuth?: boolean;
};

export async function login({
  openAuth = true,
}: LoginOptions = {}): Promise<void> {
  if (logoutActive) return;
  const activationGeneration = identityActivation.capture();
  await internetIdentityReady;
  if (activeIdentity) return;

  const authenticated = await InternetIdentity.isAuthenticated();
  if (
    !authenticated ||
    InternetIdentity.getPrincipal().toText() === ANONYMOUS_PRINCIPAL
  ) {
    if (openAuth) {
      const identityProvider = currentIdentityProvider();
      await InternetIdentity.login({
        ...(identityProvider
          ? {
              identityProvider,
            }
          : {}),
      });
    }
  }

  const identity = InternetIdentity.getIdentity();
  const nextAuthenticated = await InternetIdentity.isAuthenticated();
  const logged = !(
    !nextAuthenticated ||
    InternetIdentity.getPrincipal().toText() === ANONYMOUS_PRINCIPAL
  );

  if (!identityActivation.isCurrent(activationGeneration)) return;
  await activateIdentity(identity, logged);
}

function currentIdentityProvider(): string | undefined {
  return getRuntimeDeployment().identityProvider;
}

export async function activateIdentity(
  identity: Identity,
  logged: boolean,
): Promise<void> {
  const activationGeneration = identityActivation.begin();
  removeAllCallRequests();
  const activationIsCurrent = () =>
    identityActivation.isCurrent(activationGeneration);
  const previousPrincipal = activeIdentity?.getPrincipal().toText() ?? null;
  const nextPrincipal = identity.getPrincipal().toText();
  if (previousPrincipal !== null && previousPrincipal !== nextPrincipal) {
    clearPendingSetupBestEffort();
  }
  clearTrayState();
  // A reload has no live consent request, but may still be waiting for the
  // exact OAuth popup flow owned by this Internet Identity to report back.
  clearConnectionRequestsForAuth({ preserveStoredRecovery: logged });
  activeIdentity = logged ? identity : null;
  ic = createIcblast({
    ...runtimeIcblastOptions(),
    identity,
  }) as IcblastClient;
  resetNeutronCan();

  const principal = nextPrincipal;
  if (!logged) {
    if (!activationIsCurrent()) return;
    useAuthStore
      .getState()
      .setAuth({ logged: false, authorized: false, principal });
    return;
  }

  const neutronResult = await identityActivation.wait(
    activationGeneration,
    getBootstrapKernelCan(),
  );
  if (!neutronResult.current) return;
  const authorizedResult = await identityActivation.wait(
    activationGeneration,
    neutronResult.value.kernel_check_authorized(null),
  );
  if (!authorizedResult.current) return;
  let authorized = authorizedResult.value;
  const pendingActivation = takePendingActivation(kernelSetupStorage);
  if (!authorized && pendingActivation !== null) {
    const activationResult = await identityActivation.wait(
      activationGeneration,
      redeemActivation(neutronResult.value, pendingActivation),
    );
    if (!activationResult.current) return;
    if (!activationResult.value.authorized) {
      useAuthStore.getState().setAuth({
        logged: true,
        authorized: false,
        principal,
        authError: activationResult.value.message,
      });
      return;
    }
    const confirmation = await identityActivation.wait(
      activationGeneration,
      neutronResult.value.kernel_check_authorized(null),
    );
    if (!confirmation.current) return;
    authorized = confirmation.value;
  }
  if (!authorized) {
    if (!activationIsCurrent()) return;
    useAuthStore.getState().setAuth({
      logged: true,
      authorized: false,
      principal,
      authError:
        "This principal is not authorized for this Neutron canister. Authorize it manually or log out and use a different identity.",
    });
    return;
  }

  if (!activationIsCurrent()) return;
  useAuthStore
    .getState()
    .setAuth({ logged: true, authorized: true, principal });
}

export async function logout(): Promise<void> {
  if (logoutActive) return;
  logoutActive = true;
  const logoutGeneration = identityActivation.begin();
  removeAllCallRequests();
  clearTrayState();
  clearConnectionRequestsForAuth();
  clearPendingSetupBestEffort();
  try {
    await internetIdentityReady;
    if (!identityActivation.isCurrent(logoutGeneration)) return;
    ic = createIcblast(runtimeIcblastOptions()) as IcblastClient;
    resetNeutronCan();
    activeIdentity = null;
    useAuthStore.getState().setAuth({
      logged: false,
      authorized: false,
      principal: ANONYMOUS_PRINCIPAL,
    });
    await InternetIdentity.logout();
  } finally {
    logoutActive = false;
  }
}

function clearPendingSetupBestEffort(): void {
  try {
    clearPendingRepositorySetup(kernelSetupStorage);
  } catch {
    // Session storage is optional for ordinary Neutron use.
  }
}

export function getIC(): IcblastClient {
  if (!ic) ic = createIcblast(runtimeIcblastOptions()) as IcblastClient;
  return ic;
}

function createDynamicIcblastClient(): IcblastClient {
  return createIcblast({
    ...runtimeIcblastOptions(),
    ...(activeIdentity ? { identity: activeIdentity } : {}),
  }) as IcblastClient;
}

function runtimeIcblastOptions(): Record<string, unknown> {
  const deployment = getRuntimeDeployment();
  return {
    local: deployment.local,
    local_host: deployment.gateway,
    agentOptions: { host: deployment.gateway },
  };
}

export function resetNeutronCan(): void {
  neutronCanGeneration += 1;
  neutronCan = null;
  neutronDynamicCan = null;
  neutronDynamicCanPromise = null;
  neutronBootstrapCan = null;
}

async function getBootstrapKernelCan(): Promise<ActorSubclass<KernelActor>> {
  if (neutronBootstrapCan) return neutronBootstrapCan;
  const runtimeDeployment = getRuntimeDeployment();
  const generation = neutronCanGeneration;
  const identity = activeIdentity ?? InternetIdentity.getIdentity();
  const agent = await HttpAgent.create({
    host: runtimeDeployment.gateway,
    identity,
    ...(runtimeDeployment.local
      ? { verifyQuerySignatures: false }
      : {}),
  });
  if (runtimeDeployment.rootKeyPolicy === "fetch") await agent.fetchRootKey();

  const kernel = Actor.createActor<KernelActor>(kernelIdl, {
    agent,
    canisterId: getNeutronId(),
  });
  if (generation === neutronCanGeneration) neutronBootstrapCan = kernel;
  return kernel;
}

async function fetchKernelAsset(key: string): Promise<Response | undefined> {
  const response = await fetch(key);
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`Could not fetch kernel asset ${key}: HTTP ${response.status}`);
  }
  return response;
}

export async function readKernelAssetText(key: string): Promise<string> {
  const response = await fetchKernelAsset(key);
  if (!response) throw new Error(`Kernel asset ${key} was not found`);
  return response.text();
}

export async function readKernelAssetTextIfExists(
  key: string,
): Promise<string | undefined> {
  const response = await fetchKernelAsset(key);
  return response?.text();
}

export async function readKernelAssetJson<T>(
  key: string,
): Promise<T | undefined> {
  const response = await fetchKernelAsset(key);
  if (!response) return undefined;
  return (await response.json()) as T;
}

export function getNeutronDynamicCan(): Promise<any> {
  if (neutronDynamicCan) return Promise.resolve(neutronDynamicCan);
  if (neutronDynamicCanPromise) return neutronDynamicCanPromise;

  const generation = neutronCanGeneration;
  // icblast caches actors by canister ID inside each client. The combined
  // Neutron Candid changes after an app install, update, or uninstall, so a
  // shared client would return its old actor even after resetNeutronCan()
  // cleared our own cache. Give every Candid generation its own client.
  const generationClient = createDynamicIcblastClient();
  const pending = (async () => {
    const candid = await readKernelAssetText("/pkg/neutron.did");
    const actor = await generationClient(getNeutronId(), candid);
    // An identity change may complete while Candid is being fetched or
    // compiled. Never publish that actor into the next identity generation;
    // callers waiting on it join the current generation instead.
    if (generation !== neutronCanGeneration) return getNeutronDynamicCan();
    neutronDynamicCan = actor;
    return actor;
  })().finally(() => {
    // Successful actors live in neutronDynamicCan. Clearing the settled
    // promise also makes a failed HTTP/Candid load retryable.
    if (neutronDynamicCanPromise === pending) neutronDynamicCanPromise = null;
  });
  neutronDynamicCanPromise = pending;
  return pending;
}

function withDynamicFallback(kernel: KernelActor): KernelActor {
  return new Proxy(kernel, {
    get(target, prop) {
      if (prop in target)
        return target[prop as keyof ActorSubclass<KernelActor>];
      if (typeof prop !== "string") return undefined;
      if (proxyNonMethods.has(prop)) return undefined;

      return async (...args: unknown[]) => {
        const dynamicCan = await getNeutronDynamicCan();
        const method = dynamicCan[prop];
        if (typeof method !== "function") {
          throw new Error(`Unknown Neutron method: ${prop}`);
        }

        return method(...args);
      };
    },
  }) as KernelActor;
}

export async function getNeutronCan(): Promise<KernelActor> {
  if (neutronCan) return neutronCan;
  const generation = neutronCanGeneration;
  // The kernel frontend and its control-plane interface are shipped in the
  // same package, so these methods can use their native Candid types. Methods
  // contributed by installed apps are deliberately absent from kernelIdl and
  // fall through to the runtime-discovered icblast actor above. Keep this
  // split identical on local replicas and the IC.
  const kernel = withDynamicFallback(await getBootstrapKernelCan());
  if (generation === neutronCanGeneration) neutronCan = kernel;
  return kernel;
}

const kernelIdl: Parameters<typeof Actor.createActor>[0] = ({ IDL }) => {
  const File = IDL.Record({
    chunks: IDL.Nat,
    content: IDL.Vec(IDL.Nat8),
    content_encoding: IDL.Text,
    content_type: IDL.Text,
  });
  const KernelStaticInput = IDL.Variant({
    clear: IDL.Record({ prefix: IDL.Text }),
    delete: IDL.Record({ key: IDL.Text }),
    store: IDL.Record({ key: IDL.Text, val: File }),
    store_chunk: IDL.Record({
      chunk_id: IDL.Nat,
      content: IDL.Vec(IDL.Nat8),
      key: IDL.Text,
    }),
  });
  const KernelStaticQueryInput = IDL.Variant({
    list: IDL.Record({ prefix: IDL.Text }),
  });
  const KernelInstallCodeInput = IDL.Record({
    candid: IDL.Text,
    deployment_id: IDL.Text,
    wasm: IDL.Vec(IDL.Nat8),
  });
  const KernelInstallWasmChunkInput = IDL.Record({
    deployment_id: IDL.Text,
    chunk: IDL.Vec(IDL.Nat8),
    sha256: IDL.Vec(IDL.Nat8),
  });
  const KernelInstallCodeChunkedInput = IDL.Record({
    deployment_id: IDL.Text,
    chunk_hashes: IDL.Vec(IDL.Vec(IDL.Nat8)),
    wasm_module_hash: IDL.Vec(IDL.Nat8),
  });
  const DeploymentReference = IDL.Record({ deployment_id: IDL.Text });
  const AssetCopy = IDL.Record({ source: IDL.Text, target: IDL.Text });
  const ResidentFrameSecurity = IDL.Variant({
    credentialless_opaque_v1: IDL.Null,
    credentialless_ephemeral_dedicated_v1: IDL.Null,
    persistent_dedicated_v1: IDL.Null,
  });
  const RuntimeApp = IDL.Record({
    app_id: IDL.Text,
    version: IDL.Nat,
    capability_plan_fingerprint: IDL.Text,
    resident_frame_security: ResidentFrameSecurity,
  });
  const AppScope = IDL.Record({
    app_id: IDL.Text,
    installation_uid: IDL.Nat64,
  });
  const CertifiedAssetsSettings = certifiedAssetsSettingsIdl(IDL, AppScope);
  const AppInstance = IDL.Record({
    scope: AppScope,
    version: IDL.Nat,
    deployment_id: IDL.Text,
    capability_plan_fingerprint: IDL.Text,
    browser_origin_nonce: IDL.Text,
    browser_origin_authority_epoch: IDL.Nat64,
    resident_frame_security: ResidentFrameSecurity,
  });
  const InstallJournal = IDL.Record({
    deployment_id: IDL.Text,
    copies: IDL.Vec(AssetCopy),
    clear_prefixes: IDL.Vec(IDL.Text),
    target_app_inventory: IDL.Vec(RuntimeApp),
  });
  const CheckedInstallJournal = IDL.Record({
    journal: InstallJournal,
    expected_deployment_id: IDL.Text,
  });
  const InstallStatus = IDL.Record({
    deployment_id: IDL.Text,
    copy_count: IDL.Nat,
    clear_count: IDL.Nat,
    removed_apps: IDL.Vec(IDL.Text),
    committed_app_instances: IDL.Vec(AppInstance),
    target_app_instances: IDL.Vec(AppInstance),
  });
  const RuntimeMemory = IDL.Record({
    id: IDL.Text,
    owner: IDL.Text,
    version: IDL.Nat,
    schema: IDL.Text,
  });
  const RuntimeInfo = IDL.Record({
    deployment_id: IDL.Text,
    assembler_id: IDL.Text,
    compiler_id: IDL.Text,
    apps: IDL.Vec(AppInstance),
    memories: IDL.Vec(RuntimeMemory),
  });
  const KernelSettingsSnapshot = IDL.Record({
    snapshot_version: IDL.Nat,
    cycles_balance: IDL.Nat,
    rts_version: IDL.Text,
    wasm_memory_bytes: IDL.Nat,
    heap_size_bytes: IDL.Nat,
    total_allocation_bytes: IDL.Nat,
    reclaimed_bytes: IDL.Nat,
    max_live_size_bytes: IDL.Nat,
    stable_memory_bytes: IDL.Nat,
    logical_stable_memory_bytes: IDL.Nat,
  });
  const KernelMemorySnapshot = IDL.Record({
    snapshot_version: IDL.Nat,
    wasm_memory_bytes: IDL.Nat,
    stable_memory_bytes: IDL.Nat,
    wasm_memory_limit_bytes: IDL.Nat,
    stable_memory_limit_bytes: IDL.Nat,
  });
  const AppUsageDay = IDL.Record({
    day: IDL.Nat64,
    instructions: IDL.Nat64,
    executions: IDL.Nat64,
    outgoing_cycles: IDL.Nat,
    incoming_cycles_accepted: IDL.Nat,
  });
  const AppUsage = IDL.Record({
    app_id: IDL.Text,
    installation_uid: IDL.Nat64,
    lifetime_instructions: IDL.Nat64,
    lifetime_executions: IDL.Nat64,
    lifetime_outgoing_cycles: IDL.Nat,
    lifetime_incoming_cycles_accepted: IDL.Nat,
    window_instructions: IDL.Nat64,
    window_executions: IDL.Nat64,
    window_outgoing_cycles: IDL.Nat,
    window_incoming_cycles_accepted: IDL.Nat,
    days: IDL.Vec(AppUsageDay),
  });
  const KernelAppUsageSnapshot = IDL.Record({
    snapshot_version: IDL.Nat,
    current_day: IDL.Nat64,
    apps: IDL.Vec(AppUsage),
  });
  const KernelAccessSnapshot = IDL.Record({
    snapshot_version: IDL.Nat,
    authorized_principals: IDL.Vec(IDL.Principal),
    controllers: IDL.Vec(IDL.Principal),
    self_principal: IDL.Principal,
    controller_limit: IDL.Nat,
  });
  const BackendReservationScope = IDL.Variant({
    exact: IDL.Record({ principal: IDL.Principal, method: IDL.Text }),
    principal: IDL.Principal,
    method: IDL.Text,
  });
  const BackendReservationAction = IDL.Variant({
    reserve: BackendReservationScope,
    release: BackendReservationScope,
  });
  const BackendReservationSummary = IDL.Record({
    id: IDL.Nat,
    app_id: IDL.Text,
    installation_uid: IDL.Nat64,
    scope_kind: IDL.Text,
    principal: IDL.Opt(IDL.Principal),
    method: IDL.Opt(IDL.Text),
    created_at: IDL.Nat64,
    created_by: IDL.Principal,
  });
  const PendingReservationBlocker = IDL.Record({
    reservation: BackendReservationSummary,
    reason: IDL.Variant({
      scope_conflict: IDL.Null,
      app_capacity: IDL.Null,
      global_capacity: IDL.Null,
    }),
  });
  const ScheduledTaskSummary = IDL.Record({
    app_id: IDL.Text,
    installation_uid: IDL.Nat64,
    id: IDL.Text,
    method: IDL.Text,
    interval_seconds: IDL.Nat,
    run_on_start: IDL.Bool,
    max_backend_calls: IDL.Nat,
    enabled: IDL.Bool,
    running: IDL.Bool,
  });
  const CapabilityKind = IDL.Variant({
    backend_calls: IDL.Null,
    randomness: IDL.Null,
    chain_key_signing: IDL.Null,
    stable_store: IDL.Null,
    https_outcalls: IDL.Null,
    vetkeys: IDL.Null,
    scheduled_tasks: IDL.Null,
    connections: IDL.Null,
    persistent_browser_storage: IDL.Null,
    dedicated_resident_origin: IDL.Null,
    http_routes: IDL.Null,
    certified_read_routes: IDL.Null,
    certified_assets: IDL.Null,
    public_ingress: IDL.Null,
  });
  const CapabilityGrantMode = IDL.Variant({
    declaration: IDL.Null,
    owner_runtime_grant: IDL.Null,
  });
  const CapabilityOutcome = IDL.Variant({
    ok: IDL.Null,
    denied: IDL.Null,
    failed: IDL.Null,
    rate_limited: IDL.Null,
    busy: IDL.Null,
    revoked: IDL.Null,
  });
  const CapabilityUsage = IDL.Record({
    total: IDL.Nat64,
    succeeded: IDL.Nat64,
    denied: IDL.Nat64,
    failed: IDL.Nat64,
    rate_limited: IDL.Nat64,
    busy: IDL.Nat64,
    revoked: IDL.Nat64,
    last_at: IDL.Opt(IDL.Nat64),
    last_operation: IDL.Opt(IDL.Text),
    last_outcome: IDL.Opt(CapabilityOutcome),
  });
  const CapabilitySummary = IDL.Record({
    scope: AppScope,
    plan_fingerprint: IDL.Text,
    kind: CapabilityKind,
    resource_id: IDL.Text,
    api: IDL.Nat,
    declaration_fingerprint: IDL.Text,
    grant: CapabilityGrantMode,
    toggleable: IDL.Bool,
    enabled: IDL.Bool,
    created_at: IDL.Nat64,
    created_by: IDL.Principal,
    updated_at: IDL.Nat64,
    updated_by: IDL.Principal,
    usage: CapabilityUsage,
  });
  const CapabilityPage = IDL.Record({
    entries: IDL.Vec(CapabilitySummary),
    next: IDL.Opt(IDL.Text),
  });
  const VetKeysEnvironment = IDL.Variant({
    production: IDL.Null,
    local: IDL.Null,
  });
  const VetKeysSlotStatus = IDL.Variant({
    enabled: IDL.Null,
    disabled: IDL.Null,
    manifest_suspended: IDL.Null,
  });
  const VetKeysGenerationStatus = IDL.Variant({
    current: IDL.Null,
    previous: IDL.Null,
  });
  const VetKeysGeneration = IDL.Record({
    generation: IDL.Nat64,
    status: VetKeysGenerationStatus,
    key_name: IDL.Text,
    public_fingerprint: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const VetKeysPublicSlot = IDL.Record({
    slot: IDL.Text,
    purpose: IDL.Text,
    key_holder: IDL.Principal,
    status: VetKeysSlotStatus,
    environment: VetKeysEnvironment,
    current_generation: IDL.Nat64,
    previous_generation: IDL.Opt(IDL.Nat64),
    generations: IDL.Vec(VetKeysGeneration),
    created_at: IDL.Nat64,
    updated_at: IDL.Nat64,
    last_used_at: IDL.Opt(IDL.Nat64),
    total_derivations: IDL.Nat,
    approximate_cycle_spend: IDL.Nat,
  });
  const VetKeysAdminSlot = IDL.Record({
    app_id: IDL.Text,
    installation_uid: IDL.Nat64,
    slot_uid: IDL.Nat,
    slot: IDL.Text,
    purpose: IDL.Opt(IDL.Text),
    key_holder: IDL.Principal,
    status: VetKeysSlotStatus,
    current_generation: IDL.Nat64,
    previous_generation: IDL.Opt(IDL.Nat64),
    generations: IDL.Vec(VetKeysGeneration),
    created_at: IDL.Nat64,
    created_by: IDL.Principal,
    updated_at: IDL.Nat64,
    updated_by: IDL.Principal,
    last_used_at: IDL.Opt(IDL.Nat64),
    total_derivations: IDL.Nat,
    approximate_cycle_spend: IDL.Nat,
  });
  const VetKeysAudit = IDL.Record({
    at: IDL.Nat64,
    scope: AppScope,
    slot_uid: IDL.Opt(IDL.Nat),
    slot_id: IDL.Text,
    generation: IDL.Opt(IDL.Nat64),
    action: IDL.Variant({
      reserve: IDL.Null,
      enable: IDL.Null,
      disable: IDL.Null,
      rotate: IDL.Null,
      retire_generation: IDL.Null,
      transfer: IDL.Null,
      retire_slot: IDL.Null,
      uninstall: IDL.Null,
      derive: IDL.Null,
      public_key: IDL.Null,
      manifest_suspend: IDL.Null,
    }),
    principal: IDL.Principal,
    outcome: IDL.Variant({
      ok: IDL.Null,
      denied: IDL.Null,
      busy: IDL.Null,
      low_cycles: IDL.Null,
      unavailable: IDL.Null,
      failed: IDL.Null,
    }),
  });
  const VetKeysAdminSnapshot = IDL.Record({
    environment: IDL.Opt(VetKeysEnvironment),
    slots: IDL.Vec(VetKeysAdminSlot),
    audit: IDL.Vec(VetKeysAudit),
  });
  const VetKeysError = IDL.Variant({
    not_declared: IDL.Null,
    not_reserved: IDL.Null,
    manifest_suspended: IDL.Null,
    disabled: IDL.Null,
    generation_unavailable: IDL.Null,
    invalid_request: IDL.Null,
    challenge_expired: IDL.Null,
    challenge_consumed: IDL.Null,
    busy: IDL.Null,
    low_cycles: IDL.Null,
    key_unavailable: IDL.Null,
    management_failure: IDL.Null,
    source_gone: IDL.Null,
    owner_required: IDL.Null,
  });
  const VetKeysSlotResult = IDL.Variant({
    ok: VetKeysPublicSlot,
    err: VetKeysError,
  });
  const VetKeysUnitResult = IDL.Variant({
    ok: IDL.Null,
    err: VetKeysError,
  });
  const VetKeysBindingResult = IDL.Variant({
    ok: IDL.Nat,
    err: VetKeysError,
  });
  const ActivationResult = IDL.Variant({
    ready: IDL.Null,
    authorized: IDL.Null,
    already_authorized: IDL.Null,
    already_set: IDL.Null,
    already_activated: IDL.Null,
    invalid: IDL.Null,
  });
  const MediaSessionFeature = IDL.Variant({
    camera: IDL.Null,
    microphone: IDL.Null,
  });
  const MediaSessionLease = IDL.Record({
    session_id: IDL.Text,
    app_id: IDL.Text,
    installation_uid: IDL.Nat64,
    app_version: IDL.Nat,
    plan_fingerprint: IDL.Text,
    origin_nonce: IDL.Text,
    entrypoint: IDL.Text,
    features: IDL.Vec(MediaSessionFeature),
    created_at: IDL.Nat64,
    expires_at: IDL.Nat64,
    authority_epoch: IDL.Nat64,
  });
  const MediaSessionBeginResult = IDL.Variant({
    ok: MediaSessionLease,
    err: IDL.Variant({
      invalid_request: IDL.Null,
      undeclared: IDL.Null,
      disabled: IDL.Null,
      busy: IDL.Null,
      randomness_failed: IDL.Null,
      asset_unavailable: IDL.Null,
    }),
  });
  const MediaSessionCloseResult = IDL.Variant({
    ok: IDL.Null,
    not_found: IDL.Null,
    denied: IDL.Null,
  });

  return IDL.Service({
    ...CertifiedAssetsSettings.methods,
    kernel_capabilities_page: IDL.Func(
      [IDL.Record({ after: IDL.Opt(IDL.Text), limit: IDL.Nat })],
      [CapabilityPage],
      ["query"],
    ),
    kernel_capability_set_enabled: IDL.Func(
      [
        IDL.Record({
          app_id: IDL.Text,
          installation_uid: IDL.Nat64,
          kind: CapabilityKind,
          resource_id: IDL.Text,
          enabled: IDL.Bool,
        }),
      ],
      [CapabilitySummary],
      [],
    ),
    kernel_backend_reservations_apply: IDL.Func(
      [IDL.Record({
        app_id: IDL.Text,
        actions: IDL.Vec(BackendReservationAction),
      })],
      [IDL.Vec(BackendReservationSummary)],
      [],
    ),
    kernel_backend_reservations_snapshot: IDL.Func(
      [IDL.Null],
      [IDL.Vec(BackendReservationSummary)],
      ["query"],
    ),
    kernel_media_session_begin: IDL.Func(
      [IDL.Record({
        app_id: IDL.Text,
        request_id: IDL.Text,
        features: IDL.Vec(MediaSessionFeature),
        duration_seconds: IDL.Nat,
      })],
      [MediaSessionBeginResult],
      [],
    ),
    kernel_media_session_close: IDL.Func(
      [IDL.Text],
      [MediaSessionCloseResult],
      [],
    ),
    kernel_access_snapshot: IDL.Func(
      [IDL.Null],
      [KernelAccessSnapshot],
      [],
    ),
    kernel_authorized_add: IDL.Func([IDL.Principal], [IDL.Null], []),
    kernel_authorized_rem: IDL.Func([IDL.Principal], [IDL.Null], []),
    kernel_activation: IDL.Func(
      [
        IDL.Variant({
          set: IDL.Vec(IDL.Nat8),
          use: IDL.Vec(IDL.Nat8),
        }),
      ],
      [ActivationResult],
      [],
    ),
    kernel_check_authorized: IDL.Func([IDL.Null], [IDL.Bool], ["query"]),
    kernel_controller_add: IDL.Func(
      [IDL.Principal],
      [KernelAccessSnapshot],
      [],
    ),
    kernel_controller_rem: IDL.Func(
      [IDL.Principal],
      [KernelAccessSnapshot],
      [],
    ),
    kernel_install_abort: IDL.Func([DeploymentReference], [IDL.Null], []),
    kernel_install_begin_checked: IDL.Func(
      [CheckedInstallJournal],
      [IDL.Null],
      [],
    ),
    kernel_install_reservations_prepare: IDL.Func(
      [
        IDL.Record({
          deployment_id: IDL.Text,
          apps: IDL.Vec(
            IDL.Record({
              app_id: IDL.Text,
              reservations: IDL.Vec(BackendReservationScope),
            }),
          ),
        }),
      ],
      [IDL.Null],
      [],
    ),
    kernel_install_code: IDL.Func([KernelInstallCodeInput], [IDL.Null], []),
    kernel_install_wasm_chunks_clear: IDL.Func(
      [DeploymentReference],
      [IDL.Null],
      [],
    ),
    kernel_install_wasm_chunk: IDL.Func(
      [KernelInstallWasmChunkInput],
      [IDL.Null],
      [],
    ),
    kernel_install_code_chunked: IDL.Func(
      [KernelInstallCodeChunkedInput],
      [IDL.Null],
      [],
    ),
    kernel_install_commit: IDL.Func(
      [DeploymentReference],
      [
        IDL.Variant({
          committed: IDL.Null,
          blocked: IDL.Null,
        }),
      ],
      [],
    ),
    kernel_install_pending_reservation_blockers: IDL.Func(
      [DeploymentReference],
      [IDL.Vec(PendingReservationBlocker)],
      ["query"],
    ),
    kernel_install_pending_reservation_release: IDL.Func(
      [
        IDL.Record({
          deployment_id: IDL.Text,
          reservation_id: IDL.Nat,
        }),
      ],
      [IDL.Bool],
      [],
    ),
    kernel_install_status: IDL.Func(
      [IDL.Null],
      [IDL.Opt(InstallStatus)],
      ["query"],
    ),
    kernel_runtime_info: IDL.Func([], [RuntimeInfo], ["query"]),
    kernel_app_usage_snapshot: IDL.Func(
      [IDL.Null],
      [KernelAppUsageSnapshot],
      ["query"],
    ),
    kernel_memory_snapshot: IDL.Func(
      [IDL.Null],
      [KernelMemorySnapshot],
      [],
    ),
    kernel_settings_snapshot: IDL.Func(
      [IDL.Null],
      [KernelSettingsSnapshot],
      ["query"],
    ),
    kernel_scheduled_tasks_snapshot: IDL.Func(
      [IDL.Null],
      [IDL.Vec(ScheduledTaskSummary)],
      ["query"],
    ),
    kernel_vetkeys_admin_snapshot: IDL.Func(
      [IDL.Null],
      [VetKeysAdminSnapshot],
      ["query"],
    ),
    kernel_vetkeys_binding: IDL.Func(
      [IDL.Record({ app_id: IDL.Text, slot_id: IDL.Text })],
      [VetKeysBindingResult],
      ["query"],
    ),
    kernel_vetkeys_enable: IDL.Func(
      [IDL.Record({ app_id: IDL.Text, slot_id: IDL.Text })],
      [VetKeysSlotResult],
      [],
    ),
    kernel_vetkeys_disable: IDL.Func(
      [IDL.Record({ app_id: IDL.Text, slot_id: IDL.Text })],
      [VetKeysSlotResult],
      [],
    ),
    kernel_vetkeys_rotate: IDL.Func(
      [IDL.Record({ app_id: IDL.Text, slot_id: IDL.Text })],
      [VetKeysSlotResult],
      [],
    ),
    kernel_vetkeys_retire_generation: IDL.Func(
      [
        IDL.Record({
          app_id: IDL.Text,
          slot_id: IDL.Text,
          generation: IDL.Nat64,
        }),
      ],
      [VetKeysSlotResult],
      [],
    ),
    kernel_vetkeys_transfer: IDL.Func(
      [
        IDL.Record({
          app_id: IDL.Text,
          slot_id: IDL.Text,
          new_holder: IDL.Principal,
        }),
      ],
      [VetKeysSlotResult],
      [],
    ),
    kernel_vetkeys_retire_slot: IDL.Func(
      [IDL.Record({ app_id: IDL.Text, slot_id: IDL.Text })],
      [VetKeysUnitResult],
      [],
    ),
    kernel_static: IDL.Func([KernelStaticInput], [IDL.Null], []),
    kernel_static_query: IDL.Func(
      [KernelStaticQueryInput],
      [IDL.Vec(IDL.Text)],
      ["query"],
    ),
  });
};
