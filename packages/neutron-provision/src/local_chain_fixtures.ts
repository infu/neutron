import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  Actor,
  HttpAgent,
  type ActorMethod,
  type ActorSubclass,
  type Identity,
} from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  type ContractTransactionResponse,
} from "ethers";
import { chunkWasm, sha256, sha256Hex, toHex } from "./artifact.ts";
import { MANAGEMENT_CANISTER_ID } from "./ic_client.ts";
import { localManagementIdl, type LocalManagementActor } from "./idl.ts";
import {
  LOCAL_ANVIL_RPC_URL,
  LOCAL_BITCOIN_RPC_PASSWORD,
  LOCAL_BITCOIN_RPC_USER,
  ensureLocalBitcoinSpendableBalance,
  localBitcoinCli,
  mineLocalBitcoinBlocks,
} from "./local_chain_services.ts";

const FIXTURE_CANISTER_CYCLES = 100_000_000_000_000n;
const MINIMUM_REGTEST_DEPOSIT = 1_000n;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_WASM_BYTES = 100 * 1024 * 1024;
const CKETH_HELPER_SHA256 =
  "400d83fd3b960a5cefb5453cc715a617c62b49238224d3cdda44b17d607744ac";
const CKETH_HELPER_PATH = path.resolve(
  import.meta.dir,
  "../assets/CkEthDeposit.bin",
);

export const CKBTC_MINTER_CANISTER_ID = "mqygn-kiaaa-aaaar-qaadq-cai";
export const BTC_CHECKER_CANISTER_ID = "oltsj-fqaaa-aaaar-qal5q-cai";
export const CKETH_MINTER_CANISTER_ID = "sv3dd-oaaaa-aaaar-qacoa-cai";
export const EVM_RPC_CANISTER_ID = "7hfb6-caaaa-aaaar-qadga-cai";

const CKBTC_REVISION = "50ba5020d6d654d70a48d964969fef8443fb42ae";
const CKETH_REVISION = "a47e5434753752c1d2972fbc4407d14f88964285";

export type NativeChainWasmArtifact = {
  release: string;
  name: string;
  url: string;
  archiveSha256: string;
};

export type PreparedNativeChainWasm = {
  wasm: Uint8Array;
  moduleHashHex: string;
};

export type PreparedNativeChainArtifacts = {
  btcChecker: PreparedNativeChainWasm;
  ckbtcMinter: PreparedNativeChainWasm;
  ckethMinter: PreparedNativeChainWasm;
  evmRpc: PreparedNativeChainWasm;
};

export const CKBTC_MINTER_WASM_ARTIFACT: NativeChainWasmArtifact = {
  release: `ic-${CKBTC_REVISION}`,
  name: "ic-ckbtc-minter.wasm.gz",
  url: `https://download.dfinity.systems/ic/${CKBTC_REVISION}/canisters/ic-ckbtc-minter.wasm.gz`,
  archiveSha256:
    "789d9e138796c30bb63bc6482918d529f24627c0b96ecb81196a642a5dd236bc",
};

export const BTC_CHECKER_WASM_ARTIFACT: NativeChainWasmArtifact = {
  release: `ic-${CKBTC_REVISION}`,
  name: "ic-btc-checker.wasm.gz",
  url: `https://download.dfinity.systems/ic/${CKBTC_REVISION}/canisters/ic-btc-checker.wasm.gz`,
  archiveSha256:
    "5b596efa2cf1eca20651c1c9ea385086187c0c90a7b462e66a12c9518e94175e",
};

export const CKETH_MINTER_WASM_ARTIFACT: NativeChainWasmArtifact = {
  release: `ic-${CKETH_REVISION}`,
  name: "ic-cketh-minter.wasm.gz",
  url: `https://download.dfinity.systems/ic/${CKETH_REVISION}/canisters/ic-cketh-minter.wasm.gz`,
  archiveSha256:
    "5ca6c97d52cc3ab86f675674309255b62db91d1e2de592a44795088ba54d35c0",
};

export const EVM_RPC_WASM_ARTIFACT: NativeChainWasmArtifact = {
  release: "evm_rpc-v2.8.0",
  name: "evm_rpc.wasm.gz",
  url: "https://github.com/dfinity/evm-rpc-canister/releases/download/evm_rpc-v2.8.0/evm_rpc.wasm.gz",
  archiveSha256:
    "455fcea61d679848761848db2d99ebb9b66a7cf060de350a4fdc5c680e5292c6",
};

export type NativeLedgerFixture = {
  key: "ckbtc" | "cketh";
  canisterId: string;
  indexCanisterId: string;
  name: string;
  symbol: string;
  decimals: number;
  fee: bigint;
};

export type NativeLedgerArtifacts = {
  ledger: PreparedNativeChainWasm;
  index: PreparedNativeChainWasm;
};

export type LocalNativeFixtureClient = {
  ensureCanister(canisterId: string): Promise<{ moduleHashHex: string | null }>;
  ensureInstalled(input: {
    label: string;
    canisterId: string;
    artifact: PreparedNativeChainWasm;
    arg: Uint8Array;
  }): Promise<void>;
  installWasm(input: {
    canisterId: string;
    artifact: PreparedNativeChainWasm;
    arg: Uint8Array;
    mode: "install" | "upgrade";
  }): Promise<void>;
  verifyLedgerPair(input: {
    fixture: NativeLedgerFixture;
    expectedMinter: string;
  }): Promise<void>;
  ckethMinterAddress(): Promise<string>;
  ckethSmartContractAddress(): Promise<string>;
  evmRpcNodesInSubnet(): Promise<number>;
  ckbtcAddress(owner: Principal): Promise<string>;
  ckbtcUpdateBalance(owner: Principal): Promise<void>;
  ledgerBalance(fixture: NativeLedgerFixture, owner: Principal): Promise<bigint>;
};

export type EnsureLocalNativeChainFixturesOptions = {
  gatewayUrl: string;
  expectedRootKeyBase64: string;
  cacheDirectory: string;
  identity: Identity;
  fixtures: readonly [NativeLedgerFixture, NativeLedgerFixture];
  ledgerArtifacts: NativeLedgerArtifacts;
  encodeLedgerInitArgs: (
    fixture: NativeLedgerFixture,
    minter: Principal,
  ) => Uint8Array;
  encodeIndexInitArgs: (ledgerCanisterId: string) => Uint8Array;
  logger?: Pick<Console, "log">;
};

export type EnsureLocalNativeChainFixturesDependencies = {
  createClient?: typeof createLocalNativeFixtureClient;
  resolveArtifacts?: typeof resolveNativeChainArtifacts;
  finalizedBlockNumber?: typeof anvilFinalizedBlockNumber;
  advanceFinality?: typeof advanceAnvilFinality;
  ensureDepositHelper?: typeof ensureCkEthDepositHelper;
};

export type FundLocalNativeChainFixturesOptions = {
  gatewayUrl: string;
  expectedRootKeyBase64: string;
  cacheDirectory: string;
  stateDirectory: string;
  identity: Identity;
  owner: Principal;
  fixtures: readonly [NativeLedgerFixture, NativeLedgerFixture];
  targetWholeTokens: bigint;
  logger?: Pick<Console, "log">;
};

export type FundLocalNativeChainFixturesDependencies = {
  createClient?: typeof createLocalNativeFixtureClient;
  resolveArtifacts?: typeof resolveNativeChainArtifacts;
  ensureBitcoinBalance?: typeof ensureLocalBitcoinSpendableBalance;
  bitcoinCli?: typeof localBitcoinCli;
  mineBitcoin?: typeof mineLocalBitcoinBlocks;
  depositEth?: typeof depositCkEth;
  advanceFinality?: typeof advanceAnvilFinality;
  sleep?: (milliseconds: number) => Promise<void>;
};

export async function ensureLocalNativeChainFixtures(
  options: EnsureLocalNativeChainFixturesOptions,
  dependencies: EnsureLocalNativeChainFixturesDependencies = {},
): Promise<Record<string, string>> {
  const logger = options.logger ?? console;
  const client = await (
    dependencies.createClient ?? createLocalNativeFixtureClient
  )({
    gatewayUrl: options.gatewayUrl,
    expectedRootKeyBase64: options.expectedRootKeyBase64,
    identity: options.identity,
    logger,
  });
  const artifacts = await (
    dependencies.resolveArtifacts ?? resolveNativeChainArtifacts
  )({ cacheDirectory: options.cacheDirectory, logger });

  const [ckbtc, cketh] = options.fixtures;
  if (ckbtc.key !== "ckbtc" || cketh.key !== "cketh") {
    throw new Error("Native fixture order must be ckBTC followed by ckETH");
  }
  const canisterIds = [
    BTC_CHECKER_CANISTER_ID,
    CKBTC_MINTER_CANISTER_ID,
    EVM_RPC_CANISTER_ID,
    CKETH_MINTER_CANISTER_ID,
    ckbtc.canisterId,
    ckbtc.indexCanisterId,
    cketh.canisterId,
    cketh.indexCanisterId,
  ];
  const statuses = new Map(
    await Promise.all(
      canisterIds.map(async (canisterId) => [
        canisterId,
        await client.ensureCanister(canisterId),
      ] as const),
    ),
  );

  let ckethStartBlock = 0n;
  if (statuses.get(CKETH_MINTER_CANISTER_ID)?.moduleHashHex === null) {
    await (dependencies.advanceFinality ?? advanceAnvilFinality)();
    ckethStartBlock = await (
      dependencies.finalizedBlockNumber ?? anvilFinalizedBlockNumber
    )();
    logger.log(`Starting ckETH scraping after Anvil block ${ckethStartBlock}`);
  }

  await Promise.all([
    client.ensureInstalled({
      label: "Bitcoin checker",
      canisterId: BTC_CHECKER_CANISTER_ID,
      artifact: artifacts.btcChecker,
      arg: encodeBtcCheckerInitArgs(),
    }),
    client.ensureInstalled({
      label: "EVM RPC",
      canisterId: EVM_RPC_CANISTER_ID,
      artifact: artifacts.evmRpc,
      arg: encodeEvmRpcInitArgs(),
    }),
  ]);

  await Promise.all([
    ensureNativeLedgerPair({
      client,
      fixture: ckbtc,
      expectedMinter: Principal.fromText(CKBTC_MINTER_CANISTER_ID),
      artifacts: options.ledgerArtifacts,
      encodeLedgerInitArgs: options.encodeLedgerInitArgs,
      encodeIndexInitArgs: options.encodeIndexInitArgs,
    }),
    ensureNativeLedgerPair({
      client,
      fixture: cketh,
      expectedMinter: Principal.fromText(CKETH_MINTER_CANISTER_ID),
      artifacts: options.ledgerArtifacts,
      encodeLedgerInitArgs: options.encodeLedgerInitArgs,
      encodeIndexInitArgs: options.encodeIndexInitArgs,
    }),
  ]);

  await Promise.all([
    client.ensureInstalled({
      label: "ckBTC minter",
      canisterId: CKBTC_MINTER_CANISTER_ID,
      artifact: artifacts.ckbtcMinter,
      arg: encodeCkBtcMinterInitArgs(),
    }),
    client.ensureInstalled({
      label: "ckETH minter",
      canisterId: CKETH_MINTER_CANISTER_ID,
      artifact: artifacts.ckethMinter,
      arg: encodeCkEthMinterInitArgs(ckethStartBlock),
    }),
  ]);

  const minterAddress = await retry(
    () => client.ckethMinterAddress(),
    "ckETH minter address",
    30_000,
  );
  const configured = await client.ckethSmartContractAddress();
  const helper = await (
    dependencies.ensureDepositHelper ?? ensureCkEthDepositHelper
  )({
    currentAddress: configured === "N/A" ? null : configured,
    minterAddress,
  });
  if (helper.changed || configured.toLowerCase() !== helper.address.toLowerCase()) {
    logger.log(`Configuring ckETH helper ${helper.address}`);
    await client.installWasm({
      canisterId: CKETH_MINTER_CANISTER_ID,
      artifact: artifacts.ckethMinter,
      arg: encodeCkEthMinterUpgradeArgs(helper.address),
      mode: "upgrade",
    });
  }

  const [activeHelper, evmNodes] = await Promise.all([
    client.ckethSmartContractAddress(),
    client.evmRpcNodesInSubnet(),
    client.ckbtcAddress(options.identity.getPrincipal()),
  ]);
  if (activeHelper.toLowerCase() !== helper.address.toLowerCase()) {
    throw new Error(
      `ckETH minter reports helper ${activeHelper}, expected ${helper.address}`,
    );
  }
  if (evmNodes !== 1) {
    throw new Error(`EVM RPC reports ${evmNodes} subnet nodes, expected 1`);
  }

  logger.log("Real local ckBTC and ckETH suites are ready");
  return localNativeChainFixtureIds();
}

async function ensureNativeLedgerPair({
  client,
  fixture,
  expectedMinter,
  artifacts,
  encodeLedgerInitArgs,
  encodeIndexInitArgs,
}: {
  client: LocalNativeFixtureClient;
  fixture: NativeLedgerFixture;
  expectedMinter: Principal;
  artifacts: NativeLedgerArtifacts;
  encodeLedgerInitArgs: (
    fixture: NativeLedgerFixture,
    minter: Principal,
  ) => Uint8Array;
  encodeIndexInitArgs: (ledgerCanisterId: string) => Uint8Array;
}): Promise<void> {
  await client.ensureInstalled({
    label: `${fixture.symbol} ledger`,
    canisterId: fixture.canisterId,
    artifact: artifacts.ledger,
    arg: encodeLedgerInitArgs(fixture, expectedMinter),
  });
  await client.ensureInstalled({
    label: `${fixture.symbol} index`,
    canisterId: fixture.indexCanisterId,
    artifact: artifacts.index,
    arg: encodeIndexInitArgs(fixture.canisterId),
  });
  await client.verifyLedgerPair({
    fixture,
    expectedMinter: expectedMinter.toText(),
  });
}

export async function fundLocalNativeChainFixtures(
  options: FundLocalNativeChainFixturesOptions,
  dependencies: FundLocalNativeChainFixturesDependencies = {},
): Promise<Record<"ckbtc" | "cketh", bigint>> {
  if (options.targetWholeTokens <= 0n) {
    throw new Error("Native fixture target must be a positive whole-token amount");
  }
  const logger = options.logger ?? console;
  const sleep = dependencies.sleep ?? delay;
  const client = await (
    dependencies.createClient ?? createLocalNativeFixtureClient
  )({
    gatewayUrl: options.gatewayUrl,
    expectedRootKeyBase64: options.expectedRootKeyBase64,
    identity: options.identity,
    logger,
  });
  const [ckbtc, cketh] = options.fixtures;
  const ckbtcTarget =
    options.targetWholeTokens * 10n ** BigInt(ckbtc.decimals);
  const ckethTarget =
    options.targetWholeTokens * 10n ** BigInt(cketh.decimals);

  let ckbtcBalance = await client.ledgerBalance(ckbtc, options.owner);
  if (ckbtcBalance < ckbtcTarget) {
    await client.ckbtcUpdateBalance(options.owner);
    ckbtcBalance = await client.ledgerBalance(ckbtc, options.owner);
  }
  if (ckbtcBalance < ckbtcTarget) {
    const address = await client.ckbtcAddress(options.owner);
    const shortfall = ckbtcTarget - ckbtcBalance;
    const deposit =
      shortfall < MINIMUM_REGTEST_DEPOSIT
        ? MINIMUM_REGTEST_DEPOSIT
        : shortfall;
    await (
      dependencies.ensureBitcoinBalance ?? ensureLocalBitcoinSpendableBalance
    )(options.stateDirectory);
    const transaction = await (
      dependencies.bitcoinCli ?? localBitcoinCli
    )(
      options.stateDirectory,
      ["sendtoaddress", address, formatSatoshis(deposit)],
      { wallet: true },
    );
    logger.log(`Deposited regtest BTC for ckBTC (${transaction.stdout.trim()})`);
    await (dependencies.mineBitcoin ?? mineLocalBitcoinBlocks)(
      options.stateDirectory,
      6,
    );
    ckbtcBalance = await waitForBalance({
      client,
      fixture: ckbtc,
      owner: options.owner,
      target: ckbtcTarget,
      timeoutMs: 90_000,
      sleep,
      beforeCheck: () => client.ckbtcUpdateBalance(options.owner),
    });
  }
  assertNativeBalance(ckbtc, ckbtcBalance, ckbtcTarget);

  let ckethBalance = await client.ledgerBalance(cketh, options.owner);
  if (ckethBalance < ckethTarget) {
    const artifacts = await (
      dependencies.resolveArtifacts ?? resolveNativeChainArtifacts
    )({ cacheDirectory: options.cacheDirectory, logger });
    await (dependencies.advanceFinality ?? advanceAnvilFinality)();
    await client.installWasm({
      canisterId: CKETH_MINTER_CANISTER_ID,
      artifact: artifacts.ckethMinter,
      arg: encodeCkEthMinterUpgradeArgs(),
      mode: "upgrade",
    });
    ckethBalance = await waitForBalance({
      client,
      fixture: cketh,
      owner: options.owner,
      target: ckethTarget,
      timeoutMs: 8_000,
      sleep,
    });
    if (ckethBalance < ckethTarget) {
      const helperAddress = await client.ckethSmartContractAddress();
      const transaction = await (dependencies.depositEth ?? depositCkEth)({
        helperAddress,
        principalWord: principalWord(options.owner),
        amount: ckethTarget - ckethBalance,
      });
      logger.log(`Deposited Anvil ETH for ckETH (${transaction})`);
      await client.installWasm({
        canisterId: CKETH_MINTER_CANISTER_ID,
        artifact: artifacts.ckethMinter,
        arg: encodeCkEthMinterUpgradeArgs(),
        mode: "upgrade",
      });
      ckethBalance = await waitForBalance({
        client,
        fixture: cketh,
        owner: options.owner,
        target: ckethTarget,
        timeoutMs: 90_000,
        sleep,
      });
    }
  }
  assertNativeBalance(cketh, ckethBalance, ckethTarget);
  return { ckbtc: ckbtcBalance, cketh: ckethBalance };
}

export function localNativeChainFixtureIds(): Record<string, string> {
  return {
    btc_checker: BTC_CHECKER_CANISTER_ID,
    ckbtc_minter: CKBTC_MINTER_CANISTER_ID,
    cketh_minter: CKETH_MINTER_CANISTER_ID,
    evm_rpc: EVM_RPC_CANISTER_ID,
  };
}

export async function createLocalNativeFixtureClient({
  gatewayUrl,
  expectedRootKeyBase64,
  identity,
  logger = console,
  fetcher = fetch,
}: {
  gatewayUrl: string;
  expectedRootKeyBase64: string;
  identity: Identity;
  logger?: Pick<Console, "log">;
  fetcher?: typeof fetch;
}): Promise<LocalNativeFixtureClient> {
  const normalizedGateway = normalizeGateway(gatewayUrl);
  const agent = await HttpAgent.create({
    host: normalizedGateway,
    identity,
    fetch: fetcher,
    // PocketIC v14 query responses have no node signatures. The root key is
    // still pinned below and update request-status responses remain certified.
    verifyQuerySignatures: false,
  });
  const rootKey = await agent.fetchRootKey();
  if (Buffer.from(rootKey).toString("base64") !== expectedRootKeyBase64) {
    throw new Error(
      "PocketIC native fixture root key does not match the provision session",
    );
  }
  return new DirectLocalNativeFixtureClient(agent, identity, logger);
}

class DirectLocalNativeFixtureClient implements LocalNativeFixtureClient {
  readonly #agent: HttpAgent;
  readonly #identity: Identity;
  readonly #logger: Pick<Console, "log">;

  constructor(
    agent: HttpAgent,
    identity: Identity,
    logger: Pick<Console, "log">,
  ) {
    this.#agent = agent;
    this.#identity = identity;
    this.#logger = logger;
  }

  async ensureCanister(
    canisterId: string,
  ): Promise<{ moduleHashHex: string | null }> {
    const canister = Principal.fromText(canisterId);
    try {
      return await this.status(canister);
    } catch (statusError) {
      try {
        const result = await this.management(canister)
          .provisional_create_canister_with_cycles({
            amount: [FIXTURE_CANISTER_CYCLES],
            settings: [fixtureSettings(this.#identity.getPrincipal())],
            specified_id: [canister],
            sender_canister_version: [],
          });
        if (result.canister_id.toText() !== canisterId) {
          throw new Error(
            `PocketIC created ${result.canister_id.toText()}, expected ${canisterId}`,
          );
        }
      } catch (createError) {
        throw new Error(
          `Unable to inspect or create native fixture canister ${canisterId}`,
          { cause: createError instanceof Error ? createError : statusError },
        );
      }
      return this.status(canister);
    }
  }

  async ensureInstalled({
    label,
    canisterId,
    artifact,
    arg,
  }: {
    label: string;
    canisterId: string;
    artifact: PreparedNativeChainWasm;
    arg: Uint8Array;
  }): Promise<void> {
    const status = await this.ensureCanister(canisterId);
    if (status.moduleHashHex === artifact.moduleHashHex) return;
    if (status.moduleHashHex !== null) {
      throw new Error(
        `${canisterId} contains an unexpected ${label} module; clear the PocketIC state instead of carrying old fixtures forward`,
      );
    }
    this.#logger.log(`Installing ${label} at ${canisterId}`);
    await this.installWasm({ canisterId, artifact, arg, mode: "install" });
  }

  async installWasm({
    canisterId,
    artifact,
    arg,
    mode,
  }: {
    canisterId: string;
    artifact: PreparedNativeChainWasm;
    arg: Uint8Array;
    mode: "install" | "upgrade";
  }): Promise<void> {
    const canister = Principal.fromText(canisterId);
    const management = this.management(canister);
    const chunks = chunkWasm(artifact.wasm);
    await management.clear_chunk_store({ canister_id: canister });
    try {
      for (const chunk of chunks) {
        const uploaded = await management.upload_chunk({
          canister_id: canister,
          chunk: chunk.bytes,
        });
        if (toHex(uploaded.hash) !== chunk.hashHex) {
          throw new Error(`${canisterId} chunk hash mismatch`);
        }
      }
      await management.install_chunked_code({
        mode: mode === "install" ? { install: null } : { upgrade: [] },
        target_canister: canister,
        store_canister: [],
        chunk_hashes_list: chunks.map(({ hash }) => ({ hash })),
        wasm_module_hash: sha256(artifact.wasm),
        arg,
        sender_canister_version: [],
      });
    } finally {
      await management.clear_chunk_store({ canister_id: canister });
    }
    const status = await this.status(canister);
    if (status.moduleHashHex !== artifact.moduleHashHex) {
      throw new Error(
        `${canisterId} installed hash ${status.moduleHashHex ?? "none"} does not match ${artifact.moduleHashHex}`,
      );
    }
  }

  async verifyLedgerPair({
    fixture,
    expectedMinter,
  }: {
    fixture: NativeLedgerFixture;
    expectedMinter: string;
  }): Promise<void> {
    const ledger = this.actor<NativeLedgerActor>(
      nativeLedgerIdl,
      fixture.canisterId,
    );
    const index = this.actor<NativeIndexActor>(
      nativeIndexIdl,
      fixture.indexCanisterId,
    );
    const [metadata, mintingAccount, indexResult, ledgerId] = await Promise.all([
      ledger.icrc1_metadata(),
      ledger.icrc1_minting_account(),
      ledger.icrc106_get_index_principal(),
      index.ledger_id(),
    ]);
    assertLedgerMetadata(fixture, metadata);
    if (
      mintingAccount.length !== 1 ||
      mintingAccount[0]!.owner.toText() !== expectedMinter ||
      mintingAccount[0]!.subaccount.length !== 0
    ) {
      throw new Error(
        `${fixture.symbol} minting account is not its real local minter ${expectedMinter}`,
      );
    }
    if (
      !("Ok" in indexResult) ||
      indexResult.Ok.toText() !== fixture.indexCanisterId
    ) {
      throw new Error(`${fixture.symbol} ledger does not target its canonical index`);
    }
    if (ledgerId.toText() !== fixture.canisterId) {
      throw new Error(`${fixture.symbol} index does not target its canonical ledger`);
    }
  }

  ckethMinterAddress(): Promise<string> {
    return this.actor<CkEthMinterActor>(
      ckethMinterIdl,
      CKETH_MINTER_CANISTER_ID,
    ).minter_address();
  }

  ckethSmartContractAddress(): Promise<string> {
    return this.actor<CkEthMinterActor>(
      ckethMinterIdl,
      CKETH_MINTER_CANISTER_ID,
    ).smart_contract_address();
  }

  evmRpcNodesInSubnet(): Promise<number> {
    return this.actor<EvmRpcActor>(
      evmRpcIdl,
      EVM_RPC_CANISTER_ID,
    ).getNodesInSubnet();
  }

  ckbtcAddress(owner: Principal): Promise<string> {
    return this.actor<CkBtcMinterActor>(
      ckbtcMinterIdl,
      CKBTC_MINTER_CANISTER_ID,
    ).get_btc_address({ owner: [owner], subaccount: [] });
  }

  async ckbtcUpdateBalance(owner: Principal): Promise<void> {
    const result = await this.actor<CkBtcMinterActor>(
      ckbtcMinterIdl,
      CKBTC_MINTER_CANISTER_ID,
    ).update_balance({ owner: [owner], subaccount: [] });
    if ("Err" in result && !isExpectedCkBtcUpdateError(result.Err)) {
      throw new Error(
        `ckBTC update_balance failed: ${jsonWithBigints(result.Err)}`,
      );
    }
  }

  ledgerBalance(
    fixture: NativeLedgerFixture,
    owner: Principal,
  ): Promise<bigint> {
    return this.actor<NativeLedgerActor>(
      nativeLedgerIdl,
      fixture.canisterId,
    ).icrc1_balance_of({ owner, subaccount: [] });
  }

  private async status(
    canister: Principal,
  ): Promise<{ moduleHashHex: string | null }> {
    const status = await this.management(canister).canister_status({
      canister_id: canister,
    });
    return {
      moduleHashHex:
        status.module_hash.length === 0
          ? null
          : toHex(status.module_hash[0]!),
    };
  }

  private actor<T>(
    idl: IDL.InterfaceFactory,
    canisterId: string,
  ): ActorSubclass<T> {
    return Actor.createActor<T>(idl, {
      agent: this.#agent,
      canisterId: Principal.fromText(canisterId),
    });
  }

  private management(
    effectiveCanisterId: Principal,
  ): ActorSubclass<LocalManagementActor> {
    return Actor.createActor<LocalManagementActor>(localManagementIdl, {
      agent: this.#agent,
      canisterId: Principal.fromText(MANAGEMENT_CANISTER_ID),
      effectiveCanisterId,
    });
  }
}

export function encodeBtcCheckerInitArgs(): Uint8Array {
  const network = IDL.Variant({
    mainnet: IDL.Null,
    testnet: IDL.Null,
    regtest: IDL.Record({ json_rpc_url: IDL.Text }),
  });
  const checkMode = IDL.Variant({
    AcceptAll: IDL.Null,
    RejectAll: IDL.Null,
    Normal: IDL.Null,
  });
  const init = IDL.Record({
    btc_network: network,
    check_mode: checkMode,
    num_subnet_nodes: IDL.Nat16,
  });
  const upgrade = IDL.Record({
    check_mode: IDL.Opt(checkMode),
    num_subnet_nodes: IDL.Opt(IDL.Nat16),
  });
  const args = IDL.Opt(
    IDL.Variant({ InitArg: init, UpgradeArg: IDL.Opt(upgrade) }),
  );
  return new Uint8Array(
    IDL.encode([args], [
      [
        {
          InitArg: {
            btc_network: {
              regtest: {
                json_rpc_url:
                  `http://${LOCAL_BITCOIN_RPC_USER}:${LOCAL_BITCOIN_RPC_PASSWORD}` +
                  "@127.0.0.1:18443",
              },
            },
            check_mode: { AcceptAll: null },
            num_subnet_nodes: 1,
          },
        },
      ],
    ]),
  );
}

export function encodeCkBtcMinterInitArgs(): Uint8Array {
  const mode = IDL.Variant({
    RestrictedTo: IDL.Vec(IDL.Principal),
    DepositsRestrictedTo: IDL.Vec(IDL.Principal),
    ReadOnly: IDL.Null,
    GeneralAvailability: IDL.Null,
  });
  const network = IDL.Variant({
    Mainnet: IDL.Null,
    Regtest: IDL.Null,
    Testnet: IDL.Null,
  });
  const upgrade = IDL.Record({
    get_utxos_cache_expiration_seconds: IDL.Opt(IDL.Nat64),
    kyt_principal: IDL.Opt(IDL.Principal),
    mode: IDL.Opt(mode),
    retrieve_btc_min_amount: IDL.Opt(IDL.Nat64),
    deposit_btc_min_amount: IDL.Opt(IDL.Nat64),
    max_time_in_queue_nanos: IDL.Opt(IDL.Nat64),
    check_fee: IDL.Opt(IDL.Nat64),
    max_num_inputs_in_transaction: IDL.Opt(IDL.Nat64),
    utxo_consolidation_threshold: IDL.Opt(IDL.Nat64),
    btc_checker_principal: IDL.Opt(IDL.Principal),
    min_confirmations: IDL.Opt(IDL.Nat32),
    kyt_fee: IDL.Opt(IDL.Nat64),
  });
  const init = IDL.Record({
    get_utxos_cache_expiration_seconds: IDL.Opt(IDL.Nat64),
    kyt_principal: IDL.Opt(IDL.Principal),
    ecdsa_key_name: IDL.Text,
    mode,
    retrieve_btc_min_amount: IDL.Nat64,
    deposit_btc_min_amount: IDL.Opt(IDL.Nat64),
    ledger_id: IDL.Principal,
    max_time_in_queue_nanos: IDL.Nat64,
    btc_network: network,
    check_fee: IDL.Opt(IDL.Nat64),
    max_num_inputs_in_transaction: IDL.Opt(IDL.Nat64),
    utxo_consolidation_threshold: IDL.Opt(IDL.Nat64),
    btc_checker_principal: IDL.Opt(IDL.Principal),
    min_confirmations: IDL.Opt(IDL.Nat32),
    kyt_fee: IDL.Opt(IDL.Nat64),
  });
  const minterArg = IDL.Variant({ Upgrade: IDL.Opt(upgrade), Init: init });
  return new Uint8Array(
    IDL.encode([minterArg], [
      {
        Init: {
          get_utxos_cache_expiration_seconds: [],
          kyt_principal: [],
          ecdsa_key_name: "dfx_test_key",
          mode: { GeneralAvailability: null },
          retrieve_btc_min_amount: 10_000n,
          deposit_btc_min_amount: [1n],
          ledger_id: Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai"),
          max_time_in_queue_nanos: 1_000_000_000n,
          btc_network: { Regtest: null },
          check_fee: [0n],
          max_num_inputs_in_transaction: [],
          utxo_consolidation_threshold: [],
          btc_checker_principal: [
            Principal.fromText(BTC_CHECKER_CANISTER_ID),
          ],
          min_confirmations: [1],
          kyt_fee: [],
        },
      },
    ]),
  );
}

export function encodeEvmRpcInitArgs(): Uint8Array {
  const regexSubstitution = IDL.Record({
    pattern: IDL.Text,
    replacement: IDL.Text,
  });
  const logFilter = IDL.Variant({
    ShowAll: IDL.Null,
    HideAll: IDL.Null,
    ShowPattern: IDL.Text,
    HidePattern: IDL.Text,
  });
  const installArgs = IDL.Record({
    demo: IDL.Opt(IDL.Bool),
    manageApiKeys: IDL.Opt(IDL.Vec(IDL.Principal)),
    logFilter: IDL.Opt(logFilter),
    overrideProvider: IDL.Opt(
      IDL.Record({ overrideUrl: IDL.Opt(regexSubstitution) }),
    ),
    nodesInSubnet: IDL.Opt(IDL.Nat32),
  });
  return new Uint8Array(
    IDL.encode([installArgs], [
      {
        demo: [],
        manageApiKeys: [],
        logFilter: [],
        overrideProvider: [
          {
            overrideUrl: [
              {
                pattern: "^https://.*",
                replacement: "http://localhost:8545",
              },
            ],
          },
        ],
        nodesInSubnet: [1],
      },
    ]),
  );
}

export function encodeCkEthMinterInitArgs(
  lastScrapedBlockNumber = 0n,
): Uint8Array {
  if (lastScrapedBlockNumber < 0n) {
    throw new Error("ckETH last scraped block cannot be negative");
  }
  const { minterArg } = ckethMinterArgumentTypes();
  return new Uint8Array(
    IDL.encode([minterArg], [
      {
        InitArg: {
          ethereum_network: { Mainnet: null },
          last_scraped_block_number: lastScrapedBlockNumber,
          ecdsa_key_name: "dfx_test_key",
          next_transaction_nonce: 0n,
          evm_rpc_id: [Principal.fromText(EVM_RPC_CANISTER_ID)],
          ledger_id: Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai"),
          ethereum_contract_address: [],
          minimum_withdrawal_amount: 5_000_000_000_000_000n,
          ethereum_block_height: { Finalized: null },
        },
      },
    ]),
  );
}

export function encodeCkEthMinterUpgradeArgs(
  helperAddress?: string,
): Uint8Array {
  const { minterArg } = ckethMinterArgumentTypes();
  return new Uint8Array(
    IDL.encode([minterArg], [
      {
        UpgradeArg: {
          deposit_with_subaccount_helper_contract_address: [],
          next_transaction_nonce: [],
          evm_rpc_id: [],
          ledger_suite_orchestrator_id: [],
          erc20_helper_contract_address: [],
          last_erc20_scraped_block_number: [],
          ethereum_contract_address:
            helperAddress === undefined ? [] : [helperAddress],
          minimum_withdrawal_amount: [],
          last_deposit_with_subaccount_scraped_block_number: [],
          ethereum_block_height: [],
        },
      },
    ]),
  );
}

function ckethMinterArgumentTypes(): { minterArg: IDL.Type } {
  const blockTag = IDL.Variant({
    Safe: IDL.Null,
    Finalized: IDL.Null,
    Latest: IDL.Null,
  });
  const upgrade = IDL.Record({
    deposit_with_subaccount_helper_contract_address: IDL.Opt(IDL.Text),
    next_transaction_nonce: IDL.Opt(IDL.Nat),
    evm_rpc_id: IDL.Opt(IDL.Principal),
    ledger_suite_orchestrator_id: IDL.Opt(IDL.Principal),
    erc20_helper_contract_address: IDL.Opt(IDL.Text),
    last_erc20_scraped_block_number: IDL.Opt(IDL.Nat),
    ethereum_contract_address: IDL.Opt(IDL.Text),
    minimum_withdrawal_amount: IDL.Opt(IDL.Nat),
    last_deposit_with_subaccount_scraped_block_number: IDL.Opt(IDL.Nat),
    ethereum_block_height: IDL.Opt(blockTag),
  });
  const init = IDL.Record({
    ethereum_network: IDL.Variant({
      Mainnet: IDL.Null,
      Sepolia: IDL.Null,
    }),
    last_scraped_block_number: IDL.Nat,
    ecdsa_key_name: IDL.Text,
    next_transaction_nonce: IDL.Nat,
    evm_rpc_id: IDL.Opt(IDL.Principal),
    ledger_id: IDL.Principal,
    ethereum_contract_address: IDL.Opt(IDL.Text),
    minimum_withdrawal_amount: IDL.Nat,
    ethereum_block_height: blockTag,
  });
  return { minterArg: IDL.Variant({ UpgradeArg: upgrade, InitArg: init }) };
}

export async function resolveNativeChainArtifacts({
  cacheDirectory,
  logger = console,
  fetcher = fetch,
}: {
  cacheDirectory: string;
  logger?: Pick<Console, "log">;
  fetcher?: typeof fetch;
}): Promise<PreparedNativeChainArtifacts> {
  const [btcChecker, ckbtcMinter, ckethMinter, evmRpc] = await Promise.all([
    resolveNativeWasm(
      BTC_CHECKER_WASM_ARTIFACT,
      cacheDirectory,
      logger,
      fetcher,
    ),
    resolveNativeWasm(
      CKBTC_MINTER_WASM_ARTIFACT,
      cacheDirectory,
      logger,
      fetcher,
    ),
    resolveNativeWasm(
      CKETH_MINTER_WASM_ARTIFACT,
      cacheDirectory,
      logger,
      fetcher,
    ),
    resolveNativeWasm(EVM_RPC_WASM_ARTIFACT, cacheDirectory, logger, fetcher),
  ]);
  return { btcChecker, ckbtcMinter, ckethMinter, evmRpc };
}

async function resolveNativeWasm(
  artifact: NativeChainWasmArtifact,
  cacheDirectory: string,
  logger: Pick<Console, "log">,
  fetcher: typeof fetch,
): Promise<PreparedNativeChainWasm> {
  assertNativeArtifact(artifact);
  const directory = path.join(path.resolve(cacheDirectory), artifact.release);
  await ensureRealDirectory(directory);
  const archivePath = path.join(directory, artifact.name);
  let archive = await readCachedArchive(archivePath, artifact.archiveSha256);
  if (archive === null) {
    logger.log(`Downloading ${artifact.release}/${artifact.name}`);
    const response = await fetcher(artifact.url, {
      headers: { Accept: "application/gzip, application/octet-stream" },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`${artifact.name} download failed: HTTP ${response.status}`);
    }
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      (!/^\d+$/.test(contentLength) ||
        Number(contentLength) > MAX_ARCHIVE_BYTES)
    ) {
      throw new Error(`${artifact.name} has an invalid Content-Length`);
    }
    archive = new Uint8Array(await response.arrayBuffer());
    if (archive.byteLength === 0 || archive.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(`${artifact.name} is empty or exceeds the download limit`);
    }
    assertSha256(archive, artifact.archiveSha256, artifact.name);
    await publishCacheFile(archivePath, archive);
  }

  let wasm: Uint8Array;
  try {
    wasm = new Uint8Array(
      gunzipSync(archive, { maxOutputLength: MAX_WASM_BYTES }),
    );
  } catch (error) {
    throw new Error(`Unable to decompress verified ${artifact.name}`, {
      cause: error,
    });
  }
  if (wasm.byteLength === 0) {
    throw new Error(`${artifact.name} contains an empty Wasm module`);
  }
  return { wasm, moduleHashHex: sha256Hex(wasm) };
}

async function readCachedArchive(
  filename: string,
  expectedSha256: string,
): Promise<Uint8Array | null> {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`Refusing symlink native fixture artifact ${filename}`);
  }
  if (
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > MAX_ARCHIVE_BYTES
  ) {
    return null;
  }
  const handle = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const bytes = new Uint8Array(await handle.readFile());
    return sha256Hex(bytes) === expectedSha256 ? bytes : null;
  } finally {
    await handle.close();
  }
}

async function publishCacheFile(
  filename: string,
  bytes: Uint8Array,
): Promise<void> {
  const temporary = `${filename}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    const directory = await open(path.dirname(filename), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function ensureRealDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      `Native fixture cache path must be a real directory: ${directory}`,
    );
  }
}

function assertNativeArtifact(artifact: NativeChainWasmArtifact): void {
  if (!/^[0-9a-f]{64}$/.test(artifact.archiveSha256)) {
    throw new Error(`${artifact.name} SHA-256 must be lowercase hexadecimal`);
  }
  const url = new URL(artifact.url);
  if (url.protocol !== "https:") {
    throw new Error(`${artifact.name} URL must use HTTPS`);
  }
  if (!artifact.name.endsWith(".wasm.gz")) {
    throw new Error(`${artifact.name} must be a gzip-compressed Wasm artifact`);
  }
}

function assertSha256(
  bytes: Uint8Array,
  expected: string,
  label: string,
): void {
  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(
      `${label} checksum mismatch: expected ${expected}, got ${actual}`,
    );
  }
}

type CkEthDepositContract = Contract & {
  getMinterAddress(): Promise<string>;
  deposit(
    principal: string,
    options: { value: bigint },
  ): Promise<ContractTransactionResponse>;
};

const ckethHelperAbi = [
  "constructor(address minterAddress)",
  "function getMinterAddress() view returns (address)",
  "function deposit(bytes32 principal) payable",
] as const;

let ckethHelperBytecode: Promise<string> | undefined;

export async function ensureCkEthDepositHelper({
  currentAddress,
  minterAddress,
  provider = new JsonRpcProvider(LOCAL_ANVIL_RPC_URL),
}: {
  currentAddress: string | null;
  minterAddress: string;
  provider?: JsonRpcProvider;
}): Promise<{ address: string; changed: boolean }> {
  const bytecode = await loadCkEthHelperBytecode();
  if (currentAddress !== null) {
    const code = await provider.getCode(currentAddress);
    if (code !== "0x") {
      const current = new Contract(
        currentAddress,
        ckethHelperAbi,
        provider,
      ) as CkEthDepositContract;
      try {
        const configured = String(await current.getMinterAddress());
        if (configured.toLowerCase() === minterAddress.toLowerCase()) {
          return { address: currentAddress, changed: false };
        }
      } catch {
        // The address contains a different local contract; deploy our helper.
      }
    }
  }

  const signer = await provider.getSigner(0);
  const factory = new ContractFactory(ckethHelperAbi, bytecode, signer);
  const contract = (await factory.deploy(
    minterAddress,
  )) as CkEthDepositContract;
  await contract.waitForDeployment();
  return { address: await contract.getAddress(), changed: true };
}

export async function depositCkEth({
  helperAddress,
  principalWord: encodedPrincipal,
  amount,
  provider = new JsonRpcProvider(LOCAL_ANVIL_RPC_URL),
}: {
  helperAddress: string;
  principalWord: string;
  amount: bigint;
  provider?: JsonRpcProvider;
}): Promise<string> {
  await loadCkEthHelperBytecode();
  const signer = await provider.getSigner(0);
  const helper = new Contract(
    helperAddress,
    ckethHelperAbi,
    signer,
  ) as CkEthDepositContract;
  const transaction = await helper.deposit(encodedPrincipal, { value: amount });
  const receipt = await transaction.wait();
  if (receipt === null) {
    throw new Error("The local ckETH deposit was not mined");
  }
  await advanceAnvilFinality(provider);
  return receipt.hash;
}

export async function advanceAnvilFinality(
  provider = new JsonRpcProvider(LOCAL_ANVIL_RPC_URL),
): Promise<void> {
  // Anvil's finalized tag trails the head by 64 blocks.
  await provider.send("anvil_mine", ["0x80"]);
}

export async function anvilFinalizedBlockNumber(
  provider = new JsonRpcProvider(LOCAL_ANVIL_RPC_URL),
): Promise<bigint> {
  const block = await provider.getBlock("finalized");
  if (block === null || !Number.isSafeInteger(block.number) || block.number < 0) {
    throw new Error("The local Ethereum finalized block is unavailable");
  }
  return BigInt(block.number);
}

async function loadCkEthHelperBytecode(): Promise<string> {
  ckethHelperBytecode ??= (async () => {
    const bytecode = (await readFile(CKETH_HELPER_PATH, "utf8")).trim();
    if (!/^[0-9a-f]+$/.test(bytecode) || bytecode.length % 2 !== 0) {
      throw new Error("The pinned ckETH helper bytecode is malformed");
    }
    const digest = createHash("sha256")
      .update(Buffer.from(bytecode, "hex"))
      .digest("hex");
    if (digest !== CKETH_HELPER_SHA256) {
      throw new Error("The pinned ckETH helper bytecode checksum does not match");
    }
    return bytecode;
  })();
  return ckethHelperBytecode;
}

export function principalWord(principal: Principal): string {
  const principalBytes = principal.toUint8Array();
  if (principalBytes.length > 29) {
    throw new Error("Principal is too long for the ckETH deposit encoding");
  }
  const encoded = new Uint8Array(32);
  encoded[0] = principalBytes.length;
  encoded.set(principalBytes, 1);
  return `0x${Buffer.from(encoded).toString("hex")}`;
}

export function formatSatoshis(satoshis: bigint): string {
  if (satoshis < 0n) throw new Error("Satoshi amount cannot be negative");
  const whole = satoshis / 100_000_000n;
  const fraction = (satoshis % 100_000_000n).toString().padStart(8, "0");
  return `${whole}.${fraction}`;
}

type MetadataValue =
  | { Nat: bigint }
  | { Int: bigint }
  | { Text: string }
  | { Blob: Uint8Array };

type IcrcAccount = {
  owner: Principal;
  subaccount: [] | [Uint8Array];
};

type NativeLedgerActor = {
  icrc1_balance_of: ActorMethod<[IcrcAccount], bigint>;
  icrc1_metadata: ActorMethod<[], Array<[string, MetadataValue]>>;
  icrc1_minting_account: ActorMethod<[], [] | [IcrcAccount]>;
  icrc106_get_index_principal: ActorMethod<
    [],
    | { Ok: Principal }
    | {
        Err:
          | { IndexPrincipalNotSet: null }
          | { GenericError: { error_code: bigint; description: string } };
      }
  >;
};

type NativeIndexActor = {
  ledger_id: ActorMethod<[], Principal>;
};

type CkBtcUpdateError =
  | { AlreadyProcessing: null }
  | { TemporarilyUnavailable: string }
  | {
      NoNewUtxos: {
        current_confirmations: [] | [number];
        required_confirmations: number;
        pending_utxos: [] | [unknown[]];
        suspended_utxos: [] | [unknown[]];
      };
    }
  | { GenericError: { error_message: string; error_code: bigint } };

type CkBtcMinterActor = {
  get_btc_address: ActorMethod<
    [{ owner: [] | [Principal]; subaccount: [] | [Uint8Array] }],
    string
  >;
  update_balance: ActorMethod<
    [{ owner: [] | [Principal]; subaccount: [] | [Uint8Array] }],
    { Ok: unknown[] } | { Err: CkBtcUpdateError }
  >;
};

type CkEthMinterActor = {
  minter_address: ActorMethod<[], string>;
  smart_contract_address: ActorMethod<[], string>;
};

type EvmRpcActor = {
  getNodesInSubnet: ActorMethod<[], number>;
};

const nativeLedgerIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const account = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const metadata = IDL.Variant({
    Nat: IDL.Nat,
    Int: IDL.Int,
    Text: IDL.Text,
    Blob: IDL.Vec(IDL.Nat8),
  });
  return IDL.Service({
    icrc1_balance_of: IDL.Func([account], [IDL.Nat], ["query"]),
    icrc1_metadata: IDL.Func(
      [],
      [IDL.Vec(IDL.Tuple(IDL.Text, metadata))],
      ["query"],
    ),
    icrc1_minting_account: IDL.Func([], [IDL.Opt(account)], ["query"]),
    icrc106_get_index_principal: IDL.Func(
      [],
      [
        IDL.Variant({
          Ok: IDL.Principal,
          Err: IDL.Variant({
            IndexPrincipalNotSet: IDL.Null,
            GenericError: IDL.Record({
              error_code: IDL.Nat,
              description: IDL.Text,
            }),
          }),
        }),
      ],
      ["query"],
    ),
  });
};

const nativeIndexIdl: IDL.InterfaceFactory = ({ IDL }) =>
  IDL.Service({ ledger_id: IDL.Func([], [IDL.Principal], ["query"]) });

const ckbtcMinterIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const outpoint = IDL.Record({
    txid: IDL.Vec(IDL.Nat8),
    vout: IDL.Nat32,
  });
  const utxo = IDL.Record({
    outpoint,
    value: IDL.Nat64,
    height: IDL.Nat32,
  });
  const pendingUtxo = IDL.Record({
    outpoint,
    value: IDL.Nat64,
    confirmations: IDL.Nat32,
  });
  const suspendedUtxo = IDL.Record({
    utxo,
    reason: IDL.Variant({
      ValueTooSmall: IDL.Null,
      Quarantined: IDL.Null,
    }),
    earliest_retry: IDL.Nat64,
  });
  const updateError = IDL.Variant({
    NoNewUtxos: IDL.Record({
      current_confirmations: IDL.Opt(IDL.Nat32),
      required_confirmations: IDL.Nat32,
      pending_utxos: IDL.Opt(IDL.Vec(pendingUtxo)),
      suspended_utxos: IDL.Opt(IDL.Vec(suspendedUtxo)),
    }),
    AlreadyProcessing: IDL.Null,
    TemporarilyUnavailable: IDL.Text,
    GenericError: IDL.Record({
      error_message: IDL.Text,
      error_code: IDL.Nat64,
    }),
  });
  const updateStatus = IDL.Variant({
    ValueTooSmall: utxo,
    Tainted: utxo,
    Checked: utxo,
    Minted: IDL.Record({
      block_index: IDL.Nat64,
      minted_amount: IDL.Nat64,
      utxo,
    }),
  });
  const accountArg = IDL.Record({
    owner: IDL.Opt(IDL.Principal),
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  return IDL.Service({
    get_btc_address: IDL.Func([accountArg], [IDL.Text], []),
    update_balance: IDL.Func(
      [accountArg],
      [IDL.Variant({ Ok: IDL.Vec(updateStatus), Err: updateError })],
      [],
    ),
  });
};

const ckethMinterIdl: IDL.InterfaceFactory = ({ IDL }) =>
  IDL.Service({
    minter_address: IDL.Func([], [IDL.Text], []),
    smart_contract_address: IDL.Func([], [IDL.Text], ["query"]),
  });

const evmRpcIdl: IDL.InterfaceFactory = ({ IDL }) =>
  IDL.Service({ getNodesInSubnet: IDL.Func([], [IDL.Nat32], ["query"]) });

function fixtureSettings(controller: Principal) {
  return {
    controllers: [[controller]] as [Principal[]],
    compute_allocation: [] as [],
    memory_allocation: [] as [],
    freezing_threshold: [] as [],
    reserved_cycles_limit: [] as [],
    log_visibility: [] as [],
    wasm_memory_limit: [] as [],
    wasm_memory_threshold: [] as [],
    environment_variables: [] as [],
    snapshot_visibility: [] as [],
    minimum_incoming_canister_call_cycles: [] as [],
  };
}

function assertLedgerMetadata(
  fixture: NativeLedgerFixture,
  metadata: Array<[string, MetadataValue]>,
): void {
  const values = new Map(metadata);
  assertMetadataValue(values, "icrc1:name", "Text", fixture.name);
  assertMetadataValue(values, "icrc1:symbol", "Text", fixture.symbol);
  assertMetadataValue(
    values,
    "icrc1:decimals",
    "Nat",
    BigInt(fixture.decimals),
  );
  assertMetadataValue(values, "icrc1:fee", "Nat", fixture.fee);
}

function assertMetadataValue(
  metadata: Map<string, MetadataValue>,
  key: string,
  kind: "Nat" | "Text",
  expected: bigint | string,
): void {
  const value = metadata.get(key);
  const actual =
    kind === "Nat"
      ? value && "Nat" in value
        ? value.Nat
        : undefined
      : value && "Text" in value
        ? value.Text
        : undefined;
  if (actual !== expected) {
    throw new Error(`Unexpected ${key}; expected ${String(expected)}`);
  }
}

function isExpectedCkBtcUpdateError(error: CkBtcUpdateError): boolean {
  return (
    "NoNewUtxos" in error ||
    "AlreadyProcessing" in error ||
    "TemporarilyUnavailable" in error
  );
}

async function waitForBalance({
  client,
  fixture,
  owner,
  target,
  timeoutMs,
  sleep,
  beforeCheck,
}: {
  client: LocalNativeFixtureClient;
  fixture: NativeLedgerFixture;
  owner: Principal;
  target: bigint;
  timeoutMs: number;
  sleep: (milliseconds: number) => Promise<void>;
  beforeCheck?: () => Promise<void>;
}): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  let balance = await client.ledgerBalance(fixture, owner);
  while (balance < target && Date.now() < deadline) {
    await beforeCheck?.();
    await sleep(1_000);
    balance = await client.ledgerBalance(fixture, owner);
  }
  return balance;
}

function assertNativeBalance(
  fixture: NativeLedgerFixture,
  balance: bigint,
  target: bigint,
): void {
  if (balance < target) {
    throw new Error(
      `${fixture.symbol} balance is ${balance}, below target ${target}`,
    );
  }
}

async function retry<T>(
  operation: () => Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw new Error(
    `${label} was not ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function normalizeGateway(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:") {
    throw new Error("PocketIC native fixtures require an HTTP localhost gateway");
  }
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("PocketIC native fixture gateway must be localhost");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function jsonWithBigints(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    typeof nested === "bigint" ? nested.toString() : nested,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
