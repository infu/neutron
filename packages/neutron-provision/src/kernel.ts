import {
  Actor,
  HttpAgent,
  type ActorMethod,
  type ActorSubclass,
  type Identity,
} from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import type {
  CheckedInstallJournalRequest,
  DeploymentReference,
  InstallJournalStatus,
  KernelInstallCodeChunkedRequest,
  KernelInstallCommitResult,
  KernelInstallCodeRequest,
  KernelInstallReservationsPrepareRequest,
  KernelInstallWasmChunkRequest,
  KernelPackageInstaller,
  KernelRuntimeInfo,
  KernelStaticRequest,
} from "neutron-compiler/src/install.js";
import { PocketIcRestClient } from "./pocketic_rest.ts";

export type KernelBackendReservationSummary = {
  id: bigint;
  app_id: string;
  installation_uid: bigint;
  scope_kind: string;
  principal: [] | [Principal];
  method: [] | [string];
  created_at: bigint;
  created_by: Principal;
};

export type KernelInstallPendingReservationBlocker = {
  reservation: KernelBackendReservationSummary;
  reason:
    | { scope_conflict: null }
    | { app_capacity: null }
    | { global_capacity: null };
};

export type KernelPublicationEntropyInitializeResult =
  | { ok: { fingerprint: Uint8Array } }
  | { err: { randomness_failed: null } };

export type KernelActor = KernelPackageInstaller & {
  kernel_publication_entropy_initialize(
    request: null,
  ): Promise<KernelPublicationEntropyInitializeResult>;
  kernel_install_pending_reservation_blockers(request: {
    deployment_id: string;
  }): Promise<KernelInstallPendingReservationBlocker[]>;
  kernel_install_pending_reservation_release(request: {
    deployment_id: string;
    reservation_id: bigint;
  }): Promise<boolean>;
};

export type KernelActorWithAccess = KernelActor & {
  kernel_authorized_recover: ActorMethod<[Principal], undefined>;
  kernel_authorized_rem: ActorMethod<[Principal], undefined>;
};

export function localIdentityFromSeed(seedByte: number): Ed25519KeyIdentity {
  if (!Number.isInteger(seedByte) || seedByte < 0 || seedByte > 255) {
    throw new Error("Identity seed must be an integer from 0 to 255");
  }
  const seed = new Uint8Array(32);
  seed[31] = seedByte;
  return Ed25519KeyIdentity.generate(seed);
}

export async function createKernelActor({
  canisterId,
  host,
  identity,
  fetchRootKey,
}: {
  canisterId: string;
  host: string;
  identity: Identity;
  fetchRootKey: boolean;
}): Promise<ActorSubclass<KernelActorWithAccess>> {
  const agent = await HttpAgent.create({
    host,
    identity,
    ...(fetchRootKey ? { verifyQuerySignatures: false } : {}),
  });
  if (fetchRootKey) await agent.fetchRootKey();
  return Actor.createActor<KernelActorWithAccess>(kernelIdl, {
    agent,
    canisterId,
  });
}

/**
 * Kernel actor backed by PocketIC's loopback control API. Unlike a replica
 * agent it does not sign every local ingress or verify hundreds of request
 * status certificates, but it preserves the exact caller principal and one
 * ingress message per actor method invocation.
 */
export function createDirectPocketIcKernelActor({
  controlUrl,
  instanceId,
  canisterId,
  caller,
  client = new PocketIcRestClient(controlUrl),
}: {
  controlUrl: string;
  instanceId: number;
  canisterId: string;
  caller: Principal;
  client?: Pick<
    PocketIcRestClient,
    "submitIngressMessage" | "awaitIngressMessage" | "queryCanister"
  >;
}): KernelActor {
  return new DirectPocketIcKernelActor({
    client,
    instanceId,
    canisterId: Principal.fromText(canisterId),
    caller,
  });
}

class DirectPocketIcKernelActor implements KernelActor {
  readonly #client: Pick<
    PocketIcRestClient,
    "submitIngressMessage" | "awaitIngressMessage" | "queryCanister"
  >;
  readonly #instanceId: number;
  readonly #canisterId: Principal;
  readonly #caller: Principal;
  readonly #methods: Map<string, IDL.FuncClass>;

  constructor({
    client,
    instanceId,
    canisterId,
    caller,
  }: {
    client: Pick<
      PocketIcRestClient,
      "submitIngressMessage" | "awaitIngressMessage" | "queryCanister"
    >;
    instanceId: number;
    canisterId: Principal;
    caller: Principal;
  }) {
    this.#client = client;
    this.#instanceId = instanceId;
    this.#canisterId = canisterId;
    this.#caller = caller;
    const service = kernelIdl({ IDL });
    this.#methods = new Map(service._fields);
  }

  kernel_static(request: KernelStaticRequest): Promise<unknown> {
    return this.#invoke("kernel_static", [request]);
  }

  async kernel_static_query(request: {
    list: { prefix: string };
  }): Promise<string[]> {
    return (await this.#invoke("kernel_static_query", [request])) as string[];
  }

  kernel_install_begin_checked(
    request: CheckedInstallJournalRequest,
  ): Promise<unknown> {
    return this.#invoke("kernel_install_begin_checked", [request]);
  }

  kernel_install_reservations_prepare(
    request: KernelInstallReservationsPrepareRequest,
  ): Promise<unknown> {
    return this.#invoke("kernel_install_reservations_prepare", [request]);
  }

  async kernel_install_status(
    request: null,
  ): Promise<[] | [InstallJournalStatus]> {
    return (await this.#invoke("kernel_install_status", [request])) as
      | []
      | [InstallJournalStatus];
  }

  async kernel_install_commit(
    request: DeploymentReference,
  ): Promise<KernelInstallCommitResult> {
    return (await this.#invoke("kernel_install_commit", [
      request,
    ])) as KernelInstallCommitResult;
  }

  kernel_install_abort(request: DeploymentReference): Promise<unknown> {
    return this.#invoke("kernel_install_abort", [request]);
  }

  kernel_install_code(request: KernelInstallCodeRequest): Promise<unknown> {
    return this.#invoke("kernel_install_code", [request]);
  }

  kernel_install_wasm_chunks_clear(
    request: DeploymentReference,
  ): Promise<unknown> {
    return this.#invoke("kernel_install_wasm_chunks_clear", [request]);
  }

  kernel_install_wasm_chunk(
    request: KernelInstallWasmChunkRequest,
  ): Promise<unknown> {
    return this.#invoke("kernel_install_wasm_chunk", [request]);
  }

  kernel_install_code_chunked(
    request: KernelInstallCodeChunkedRequest,
  ): Promise<unknown> {
    return this.#invoke("kernel_install_code_chunked", [request]);
  }

  async kernel_install_pending_reservation_blockers(request: {
    deployment_id: string;
  }): Promise<KernelInstallPendingReservationBlocker[]> {
    return (await this.#invoke("kernel_install_pending_reservation_blockers", [
      request,
    ])) as KernelInstallPendingReservationBlocker[];
  }

  async kernel_install_pending_reservation_release(request: {
    deployment_id: string;
    reservation_id: bigint;
  }): Promise<boolean> {
    return (await this.#invoke("kernel_install_pending_reservation_release", [
      request,
    ])) as boolean;
  }

  async kernel_publication_entropy_initialize(
    _request: null,
  ): Promise<KernelPublicationEntropyInitializeResult> {
    return (await this.#invoke(
      "kernel_publication_entropy_initialize",
      [null],
    )) as KernelPublicationEntropyInitializeResult;
  }

  async kernel_runtime_info(): Promise<KernelRuntimeInfo> {
    return (await this.#invoke("kernel_runtime_info", [])) as KernelRuntimeInfo;
  }

  async #invoke(methodName: string, args: unknown[]): Promise<unknown> {
    const method = this.#methods.get(methodName);
    if (method === undefined) {
      throw new Error(`PocketIC kernel IDL has no ${methodName} method`);
    }
    const payload = new Uint8Array(IDL.encode(method.argTypes, args));
    const call = {
      sender: this.#caller,
      canisterId: this.#canisterId,
      method: methodName,
      payload,
    };
    const reply = method.annotations.some(
      (annotation) => annotation === "query" || annotation === "composite_query",
    )
      ? await this.#client.queryCanister(this.#instanceId, call)
      : await this.#client.awaitIngressMessage(
          this.#instanceId,
          await this.#client.submitIngressMessage(this.#instanceId, call),
        );
    const values = IDL.decode(method.retTypes, reply);
    return values.length === 0 ? undefined : values[0];
  }
}

export const kernelIdl: Parameters<typeof Actor.createActor>[0] = ({ IDL }) => {
  const file = IDL.Record({
    chunks: IDL.Nat,
    content: IDL.Vec(IDL.Nat8),
    content_encoding: IDL.Text,
    content_type: IDL.Text,
  });
  const staticInput = IDL.Variant({
    clear: IDL.Record({ prefix: IDL.Text }),
    delete: IDL.Record({ key: IDL.Text }),
    store: IDL.Record({ key: IDL.Text, val: file }),
    store_chunk: IDL.Record({
      chunk_id: IDL.Nat,
      content: IDL.Vec(IDL.Nat8),
      key: IDL.Text,
    }),
  });
  const appScope = IDL.Record({
    app_id: IDL.Text,
    installation_uid: IDL.Nat64,
  });
  const residentFrameSecurity = IDL.Variant({
    credentialless_opaque_v1: IDL.Null,
    credentialless_ephemeral_dedicated_v1: IDL.Null,
    persistent_dedicated_v1: IDL.Null,
  });
  const appInstance = IDL.Record({
    scope: appScope,
    version: IDL.Nat,
    deployment_id: IDL.Text,
    capability_plan_fingerprint: IDL.Text,
    browser_origin_nonce: IDL.Text,
    browser_origin_authority_epoch: IDL.Nat64,
    resident_frame_security: residentFrameSecurity,
  });
  const deploymentReference = IDL.Record({ deployment_id: IDL.Text });
  const backendReservationScope = IDL.Variant({
    exact: IDL.Record({
      principal: IDL.Principal,
      method: IDL.Text,
    }),
    principal: IDL.Principal,
    method: IDL.Text,
  });
  const backendReservationSummary = IDL.Record({
    id: IDL.Nat,
    app_id: IDL.Text,
    installation_uid: IDL.Nat64,
    scope_kind: IDL.Text,
    principal: IDL.Opt(IDL.Principal),
    method: IDL.Opt(IDL.Text),
    created_at: IDL.Nat64,
    created_by: IDL.Principal,
  });
  const installJournal = IDL.Record({
    deployment_id: IDL.Text,
    copies: IDL.Vec(IDL.Record({ source: IDL.Text, target: IDL.Text })),
    clear_prefixes: IDL.Vec(IDL.Text),
    target_app_inventory: IDL.Vec(
      IDL.Record({
        app_id: IDL.Text,
        version: IDL.Nat,
        capability_plan_fingerprint: IDL.Text,
        resident_frame_security: residentFrameSecurity,
      }),
    ),
  });
  const installStatus = IDL.Record({
    deployment_id: IDL.Text,
    copy_count: IDL.Nat,
    clear_count: IDL.Nat,
    removed_apps: IDL.Vec(IDL.Text),
    committed_app_instances: IDL.Vec(appInstance),
    target_app_instances: IDL.Vec(appInstance),
  });
  const runtimeInfo = IDL.Record({
    deployment_id: IDL.Text,
    assembler_id: IDL.Text,
    compiler_id: IDL.Text,
    apps: IDL.Vec(appInstance),
    memories: IDL.Vec(
      IDL.Record({
        id: IDL.Text,
        owner: IDL.Text,
        version: IDL.Nat,
        schema: IDL.Text,
      }),
    ),
  });
  return IDL.Service({
    kernel_authorized_recover: IDL.Func([IDL.Principal], [], []),
    kernel_authorized_rem: IDL.Func([IDL.Principal], [], []),
    kernel_install_abort: IDL.Func([deploymentReference], [IDL.Null], []),
    kernel_install_begin_checked: IDL.Func(
      [
        IDL.Record({
          journal: installJournal,
          expected_deployment_id: IDL.Text,
        }),
      ],
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
              reservations: IDL.Vec(backendReservationScope),
            }),
          ),
        }),
      ],
      [IDL.Null],
      [],
    ),
    kernel_install_code: IDL.Func(
      [
        IDL.Record({
          candid: IDL.Text,
          deployment_id: IDL.Text,
          wasm: IDL.Vec(IDL.Nat8),
        }),
      ],
      [IDL.Null],
      [],
    ),
    kernel_install_wasm_chunks_clear: IDL.Func(
      [deploymentReference],
      [IDL.Null],
      [],
    ),
    kernel_install_wasm_chunk: IDL.Func(
      [
        IDL.Record({
          deployment_id: IDL.Text,
          chunk: IDL.Vec(IDL.Nat8),
          sha256: IDL.Vec(IDL.Nat8),
        }),
      ],
      [IDL.Null],
      [],
    ),
    kernel_install_code_chunked: IDL.Func(
      [
        IDL.Record({
          deployment_id: IDL.Text,
          chunk_hashes: IDL.Vec(IDL.Vec(IDL.Nat8)),
          wasm_module_hash: IDL.Vec(IDL.Nat8),
        }),
      ],
      [IDL.Null],
      [],
    ),
    kernel_install_commit: IDL.Func(
      [deploymentReference],
      [
        IDL.Variant({
          committed: IDL.Null,
          blocked: IDL.Null,
        }),
      ],
      [],
    ),
    kernel_install_pending_reservation_blockers: IDL.Func(
      [deploymentReference],
      [
        IDL.Vec(
          IDL.Record({
            reservation: backendReservationSummary,
            reason: IDL.Variant({
              scope_conflict: IDL.Null,
              app_capacity: IDL.Null,
              global_capacity: IDL.Null,
            }),
          }),
        ),
      ],
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
      [IDL.Opt(installStatus)],
      ["query"],
    ),
    kernel_runtime_info: IDL.Func([], [runtimeInfo], ["query"]),
    kernel_publication_entropy_initialize: IDL.Func(
      [IDL.Null],
      [
        IDL.Variant({
          ok: IDL.Record({ fingerprint: IDL.Vec(IDL.Nat8) }),
          err: IDL.Variant({ randomness_failed: IDL.Null }),
        }),
      ],
      [],
    ),
    kernel_static: IDL.Func([staticInput], [IDL.Null], []),
    kernel_static_query: IDL.Func(
      [IDL.Variant({ list: IDL.Record({ prefix: IDL.Text }) })],
      [IDL.Vec(IDL.Text)],
      ["query"],
    ),
  });
};

export type KernelStaticCall = KernelStaticRequest;

export async function initializePublicationEntropy(
  actor: Pick<KernelActor, "kernel_publication_entropy_initialize">,
): Promise<string> {
  const result = await actor.kernel_publication_entropy_initialize(null);
  if ("err" in result) {
    throw new Error("Kernel publication entropy initialization failed");
  }
  if (result.ok.fingerprint.byteLength !== 32) {
    throw new Error(
      "Kernel publication entropy initializer returned an invalid fingerprint",
    );
  }
  return Buffer.from(result.ok.fingerprint).toString("hex");
}
