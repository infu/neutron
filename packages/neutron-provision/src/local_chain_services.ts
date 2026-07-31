import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

export const LOCAL_BITCOIN_RPC_HOST = "127.0.0.1" as const;
export const LOCAL_BITCOIN_RPC_PORT = 18443 as const;
export const LOCAL_BITCOIN_P2P_PORT = 18444 as const;
export const LOCAL_BITCOIN_RPC_USER = "ic-btc-integration" as const;
export const LOCAL_BITCOIN_RPC_PASSWORD = "ic-btc-integration" as const;
export const LOCAL_ANVIL_RPC_URL = "http://127.0.0.1:8545" as const;
export const LOCAL_ANVIL_FIRST_ACCOUNT =
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as const;

const BITCOIN_WALLET = "neutron";
const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../../..");
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const SERVICE_OWNER_SCHEMA = 1;
const MAX_OWNER_BYTES = 8 * 1024;
const MAX_PID_BYTES = 128;
const execFile = promisify(execFileCallback);
const bitcoinToolResolutions = new WeakMap<
  LocalCommandRunner,
  Promise<{ bitcoind: string; cli: string }>
>();

export type LocalChainServicePaths = {
  root: string;
  bitcoinRoot: string;
  bitcoinDataRoot: string;
  bitcoinPidPath: string;
  bitcoinOwnerPath: string;
  bitcoinLogPath: string;
  anvilRoot: string;
  anvilPidPath: string;
  anvilOwnerPath: string;
  anvilLogPath: string;
  anvilStatePath: string;
};

export type LocalChainServices = {
  bitcoin: {
    rpcUrl: string;
    p2pAddress: string;
    dataDirectory: string;
  };
  ethereum: {
    rpcUrl: typeof LOCAL_ANVIL_RPC_URL;
    chainId: 1;
    statePath: string;
  };
};

export type LocalCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type LocalCommandRunner = (
  command: string,
  args: readonly string[],
  allowFailure?: boolean,
) => Promise<LocalCommandResult>;

export type LocalDetachedSpawner = (input: {
  command: string;
  args: readonly string[];
  cwd: string;
  logPath: string;
}) => Promise<number>;

export type LocalProcessIdentity = (pid: number) => Promise<string | null>;

export type LocalTcpListenerProbe = (
  host: string,
  port: number,
) => Promise<boolean>;

export type EnsureLocalChainServicesOptions = {
  stateDirectory: string;
  logger?: Pick<Console, "log">;
};

export type EnsureLocalChainServicesDependencies = {
  run?: LocalCommandRunner;
  spawnDetached?: LocalDetachedSpawner;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  resolveBitcoinTools?: (
    run: LocalCommandRunner,
  ) => Promise<{ bitcoind: string; cli: string }>;
  anvilExecutable?: string;
  processIdentity?: LocalProcessIdentity;
  tcpListener?: LocalTcpListenerProbe;
};

type LocalChainServiceOwner = {
  schema: typeof SERVICE_OWNER_SCHEMA;
  service: "bitcoin" | "anvil";
  pid: number;
  processIdentity: string;
  statePath: string;
};

export function localChainServicePaths(
  stateDirectory: string,
): LocalChainServicePaths {
  const neutronDirectory = path.dirname(path.resolve(stateDirectory));
  const root = path.join(neutronDirectory, "runtime", "chains");
  const bitcoinRoot = path.join(root, "bitcoin");
  const anvilRoot = path.join(root, "anvil");
  return {
    root,
    bitcoinRoot,
    bitcoinDataRoot: path.join(bitcoinRoot, "data"),
    bitcoinPidPath: path.join(bitcoinRoot, "bitcoind.pid"),
    bitcoinOwnerPath: path.join(bitcoinRoot, "owner.json"),
    bitcoinLogPath: path.join(bitcoinRoot, "debug.log"),
    anvilRoot,
    anvilPidPath: path.join(anvilRoot, "anvil.pid"),
    anvilOwnerPath: path.join(anvilRoot, "owner.json"),
    anvilLogPath: path.join(anvilRoot, "anvil.log"),
    anvilStatePath: path.join(anvilRoot, "state.json"),
  };
}

/**
 * Start or attach to the two persistent native-chain services before PocketIC
 * creates its Bitcoin subnet. Both endpoints are loopback-only and their state
 * lives beside the provisioner's PocketIC state.
 */
export async function ensureLocalChainServices(
  options: EnsureLocalChainServicesOptions,
  dependencies: EnsureLocalChainServicesDependencies = {},
): Promise<LocalChainServices> {
  const paths = localChainServicePaths(options.stateDirectory);
  const run = dependencies.run ?? runLocalCommand;
  const fetcher = dependencies.fetcher ?? fetch;
  const sleep = dependencies.sleep ?? delay;
  const logger = options.logger ?? console;
  const processIdentity = dependencies.processIdentity ?? localProcessIdentity;
  const tcpListener = dependencies.tcpListener ?? tcpListenerPresent;
  const resolveTools =
    dependencies.resolveBitcoinTools ?? resolveLocalBitcoinTools;

  await ensurePrivateDirectory(paths.root, "local chain runtime");
  const [bitcoinTools] = await Promise.all([
    resolveTools(run),
    ensureLocalAnvil({
      paths,
      fetcher,
      sleep,
      logger,
      spawnDetached: dependencies.spawnDetached ?? spawnLocalDetached,
      anvilExecutable:
        dependencies.anvilExecutable ??
        path.join(REPOSITORY_ROOT, "node_modules", ".bin", "anvil"),
      processIdentity,
      tcpListener,
    }),
  ]);
  await ensureLocalBitcoin({
    paths,
    run,
    sleep,
    logger,
    bitcoinTools,
    processIdentity,
    tcpListener,
  });

  return {
    bitcoin: {
      rpcUrl:
        `http://${LOCAL_BITCOIN_RPC_USER}:${LOCAL_BITCOIN_RPC_PASSWORD}` +
        `@${LOCAL_BITCOIN_RPC_HOST}:${LOCAL_BITCOIN_RPC_PORT}`,
      p2pAddress: `${LOCAL_BITCOIN_RPC_HOST}:${LOCAL_BITCOIN_P2P_PORT}`,
      dataDirectory: paths.bitcoinDataRoot,
    },
    ethereum: {
      rpcUrl: LOCAL_ANVIL_RPC_URL,
      chainId: 1,
      statePath: paths.anvilStatePath,
    },
  };
}

export async function localBitcoinCli(
  stateDirectory: string,
  args: readonly string[],
  options: {
    wallet?: boolean;
    allowFailure?: boolean;
    run?: LocalCommandRunner;
    resolveBitcoinTools?: (
      run: LocalCommandRunner,
    ) => Promise<{ bitcoind: string; cli: string }>;
  } = {},
): Promise<LocalCommandResult> {
  const run = options.run ?? runLocalCommand;
  const tools = await (
    options.resolveBitcoinTools ?? resolveLocalBitcoinTools
  )(run);
  const paths = localChainServicePaths(stateDirectory);
  return run(
    tools.cli,
    [
      `-datadir=${paths.bitcoinDataRoot}`,
      "-regtest",
      `-rpcuser=${LOCAL_BITCOIN_RPC_USER}`,
      `-rpcpassword=${LOCAL_BITCOIN_RPC_PASSWORD}`,
      `-rpcconnect=${LOCAL_BITCOIN_RPC_HOST}`,
      `-rpcport=${LOCAL_BITCOIN_RPC_PORT}`,
      ...(options.wallet ? [`-rpcwallet=${BITCOIN_WALLET}`] : []),
      ...args,
    ],
    options.allowFailure ?? false,
  );
}

export async function ensureLocalBitcoinSpendableBalance(
  stateDirectory: string,
  minimumBtc = 100,
): Promise<void> {
  const balance = Number(
    (
      await localBitcoinCli(stateDirectory, ["getbalance"], { wallet: true })
    ).stdout.trim(),
  );
  if (Number.isFinite(balance) && balance >= minimumBtc) return;
  const address = (
    await localBitcoinCli(stateDirectory, ["getnewaddress"], { wallet: true })
  ).stdout.trim();
  await localBitcoinCli(
    stateDirectory,
    ["generatetoaddress", "101", address],
    { wallet: true },
  );
}

export async function mineLocalBitcoinBlocks(
  stateDirectory: string,
  count: number,
): Promise<void> {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error("Bitcoin block count must be a positive integer");
  }
  const address = (
    await localBitcoinCli(stateDirectory, ["getnewaddress"], { wallet: true })
  ).stdout.trim();
  await localBitcoinCli(
    stateDirectory,
    ["generatetoaddress", String(count), address],
    { wallet: true },
  );
}

async function ensureLocalBitcoin({
  paths,
  run,
  sleep,
  logger,
  bitcoinTools,
  processIdentity,
  tcpListener,
}: {
  paths: LocalChainServicePaths;
  run: LocalCommandRunner;
  sleep: (milliseconds: number) => Promise<void>;
  logger: Pick<Console, "log">;
  bitcoinTools: { bitcoind: string; cli: string };
  processIdentity: LocalProcessIdentity;
  tcpListener: LocalTcpListenerProbe;
}): Promise<void> {
  await ensurePrivateDirectory(paths.bitcoinRoot, "Bitcoin runtime");
  await ensurePrivateDirectory(paths.bitcoinDataRoot, "Bitcoin data");
  const probe = () =>
    bitcoinCliWithTools(paths, bitcoinTools.cli, ["getblockchaininfo"], {
      run,
      allowFailure: true,
    });
  let status = await probe();
  if (status.exitCode === 0) {
    await assertOwnedChainService({
      service: "bitcoin",
      statePath: paths.bitcoinDataRoot,
      pidPath: paths.bitcoinPidPath,
      ownerPath: paths.bitcoinOwnerPath,
      processIdentity,
    });
  } else {
    if (await tcpListener(LOCAL_BITCOIN_RPC_HOST, LOCAL_BITCOIN_RPC_PORT)) {
      throw new Error(
        `Port ${LOCAL_BITCOIN_RPC_PORT} has a Bitcoin listener which is not usable by this provisioner`,
      );
    }
    await assertNoLiveRecordedOwner({
      service: "bitcoin",
      statePath: paths.bitcoinDataRoot,
      ownerPath: paths.bitcoinOwnerPath,
      processIdentity,
    });
    await assertSafeOptionalRegularFile(paths.bitcoinPidPath, "Bitcoin PID file");
    await rm(paths.bitcoinPidPath, { force: true });
    logger.log("Starting persistent Bitcoin Core regtest");
    await run(bitcoinTools.bitcoind, [
      `-datadir=${paths.bitcoinDataRoot}`,
      "-regtest",
      "-server=1",
      "-daemonwait=1",
      "-listen=1",
      "-discover=0",
      "-dnsseed=0",
      `-rpcbind=${LOCAL_BITCOIN_RPC_HOST}`,
      `-rpcallowip=${LOCAL_BITCOIN_RPC_HOST}`,
      `-rpcport=${LOCAL_BITCOIN_RPC_PORT}`,
      `-port=${LOCAL_BITCOIN_P2P_PORT}`,
      `-bind=${LOCAL_BITCOIN_RPC_HOST}:${LOCAL_BITCOIN_P2P_PORT}`,
      `-rpcuser=${LOCAL_BITCOIN_RPC_USER}`,
      `-rpcpassword=${LOCAL_BITCOIN_RPC_PASSWORD}`,
      "-fallbackfee=0.00001",
      "-txindex=1",
      `-pid=${paths.bitcoinPidPath}`,
      `-debuglogfile=${paths.bitcoinLogPath}`,
    ]);
    const pid = await waitForPidFile(paths.bitcoinPidPath, sleep, "Bitcoin Core");
    const identity = await waitForProcessIdentity(
      pid,
      processIdentity,
      sleep,
      "Bitcoin Core",
    );
    await writeServiceOwner(paths.bitcoinOwnerPath, {
      schema: SERVICE_OWNER_SCHEMA,
      service: "bitcoin",
      pid,
      processIdentity: identity,
      statePath: path.resolve(paths.bitcoinDataRoot),
    });
    await waitFor(async () => (await probe()).exitCode === 0, "Bitcoin Core", sleep);
    status = await probe();
    await assertOwnedChainService({
      service: "bitcoin",
      statePath: paths.bitcoinDataRoot,
      pidPath: paths.bitcoinPidPath,
      ownerPath: paths.bitcoinOwnerPath,
      processIdentity,
    });
  }
  const info = parseJsonRecord(status.stdout, "Bitcoin Core blockchain info");
  if (info.chain !== "regtest") {
    throw new Error(`Bitcoin RPC is serving ${String(info.chain)}, expected regtest`);
  }
  await ensureBitcoinWallet(paths, bitcoinTools.cli, run);
}

async function ensureBitcoinWallet(
  paths: LocalChainServicePaths,
  cli: string,
  run: LocalCommandRunner,
): Promise<void> {
  const walletInfo = await bitcoinCliWithTools(
    paths,
    cli,
    ["getwalletinfo"],
    { run, wallet: true, allowFailure: true },
  );
  if (walletInfo.exitCode === 0) return;

  const created = await bitcoinCliWithTools(
    paths,
    cli,
    ["createwallet", BITCOIN_WALLET],
    { run, allowFailure: true },
  );
  if (created.exitCode === 0) return;
  const loaded = await bitcoinCliWithTools(
    paths,
    cli,
    ["loadwallet", BITCOIN_WALLET],
    { run, allowFailure: true },
  );
  if (loaded.exitCode !== 0 && !/already loaded/i.test(loaded.stderr)) {
    throw new Error(
      `Could not create or load the Bitcoin regtest wallet: ${created.stderr || loaded.stderr}`,
    );
  }
}

async function bitcoinCliWithTools(
  paths: LocalChainServicePaths,
  cli: string,
  args: readonly string[],
  options: {
    run: LocalCommandRunner;
    wallet?: boolean;
    allowFailure?: boolean;
  },
): Promise<LocalCommandResult> {
  return options.run(
    cli,
    [
      `-datadir=${paths.bitcoinDataRoot}`,
      "-regtest",
      `-rpcuser=${LOCAL_BITCOIN_RPC_USER}`,
      `-rpcpassword=${LOCAL_BITCOIN_RPC_PASSWORD}`,
      `-rpcconnect=${LOCAL_BITCOIN_RPC_HOST}`,
      `-rpcport=${LOCAL_BITCOIN_RPC_PORT}`,
      ...(options.wallet ? [`-rpcwallet=${BITCOIN_WALLET}`] : []),
      ...args,
    ],
    options.allowFailure ?? false,
  );
}

async function ensureLocalAnvil({
  paths,
  fetcher,
  sleep,
  logger,
  spawnDetached,
  anvilExecutable,
  processIdentity,
  tcpListener,
}: {
  paths: LocalChainServicePaths;
  fetcher: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  logger: Pick<Console, "log">;
  spawnDetached: LocalDetachedSpawner;
  anvilExecutable: string;
  processIdentity: LocalProcessIdentity;
  tcpListener: LocalTcpListenerProbe;
}): Promise<void> {
  await ensurePrivateDirectory(paths.anvilRoot, "Anvil runtime");
  await assertSafeOptionalRegularFile(paths.anvilStatePath, "Anvil state file");
  let chainId = await ethereumChainId(fetcher);
  if (chainId !== null) {
    await assertOwnedChainService({
      service: "anvil",
      statePath: paths.anvilStatePath,
      pidPath: paths.anvilPidPath,
      ownerPath: paths.anvilOwnerPath,
      processIdentity,
    });
  } else {
    if (await tcpListener("127.0.0.1", 8545)) {
      throw new Error(
        "Port 8545 has an Ethereum listener which is not usable by this provisioner",
      );
    }
    await assertNoLiveRecordedOwner({
      service: "anvil",
      statePath: paths.anvilStatePath,
      ownerPath: paths.anvilOwnerPath,
      processIdentity,
    });
    await assertSafeOptionalRegularFile(paths.anvilPidPath, "Anvil PID file");
    await access(anvilExecutable);
    logger.log("Starting persistent Foundry Anvil for ckETH");
    const pid = await spawnDetached({
      command: anvilExecutable,
      args: [
        "--host",
        "127.0.0.1",
        "--port",
        "8545",
        "--chain-id",
        "1",
        "--block-time",
        "1",
        "--mnemonic",
        "test test test test test test test test test test test junk",
        "--state",
        paths.anvilStatePath,
        "--state-interval",
        "1",
        "--quiet",
      ],
      cwd: paths.anvilRoot,
      logPath: paths.anvilLogPath,
    });
    const identity = await waitForProcessIdentity(
      pid,
      processIdentity,
      sleep,
      "Anvil",
    );
    await atomicWritePrivateText(paths.anvilPidPath, `${pid}\n`, "Anvil PID file");
    await writeServiceOwner(paths.anvilOwnerPath, {
      schema: SERVICE_OWNER_SCHEMA,
      service: "anvil",
      pid,
      processIdentity: identity,
      statePath: path.resolve(paths.anvilStatePath),
    });
    try {
      await waitFor(
        async () => (await ethereumChainId(fetcher)) === 1n,
        "Anvil",
        sleep,
      );
    } catch (error) {
      const log = await readFile(paths.anvilLogPath, "utf8").catch(() => "");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${log.slice(-2_000)}`,
      );
    }
    chainId = await ethereumChainId(fetcher);
    await assertOwnedChainService({
      service: "anvil",
      statePath: paths.anvilStatePath,
      pidPath: paths.anvilPidPath,
      ownerPath: paths.anvilOwnerPath,
      processIdentity,
    });
  }
  if (chainId !== 1n) {
    throw new Error(
      `Port 8545 is serving Ethereum chain ${chainId?.toString() ?? "unknown"}; ckETH requires chain 1`,
    );
  }
  const accounts = await ethereumAccounts(fetcher);
  if (accounts?.[0]?.toLowerCase() !== LOCAL_ANVIL_FIRST_ACCOUNT) {
    throw new Error(
      "Port 8545 is not the Neutron Anvil instance with its deterministic development identity",
    );
  }
}

async function assertOwnedChainService({
  service,
  statePath,
  pidPath,
  ownerPath,
  processIdentity,
}: {
  service: LocalChainServiceOwner["service"];
  statePath: string;
  pidPath: string;
  ownerPath: string;
  processIdentity: LocalProcessIdentity;
}): Promise<LocalChainServiceOwner> {
  const owner = await readServiceOwner(ownerPath);
  if (owner === null) {
    throw new Error(
      `${serviceLabel(service)} RPC is running without provision-owned process metadata; refusing the foreign listener`,
    );
  }
  assertServiceOwnerMatches(owner, service, statePath, ownerPath);
  const pid = await readPidFile(pidPath, `${serviceLabel(service)} PID file`);
  if (pid !== owner.pid) {
    throw new Error(
      `${serviceLabel(service)} PID file does not match its provision-owned process metadata`,
    );
  }
  const currentIdentity = await processIdentity(owner.pid);
  if (currentIdentity !== owner.processIdentity) {
    throw new Error(
      `${serviceLabel(service)} process identity does not match its provision-owned process metadata`,
    );
  }
  return owner;
}

async function assertNoLiveRecordedOwner({
  service,
  statePath,
  ownerPath,
  processIdentity,
}: {
  service: LocalChainServiceOwner["service"];
  statePath: string;
  ownerPath: string;
  processIdentity: LocalProcessIdentity;
}): Promise<void> {
  const owner = await readServiceOwner(ownerPath);
  if (owner === null) return;
  assertServiceOwnerMatches(owner, service, statePath, ownerPath);
  if ((await processIdentity(owner.pid)) === owner.processIdentity) {
    throw new Error(
      `${serviceLabel(service)} provision-owned process ${owner.pid} is alive but its RPC endpoint is unavailable`,
    );
  }
}

function assertServiceOwnerMatches(
  owner: LocalChainServiceOwner,
  service: LocalChainServiceOwner["service"],
  statePath: string,
  ownerPath: string,
): void {
  if (owner.service !== service) {
    throw new Error(`${ownerPath} belongs to ${owner.service}, expected ${service}`);
  }
  const expectedStatePath = path.resolve(statePath);
  if (owner.statePath !== expectedStatePath) {
    throw new Error(
      `${serviceLabel(service)} process metadata belongs to ${owner.statePath}, expected ${expectedStatePath}`,
    );
  }
}

async function readServiceOwner(
  filename: string,
): Promise<LocalChainServiceOwner | null> {
  let source: string;
  try {
    source = await readBoundedRegularFile(
      filename,
      MAX_OWNER_BYTES,
      "chain-service owner metadata",
      true,
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Chain-service owner metadata is invalid JSON: ${filename}`, {
      cause: error,
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Chain-service owner metadata must be an object: ${filename}`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["pid", "processIdentity", "schema", "service", "statePath"];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`Chain-service owner metadata has unknown or missing fields: ${filename}`);
  }
  if (record.schema !== SERVICE_OWNER_SCHEMA) {
    throw new Error(`Unsupported chain-service owner schema: ${filename}`);
  }
  if (record.service !== "bitcoin" && record.service !== "anvil") {
    throw new Error(`Chain-service owner has an invalid service: ${filename}`);
  }
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1) {
    throw new Error(`Chain-service owner has an invalid PID: ${filename}`);
  }
  if (
    typeof record.processIdentity !== "string" ||
    record.processIdentity.length === 0 ||
    record.processIdentity.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(record.processIdentity)
  ) {
    throw new Error(`Chain-service owner has an invalid process identity: ${filename}`);
  }
  if (
    typeof record.statePath !== "string" ||
    !path.isAbsolute(record.statePath) ||
    path.normalize(record.statePath) !== record.statePath ||
    record.statePath.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(record.statePath)
  ) {
    throw new Error(`Chain-service owner has an invalid state path: ${filename}`);
  }
  return record as LocalChainServiceOwner;
}

async function writeServiceOwner(
  filename: string,
  owner: LocalChainServiceOwner,
): Promise<void> {
  assertServiceOwnerMatches(owner, owner.service, owner.statePath, filename);
  if (
    owner.schema !== SERVICE_OWNER_SCHEMA ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1 ||
    owner.processIdentity.length === 0
  ) {
    throw new Error(`Refusing invalid chain-service owner metadata for ${filename}`);
  }
  await atomicWritePrivateText(
    filename,
    `${JSON.stringify(owner)}\n`,
    "chain-service owner metadata",
  );
}

async function readPidFile(filename: string, label: string): Promise<number> {
  const source = await readBoundedRegularFile(filename, MAX_PID_BYTES, label, false);
  const match = source.match(/^([1-9][0-9]*)\n?$/u);
  if (match === null) throw new Error(`${label} is malformed: ${filename}`);
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid)) throw new Error(`${label} has an invalid PID`);
  return pid;
}

async function waitForPidFile(
  filename: string,
  sleep: (milliseconds: number) => Promise<void>,
  label: string,
): Promise<number> {
  const deadline = Date.now() + DEFAULT_READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await readPidFile(filename, `${label} PID file`);
    } catch (error) {
      lastError = error;
      await sleep(20);
    }
  }
  throw new Error(`${label} did not publish a valid PID file`, { cause: lastError });
}

async function waitForProcessIdentity(
  pid: number,
  processIdentity: LocalProcessIdentity,
  sleep: (milliseconds: number) => Promise<void>,
  label: string,
): Promise<string> {
  const deadline = Date.now() + DEFAULT_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const identity = await processIdentity(pid);
    if (identity !== null) return identity;
    await sleep(20);
  }
  throw new Error(`${label} process ${pid} exited before ownership was recorded`);
}

export async function localProcessIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (process.platform === "linux") {
    let source: string;
    try {
      source = await readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    const commandEnd = source.lastIndexOf(")");
    if (commandEnd < 0) {
      throw new Error(`Unable to parse chain-service process identity for PID ${pid}`);
    }
    const fields = source.slice(commandEnd + 2).trim().split(/\s+/u);
    const startTime = fields[19];
    if (startTime === undefined || !/^\d+$/u.test(startTime)) {
      throw new Error(`Unable to parse chain-service process start time for PID ${pid}`);
    }
    return `linux:${pid}:${startTime}`;
  }
  if (process.platform === "darwin") {
    try {
      const result = await execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        maxBuffer: 4096,
      });
      const startedAt = result.stdout.trim().replace(/\s+/gu, " ");
      return startedAt.length === 0 ? null : `darwin:${pid}:${startedAt}`;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 1 || code === "ESRCH") return null;
      throw error;
    }
  }
  throw new Error(`Chain-service process identity is unsupported on ${process.platform}`);
}

export function tcpListenerPresent(
  host: string,
  port: number,
): Promise<boolean> {
  if (
    (host !== "127.0.0.1" && host !== "localhost") ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("Chain-service listener probe requires a loopback TCP port");
  }
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function ensurePrivateDirectory(directory: string, label: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${directory}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`${label} is not owned by the current user: ${directory}`);
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group/world-writable: ${directory}`);
  }
}

async function assertSafeOptionalRegularFile(
  filename: string,
  label: string,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a real file: ${filename}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`${label} is not owned by the current user: ${filename}`);
  }
}

async function readBoundedRegularFile(
  filename: string,
  maxBytes: number,
  label: string,
  privateFile: boolean,
): Promise<string> {
  const handle = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) {
      throw new Error(`${label} is not a bounded regular file: ${filename}`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined && metadata.uid !== uid) {
      throw new Error(`${label} is not owned by the current user: ${filename}`);
    }
    if (privateFile && (metadata.mode & 0o077) !== 0) {
      throw new Error(`${label} must have mode 0600 or stricter: ${filename}`);
    }
    return (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function atomicWritePrivateText(
  filename: string,
  source: string,
  label: string,
): Promise<void> {
  await assertSafeOptionalRegularFile(filename, label);
  const temporary = `${filename}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(source);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function serviceLabel(service: LocalChainServiceOwner["service"]): string {
  return service === "bitcoin" ? "Bitcoin Core" : "Anvil";
}

export async function ethereumChainId(
  fetcher: typeof fetch = fetch,
): Promise<bigint | null> {
  try {
    const response = await fetcher(LOCAL_ANVIL_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { result?: unknown };
    return typeof body.result === "string" ? BigInt(body.result) : null;
  } catch {
    return null;
  }
}

export async function ethereumAccounts(
  fetcher: typeof fetch = fetch,
): Promise<string[] | null> {
  try {
    const response = await fetcher(LOCAL_ANVIL_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_accounts",
        params: [],
      }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { result?: unknown };
    if (
      !Array.isArray(body.result) ||
      !body.result.every((value) => typeof value === "string")
    ) {
      return null;
    }
    return body.result as string[];
  } catch {
    return null;
  }
}

export async function resolveLocalBitcoinTools(
  run: LocalCommandRunner = runLocalCommand,
): Promise<{ bitcoind: string; cli: string }> {
  const existing = bitcoinToolResolutions.get(run);
  if (existing !== undefined) return existing;
  const resolution = resolveLocalBitcoinToolsUncached(run);
  bitcoinToolResolutions.set(run, resolution);
  try {
    return await resolution;
  } catch (error) {
    bitcoinToolResolutions.delete(run);
    throw error;
  }
}

async function resolveLocalBitcoinToolsUncached(
  run: LocalCommandRunner,
): Promise<{ bitcoind: string; cli: string }> {
  const [daemon, cli] = await Promise.all([
    run("bitcoind", ["--version"], true),
    run("bitcoin-cli", ["--version"], true),
  ]);
  if (daemon.exitCode === 0 && cli.exitCode === 0) {
    return { bitcoind: "bitcoind", cli: "bitcoin-cli" };
  }

  const resolved = await run(
    "nix",
    [
      "develop",
      REPOSITORY_ROOT,
      "--command",
      "sh",
      "-c",
      'printf "bitcoind=%s\\nbitcoin-cli=%s\\n" "$(command -v bitcoind)" "$(command -v bitcoin-cli)"',
    ],
    true,
  );
  const bitcoind = resolved.stdout.match(/^bitcoind=(.+)$/m)?.[1]?.trim();
  const bitcoinCli = resolved.stdout.match(/^bitcoin-cli=(.+)$/m)?.[1]?.trim();
  if (resolved.exitCode !== 0 || !bitcoind || !bitcoinCli) {
    throw new Error(
      "Bitcoin Core is required by the Neutron PocketIC profile. Install bitcoind or enter `nix develop`.",
    );
  }
  return { bitcoind, cli: bitcoinCli };
}

export async function runLocalCommand(
  command: string,
  args: readonly string[],
  allowFailure = false,
): Promise<LocalCommandResult> {
  try {
    const result = await execFile(command, [...args], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 60_000,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const caught = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
      message?: string;
    };
    const result = {
      stdout: caught.stdout ?? "",
      stderr: caught.stderr ?? caught.message ?? "",
      exitCode: typeof caught.code === "number" ? caught.code : 1,
    };
    if (!allowFailure) {
      throw new Error(
        `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
      );
    }
    return result;
  }
}

export async function spawnLocalDetached({
  command,
  args,
  cwd,
  logPath,
}: Parameters<LocalDetachedSpawner>[0]): Promise<number> {
  const log = await open(logPath, "a", 0o600);
  try {
    const child = spawn(command, [...args], {
      cwd,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    if (child.pid === undefined) {
      throw new Error(`Failed to start ${command}`);
    }
    child.unref();
    return child.pid;
  } finally {
    await log.close();
  }
}

async function waitFor(
  check: () => Promise<boolean>,
  label: string,
  sleep: (milliseconds: number) => Promise<void>,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs / 1_000}s`);
}

function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} was not valid JSON`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} was not a JSON record`);
  }
  return parsed as Record<string, unknown>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
