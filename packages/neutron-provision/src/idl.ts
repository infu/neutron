import type { ActorMethod } from "@dfinity/agent";
import type { IDL } from "@dfinity/candid";
import type { Principal } from "@dfinity/principal";

export type CandidOpt<T> = [] | [T];

export type IcrcAccount = {
  owner: Principal;
  subaccount: CandidOpt<Uint8Array>;
};

export type IcrcTransferError =
  | { BadFee: { expected_fee: bigint } }
  | { BadBurn: { min_burn_amount: bigint } }
  | { InsufficientFunds: { balance: bigint } }
  | { TooOld: null }
  | { CreatedInFuture: { ledger_time: bigint } }
  | { TemporarilyUnavailable: null }
  | { Duplicate: { duplicate_of: bigint } }
  | { GenericError: { error_code: bigint; message: string } };

export type IcpLedgerActor = {
  icrc1_balance_of: ActorMethod<[IcrcAccount], bigint>;
  icrc1_fee: ActorMethod<[], bigint>;
  icrc1_transfer: ActorMethod<
    [
      {
        from_subaccount: CandidOpt<Uint8Array>;
        to: IcrcAccount;
        amount: bigint;
        fee: CandidOpt<bigint>;
        memo: CandidOpt<Uint8Array>;
        created_at_time: CandidOpt<bigint>;
      },
    ],
    { Ok: bigint } | { Err: IcrcTransferError }
  >;
};

export type NotifyError =
  | { Refunded: { reason: string; block_index: CandidOpt<bigint> } }
  | { Processing: null }
  | { TransactionTooOld: bigint }
  | { InvalidTransaction: string }
  | { Other: { error_code: bigint; error_message: string } };

export type CmcActor = {
  get_default_subnets: ActorMethod<[], Principal[]>;
  get_subnet_types_to_subnets: ActorMethod<
    [],
    { data: Array<[string, Principal[]]> }
  >;
  get_principals_authorized_to_create_canisters_to_subnets: ActorMethod<
    [],
    { data: Array<[Principal, Principal[]]> }
  >;
  get_icp_xdr_conversion_rate: ActorMethod<
    [],
    {
      data: {
        timestamp_seconds: bigint;
        xdr_permyriad_per_icp: bigint;
      };
      hash_tree: Uint8Array;
      certificate: Uint8Array;
    }
  >;
  notify_create_canister: ActorMethod<
    [
      {
        block_index: bigint;
        controller: Principal;
        subnet_type: CandidOpt<string>;
        subnet_selection: CandidOpt<{
          Subnet: { subnet: Principal };
        }>;
        settings: CandidOpt<{
          controllers: CandidOpt<Principal[]>;
          compute_allocation: CandidOpt<bigint>;
          memory_allocation: CandidOpt<bigint>;
          freezing_threshold: CandidOpt<bigint>;
          reserved_cycles_limit: CandidOpt<bigint>;
          log_visibility: CandidOpt<unknown>;
          wasm_memory_limit: CandidOpt<bigint>;
          wasm_memory_threshold: CandidOpt<bigint>;
          environment_variables: CandidOpt<
            Array<{ name: string; value: string }>
          >;
          snapshot_visibility: CandidOpt<unknown>;
          minimum_incoming_canister_call_cycles: CandidOpt<bigint>;
        }>;
      },
    ],
    { Ok: Principal } | { Err: NotifyError }
  >;
};

export type ManagementActor = {
  provisional_create_canister_with_cycles: ActorMethod<
    [
      {
        amount: CandidOpt<bigint>;
        settings: CandidOpt<{
          controllers: CandidOpt<Principal[]>;
          compute_allocation: CandidOpt<bigint>;
          memory_allocation: CandidOpt<bigint>;
          freezing_threshold: CandidOpt<bigint>;
          reserved_cycles_limit: CandidOpt<bigint>;
          log_visibility: CandidOpt<unknown>;
          wasm_memory_limit: CandidOpt<bigint>;
          wasm_memory_threshold: CandidOpt<bigint>;
          environment_variables: CandidOpt<
            Array<{ name: string; value: string }>
          >;
          snapshot_visibility: CandidOpt<unknown>;
          minimum_incoming_canister_call_cycles: CandidOpt<bigint>;
        }>;
        specified_id: CandidOpt<Principal>;
        sender_canister_version: CandidOpt<bigint>;
      },
    ],
    { canister_id: Principal }
  >;
  upload_chunk: ActorMethod<
    [{ canister_id: Principal; chunk: Uint8Array }],
    { hash: Uint8Array }
  >;
  stored_chunks: ActorMethod<
    [{ canister_id: Principal }],
    Array<{ hash: Uint8Array }>
  >;
  install_chunked_code: ActorMethod<
    [
      {
        mode:
          | { install: null }
          | { reinstall: null }
          | {
              upgrade: CandidOpt<{
                skip_pre_upgrade: CandidOpt<boolean>;
                wasm_memory_persistence: CandidOpt<
                  { keep: null } | { replace: null }
                >;
              }>;
            };
        target_canister: Principal;
        store_canister: CandidOpt<Principal>;
        chunk_hashes_list: Array<{ hash: Uint8Array }>;
        wasm_module_hash: Uint8Array;
        arg: Uint8Array;
        sender_canister_version: CandidOpt<bigint>;
      },
    ],
    undefined
  >;
  clear_chunk_store: ActorMethod<
    [{ canister_id: Principal }],
    undefined
  >;
  canister_status: ActorMethod<
    [{ canister_id: Principal }],
    {
      status: { running: null } | { stopping: null } | { stopped: null };
      version: bigint;
      cycles: bigint;
      settings: {
        controllers: Principal[];
        compute_allocation: bigint;
        memory_allocation: bigint;
        freezing_threshold: bigint;
        reserved_cycles_limit: bigint;
        log_visibility:
          | { controllers: null }
          | { public: null }
          | { allowed_viewers: Principal[] };
        snapshot_visibility:
          | { controllers: null }
          | { public: null }
          | { allowed_viewers: Principal[] };
        wasm_memory_limit: bigint;
        wasm_memory_threshold: bigint;
        minimum_incoming_canister_call_cycles: bigint;
        environment_variables: Array<{ name: string; value: string }>;
      };
      module_hash: CandidOpt<Uint8Array>;
    }
  >;
  stop_canister: ActorMethod<[{ canister_id: Principal }], undefined>;
  start_canister: ActorMethod<[{ canister_id: Principal }], undefined>;
  list_canister_snapshots: ActorMethod<
    [{ canister_id: Principal }],
    Array<{ id: Uint8Array; total_size: bigint; taken_at_timestamp: bigint }>
  >;
  delete_canister_snapshot: ActorMethod<
    [{ canister_id: Principal; snapshot_id: Uint8Array }],
    undefined
  >;
  update_settings: ActorMethod<
    [
      {
        canister_id: Principal;
        settings: {
          controllers: CandidOpt<Principal[]>;
          compute_allocation: CandidOpt<bigint>;
          memory_allocation: CandidOpt<bigint>;
          freezing_threshold: CandidOpt<bigint>;
          reserved_cycles_limit: CandidOpt<bigint>;
          log_visibility: CandidOpt<unknown>;
          wasm_memory_limit: CandidOpt<bigint>;
          wasm_memory_threshold: CandidOpt<bigint>;
          environment_variables: CandidOpt<
            Array<{ name: string; value: string }>
          >;
          snapshot_visibility: CandidOpt<unknown>;
          minimum_incoming_canister_call_cycles: CandidOpt<bigint>;
        };
        sender_canister_version: CandidOpt<bigint>;
      },
    ],
    undefined
  >;
};

/**
 * The PocketIC binary intentionally trails the live IC management interface.
 * Keep its status decoder limited to fields needed by local provisioning so a
 * newly-added production setting cannot make an older pinned PocketIC unusable.
 */
export type LocalManagementActor = Pick<
  ManagementActor,
  | "provisional_create_canister_with_cycles"
  | "upload_chunk"
  | "install_chunked_code"
  | "clear_chunk_store"
  | "update_settings"
> & {
  canister_status: ActorMethod<
    [{ canister_id: Principal }],
    {
      status: { running: null } | { stopping: null } | { stopped: null };
      settings: { controllers: Principal[] };
      module_hash: CandidOpt<Uint8Array>;
    }
  >;
};

export type KernelAccessActor = {
  kernel_authorized_recover: ActorMethod<[Principal], undefined>;
  kernel_access_snapshot: ActorMethod<
    [null],
    {
      snapshot_version: bigint;
      authorized_principals: Principal[];
      controllers: Principal[];
      self_principal: Principal;
      controller_limit: bigint;
    }
  >;
};

export const icpLedgerIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const account = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const transferError = IDL.Variant({
    BadFee: IDL.Record({ expected_fee: IDL.Nat }),
    BadBurn: IDL.Record({ min_burn_amount: IDL.Nat }),
    InsufficientFunds: IDL.Record({ balance: IDL.Nat }),
    TooOld: IDL.Null,
    CreatedInFuture: IDL.Record({ ledger_time: IDL.Nat64 }),
    TemporarilyUnavailable: IDL.Null,
    Duplicate: IDL.Record({ duplicate_of: IDL.Nat }),
    GenericError: IDL.Record({ error_code: IDL.Nat, message: IDL.Text }),
  });
  return IDL.Service({
    icrc1_balance_of: IDL.Func([account], [IDL.Nat], ["query"]),
    icrc1_fee: IDL.Func([], [IDL.Nat], ["query"]),
    icrc1_transfer: IDL.Func(
      [
        IDL.Record({
          from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
          to: account,
          amount: IDL.Nat,
          fee: IDL.Opt(IDL.Nat),
          memo: IDL.Opt(IDL.Vec(IDL.Nat8)),
          created_at_time: IDL.Opt(IDL.Nat64),
        }),
      ],
      [IDL.Variant({ Ok: IDL.Nat, Err: transferError })],
      [],
    ),
  });
};

type IDLBuilder = Parameters<IDL.InterfaceFactory>[0]["IDL"];

function logVisibility(IDL: IDLBuilder) {
  return IDL.Variant({
    controllers: IDL.Null,
    public: IDL.Null,
    allowed_viewers: IDL.Vec(IDL.Principal),
  });
}

function canisterSettings(IDL: IDLBuilder) {
  return IDL.Record({
    controllers: IDL.Opt(IDL.Vec(IDL.Principal)),
    compute_allocation: IDL.Opt(IDL.Nat),
    memory_allocation: IDL.Opt(IDL.Nat),
    freezing_threshold: IDL.Opt(IDL.Nat),
    reserved_cycles_limit: IDL.Opt(IDL.Nat),
    log_visibility: IDL.Opt(logVisibility(IDL)),
    wasm_memory_limit: IDL.Opt(IDL.Nat),
    wasm_memory_threshold: IDL.Opt(IDL.Nat),
    environment_variables: IDL.Opt(
      IDL.Vec(IDL.Record({ name: IDL.Text, value: IDL.Text })),
    ),
    snapshot_visibility: IDL.Opt(logVisibility(IDL)),
    minimum_incoming_canister_call_cycles: IDL.Opt(IDL.Nat),
  });
}

export const cmcIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const settings = canisterSettings(IDL);
  const subnetSelection = IDL.Variant({
    Subnet: IDL.Record({ subnet: IDL.Principal }),
    Filter: IDL.Record({ subnet_type: IDL.Opt(IDL.Text) }),
  });
  const notifyError = IDL.Variant({
    Refunded: IDL.Record({
      reason: IDL.Text,
      block_index: IDL.Opt(IDL.Nat64),
    }),
    Processing: IDL.Null,
    TransactionTooOld: IDL.Nat64,
    InvalidTransaction: IDL.Text,
    Other: IDL.Record({ error_code: IDL.Nat64, error_message: IDL.Text }),
  });
  return IDL.Service({
    notify_create_canister: IDL.Func(
      [
        IDL.Record({
          block_index: IDL.Nat64,
          controller: IDL.Principal,
          subnet_type: IDL.Opt(IDL.Text),
          subnet_selection: IDL.Opt(subnetSelection),
          settings: IDL.Opt(settings),
        }),
      ],
      [IDL.Variant({ Ok: IDL.Principal, Err: notifyError })],
      [],
    ),
    get_default_subnets: IDL.Func([], [IDL.Vec(IDL.Principal)], ["query"]),
    get_subnet_types_to_subnets: IDL.Func(
      [],
      [
        IDL.Record({
          data: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Vec(IDL.Principal))),
        }),
      ],
      ["query"],
    ),
    get_principals_authorized_to_create_canisters_to_subnets: IDL.Func(
      [],
      [
        IDL.Record({
          data: IDL.Vec(IDL.Tuple(IDL.Principal, IDL.Vec(IDL.Principal))),
        }),
      ],
      ["query"],
    ),
    get_icp_xdr_conversion_rate: IDL.Func(
      [],
      [
        IDL.Record({
          data: IDL.Record({
            timestamp_seconds: IDL.Nat64,
            xdr_permyriad_per_icp: IDL.Nat64,
          }),
          hash_tree: IDL.Vec(IDL.Nat8),
          certificate: IDL.Vec(IDL.Nat8),
        }),
      ],
      ["query"],
    ),
  });
};

export const managementIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const chunkHash = IDL.Record({ hash: IDL.Vec(IDL.Nat8) });
  const installMode = IDL.Variant({
    install: IDL.Null,
    reinstall: IDL.Null,
    upgrade: IDL.Opt(
      IDL.Record({
        skip_pre_upgrade: IDL.Opt(IDL.Bool),
        wasm_memory_persistence: IDL.Opt(
          IDL.Variant({ keep: IDL.Null, replace: IDL.Null }),
        ),
      }),
    ),
  });
  const settings = canisterSettings(IDL);
  const definiteSettings = IDL.Record({
    controllers: IDL.Vec(IDL.Principal),
    compute_allocation: IDL.Nat,
    memory_allocation: IDL.Nat,
    freezing_threshold: IDL.Nat,
    reserved_cycles_limit: IDL.Nat,
    log_visibility: logVisibility(IDL),
    snapshot_visibility: logVisibility(IDL),
    wasm_memory_limit: IDL.Nat,
    wasm_memory_threshold: IDL.Nat,
    minimum_incoming_canister_call_cycles: IDL.Nat,
    environment_variables: IDL.Vec(
      IDL.Record({ name: IDL.Text, value: IDL.Text }),
    ),
  });
  return IDL.Service({
    provisional_create_canister_with_cycles: IDL.Func(
      [
        IDL.Record({
          amount: IDL.Opt(IDL.Nat),
          settings: IDL.Opt(settings),
          specified_id: IDL.Opt(IDL.Principal),
          sender_canister_version: IDL.Opt(IDL.Nat64),
        }),
      ],
      [IDL.Record({ canister_id: IDL.Principal })],
      [],
    ),
    upload_chunk: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal, chunk: IDL.Vec(IDL.Nat8) })],
      [chunkHash],
      [],
    ),
    stored_chunks: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal })],
      [IDL.Vec(chunkHash)],
      [],
    ),
    install_chunked_code: IDL.Func(
      [
        IDL.Record({
          mode: installMode,
          target_canister: IDL.Principal,
          store_canister: IDL.Opt(IDL.Principal),
          chunk_hashes_list: IDL.Vec(chunkHash),
          wasm_module_hash: IDL.Vec(IDL.Nat8),
          arg: IDL.Vec(IDL.Nat8),
          sender_canister_version: IDL.Opt(IDL.Nat64),
        }),
      ],
      [],
      [],
    ),
    clear_chunk_store: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal })],
      [],
      [],
    ),
    canister_status: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal })],
      [
        IDL.Record({
          status: IDL.Variant({
            running: IDL.Null,
            stopping: IDL.Null,
            stopped: IDL.Null,
          }),
          version: IDL.Nat64,
          cycles: IDL.Nat,
          settings: definiteSettings,
          module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
        }),
      ],
      [],
    ),
    stop_canister: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal })],
      [],
      [],
    ),
    start_canister: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal })],
      [],
      [],
    ),
    list_canister_snapshots: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal })],
      [
        IDL.Vec(
          IDL.Record({
            id: IDL.Vec(IDL.Nat8),
            total_size: IDL.Nat64,
            taken_at_timestamp: IDL.Nat64,
          }),
        ),
      ],
      [],
    ),
    delete_canister_snapshot: IDL.Func(
      [
        IDL.Record({
          canister_id: IDL.Principal,
          snapshot_id: IDL.Vec(IDL.Nat8),
        }),
      ],
      [],
      [],
    ),
    update_settings: IDL.Func(
      [
        IDL.Record({
          canister_id: IDL.Principal,
          settings,
          sender_canister_version: IDL.Opt(IDL.Nat64),
        }),
      ],
      [],
      [],
    ),
  });
};

export const localManagementIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const chunkHash = IDL.Record({ hash: IDL.Vec(IDL.Nat8) });
  const settings = canisterSettings(IDL);
  return IDL.Service({
    provisional_create_canister_with_cycles: IDL.Func(
      [
        IDL.Record({
          amount: IDL.Opt(IDL.Nat),
          settings: IDL.Opt(settings),
          specified_id: IDL.Opt(IDL.Principal),
          sender_canister_version: IDL.Opt(IDL.Nat64),
        }),
      ],
      [IDL.Record({ canister_id: IDL.Principal })],
      [],
    ),
    upload_chunk: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal, chunk: IDL.Vec(IDL.Nat8) })],
      [chunkHash],
      [],
    ),
    install_chunked_code: IDL.Func(
      [
        IDL.Record({
          mode: IDL.Variant({
            install: IDL.Null,
            reinstall: IDL.Null,
            upgrade: IDL.Opt(
              IDL.Record({
                skip_pre_upgrade: IDL.Opt(IDL.Bool),
                wasm_memory_persistence: IDL.Opt(
                  IDL.Variant({ keep: IDL.Null, replace: IDL.Null }),
                ),
              }),
            ),
          }),
          target_canister: IDL.Principal,
          store_canister: IDL.Opt(IDL.Principal),
          chunk_hashes_list: IDL.Vec(chunkHash),
          wasm_module_hash: IDL.Vec(IDL.Nat8),
          arg: IDL.Vec(IDL.Nat8),
          sender_canister_version: IDL.Opt(IDL.Nat64),
        }),
      ],
      [],
      [],
    ),
    clear_chunk_store: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal })],
      [],
      [],
    ),
    canister_status: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal })],
      [
        IDL.Record({
          status: IDL.Variant({
            running: IDL.Null,
            stopping: IDL.Null,
            stopped: IDL.Null,
          }),
          settings: IDL.Record({ controllers: IDL.Vec(IDL.Principal) }),
          module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
        }),
      ],
      [],
    ),
    update_settings: IDL.Func(
      [
        IDL.Record({
          canister_id: IDL.Principal,
          settings,
          sender_canister_version: IDL.Opt(IDL.Nat64),
        }),
      ],
      [],
      [],
    ),
  });
};

export const kernelAccessIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const accessSnapshot = IDL.Record({
    snapshot_version: IDL.Nat,
    authorized_principals: IDL.Vec(IDL.Principal),
    controllers: IDL.Vec(IDL.Principal),
    self_principal: IDL.Principal,
    controller_limit: IDL.Nat,
  });
  return IDL.Service({
    kernel_authorized_recover: IDL.Func([IDL.Principal], [], []),
    kernel_access_snapshot: IDL.Func([IDL.Null], [accessSnapshot], []),
  });
};
