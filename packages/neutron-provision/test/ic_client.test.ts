import { describe, expect, test } from "bun:test";
import { Actor, type Identity } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { chunkWasm, sha256, toHex } from "../src/artifact.ts";
import {
  CMC_CANISTER_ID,
  CREATE_CANISTER_MEMO,
  EMPTY_CANDID_ARGS,
  ICP_LEDGER_CANISTER_ID,
  IcProvisionClient,
  IcpTransferBadFeeError,
  MANAGEMENT_CANISTER_ID,
  assertInitialKernelAccess,
  defaultIcpAccountIdentifier,
  principalSubaccount,
} from "../src/ic_client.ts";
import { managementIdl } from "../src/idl.ts";

const DEPLOYER = Principal.fromText(
  "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe",
);
const TARGET = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
const SUBNET = Principal.selfAuthenticating(new Uint8Array(32).fill(3));

describe("icblast-backed IC adapter", () => {
  test("derives the canonical default ICP account identifier", () => {
    expect(defaultIcpAccountIdentifier(Principal.fromText(
      "y7t6r-gtsqz-45ogs-2k3gk-l6hic-2h7wm-zosg6-uldzf-l4ams-2jaky-wqe",
    ))).toBe(
      "3e3e4de2c2e3d2d497c54f0b54d6fadc9d5dbc36df4e6e76d69598955590a6ee",
    );
  });

  test("rechecks only the deployer's default ICP balance and current fee", async () => {
    const client = await createClient();
    let balanceAccount: unknown;
    Object.defineProperty(client, "ledger", {
      value: {
        icrc1_balance_of: async (account: unknown) => {
          balanceAccount = account;
          return 123_000_000n;
        },
        icrc1_fee: async () => 12_345n,
      },
    });
    expect(await client.fundingStatus()).toEqual({
      ledgerBalanceE8s: 123_000_000n,
      ledgerFeeE8s: 12_345n,
    });
    expect(balanceAccount).toEqual({ owner: DEPLOYER, subaccount: [] });
  });

  test("requires the installer to be the sole initial kernel principal", () => {
    expect(() =>
      assertInitialKernelAccess(DEPLOYER.toText(), [DEPLOYER.toText()]),
    ).not.toThrow();
    expect(() => assertInitialKernelAccess(DEPLOYER.toText(), [])).toThrow(
      "expected only icblast deployer",
    );
    expect(() =>
      assertInitialKernelAccess(DEPLOYER.toText(), [
        DEPLOYER.toText(),
        TARGET.toText(),
      ]),
    ).toThrow("expected only icblast deployer");
  });

  test("routes the virtual management actor with the target as effective ID", async () => {
    const client = await createClient();
    const management = client.managementActor(TARGET.toText());
    expect(Actor.canisterIdOf(management).toText()).toBe(MANAGEMENT_CANISTER_ID);
    expect(actorConfig(management).effectiveCanisterId.toText()).toBe(
      TARGET.toText(),
    );
    expect(Actor.canisterIdOf(client.ledger).toText()).toBe(
      ICP_LEDGER_CANISTER_ID,
    );
    expect(Actor.canisterIdOf(client.cmc).toText()).toBe(CMC_CANISTER_ID);
  });

  test("fingerprints every current definite setting without storing plaintext values", async () => {
    const client = await createClient();
    let minimum = 10n;
    replaceMethod(client, "managementActor", () => ({
      canister_status: async () => ({
        status: { running: null },
        version: 7n,
        cycles: 123n,
        module_hash: [new Uint8Array(32).fill(4)],
        settings: {
          controllers: [DEPLOYER, TARGET],
          compute_allocation: 1n,
          memory_allocation: 2n,
          freezing_threshold: 3n,
          reserved_cycles_limit: 4n,
          log_visibility: { allowed_viewers: [TARGET] },
          snapshot_visibility: { controllers: null },
          wasm_memory_limit: 5n,
          wasm_memory_threshold: 6n,
          minimum_incoming_canister_call_cycles: minimum,
          environment_variables: [
            { name: "API_SECRET", value: "must-not-enter-session" },
          ],
        },
      }),
    }));

    const first = await client.operationalState(TARGET.toText());
    minimum = 11n;
    const second = await client.operationalState(TARGET.toText());
    expect(first.settingsFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.settingsFingerprint).not.toContain("must-not-enter-session");
    expect(second.settingsFingerprint).not.toBe(first.settingsFingerprint);
    expect(first.controllers).toEqual(
      [DEPLOYER.toText(), TARGET.toText()].sort(),
    );
  });

  test("accepts an exact subnet assigned to a CMC subnet type", async () => {
    const client = await createClient();
    let balanceAccount: unknown;
    Object.defineProperty(client, "ledger", {
      value: {
        icrc1_balance_of: async (account: unknown) => {
          balanceAccount = account;
          return 600_010_000n;
        },
        icrc1_fee: async () => 10_000n,
      },
    });
    Object.defineProperty(client, "cmc", {
      value: {
        get_default_subnets: async () => [],
        get_subnet_types_to_subnets: async () => ({
          data: [["fiduciary", [SUBNET]]],
        }),
        get_principals_authorized_to_create_canisters_to_subnets: async () => ({
          data: [],
        }),
        get_icp_xdr_conversion_rate: async () => ({
          data: { timestamp_seconds: 1n, xdr_permyriad_per_icp: 15_735n },
          hash_tree: new Uint8Array(),
          certificate: new Uint8Array(),
        }),
      },
    });

    const result = await client.preflight({
      targetSubnet: SUBNET.toText(),
      amountE8s: 500_000_000n,
    });

    expect(balanceAccount).toEqual({ owner: DEPLOYER, subaccount: [] });
    expect(result).toMatchObject({
      ledgerBalanceE8s: 600_010_000n,
      ledgerFeeE8s: 10_000n,
      estimatedCycles: 7_867_500_000_000n,
      targetIsDefault: false,
      targetHasSubnetType: true,
      targetIsAuthorized: false,
    });
  });

  test("rejects an exact subnet outside every current CMC allow-list", async () => {
    const client = await createClient();
    Object.defineProperty(client, "ledger", {
      value: {
        icrc1_balance_of: async () => 600_010_000n,
        icrc1_fee: async () => 10_000n,
      },
    });
    Object.defineProperty(client, "cmc", {
      value: {
        get_default_subnets: async () => [],
        get_subnet_types_to_subnets: async () => ({ data: [] }),
        get_principals_authorized_to_create_canisters_to_subnets: async () => ({
          data: [],
        }),
        get_icp_xdr_conversion_rate: async () => ({
          data: { timestamp_seconds: 1n, xdr_permyriad_per_icp: 15_735n },
          hash_tree: new Uint8Array(),
          certificate: new Uint8Array(),
        }),
      },
    });

    expect(
      client.preflight({
        targetSubnet: SUBNET.toText(),
        amountE8s: 500_000_000n,
      }),
    ).rejects.toThrow("does not currently allow");
  });

  test("models stored_chunks as an ingress update, matching the IC interface", () => {
    const service = managementIdl({ IDL });
    const method = service._fields.find(([name]) => name === "stored_chunks")?.[1];
    expect(method?.annotations).toEqual([]);
  });

  test("reconciles a committed stop whose reply was lost", async () => {
    const client = await createClient();
    const lostReply = new Error("transport closed after stop committed");
    replaceMethod(
      client,
      "operationalState",
      sequence([runState("running"), runState("stopped")]),
    );
    replaceMethod(client, "managementActor", () => ({
      stop_canister: async () => {
        throw lostReply;
      },
    }));

    expect(await client.ensureStopped(TARGET.toText())).toMatchObject({
      status: "stopped",
    });
  });

  test("reconciles a committed start whose reply was lost", async () => {
    const client = await createClient();
    const lostReply = new Error("transport closed after start committed");
    replaceMethod(
      client,
      "operationalState",
      sequence([runState("stopped"), runState("running")]),
    );
    replaceMethod(client, "managementActor", () => ({
      start_canister: async () => {
        throw lostReply;
      },
    }));

    expect(await client.ensureRunning(TARGET.toText())).toMatchObject({
      status: "running",
    });
  });

  test("retries the exact ICP transfer and accepts a duplicate block", async () => {
    const client = await createClient();
    let captured: unknown;
    Object.defineProperty(client, "ledger", {
      value: {
        icrc1_transfer: async (request: unknown) => {
          captured = request;
          return { Err: { Duplicate: { duplicate_of: 77n } } };
        },
      },
    });
    const block = await client.transferCreationIcp({
      amountE8s: 500_000_000n,
      feeE8s: 10_000n,
      createdAtTimeNanos: 123_000_000n,
    });
    expect(block).toBe(77n);
    expect(captured).toEqual({
      from_subaccount: [],
      to: {
        owner: Principal.fromText(CMC_CANISTER_ID),
        subaccount: [principalSubaccount(DEPLOYER)],
      },
      amount: 500_000_000n,
      fee: [10_000n],
      memo: [CREATE_CANISTER_MEMO],
      created_at_time: [123_000_000n],
    });
  });

  test("stops rather than repaying when the ledger duplicate window expired", async () => {
    const client = await createClient();
    Object.defineProperty(client, "ledger", {
      value: {
        icrc1_transfer: async () => ({ Err: { TooOld: null } }),
      },
    });
    expect(
      client.transferCreationIcp({
        amountE8s: 500_000_000n,
        feeE8s: 10_000n,
        createdAtTimeNanos: 123_000_000n,
      }),
    ).rejects.toThrow("Do not delete or replace the deployment session");
  });

  test("reports the ledger's expected fee without changing the transfer", async () => {
    const client = await createClient();
    Object.defineProperty(client, "ledger", {
      value: {
        icrc1_transfer: async () => ({
          Err: { BadFee: { expected_fee: 20_000n } },
        }),
      },
    });
    try {
      await client.transferCreationIcp({
        amountE8s: 500_000_000n,
        feeE8s: 10_000n,
        createdAtTimeNanos: 123_000_000n,
      });
      throw new Error("expected BadFee");
    } catch (error) {
      expect(error).toBeInstanceOf(IcpTransferBadFeeError);
      expect((error as IcpTransferBadFeeError).expectedFeeE8s).toBe(20_000n);
    }
  });

  test("retries CMC Processing with the same block and exact subnet", async () => {
    const client = await createClient();
    const requests: unknown[] = [];
    Object.defineProperty(client, "cmc", {
      value: {
        notify_create_canister: async (request: unknown) => {
          requests.push(request);
          return requests.length === 1
            ? { Err: { Processing: null } }
            : { Ok: TARGET };
        },
      },
    });
    const created = await client.notifyCreateCanister({
      blockIndex: 91n,
      targetSubnet: SUBNET.toText(),
      controllers: [DEPLOYER.toText()],
      attempts: 2,
    });
    expect(created).toBe(TARGET.toText());
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]).toMatchObject({
      block_index: 91n,
      controller: DEPLOYER,
      subnet_selection: [{ Subnet: { subnet: SUBNET } }],
      settings: [{ controllers: [[DEPLOYER]] }],
    });
  });

  test("uses a valid Candid empty tuple for the actor-class install argument", () => {
    expect([...EMPTY_CANDID_ARGS]).toEqual([0x44, 0x49, 0x44, 0x4c, 0, 0]);
  });

  test("installs chunks in artifact order, verifies the module, then clears the store", async () => {
    const client = await createClient();
    const wasm = new Uint8Array([10, 11, 12, 13, 14]);
    const chunks = chunkWasm(wasm, 2);
    const transportWasmHash = sha256(wasm);
    const events: string[] = [];
    let installRequest: Record<string, unknown> | undefined;
    const states = [null, toHex(transportWasmHash)];

    replaceMethod(client, "certifiedState", async () => {
      events.push("status");
      return certifiedState(states.shift() ?? null);
    });
    replaceMethod(client, "managementActor", () => ({
      stored_chunks: async () => {
        events.push("stored");
        return [{ hash: chunks[0]!.hash }];
      },
      upload_chunk: async ({ chunk }: { chunk: Uint8Array }) => {
        const uploaded = chunks.find(
          (candidate) => toHex(candidate.bytes) === toHex(chunk),
        );
        if (!uploaded) throw new Error("unexpected chunk");
        events.push(`upload:${uploaded.hashHex}`);
        return { hash: uploaded.hash };
      },
      install_chunked_code: async (request: Record<string, unknown>) => {
        events.push("install");
        installRequest = request;
      },
      clear_chunk_store: async () => {
        events.push("clear");
      },
    }));

    await client.installChunkedWasm({
      canisterId: TARGET.toText(),
      chunks,
      transportWasmHash,
    });

    expect(events).toEqual([
      "status",
      "stored",
      `upload:${chunks[1]!.hashHex}`,
      `upload:${chunks[2]!.hashHex}`,
      "install",
      "status",
      "clear",
    ]);
    expect(installRequest).toEqual({
      mode: { install: null },
      target_canister: TARGET,
      store_canister: [],
      chunk_hashes_list: chunks.map(({ hash }) => ({ hash })),
      wasm_module_hash: transportWasmHash,
      arg: EMPTY_CANDID_ARGS,
      sender_canister_version: [],
    });
  });

  test("reconciles an upload whose successful reply was lost", async () => {
    const client = await createClient();
    const wasm = new Uint8Array([21, 22, 23]);
    const chunks = chunkWasm(wasm);
    const chunk = chunks[0]!;
    const transportWasmHash = sha256(wasm);
    const events: string[] = [];
    let storedCalls = 0;

    replaceMethod(client, "certifiedState", sequence([
      certifiedState(null),
      certifiedState(toHex(transportWasmHash)),
    ]));
    replaceMethod(client, "managementActor", () => ({
      stored_chunks: async () => {
        storedCalls += 1;
        events.push(`stored:${storedCalls}`);
        return storedCalls === 1 ? [] : [{ hash: chunk.hash }];
      },
      upload_chunk: async () => {
        events.push("upload-lost-reply");
        throw new Error("transport closed after commit");
      },
      install_chunked_code: async () => {
        events.push("install");
      },
      clear_chunk_store: async () => {
        events.push("clear");
      },
    }));

    await client.installChunkedWasm({
      canisterId: TARGET.toText(),
      chunks,
      transportWasmHash,
    });

    expect(events).toEqual([
      "stored:1",
      "upload-lost-reply",
      "stored:2",
      "install",
      "clear",
    ]);
  });

  test("reconciles an install whose successful reply was lost before clearing chunks", async () => {
    const client = await createClient();
    const wasm = new Uint8Array([31, 32, 33]);
    const chunks = chunkWasm(wasm);
    const transportWasmHash = sha256(wasm);
    const events: string[] = [];

    replaceMethod(client, "certifiedState", sequence([
      certifiedState(null),
      certifiedState(toHex(transportWasmHash)),
      certifiedState(toHex(transportWasmHash)),
    ]));
    replaceMethod(client, "managementActor", () => ({
      stored_chunks: async () => chunks.map(({ hash }) => ({ hash })),
      upload_chunk: async () => {
        throw new Error("already stored chunks must not upload");
      },
      install_chunked_code: async () => {
        events.push("install-lost-reply");
        throw new Error("transport closed after commit");
      },
      clear_chunk_store: async () => {
        events.push("clear");
      },
    }));

    await client.installChunkedWasm({
      canisterId: TARGET.toText(),
      chunks,
      transportWasmHash,
    });

    expect(events).toEqual(["install-lost-reply", "clear"]);
  });

  test("does not install or clear when an uploaded chunk cannot be reconciled", async () => {
    const client = await createClient();
    const wasm = new Uint8Array([41, 42, 43]);
    const chunks = chunkWasm(wasm);
    const transportWasmHash = sha256(wasm);
    let installCalls = 0;
    let clearCalls = 0;

    replaceMethod(client, "certifiedState", async () => certifiedState(null));
    replaceMethod(client, "managementActor", () => ({
      stored_chunks: async () => [],
      upload_chunk: async () => ({ hash: new Uint8Array(32).fill(9) }),
      install_chunked_code: async () => {
        installCalls += 1;
      },
      clear_chunk_store: async () => {
        clearCalls += 1;
      },
    }));

    expect(
      client.installChunkedWasm({
        canisterId: TARGET.toText(),
        chunks,
        transportWasmHash,
      }),
    ).rejects.toThrow("Management canister returned chunk hash");
    expect(installCalls).toBe(0);
    expect(clearCalls).toBe(0);
  });

  test("keeps chunks when installation did not commit or verify", async () => {
    const client = await createClient();
    const wasm = new Uint8Array([51, 52, 53]);
    const chunks = chunkWasm(wasm);
    const transportWasmHash = sha256(wasm);
    const installFailure = new Error("install rejected");
    let clearCalls = 0;

    replaceMethod(client, "certifiedState", sequence([
      certifiedState(null),
      certifiedState(null),
    ]));
    replaceMethod(client, "managementActor", () => ({
      stored_chunks: async () => chunks.map(({ hash }) => ({ hash })),
      upload_chunk: async () => {
        throw new Error("already stored chunks must not upload");
      },
      install_chunked_code: async () => {
        throw installFailure;
      },
      clear_chunk_store: async () => {
        clearCalls += 1;
      },
    }));

    try {
      await client.installChunkedWasm({
        canisterId: TARGET.toText(),
        chunks,
        transportWasmHash,
      });
      throw new Error("expected install failure");
    } catch (error) {
      expect(error).toBe(installFailure);
    }
    expect(clearCalls).toBe(0);
  });

  test("clears stale chunks when the expected module is already installed", async () => {
    const client = await createClient();
    const wasm = new Uint8Array([61, 62, 63]);
    const chunks = chunkWasm(wasm);
    const transportWasmHash = sha256(wasm);
    const events: string[] = [];

    replaceMethod(client, "certifiedState", async () =>
      certifiedState(toHex(transportWasmHash)),
    );
    replaceMethod(client, "managementActor", () => ({
      stored_chunks: async () => {
        throw new Error("stored_chunks must not be read");
      },
      upload_chunk: async () => {
        throw new Error("chunks must not upload");
      },
      install_chunked_code: async () => {
        throw new Error("wasm must not reinstall");
      },
      clear_chunk_store: async () => {
        events.push("clear");
      },
    }));

    await client.installChunkedWasm({
      canisterId: TARGET.toText(),
      chunks,
      transportWasmHash,
    });
    expect(events).toEqual(["clear"]);
  });

  test("stages reinstall chunks from an empty store before downtime", async () => {
    const client = await createClient();
    const chunks = chunkWasm(new Uint8Array([64, 65, 66]));
    const events: string[] = [];
    let storedCalls = 0;
    replaceMethod(client, "managementActor", () => ({
      clear_chunk_store: async () => {
        events.push("clear");
      },
      stored_chunks: async () => {
        storedCalls += 1;
        events.push(`stored:${storedCalls}`);
        return storedCalls === 1
          ? []
          : chunks.map(({ hash }) => ({ hash }));
      },
      upload_chunk: async ({ chunk }: { chunk: Uint8Array }) => {
        events.push("upload");
        return { hash: chunks[0]!.hash };
      },
    }));
    await client.stageWasmChunks({
      canisterId: TARGET.toText(),
      chunks,
    });
    expect(events).toEqual(["clear", "stored:1", "upload", "stored:2"]);
  });

  test("deletes every snapshot and reconciles a lost delete reply", async () => {
    const client = await createClient();
    const first = new Uint8Array([1]);
    const second = new Uint8Array([2]);
    const events: string[] = [];
    let listCalls = 0;
    replaceMethod(client, "managementActor", () => ({
      list_canister_snapshots: async () => {
        listCalls += 1;
        events.push(`list:${listCalls}`);
        if (listCalls === 1) {
          return [first, second].map((id) => ({
            id,
            total_size: 1n,
            taken_at_timestamp: 1n,
          }));
        }
        if (listCalls === 2) {
          return [{ id: second, total_size: 1n, taken_at_timestamp: 1n }];
        }
        return [];
      },
      delete_canister_snapshot: async ({
        snapshot_id,
      }: {
        snapshot_id: Uint8Array;
      }) => {
        events.push(`delete:${snapshot_id[0]}`);
        if (snapshot_id[0] === 1) {
          throw new Error("transport closed after delete committed");
        }
      },
    }));
    expect(await client.deleteAllCanisterSnapshots(TARGET.toText())).toBe(2);
    expect(events).toEqual([
      "list:1",
      "delete:1",
      "list:2",
      "delete:2",
      "list:3",
    ]);
  });

  test("reinstalls an existing module with the management reinstall mode", async () => {
    const client = await createClient();
    const oldHash = "11".repeat(32);
    const wasm = new Uint8Array([71, 72, 73]);
    const chunks = chunkWasm(wasm);
    const transportWasmHash = sha256(wasm);
    const expectedHash = toHex(transportWasmHash);
    let request: Record<string, unknown> | undefined;

    replaceMethod(
      client,
      "certifiedState",
      sequence([
        certifiedState(oldHash),
        certifiedState(expectedHash),
      ]),
    );
    replaceMethod(client, "managementActor", () => ({
      stored_chunks: async () => [],
      upload_chunk: async ({ chunk }: { chunk: Uint8Array }) => {
        const uploaded = chunks.find(
          (candidate) => toHex(candidate.bytes) === toHex(chunk),
        );
        if (!uploaded) throw new Error("unexpected chunk");
        return { hash: uploaded.hash };
      },
      install_chunked_code: async (input: Record<string, unknown>) => {
        request = input;
      },
      clear_chunk_store: async () => undefined,
    }));

    await client.reinstallChunkedWasm({
      canisterId: TARGET.toText(),
      chunks,
      transportWasmHash,
      previousModuleHash: oldHash,
    });

    expect(request).toEqual({
      mode: { reinstall: null },
      target_canister: TARGET,
      store_canister: [],
      chunk_hashes_list: chunks.map(({ hash }) => ({ hash })),
      wasm_module_hash: transportWasmHash,
      arg: EMPTY_CANDID_ARGS,
      sender_canister_version: [],
    });
  });

  test("reconciles a lost reinstall reply only against its unique target hash", async () => {
    const client = await createClient();
    const oldHash = "22".repeat(32);
    const wasm = new Uint8Array([81, 82, 83]);
    const chunks = chunkWasm(wasm);
    const transportWasmHash = sha256(wasm);
    const expectedHash = toHex(transportWasmHash);
    let clearCalls = 0;

    replaceMethod(
      client,
      "certifiedState",
      sequence([
        certifiedState(oldHash),
        certifiedState(expectedHash),
        certifiedState(expectedHash),
      ]),
    );
    replaceMethod(client, "managementActor", () => ({
      stored_chunks: async () => chunks.map(({ hash }) => ({ hash })),
      upload_chunk: async () => {
        throw new Error("stored chunks must not upload");
      },
      install_chunked_code: async () => {
        throw new Error("transport closed after committed reinstall");
      },
      clear_chunk_store: async () => {
        clearCalls += 1;
      },
    }));

    await client.reinstallChunkedWasm({
      canisterId: TARGET.toText(),
      chunks,
      transportWasmHash,
      previousModuleHash: oldHash,
    });
    expect(clearCalls).toBe(1);

    await expect(
      client.reinstallChunkedWasm({
        canisterId: TARGET.toText(),
        chunks,
        transportWasmHash,
        previousModuleHash: expectedHash,
      }),
    ).rejects.toThrow("unique deployment hash");
  });

  test("resumes an already committed uniquely stamped reinstall without installing again", async () => {
    const client = await createClient();
    const oldHash = "55".repeat(32);
    const wasm = new Uint8Array([91, 92, 93]);
    const chunks = chunkWasm(wasm);
    const transportWasmHash = sha256(wasm);
    let clears = 0;
    replaceMethod(client, "certifiedState", async () =>
      certifiedState(toHex(transportWasmHash)),
    );
    replaceMethod(client, "managementActor", () => ({
      stored_chunks: async () => {
        throw new Error("committed reinstall must not inspect staged chunks");
      },
      upload_chunk: async () => {
        throw new Error("committed reinstall must not upload");
      },
      install_chunked_code: async () => {
        throw new Error("committed reinstall must not install again");
      },
      clear_chunk_store: async () => {
        clears += 1;
      },
    }));
    await client.reinstallChunkedWasm({
      canisterId: TARGET.toText(),
      chunks,
      transportWasmHash,
      previousModuleHash: oldHash,
    });
    expect(clears).toBe(1);
  });
});

async function createClient(): Promise<IcProvisionClient> {
  return IcProvisionClient.create({
    identity: { getPrincipal: () => DEPLOYER } as Identity,
    sleep: async () => undefined,
    logger: { log() {} },
  });
}

function actorConfig(actor: object): { effectiveCanisterId: Principal } {
  const symbol = Object.getOwnPropertySymbols(actor).find(
    (candidate) => String(candidate) === "Symbol(ic-agent-metadata)",
  );
  if (!symbol) throw new Error("Actor metadata symbol was not found");
  const metadata = (actor as Record<symbol, unknown>)[symbol] as {
    config: { effectiveCanisterId: Principal };
  };
  return metadata.config;
}

function certifiedState(moduleHash: string | null) {
  return {
    subnetId: SUBNET.toText(),
    controllers: [DEPLOYER.toText()],
    moduleHash,
  };
}

function runState(status: "running" | "stopping" | "stopped") {
  return {
    status,
    version: 1n,
    cycles: 1_000_000n,
    moduleHash: "11".repeat(32),
    settingsFingerprint: "22".repeat(32),
    controllers: [DEPLOYER.toText()],
  };
}

function sequence<T>(values: T[]): () => Promise<T> {
  return async () => {
    const value = values.shift();
    if (value === undefined) throw new Error("mock sequence exhausted");
    return value;
  };
}

function replaceMethod(
  target: object,
  name: string,
  value: (...args: never[]) => unknown,
): void {
  Object.defineProperty(target, name, { value });
}
