import { Actor, CanisterStatus, type HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { normalizeUpdateSourcePrincipal } from "neutron-tools/src/schema.ts";
import type { HeaderField } from "./model.ts";

export type PermissionName = "Prepare" | "Commit" | "ManagePermissions";

export type CreateAssetOperation = {
  CreateAsset: {
    key: string;
    content_type: string;
    headers: [HeaderField[]];
    allow_raw_access: [boolean];
    max_age: [bigint];
    enable_aliasing: [boolean];
  };
};

export type SetAssetPropertiesOperation = {
  SetAssetProperties: {
    key: string;
    headers: [[HeaderField[]]];
    is_aliased: [[boolean]];
    allow_raw_access: [[boolean]];
    max_age: [[bigint]];
  };
};

export type SetAssetContentOperation = {
  SetAssetContent: {
    key: string;
    sha256: [Uint8Array];
    chunk_ids: bigint[];
    content_encoding: "identity";
    last_chunk: [];
  };
};

export type BatchOperation =
  | CreateAssetOperation
  | SetAssetPropertiesOperation
  | SetAssetContentOperation;

export type AssetEncodingMetadata = {
  contentEncoding: string;
  sha256: Uint8Array | null;
  length: bigint;
};

export type AssetMetadata = {
  key: string;
  contentType: string;
  encodings: AssetEncodingMetadata[];
};

export interface AssetCanisterPort {
  listAssets?(): Promise<AssetMetadata[]>;
  createBatch(): Promise<bigint>;
  createChunk(batchId: bigint, content: Uint8Array): Promise<bigint>;
  commitBatch(batchId: bigint, operations: readonly BatchOperation[]): Promise<void>;
  deleteBatch(batchId: bigint): Promise<void>;
  listPermitted(permission: PermissionName): Promise<string[]>;
  grantPermission(permission: PermissionName, principal: string): Promise<void>;
  revokePermission(permission: PermissionName, principal: string): Promise<void>;
  controllers(): Promise<string[]>;
}

type PermissionValue =
  | { Prepare: null }
  | { Commit: null }
  | { ManagePermissions: null };

type AssetDetailsValue = {
  key: string;
  content_type: string;
  encodings: Array<{
    content_encoding: string;
    sha256: [] | [Uint8Array];
    length: bigint;
  }>;
};

export type AssetCanisterActor = {
  list(request: {
    start: [] | [bigint];
    length: [] | [bigint];
  }): Promise<AssetDetailsValue[]>;
  create_batch(request: Record<string, never>): Promise<{ batch_id: bigint }>;
  create_chunk(request: {
    batch_id: bigint;
    content: Uint8Array;
  }): Promise<{ chunk_id: bigint }>;
  commit_batch(request: {
    batch_id: bigint;
    operations: BatchOperation[];
  }): Promise<void>;
  delete_batch(request: { batch_id: bigint }): Promise<void>;
  list_permitted(request: {
    permission: PermissionValue;
  }): Promise<Principal[]>;
  grant_permission(request: {
    permission: PermissionValue;
    to_principal: Principal;
  }): Promise<void>;
  revoke_permission(request: {
    permission: PermissionValue;
    of_principal: Principal;
  }): Promise<void>;
};

export type ControllerReader = (options: {
  agent: HttpAgent;
  canisterId: Principal;
}) => Promise<readonly Principal[]>;

export type AgentAssetCanisterOptions = {
  canisterId: string;
  agent: HttpAgent;
  actor?: AssetCanisterActor;
  readControllers?: ControllerReader;
};

export class AgentAssetCanister implements AssetCanisterPort {
  readonly canisterId: string;
  private readonly agent: HttpAgent;
  private readonly canisterPrincipal: Principal;
  private readonly actor: AssetCanisterActor;
  private readonly readControllers: ControllerReader;

  constructor(options: AgentAssetCanisterOptions) {
    this.canisterId = normalizeUpdateSourcePrincipal(options.canisterId);
    this.canisterPrincipal = Principal.fromText(this.canisterId);
    this.agent = options.agent;
    this.actor =
      options.actor ??
      Actor.createActor<AssetCanisterActor>(assetCanisterIdl, {
        agent: options.agent,
        canisterId: this.canisterPrincipal,
      });
    this.readControllers = options.readControllers ?? certifiedControllers;
  }

  async listAssets(): Promise<AssetMetadata[]> {
    const pageSize = 100n;
    const assets: AssetMetadata[] = [];
    for (let start = 0n; ; start += pageSize) {
      const page = await this.actor.list({
        start: [start],
        length: [pageSize],
      });
      assets.push(
        ...page.map((asset) => ({
          key: asset.key,
          contentType: asset.content_type,
          encodings: asset.encodings.map((encoding) => ({
            contentEncoding: encoding.content_encoding,
            sha256: encoding.sha256[0]?.slice() ?? null,
            length: encoding.length,
          })),
        })),
      );
      if (page.length < Number(pageSize)) break;
    }
    return assets.sort((left, right) => left.key.localeCompare(right.key));
  }

  async createBatch(): Promise<bigint> {
    return (await this.actor.create_batch({})).batch_id;
  }

  async createChunk(batchId: bigint, content: Uint8Array): Promise<bigint> {
    return (await this.actor.create_chunk({ batch_id: batchId, content })).chunk_id;
  }

  async commitBatch(
    batchId: bigint,
    operations: readonly BatchOperation[],
  ): Promise<void> {
    await this.actor.commit_batch({
      batch_id: batchId,
      operations: [...operations],
    });
  }

  async deleteBatch(batchId: bigint): Promise<void> {
    await this.actor.delete_batch({ batch_id: batchId });
  }

  async listPermitted(permission: PermissionName): Promise<string[]> {
    const principals = await this.actor.list_permitted({
      permission: permissionValue(permission),
    });
    return principals.map((principal) => principal.toText()).sort();
  }

  async grantPermission(
    permission: PermissionName,
    principal: string,
  ): Promise<void> {
    await this.actor.grant_permission({
      permission: permissionValue(permission),
      to_principal: canonicalPrincipal(principal),
    });
  }

  async revokePermission(
    permission: PermissionName,
    principal: string,
  ): Promise<void> {
    await this.actor.revoke_permission({
      permission: permissionValue(permission),
      of_principal: canonicalPrincipal(principal),
    });
  }

  async controllers(): Promise<string[]> {
    const controllers = await this.readControllers({
      agent: this.agent,
      canisterId: this.canisterPrincipal,
    });
    return controllers.map((principal) => principal.toText()).sort();
  }
}

const assetCanisterIdl: Parameters<typeof Actor.createActor>[0] = ({ IDL }) => {
  const Header = IDL.Tuple(IDL.Text, IDL.Text);
  const CreateAsset = IDL.Record({
    key: IDL.Text,
    content_type: IDL.Text,
    headers: IDL.Opt(IDL.Vec(Header)),
    allow_raw_access: IDL.Opt(IDL.Bool),
    max_age: IDL.Opt(IDL.Nat64),
    enable_aliasing: IDL.Opt(IDL.Bool),
  });
  const SetAssetProperties = IDL.Record({
    key: IDL.Text,
    headers: IDL.Opt(IDL.Opt(IDL.Vec(Header))),
    is_aliased: IDL.Opt(IDL.Opt(IDL.Bool)),
    allow_raw_access: IDL.Opt(IDL.Opt(IDL.Bool)),
    max_age: IDL.Opt(IDL.Opt(IDL.Nat64)),
  });
  const SetAssetContent = IDL.Record({
    key: IDL.Text,
    sha256: IDL.Opt(IDL.Vec(IDL.Nat8)),
    chunk_ids: IDL.Vec(IDL.Nat),
    content_encoding: IDL.Text,
    last_chunk: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const BatchOperationType = IDL.Variant({
    SetAssetProperties,
    CreateAsset,
    SetAssetContent,
  });
  const Permission = IDL.Variant({
    Prepare: IDL.Null,
    Commit: IDL.Null,
    ManagePermissions: IDL.Null,
  });
  const AssetEncoding = IDL.Record({
    content_encoding: IDL.Text,
    sha256: IDL.Opt(IDL.Vec(IDL.Nat8)),
    length: IDL.Nat,
    modified: IDL.Int,
  });
  const AssetDetails = IDL.Record({
    key: IDL.Text,
    content_type: IDL.Text,
    encodings: IDL.Vec(AssetEncoding),
    max_age: IDL.Opt(IDL.Nat64),
    headers: IDL.Opt(IDL.Vec(Header)),
    allow_raw_access: IDL.Opt(IDL.Bool),
    is_aliased: IDL.Opt(IDL.Bool),
  });
  return IDL.Service({
    list: IDL.Func(
      [IDL.Record({ start: IDL.Opt(IDL.Nat), length: IDL.Opt(IDL.Nat) })],
      [IDL.Vec(AssetDetails)],
      ["query"],
    ),
    create_batch: IDL.Func(
      [IDL.Record({})],
      [IDL.Record({ batch_id: IDL.Nat })],
      [],
    ),
    create_chunk: IDL.Func(
      [IDL.Record({ batch_id: IDL.Nat, content: IDL.Vec(IDL.Nat8) })],
      [IDL.Record({ chunk_id: IDL.Nat })],
      [],
    ),
    commit_batch: IDL.Func(
      [
        IDL.Record({
          batch_id: IDL.Nat,
          operations: IDL.Vec(BatchOperationType),
        }),
      ],
      [],
      [],
    ),
    delete_batch: IDL.Func([IDL.Record({ batch_id: IDL.Nat })], [], []),
    list_permitted: IDL.Func(
      [IDL.Record({ permission: Permission })],
      [IDL.Vec(IDL.Principal)],
      [],
    ),
    grant_permission: IDL.Func(
      [IDL.Record({ permission: Permission, to_principal: IDL.Principal })],
      [],
      [],
    ),
    revoke_permission: IDL.Func(
      [IDL.Record({ permission: Permission, of_principal: IDL.Principal })],
      [],
      [],
    ),
  });
};

async function certifiedControllers(options: {
  agent: HttpAgent;
  canisterId: Principal;
}): Promise<readonly Principal[]> {
  const status = await CanisterStatus.request({
    ...options,
    paths: ["controllers"],
  });
  const controllers = status.get("controllers");
  if (
    !Array.isArray(controllers) ||
    controllers.some((controller) => !(controller instanceof Principal))
  ) {
    throw new Error("Certified canister state did not contain controllers");
  }
  return controllers as Principal[];
}

function permissionValue(permission: PermissionName): PermissionValue {
  if (permission === "Prepare") return { Prepare: null };
  if (permission === "Commit") return { Commit: null };
  return { ManagePermissions: null };
}

function canonicalPrincipal(value: string): Principal {
  const trimmed = value.trim();
  const principal = Principal.fromText(trimmed);
  if (principal.toText() !== trimmed) {
    throw new Error(`Principal '${value}' is not canonical`);
  }
  return principal;
}
