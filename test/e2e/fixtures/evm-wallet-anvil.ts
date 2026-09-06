import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/**
 * Dedicated, persistent, unforked Anvil execution fixture for chain 42161.
 * It does not qualify Nitro posting fees, sequencing or L1 finality. The normal
 * provisioner owns Ethereum8545; this helper only ever uses loopback8546.
 *
 * From the repository root (Bun, Linux x64):
 *   bun test/e2e/fixtures/evm-wallet-anvil.ts start
 *   bun test/e2e/fixtures/evm-wallet-anvil.ts status
 *   bun test/e2e/fixtures/evm-wallet-anvil.ts stop
 *
 * Importing this module performs no filesystem, process or RPC actions. Start
 * reattaches to a verified task owner, or restores the existing state file.
 * Stop sends SIGTERM only to the verified owner and retains all fixture data.
 */
export const EVM_ARBITRUM_FIXTURE_RPC_URL = "http://127.0.0.1:8546" as const;
export const EVM_ARBITRUM_FIXTURE_BINARY_SHA256 = "10c1c727d6c1de973aeb160e59875b9a9a23464d6e74149ee8abb30b3500311b";
const OWNER_SCHEMA = "neutron-evm-qualification-chain-owner-v1";
const DEFAULT_REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCOPE = "Independent unforked EVM execution fixture with chain ID42161; does not qualify Nitro parent data fees, sequencing or L1 finality.";
const MNEMONIC = "test test test test test test test test test test test junk";

export type EvmAnvilFixtureOptions = { repositoryRoot?: string };
export type EvmAnvilFixtureOwner = {
  schema: typeof OWNER_SCHEMA;
  pid: number;
  processIdentity: string;
  startedAt: number;
  binary: string;
  binarySha256: typeof EVM_ARBITRUM_FIXTURE_BINARY_SHA256;
  rpcUrl: typeof EVM_ARBITRUM_FIXTURE_RPC_URL;
  chainId: "42161";
  statePath: string;
  scope: string;
};
export type EvmAnvilFixtureStatus = {
  readyAt: number;
  owner: EvmAnvilFixtureOwner;
  chainId: "0xa4b1";
  clientVersion: string;
  nodeInfo: Record<string, unknown>;
};
export function evmAnvilFixturePaths(options: EvmAnvilFixtureOptions = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT);
  const root = path.join(repositoryRoot, ".neutron/evm-wallet-qualification/arbitrum-chain-fixture");
  return {
    repositoryRoot, root,
    binary: path.join(repositoryRoot, "node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil"),
    state: path.join(root, "state.json"), log: path.join(root, "anvil.log"),
    owner: path.join(root, "owner.json"), ready: path.join(root, "ready.json"),
    stopped: path.join(root, "stopped.json"), lock: path.join(root, "lifecycle.lock"),
  };
}
type Paths = ReturnType<typeof evmAnvilFixturePaths>;

/** Pure validation; also accepts the initial Python fixture owner's v1 shape. */
export function parseEvmAnvilFixtureOwner(value: unknown, options: EvmAnvilFixtureOptions = {}): EvmAnvilFixtureOwner {
  const paths = evmAnvilFixturePaths(options);
  if (!value || typeof value !== "object") throw new Error("Invalid task Anvil owner");
  const owner = value as Partial<EvmAnvilFixtureOwner>;
  if (owner.schema !== OWNER_SCHEMA || !Number.isSafeInteger(owner.pid) || owner.pid! <= 1 ||
    typeof owner.processIdentity !== "string" || new RegExp(`^linux:${owner.pid}:[0-9]+`, "u").exec(owner.processIdentity)?.[0] !== owner.processIdentity ||
    typeof owner.startedAt !== "number" || !Number.isFinite(owner.startedAt) || owner.startedAt <= 0 ||
    owner.binary !== paths.binary || owner.binarySha256 !== EVM_ARBITRUM_FIXTURE_BINARY_SHA256 ||
    owner.rpcUrl !== EVM_ARBITRUM_FIXTURE_RPC_URL || owner.chainId !== "42161" ||
    owner.statePath !== paths.state || typeof owner.scope !== "string" || !owner.scope) {
    throw new Error("Anvil owner does not match the pinned task fixture");
  }
  return owner as EvmAnvilFixtureOwner;
}

/** Exact launch arguments exclude forks, external bindings and other state. */
export function evmAnvilFixtureArgs(options: EvmAnvilFixtureOptions = {}): string[] {
  return ["--host", "127.0.0.1", "--port", "8546", "--chain-id", "42161",
    "--block-time", "1", "--mnemonic", MNEMONIC, "--state", evmAnvilFixturePaths(options).state,
    "--state-interval", "1", "--quiet"];
}

export function validateEvmAnvilFixtureNode(chainId: unknown, clientVersion: unknown, nodeInfo: unknown): asserts nodeInfo is Record<string, unknown> {
  if (chainId !== "0xa4b1" || typeof clientVersion !== "string" || !/^anvil\b/iu.test(clientVersion) ||
    !nodeInfo || typeof nodeInfo !== "object" || Array.isArray(nodeInfo)) {
    throw new Error("Task fixture is not Anvil chain42161");
  }
  const node = nodeInfo as Record<string, unknown>;
  if (node.chainId !== undefined && node.chainId !== 42161 && node.chainId !== "0xa4b1") {
    throw new Error("Anvil nodeInfo reports an unexpected chain");
  }
  if (node.environment !== undefined && (!node.environment || typeof node.environment !== "object" ||
    (node.environment as Record<string, unknown>).chainId !== 42161)) {
    throw new Error("Anvil environment reports an unexpected chain");
  }
  const fork = node.forkConfig;
  if (fork !== undefined && fork !== null) {
    if (typeof fork !== "object" || Array.isArray(fork)) throw new Error("Invalid Anvil fork configuration");
    const config = fork as Record<string, unknown>;
    if (config.forkUrl != null || config.forkBlockNumber != null || config.forkChainId != null) {
      throw new Error("Task fixture must be unforked");
    }
  }
}

/** Read-only: verifies process, executable, exact arguments, socket and RPC. */
export async function inspectEvmAnvilFixture(options: EvmAnvilFixtureOptions = {}): Promise<EvmAnvilFixtureStatus> {
  const paths = evmAnvilFixturePaths(options);
  await verifyPaths(paths);
  const owner = await readOwner(paths, options);
  if (!owner) throw new Error("No task Anvil owner is recorded");
  await verifyOwnerProcess(owner, options);
  await verifyOwnedListener(owner, true);
  const [chainId, clientVersion, nodeInfo] = await Promise.all([
    rpc("eth_chainId"), rpc("web3_clientVersion"), rpc("anvil_nodeInfo"),
  ]);
  validateEvmAnvilFixtureNode(chainId, clientVersion, nodeInfo);
  await verifyOwnerProcess(owner, options);
  return { readyAt: Date.now() / 1000, owner, chainId: "0xa4b1", clientVersion: clientVersion as string, nodeInfo };
}

/** Explicit lifecycle mutation. Existing state is never deleted or reset. */
export async function startEvmAnvilFixture(options: EvmAnvilFixtureOptions = {}): Promise<EvmAnvilFixtureStatus> {
  const paths = evmAnvilFixturePaths(options);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await verifyPaths(paths);
  return withLifecycleLock(paths, async () => {
    const existing = await readOwner(paths, options);
    const listeners = await fixtureListeners();
    if (listeners.length) {
      if (!existing) throw new Error("Port8546 is occupied without the task owner; no process was changed");
      return inspectEvmAnvilFixture(options);
    }
    if (existing && await processIdentity(existing.pid) === existing.processIdentity) {
      throw new Error("Task Anvil owner is still live without ready RPC; refusing a duplicate");
    }
    for (const file of [paths.state, paths.log]) await assertRegularFile(file, true);
    if (existing) await writeJson(path.join(paths.root, `owner-retired-${Date.now()}-${randomBytes(4).toString("hex")}.json`), existing);
    const log = await open(paths.log, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    let pid: number;
    try {
      const child = spawn(paths.binary, evmAnvilFixtureArgs(options), {
        cwd: paths.root, detached: true, stdio: ["ignore", log.fd, log.fd],
      });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      if (!child.pid) throw new Error("Anvil did not report its PID");
      pid = child.pid;
      child.unref();
    } finally { await log.close(); }
    const identity = await processIdentity(pid);
    if (!identity) throw new Error("Task Anvil exited before ownership could be recorded");
    const owner: EvmAnvilFixtureOwner = {
      schema: OWNER_SCHEMA, pid, processIdentity: identity, startedAt: Date.now() / 1000,
      binary: paths.binary, binarySha256: EVM_ARBITRUM_FIXTURE_BINARY_SHA256,
      rpcUrl: EVM_ARBITRUM_FIXTURE_RPC_URL, chainId: "42161", statePath: paths.state, scope: SCOPE,
    };
    try { await writeJson(paths.owner, owner); }
    catch (error) {
      // If ownership cannot be made durable, stop only the child just spawned
      // here, after checking its identity, executable and exact launch args.
      await verifyOwnerProcess(owner, options);
      process.kill(owner.pid, "SIGTERM");
      throw error;
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await verifyOwnerProcess(owner, options);
      if ((await fixtureListeners()).length) {
        const status = await inspectEvmAnvilFixture(options);
        await writeJson(paths.ready, status);
        return status;
      }
      await delay(100);
    }
    throw new Error("Owned task Anvil did not become ready; ownership and state retained for inspection");
  });
}

/** SIGTERM only; retains owner, state and logs. Never signals unrelated PIDs. */
export async function stopEvmAnvilFixture(options: EvmAnvilFixtureOptions = {}): Promise<{ stoppedAt: number; owner: EvmAnvilFixtureOwner }> {
  const paths = evmAnvilFixturePaths(options);
  await verifyPaths(paths);
  return withLifecycleLock(paths, async () => {
    const owner = await readOwner(paths, options);
    if (!owner) throw new Error("No task Anvil owner is recorded; no process was signaled");
    const identity = await processIdentity(owner.pid);
    if (identity !== null) {
      await verifyOwnerProcess(owner, options);
      await verifyOwnedListener(owner, false);
      // Recheck immediately before the signal, including PID start time.
      if (await processIdentity(owner.pid) !== owner.processIdentity) throw new Error("Task owner changed before SIGTERM");
      process.kill(owner.pid, "SIGTERM");
      const deadline = Date.now() + 20_000;
      while (await processIdentity(owner.pid) === owner.processIdentity && Date.now() < deadline) await delay(100);
      if (await processIdentity(owner.pid) === owner.processIdentity) throw new Error("Owned Anvil did not stop; no stronger signal was sent");
    }
    if ((await fixtureListeners()).length) throw new Error("Port8546 remains occupied; no unrelated process was signaled");
    const result = { stoppedAt: Date.now() / 1000, owner };
    await writeJson(paths.stopped, result);
    return result;
  });
}

async function verifyPaths(paths: Paths): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Pinned Anvil fixture requires Linux x64");
  if (await realpath(paths.root) !== paths.root || await realpath(paths.repositoryRoot) !== paths.repositoryRoot) {
    throw new Error("Task fixture directory must not redirect through symlinks");
  }
  await assertRegularFile(paths.binary, false);
  if (createHash("sha256").update(await readFile(paths.binary)).digest("hex") !== EVM_ARBITRUM_FIXTURE_BINARY_SHA256) {
    throw new Error("Task Anvil binary does not match the pinned installed executable");
  }
  for (const file of [paths.owner, paths.state, paths.log, paths.ready, paths.stopped]) await assertRegularFile(file, true);
}
async function readOwner(paths: Paths, options: EvmAnvilFixtureOptions): Promise<EvmAnvilFixtureOwner | null> {
  try { return parseEvmAnvilFixtureOwner(JSON.parse(await readFile(paths.owner, "utf8")), options); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}
async function processIdentity(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return null;
    if (!fields[19] || !/^[0-9]+$/u.test(fields[19])) throw new Error("Invalid Linux process start time");
    return `linux:${pid}:${fields[19]}`;
  } catch (error) { if (isMissing(error)) return null; throw error; }
}
async function verifyOwnerProcess(owner: EvmAnvilFixtureOwner, options: EvmAnvilFixtureOptions): Promise<void> {
  if (await processIdentity(owner.pid) !== owner.processIdentity) throw new Error("Task Anvil process identity mismatch");
  if (await realpath(`/proc/${owner.pid}/exe`) !== await realpath(owner.binary)) throw new Error("Task Anvil executable changed");
  const args = (await readFile(`/proc/${owner.pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
  if (JSON.stringify(args) !== JSON.stringify([owner.binary, ...evmAnvilFixtureArgs(options)])) {
    throw new Error("Task Anvil launch arguments differ from the pinned unforked fixture");
  }
}
async function fixtureListeners(): Promise<Array<{ address: string; inode: string }>> {
  const result: Array<{ address: string; inode: string }> = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const lines = (await readFile(file, "utf8")).trim().split("\n").slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/u);
      if (fields[3] === "0A" && fields[1]?.endsWith(":2162")) result.push({ address: fields[1], inode: fields[9]! });
    }
  }
  return result;
}
async function verifyOwnedListener(owner: EvmAnvilFixtureOwner, required: boolean): Promise<void> {
  const listeners = await fixtureListeners();
  if (!listeners.length && !required) return;
  if (listeners.length !== 1 || listeners[0]!.address !== "0100007F:2162") throw new Error("Task Anvil port is not exclusively bound to IPv4 loopback");
  const expected = `socket:[${listeners[0]!.inode}]`;
  const descriptors = await readdir(`/proc/${owner.pid}/fd`);
  const targets = await Promise.all(descriptors.map(async fd => {
    try { return await readlink(`/proc/${owner.pid}/fd/${fd}`); }
    catch (error) { if (isMissing(error)) return null; throw error; }
  }));
  if (!targets.includes(expected)) throw new Error("Port8546 listener does not belong to the task owner");
}
async function rpc(method: string): Promise<unknown> {
  const response = await fetch(EVM_ARBITRUM_FIXTURE_RPC_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    redirect: "error", signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Task Anvil RPC inspection failed");
  const value = await response.json() as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
  if (value.jsonrpc !== "2.0" || value.id !== 1 || value.error !== undefined || !("result" in value)) throw new Error("Invalid task Anvil RPC response");
  return value.result;
}
async function assertRegularFile(file: string, optional: boolean): Promise<void> {
  try { const stat = await lstat(file); if (!stat.isFile() || stat.nlink !== 1) throw new Error("Task fixture path is not a private regular file"); }
  catch (error) { if (optional && isMissing(error)) return; throw error; }
}
async function writeJson(file: string, value: unknown): Promise<void> {
  await assertRegularFile(file, true);
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
}
async function withLifecycleLock<T>(paths: Paths, work: () => Promise<T>): Promise<T> {
  const identity = await processIdentity(process.pid);
  if (!identity) throw new Error("Cannot determine fixture supervisor identity");
  const token = randomBytes(16).toString("hex");
  let handle;
  try { handle = await open(paths.lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Task Anvil lifecycle lock exists; inspect its owner before retrying");
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, processIdentity: identity, token })}\n`);
    await handle.close();
    return await work();
  } finally {
    await handle.close();
    const lock = JSON.parse(await readFile(paths.lock, "utf8")) as { token?: unknown };
    if (lock.token !== token) throw new Error("Task lifecycle lock changed; preserving it for inspection");
    await unlink(paths.lock);
  }
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

if (import.meta.main) {
  const action = process.argv[2];
  if (process.argv.length !== 3 || !["start", "status", "stop"].includes(action ?? "")) {
    throw new Error("Usage: bun test/e2e/fixtures/evm-wallet-anvil.ts start|status|stop");
  }
  const result = action === "start" ? await startEvmAnvilFixture()
    : action === "stop" ? await stopEvmAnvilFixture() : await inspectEvmAnvilFixture();
  console.log(JSON.stringify(result, null, 2));
}
