import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  Actor,
  AnonymousIdentity,
  HttpAgent,
  type ActorMethod,
  type ActorSubclass,
  type Identity,
} from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { LOCAL_II_FRONTEND_CANISTER_ID } from "neutron-tools/src/runtime.js";
import {
  chunkWasm,
  sha256,
  sha256Hex,
  toHex,
} from "./artifact.ts";
import { MANAGEMENT_CANISTER_ID } from "./ic_client.ts";
import type { LocalEnvironment } from "./local_environment.ts";
import {
  CKBTC_MINTER_CANISTER_ID,
  CKETH_MINTER_CANISTER_ID,
  ensureLocalNativeChainFixtures,
  fundLocalNativeChainFixtures,
  localNativeChainFixtureIds,
  type NativeLedgerFixture,
} from "./local_chain_fixtures.ts";

const FIXTURE_IDENTITY_DOMAIN = "neutron-pocketic-ledger-minter-v1";
const FIXTURE_CANISTER_CYCLES = 100_000_000_000_000n;
// Keep two independently configured local Neutrons below the ICRC ledger's
// unsigned-64-bit supply ceiling even when both receive the full ckETH fixture.
const DEFAULT_TARGET_WHOLE_TOKENS = 9n;
const STANDARD_LEDGER_MAX_AMOUNT = (1n << 64n) - 1n;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_WASM_BYTES = 100 * 1024 * 1024;

export const ICP_LEDGER_CANISTER_ID = "ryjl3-tyaaa-aaaaa-aaaba-cai";
export const ICP_INDEX_CANISTER_ID = "qhbym-qaaaa-aaaaa-aaafq-cai";
export const CYCLES_LEDGER_CANISTER_ID = "um5iw-rqaaa-aaaaq-qaaba-cai";
export const CYCLES_INDEX_CANISTER_ID = "ul4oc-4iaaa-aaaaq-qaabq-cai";

export type LocalLedgerFixture = {
  key: string;
  canisterId: string;
  indexCanisterId: string;
  name: string;
  symbol: string;
  decimals: number;
  fee: bigint;
  source: "pocketic" | "managed" | "ckbtc" | "cketh";
};

/**
 * Canonical full-protocol fixture IDs. PocketIC v14 supplies ICP and TCYCLES; the
 * ckBTC and ckETH use their real local protocol minters. The remaining four
 * script-managed pairs are deterministic generic ICRC fixtures.
 */
export const LOCAL_LEDGER_FIXTURES: readonly LocalLedgerFixture[] = [
  {
    key: "icp",
    canisterId: ICP_LEDGER_CANISTER_ID,
    indexCanisterId: ICP_INDEX_CANISTER_ID,
    name: "Internet Computer",
    symbol: "ICP",
    decimals: 8,
    fee: 10_000n,
    source: "pocketic",
  },
  {
    key: "ckbtc",
    canisterId: "mxzaz-hqaaa-aaaar-qaada-cai",
    indexCanisterId: "n5wcd-faaaa-aaaar-qaaea-cai",
    name: "ckBTC",
    symbol: "ckBTC",
    decimals: 8,
    fee: 10n,
    source: "ckbtc",
  },
  {
    key: "cketh",
    canisterId: "ss2fx-dyaaa-aaaar-qacoq-cai",
    indexCanisterId: "s3zol-vqaaa-aaaar-qacpa-cai",
    name: "ckETH",
    symbol: "ckETH",
    decimals: 18,
    fee: 2_000_000_000_000n,
    source: "cketh",
  },
  {
    key: "ckusdc",
    canisterId: "xevnm-gaaaa-aaaar-qafnq-cai",
    indexCanisterId: "xrs4b-hiaaa-aaaar-qafoa-cai",
    name: "ckUSDC",
    symbol: "ckUSDC",
    decimals: 6,
    fee: 10_000n,
    source: "managed",
  },
  {
    key: "ckusdt",
    canisterId: "cngnf-vqaaa-aaaar-qag4q-cai",
    indexCanisterId: "cefgz-dyaaa-aaaar-qag5a-cai",
    name: "ckUSDT",
    symbol: "ckUSDT",
    decimals: 6,
    fee: 10_000n,
    source: "managed",
  },
  {
    key: "ckdoge",
    canisterId: "efmc5-wyaaa-aaaar-qb3wa-cai",
    indexCanisterId: "ecnej-3aaaa-aaaar-qb3wq-cai",
    name: "ckDOGE",
    symbol: "ckDOGE",
    decimals: 8,
    fee: 1_000_000n,
    source: "managed",
  },
  {
    key: "cksol",
    canisterId: "ls5lp-lqaaa-aaaar-qb5oa-cai",
    indexCanisterId: "2ezyf-hqaaa-aaaar-qb6ga-cai",
    name: "ckSOL",
    symbol: "ckSOL",
    decimals: 9,
    fee: 50n,
    source: "managed",
  },
  {
    key: "cycles",
    canisterId: CYCLES_LEDGER_CANISTER_ID,
    indexCanisterId: CYCLES_INDEX_CANISTER_ID,
    name: "Trillion Cycles",
    symbol: "TCYCLES",
    decimals: 12,
    fee: 100_000_000n,
    source: "pocketic",
  },
] as const;

export const LOCAL_SYSTEM_FIXTURES = {
  bitcoin: "g4xu7-jiaaa-aaaan-aaaaq-cai",
  cycles_minting: "rkp4c-7iaaa-aaaaa-aaaca-cai",
  internet_identity: LOCAL_II_FRONTEND_CANISTER_ID,
  nns_governance: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  nns_registry: "rwlgt-iiaaa-aaaaa-aaaaa-cai",
  nns_root: "r7inp-6aaaa-aaaaa-aaabq-cai",
} as const;

export const LEDGER_WASM_ARTIFACT: LocalFixtureWasmArtifact = {
  release: "ledger-suite-icrc-2026-03-09",
  name: "ic-icrc1-ledger.wasm.gz",
  url: "https://github.com/dfinity/ic/releases/download/ledger-suite-icrc-2026-03-09/ic-icrc1-ledger.wasm.gz",
  archiveSha256:
    "354dd6ecfdc72b5409805b31dea22c9db11df6e14095a5a68924eb63535e6d8a",
};

export const INDEX_WASM_ARTIFACT: LocalFixtureWasmArtifact = {
  release: "ledger-suite-icrc-2026-03-09",
  name: "ic-icrc1-index-ng.wasm.gz",
  url: "https://github.com/dfinity/ic/releases/download/ledger-suite-icrc-2026-03-09/ic-icrc1-index-ng.wasm.gz",
  archiveSha256:
    "dab6808d0dfc06e5e88336d0c3d3e45e5448c6e36c2a781f3e9e09bd450f528c",
};

export type LocalFixtureWasmArtifact = {
  release: string;
  name: string;
  url: string;
  archiveSha256: string;
};

export type PreparedLocalFixtureWasm = {
  wasm: Uint8Array;
  moduleHashHex: string;
};

export type PreparedLocalFixtureArtifacts = {
  ledger: PreparedLocalFixtureWasm;
  index: PreparedLocalFixtureWasm;
};

export type LocalFixtureClient = {
  verifyInternetIdentity(canisterId: string): Promise<void>;
  verifyLedgerPair(fixture: LocalLedgerFixture): Promise<void>;
  ensureManagedLedgerPair(
    fixture: LocalLedgerFixture,
    artifacts: PreparedLocalFixtureArtifacts,
  ): Promise<void>;
  fundLedger(
    fixture: LocalLedgerFixture,
    owner: Principal,
    targetBalance: bigint,
  ): Promise<bigint>;
};

export type LocalFixtureConnection = {
  gatewayUrl: string;
  expectedRootKeyBase64: string;
};

export type EnsureLocalFixturesOptions = LocalFixtureConnection & {
  profile: LocalEnvironment;
  cacheDirectory: string;
  logger?: Pick<Console, "log">;
};

export type EnsureLocalFixturesDependencies = {
  createClient?: typeof createLocalFixtureClient;
  resolveArtifacts?: typeof resolveLocalFixtureArtifacts;
  ensureNative?: typeof ensureLocalNativeChainFixtures;
};

export type FundLocalFixturesOptions = LocalFixtureConnection & {
  canisterId: string;
  stateDirectory: string;
  cacheDirectory: string;
  targetWholeTokens?: bigint;
  /**
   * Native deposits consume shared ckBTC/ckETH ledger supply. Fleet
   * deployments fund those scarce fixtures on the primary node only.
   */
  fundNativeChains?: boolean;
  logger?: Pick<Console, "log">;
};

export type FundLocalFixturesDependencies = {
  createClient?: typeof createLocalFixtureClient;
  fundNative?: typeof fundLocalNativeChainFixtures;
};

export async function ensureLocalPocketIcFixtures(
  options: EnsureLocalFixturesOptions,
  dependencies: EnsureLocalFixturesDependencies = {},
): Promise<Record<string, string>> {
  const logger = options.logger ?? console;
  const identity = localFixtureMinterIdentity();
  const client = await (dependencies.createClient ?? createLocalFixtureClient)({
    gatewayUrl: options.gatewayUrl,
    expectedRootKeyBase64: options.expectedRootKeyBase64,
    identity,
    logger,
  });

  logger.log("Verifying PocketIC Internet Identity");
  await client.verifyInternetIdentity(LOCAL_II_FRONTEND_CANISTER_ID);
  if (options.profile === "minimal") {
    return { internet_identity: LOCAL_II_FRONTEND_CANISTER_ID };
  }

  logger.log("Verifying full protocol ledger fixtures");
  for (const fixture of LOCAL_LEDGER_FIXTURES) {
    if (fixture.source === "pocketic") {
      await client.verifyLedgerPair(fixture);
    }
  }

  const artifacts = await (
    dependencies.resolveArtifacts ?? resolveLocalFixtureArtifacts
  )({ cacheDirectory: options.cacheDirectory, logger });
  const nativeFixtures = nativeLedgerFixtures();
  await (dependencies.ensureNative ?? ensureLocalNativeChainFixtures)({
    gatewayUrl: options.gatewayUrl,
    expectedRootKeyBase64: options.expectedRootKeyBase64,
    cacheDirectory: options.cacheDirectory,
    identity,
    fixtures: nativeFixtures,
    ledgerArtifacts: artifacts,
    encodeLedgerInitArgs: (fixture, minter) =>
      encodeLocalLedgerInitArgs(
        {
          ...fixture,
          source: fixture.key,
        },
        minter,
      ),
    encodeIndexInitArgs: encodeLocalIndexInitArgs,
    logger,
  });
  for (const fixture of LOCAL_LEDGER_FIXTURES) {
    if (fixture.source !== "managed") continue;
    await client.ensureManagedLedgerPair(fixture, artifacts);
  }
  return localPocketIcFixtureIds();
}

/**
 * Cheap post-deploy hook. ckBTC/ckETH follow their real native deposit paths,
 * generic fixtures mint through their deterministic local identity, and ICP
 * transfers from PocketIC's pre-funded anonymous account.
 */
export async function fundLocalPocketIcFixtures(
  options: FundLocalFixturesOptions,
  dependencies: FundLocalFixturesDependencies = {},
): Promise<Record<string, bigint>> {
  const target = Principal.fromText(options.canisterId);
  const targetWholeTokens =
    options.targetWholeTokens ?? DEFAULT_TARGET_WHOLE_TOKENS;
  if (targetWholeTokens <= 0n) {
    throw new Error("Local fixture target must be a positive whole-token amount");
  }
  for (const fixture of LOCAL_LEDGER_FIXTURES) {
    const target =
      targetWholeTokens * 10n ** BigInt(fixture.decimals);
    if (target > STANDARD_LEDGER_MAX_AMOUNT) {
      throw new Error(
        `${targetWholeTokens} whole ${fixture.symbol} exceeds the local ledger amount limit`,
      );
    }
  }
  const logger = options.logger ?? console;
  const createClient = dependencies.createClient ?? createLocalFixtureClient;
  const [managedClient, anonymousClient] = await Promise.all([
    createClient({
      gatewayUrl: options.gatewayUrl,
      expectedRootKeyBase64: options.expectedRootKeyBase64,
      identity: localFixtureMinterIdentity(),
      logger,
    }),
    createClient({
      gatewayUrl: options.gatewayUrl,
      expectedRootKeyBase64: options.expectedRootKeyBase64,
      identity: new AnonymousIdentity(),
      logger,
    }),
  ]);
  const fundNativeChains = options.fundNativeChains ?? true;
  const nativePromise: Promise<Partial<Record<"ckbtc" | "cketh", bigint>>> =
    fundNativeChains
      ? (dependencies.fundNative ?? fundLocalNativeChainFixtures)({
          gatewayUrl: options.gatewayUrl,
          expectedRootKeyBase64: options.expectedRootKeyBase64,
          cacheDirectory: options.cacheDirectory,
          stateDirectory: options.stateDirectory,
          identity: localFixtureMinterIdentity(),
          owner: target,
          fixtures: nativeLedgerFixtures(),
          targetWholeTokens,
          logger,
        })
      : Promise.resolve({});
  const genericPromise = Promise.all(
    LOCAL_LEDGER_FIXTURES.filter(
      ({ source }) => source === "managed" || source === "pocketic",
    ).map(async (fixture) => {
      const client =
        fixture.source === "managed" ? managedClient : anonymousClient;
      const balance = await client.fundLedger(
        fixture,
        target,
        targetWholeTokens * 10n ** BigInt(fixture.decimals),
      );
      return [fixture.key, balance] as const;
    }),
  );
  const [nativeBalances, genericEntries] = await Promise.all([
    nativePromise,
    genericPromise,
  ]);
  const genericBalances = new Map(genericEntries);
  const balances: Record<string, bigint> = {};
  for (const fixture of LOCAL_LEDGER_FIXTURES) {
    if (fixture.source === "ckbtc" || fixture.source === "cketh") {
      const balance = nativeBalances[fixture.source];
      if (balance === undefined) {
        balances[fixture.key] = 0n;
        logger.log(
          `Skipped ${fixture.symbol} funding on secondary fleet node`,
        );
        continue;
      }
      balances[fixture.key] = balance;
      logger.log(`Funded ${fixture.symbol} balance ${balance}`);
      continue;
    }
    const balance = genericBalances.get(fixture.key);
    if (balance === undefined) {
      throw new Error(`Missing local ${fixture.symbol} funding result`);
    }
    balances[fixture.key] = balance;
    logger.log(`Funded ${fixture.symbol} balance ${balance}`);
  }
  return balances;
}

export function localPocketIcFixtureIds(): Record<string, string> {
  const entries: Array<[string, string]> = Object.entries(
    LOCAL_SYSTEM_FIXTURES,
  );
  for (const fixture of LOCAL_LEDGER_FIXTURES) {
    entries.push([`${fixture.key}_ledger`, fixture.canisterId]);
    entries.push([`${fixture.key}_index`, fixture.indexCanisterId]);
  }
  entries.push(...Object.entries(localNativeChainFixtureIds()));
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function nativeLedgerFixtures(): readonly [
  NativeLedgerFixture,
  NativeLedgerFixture,
] {
  const ckbtc = LOCAL_LEDGER_FIXTURES.find(({ source }) => source === "ckbtc");
  const cketh = LOCAL_LEDGER_FIXTURES.find(({ source }) => source === "cketh");
  if (ckbtc === undefined || cketh === undefined) {
    throw new Error("The local fixture catalog must contain ckBTC and ckETH");
  }
  return [
    {
      key: "ckbtc",
      canisterId: ckbtc.canisterId,
      indexCanisterId: ckbtc.indexCanisterId,
      name: ckbtc.name,
      symbol: ckbtc.symbol,
      decimals: ckbtc.decimals,
      fee: ckbtc.fee,
    },
    {
      key: "cketh",
      canisterId: cketh.canisterId,
      indexCanisterId: cketh.indexCanisterId,
      name: cketh.name,
      symbol: cketh.symbol,
      decimals: cketh.decimals,
      fee: cketh.fee,
    },
  ];
}

export function localFixtureMinterIdentity(): Ed25519KeyIdentity {
  const seed = createHash("sha256").update(FIXTURE_IDENTITY_DOMAIN).digest();
  return Ed25519KeyIdentity.generate(new Uint8Array(seed));
}

export function encodeLocalLedgerInitArgs(
  fixture: LocalLedgerFixture,
  minter: Principal,
): Uint8Array {
  if (fixture.source === "pocketic") {
    throw new Error(`Cannot initialize PocketIC ledger ${fixture.canisterId}`);
  }
  const account = { owner: minter, subaccount: [] };
  return new Uint8Array(
    IDL.encode(ledgerInitTypes(), [
      {
        Init: {
          decimals: [fixture.decimals],
          token_symbol: fixture.symbol,
          transfer_fee: fixture.fee,
          metadata: [
            ["icrc1:logo", { Text: fixtureLogo(fixture.symbol) }],
            ["neutron:fixture", { Text: "local" }],
          ],
          minting_account: account,
          initial_balances: [],
          fee_collector_account: [],
          archive_options: {
            num_blocks_to_archive: 1_000n,
            max_transactions_per_response: [],
            trigger_threshold: 2_000n,
            more_controller_ids: [],
            max_message_size_bytes: [],
            cycles_for_archive_creation: [100_000_000_000_000n],
            node_max_memory_size_bytes: [],
            controller_id: minter,
          },
          max_memo_length: [80],
          index_principal: [Principal.fromText(fixture.indexCanisterId)],
          token_name: fixture.name,
          feature_flags: [{ icrc2: true }],
        },
      },
    ]),
  );
}

export function encodeLocalIndexInitArgs(ledgerCanisterId: string): Uint8Array {
  const ledgerId = Principal.fromText(ledgerCanisterId);
  return new Uint8Array(
    IDL.encode(indexInitTypes(), [
      [
        {
          Init: {
            ledger_id: ledgerId,
            retrieve_blocks_from_ledger_interval_seconds: [],
            min_retrieve_blocks_from_ledger_interval_seconds: [1n],
            max_retrieve_blocks_from_ledger_interval_seconds: [1n],
          },
        },
      ],
    ]),
  );
}

export async function resolveLocalFixtureArtifacts({
  cacheDirectory,
  logger = console,
  fetcher = fetch,
}: {
  cacheDirectory: string;
  logger?: Pick<Console, "log">;
  fetcher?: typeof fetch;
}): Promise<PreparedLocalFixtureArtifacts> {
  const [ledger, index] = await Promise.all([
    resolvePinnedWasm(LEDGER_WASM_ARTIFACT, cacheDirectory, logger, fetcher),
    resolvePinnedWasm(INDEX_WASM_ARTIFACT, cacheDirectory, logger, fetcher),
  ]);
  return { ledger, index };
}

export async function createLocalFixtureClient({
  gatewayUrl,
  expectedRootKeyBase64,
  identity,
  logger = console,
  fetcher = fetch,
}: LocalFixtureConnection & {
  identity: Identity;
  logger?: Pick<Console, "log">;
  fetcher?: typeof fetch;
}): Promise<LocalFixtureClient> {
  return DirectLocalFixtureClient.create({
    gatewayUrl,
    expectedRootKeyBase64,
    identity,
    logger,
    fetcher,
  });
}

class DirectLocalFixtureClient implements LocalFixtureClient {
  readonly #agent: HttpAgent;
  readonly #identity: Identity;
  readonly #gatewayUrl: string;
  readonly #logger: Pick<Console, "log">;
  readonly #fetcher: typeof fetch;

  private constructor({
    agent,
    gatewayUrl,
    identity,
    logger,
    fetcher,
  }: {
    agent: HttpAgent;
    gatewayUrl: string;
    identity: Identity;
    logger: Pick<Console, "log">;
    fetcher: typeof fetch;
  }) {
    this.#agent = agent;
    this.#gatewayUrl = gatewayUrl;
    this.#identity = identity;
    this.#logger = logger;
    this.#fetcher = fetcher;
  }

  static async create({
    gatewayUrl,
    expectedRootKeyBase64,
    identity,
    logger,
    fetcher,
  }: LocalFixtureConnection & {
    identity: Identity;
    logger: Pick<Console, "log">;
    fetcher: typeof fetch;
  }): Promise<DirectLocalFixtureClient> {
    const normalizedGateway = normalizeGateway(gatewayUrl);
    const agent = await HttpAgent.create({
      host: normalizedGateway,
      identity,
      fetch: fetcher,
      // PocketIC query replies do not carry replica node signatures. Updates
      // are still certified through request-status and the pinned root key.
      verifyQuerySignatures: false,
    });
    const rootKey = await agent.fetchRootKey();
    if (Buffer.from(rootKey).toString("base64") !== expectedRootKeyBase64) {
      throw new Error(
        "PocketIC fixture gateway root key does not match the provision session",
      );
    }
    return new DirectLocalFixtureClient({
      agent,
      gatewayUrl: normalizedGateway,
      identity,
      logger,
      fetcher,
    });
  }

  async verifyInternetIdentity(canisterId: string): Promise<void> {
    Principal.fromText(canisterId);
    const url = new URL(this.#gatewayUrl);
    url.searchParams.set("canisterId", canisterId);
    const response = await this.#fetcher(url, { redirect: "manual" });
    if (!response.ok && !isRedirect(response.status)) {
      throw new Error(
        `PocketIC Internet Identity ${canisterId} returned HTTP ${response.status}`,
      );
    }
    const subnet = await this.#agent.fetchSubnetKeys(canisterId);
    if (subnet === undefined) {
      throw new Error(
        `PocketIC Internet Identity ${canisterId} has no certified query-signature subnet keys`,
      );
    }
  }

  async verifyLedgerPair(fixture: LocalLedgerFixture): Promise<void> {
    const ledger = this.ledgerActor(fixture.canisterId);
    const index = this.indexActor(fixture.indexCanisterId);
    const [metadata, ledgerId] = await Promise.all([
      ledger.icrc1_metadata(),
      index.ledger_id(),
    ]);
    assertLedgerMetadata(fixture, metadata);
    if (ledgerId.toText() !== fixture.canisterId) {
      throw new Error(`${fixture.symbol} index does not target its canonical ledger`);
    }
    // The ICP ledger predates ICRC-106. Its index still reports the canonical
    // ledger ID, while every generic/cycles ledger reports both directions.
    if (fixture.key !== "icp") {
      const indexPrincipal = await ledger.icrc106_get_index_principal();
      if (
        !("Ok" in indexPrincipal) ||
        indexPrincipal.Ok.toText() !== fixture.indexCanisterId
      ) {
        throw new Error(
          `${fixture.symbol} ledger does not target its canonical index`,
        );
      }
    }
    if (fixture.source !== "pocketic") {
      const minting = await ledger.icrc1_minting_account();
      const expected =
        fixture.source === "ckbtc"
          ? CKBTC_MINTER_CANISTER_ID
          : fixture.source === "cketh"
            ? CKETH_MINTER_CANISTER_ID
            : this.#identity.getPrincipal().toText();
      if (
        minting.length !== 1 ||
        minting[0]!.owner.toText() !== expected ||
        minting[0]!.subaccount.length !== 0
      ) {
        throw new Error(
          `${fixture.symbol} does not use its expected local minting account`,
        );
      }
    }
  }

  async ensureManagedLedgerPair(
    fixture: LocalLedgerFixture,
    artifacts: PreparedLocalFixtureArtifacts,
  ): Promise<void> {
    if (fixture.source !== "managed") {
      throw new Error(`Cannot manage PocketIC-owned ledger ${fixture.canisterId}`);
    }
    const minter = this.#identity.getPrincipal();
    await this.ensureCanister(fixture.canisterId);
    await this.ensureCanister(fixture.indexCanisterId);
    await this.ensureInstalled({
      label: `${fixture.symbol} ledger`,
      canisterId: fixture.canisterId,
      artifact: artifacts.ledger,
      arg: encodeLocalLedgerInitArgs(fixture, minter),
    });
    await this.ensureInstalled({
      label: `${fixture.symbol} index`,
      canisterId: fixture.indexCanisterId,
      artifact: artifacts.index,
      arg: encodeLocalIndexInitArgs(fixture.canisterId),
    });
    await this.verifyLedgerPair(fixture);
    this.#logger.log(`Local ${fixture.symbol} fixture is ready`);
  }

  async fundLedger(
    fixture: LocalLedgerFixture,
    owner: Principal,
    targetBalance: bigint,
  ): Promise<bigint> {
    if (targetBalance <= 0n) {
      throw new Error(`${fixture.symbol} target balance must be positive`);
    }
    const ledger = this.ledgerActor(fixture.canisterId);
    const account: IcrcAccount = { owner, subaccount: [] };
    let balance = await ledger.icrc1_balance_of(account);
    if (balance >= targetBalance) return balance;
    const result = await ledger.icrc1_transfer({
      from_subaccount: [],
      to: account,
      amount: targetBalance - balance,
      fee: [],
      memo: [],
      created_at_time: [],
    });
    if ("Err" in result) {
      throw new Error(
        `${fixture.symbol} local funding failed: ${jsonWithBigints(result.Err)}`,
      );
    }
    balance = await ledger.icrc1_balance_of(account);
    if (balance < targetBalance) {
      throw new Error(
        `${fixture.symbol} balance ${balance} is below target ${targetBalance}`,
      );
    }
    return balance;
  }

  async ensureCanister(canisterId: string): Promise<void> {
    const canister = Principal.fromText(canisterId);
    try {
      await this.canisterStatus(canister);
      return;
    } catch (statusError) {
      try {
        const result = await this.managementActor(canister)
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
          `Unable to inspect or create local fixture canister ${canisterId}; clear the PocketIC state if this ID is occupied by an old fixture`,
          { cause: createError instanceof Error ? createError : statusError },
        );
      }
    }
    await this.canisterStatus(canister);
  }

  async ensureInstalled({
    label,
    canisterId,
    artifact,
    arg,
  }: {
    label: string;
    canisterId: string;
    artifact: PreparedLocalFixtureWasm;
    arg: Uint8Array;
  }): Promise<void> {
    const canister = Principal.fromText(canisterId);
    const status = await this.canisterStatus(canister);
    const installedHash =
      status.module_hash.length === 0 ? null : toHex(status.module_hash[0]!);
    if (installedHash === artifact.moduleHashHex) return;
    if (installedHash !== null) {
      throw new Error(
        `${canisterId} contains an unexpected ${label} module; clear the PocketIC state instead of replacing fixtures in place`,
      );
    }

    const management = this.managementActor(canister);
    const chunks = chunkWasm(artifact.wasm);
    await management.clear_chunk_store({ canister_id: canister });
    try {
      for (const chunk of chunks) {
        const uploaded = await management.upload_chunk({
          canister_id: canister,
          chunk: chunk.bytes,
        });
        if (toHex(uploaded.hash) !== chunk.hashHex) {
          throw new Error(`${label} chunk hash mismatch`);
        }
      }
      await management.install_chunked_code({
        mode: { install: null },
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
    const installed = await this.canisterStatus(canister);
    const actualHash =
      installed.module_hash.length === 0
        ? null
        : toHex(installed.module_hash[0]!);
    if (actualHash !== artifact.moduleHashHex) {
      throw new Error(
        `${label} installed module hash ${actualHash ?? "none"} does not match ${artifact.moduleHashHex}`,
      );
    }
  }

  private ledgerActor(canisterId: string): ActorSubclass<FixtureLedgerActor> {
    return Actor.createActor<FixtureLedgerActor>(fixtureLedgerIdl, {
      agent: this.#agent,
      canisterId: Principal.fromText(canisterId),
    });
  }

  private indexActor(canisterId: string): ActorSubclass<FixtureIndexActor> {
    return Actor.createActor<FixtureIndexActor>(fixtureIndexIdl, {
      agent: this.#agent,
      canisterId: Principal.fromText(canisterId),
    });
  }

  private canisterStatus(canister: Principal) {
    return this.managementActor(canister).canister_status({
      canister_id: canister,
    });
  }

  private managementActor(
    effectiveCanisterId: Principal,
  ): ActorSubclass<FixtureManagementActor> {
    return Actor.createActor<FixtureManagementActor>(fixtureManagementIdl, {
      agent: this.#agent,
      canisterId: Principal.fromText(MANAGEMENT_CANISTER_ID),
      effectiveCanisterId,
    });
  }
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

type FixtureLedgerActor = {
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
  icrc1_transfer: ActorMethod<
    [
      {
        from_subaccount: [] | [Uint8Array];
        to: IcrcAccount;
        amount: bigint;
        fee: [] | [bigint];
        memo: [] | [Uint8Array];
        created_at_time: [] | [bigint];
      },
    ],
    { Ok: bigint } | { Err: Record<string, unknown> }
  >;
};

type FixtureIndexActor = {
  ledger_id: ActorMethod<[], Principal>;
};

type FixtureCanisterSettings = {
  controllers: [] | [Principal[]];
  compute_allocation: [] | [bigint];
  memory_allocation: [] | [bigint];
  freezing_threshold: [] | [bigint];
  reserved_cycles_limit: [] | [bigint];
  log_visibility: [] | [unknown];
  wasm_memory_limit: [] | [bigint];
  wasm_memory_threshold: [] | [bigint];
  environment_variables: [] | [Array<{ name: string; value: string }>];
  snapshot_visibility: [] | [unknown];
  minimum_incoming_canister_call_cycles: [] | [bigint];
};

type FixtureManagementActor = {
  provisional_create_canister_with_cycles: ActorMethod<
    [
      {
        amount: [] | [bigint];
        settings: [] | [FixtureCanisterSettings];
        specified_id: [] | [Principal];
        sender_canister_version: [] | [bigint];
      },
    ],
    { canister_id: Principal }
  >;
  canister_status: ActorMethod<
    [{ canister_id: Principal }],
    { module_hash: [] | [Uint8Array] }
  >;
  upload_chunk: ActorMethod<
    [{ canister_id: Principal; chunk: Uint8Array }],
    { hash: Uint8Array }
  >;
  clear_chunk_store: ActorMethod<
    [{ canister_id: Principal }],
    undefined
  >;
  install_chunked_code: ActorMethod<
    [
      {
        mode: { install: null };
        target_canister: Principal;
        store_canister: [];
        chunk_hashes_list: Array<{ hash: Uint8Array }>;
        wasm_module_hash: Uint8Array;
        arg: Uint8Array;
        sender_canister_version: [];
      },
    ],
    undefined
  >;
};

const fixtureLedgerIdl: IDL.InterfaceFactory = ({ IDL }) => {
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

const fixtureIndexIdl: IDL.InterfaceFactory = ({ IDL }) =>
  IDL.Service({ ledger_id: IDL.Func([], [IDL.Principal], ["query"]) });

const fixtureManagementIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const visibility = IDL.Variant({
    controllers: IDL.Null,
    public: IDL.Null,
    allowed_viewers: IDL.Vec(IDL.Principal),
  });
  const settings = IDL.Record({
    controllers: IDL.Opt(IDL.Vec(IDL.Principal)),
    compute_allocation: IDL.Opt(IDL.Nat),
    memory_allocation: IDL.Opt(IDL.Nat),
    freezing_threshold: IDL.Opt(IDL.Nat),
    reserved_cycles_limit: IDL.Opt(IDL.Nat),
    log_visibility: IDL.Opt(visibility),
    wasm_memory_limit: IDL.Opt(IDL.Nat),
    wasm_memory_threshold: IDL.Opt(IDL.Nat),
    environment_variables: IDL.Opt(
      IDL.Vec(IDL.Record({ name: IDL.Text, value: IDL.Text })),
    ),
    snapshot_visibility: IDL.Opt(visibility),
    minimum_incoming_canister_call_cycles: IDL.Opt(IDL.Nat),
  });
  const chunkHash = IDL.Record({ hash: IDL.Vec(IDL.Nat8) });
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
    canister_status: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal })],
      [IDL.Record({ module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)) })],
      [],
    ),
    upload_chunk: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal, chunk: IDL.Vec(IDL.Nat8) })],
      [chunkHash],
      [],
    ),
    clear_chunk_store: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal })],
      [],
      [],
    ),
    install_chunked_code: IDL.Func(
      [
        IDL.Record({
          mode: IDL.Variant({ install: IDL.Null }),
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
  });
};

function ledgerInitTypes(): IDL.Type[] {
  const metadata = IDL.Variant({
    Int: IDL.Int,
    Nat: IDL.Nat,
    Blob: IDL.Vec(IDL.Nat8),
    Text: IDL.Text,
  });
  const account = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const init = IDL.Record({
    decimals: IDL.Opt(IDL.Nat8),
    token_symbol: IDL.Text,
    transfer_fee: IDL.Nat,
    metadata: IDL.Vec(IDL.Tuple(IDL.Text, metadata)),
    minting_account: account,
    initial_balances: IDL.Vec(IDL.Tuple(account, IDL.Nat)),
    fee_collector_account: IDL.Opt(account),
    archive_options: IDL.Record({
      num_blocks_to_archive: IDL.Nat64,
      max_transactions_per_response: IDL.Opt(IDL.Nat64),
      trigger_threshold: IDL.Nat64,
      more_controller_ids: IDL.Opt(IDL.Vec(IDL.Principal)),
      max_message_size_bytes: IDL.Opt(IDL.Nat64),
      cycles_for_archive_creation: IDL.Opt(IDL.Nat64),
      node_max_memory_size_bytes: IDL.Opt(IDL.Nat64),
      controller_id: IDL.Principal,
    }),
    max_memo_length: IDL.Opt(IDL.Nat16),
    index_principal: IDL.Opt(IDL.Principal),
    token_name: IDL.Text,
    feature_flags: IDL.Opt(IDL.Record({ icrc2: IDL.Bool })),
  });
  return [IDL.Variant({ Upgrade: IDL.Opt(IDL.Reserved), Init: init })];
}

function indexInitTypes(): IDL.Type[] {
  const interval = {
    retrieve_blocks_from_ledger_interval_seconds: IDL.Opt(IDL.Nat64),
    min_retrieve_blocks_from_ledger_interval_seconds: IDL.Opt(IDL.Nat64),
    max_retrieve_blocks_from_ledger_interval_seconds: IDL.Opt(IDL.Nat64),
  };
  const indexArg = IDL.Variant({
    Upgrade: IDL.Record({
      ledger_id: IDL.Opt(IDL.Principal),
      ...interval,
    }),
    Init: IDL.Record({
      ledger_id: IDL.Principal,
      ...interval,
    }),
  });
  return [IDL.Opt(indexArg)];
}

function fixtureSettings(
  controller: Principal,
): FixtureCanisterSettings {
  return {
    controllers: [[controller]] as [Principal[]],
    compute_allocation: [],
    memory_allocation: [],
    freezing_threshold: [],
    reserved_cycles_limit: [],
    log_visibility: [],
    wasm_memory_limit: [],
    wasm_memory_threshold: [],
    environment_variables: [],
    snapshot_visibility: [],
    minimum_incoming_canister_call_cycles: [],
  };
}

async function resolvePinnedWasm(
  artifact: LocalFixtureWasmArtifact,
  cacheDirectory: string,
  logger: Pick<Console, "log">,
  fetcher: typeof fetch,
): Promise<PreparedLocalFixtureWasm> {
  assertArtifact(artifact);
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
      (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_ARCHIVE_BYTES)
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
    throw new Error(`Refusing symlink local fixture artifact ${filename}`);
  }
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_ARCHIVE_BYTES) {
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
    throw new Error(`Local fixture cache path must be a real directory: ${directory}`);
  }
}

function assertArtifact(artifact: LocalFixtureWasmArtifact): void {
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

function assertLedgerMetadata(
  fixture: LocalLedgerFixture,
  metadata: Array<[string, MetadataValue]>,
): void {
  const values = new Map(metadata);
  assertMetadata(values, "icrc1:name", "Text", fixture.name);
  assertMetadata(values, "icrc1:symbol", "Text", fixture.symbol);
  assertMetadata(values, "icrc1:decimals", "Nat", BigInt(fixture.decimals));
  assertMetadata(values, "icrc1:fee", "Nat", fixture.fee);
}

function assertMetadata(
  metadata: Map<string, MetadataValue>,
  key: string,
  kind: "Nat" | "Text",
  expected: bigint | string,
): void {
  const value = metadata.get(key);
  const actual =
    value && kind in value
      ? (value as { Nat?: bigint; Text?: string })[kind]
      : undefined;
  if (actual !== expected) {
    throw new Error(`Unexpected ${key}; expected ${String(expected)}`);
  }
}

function fixtureLogo(symbol: string): string {
  const label = symbol
    .slice(0, 6)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">` +
    `<rect width="128" height="128" rx="24" fill="#14171c"/>` +
    `<text x="64" y="70" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#f4f6f8">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function normalizeGateway(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("PocketIC fixture gateway must be a bare loopback HTTP origin");
  }
  return url.href;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function jsonWithBigints(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
