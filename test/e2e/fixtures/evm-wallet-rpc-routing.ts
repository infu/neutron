import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { Actor, HttpAgent, type ActorMethod } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { keccak256 } from "ethers";

/**
 * Opt-in local qualification plumbing. Importing this file has no side effects.
 * No canister is reinstalled, no stable memory is written through PocketIC, and
 * no provider request can be forwarded outside the two explicit loopback nodes.
 *
 * Official evm_rpc-v2.8.0, commit 1f81042160863749455fcd78a69e9b55ae327454:
 * src/main.rs:405 post_upgrade changes only fields supplied as Some.
 * src/memory.rs:18-46 keeps API keys/config in stable memories 4-9; upgrades
 * reset the explicitly unstable metrics, request counter and provider ranking.
 * There is no override setter/getter. The supported update is a same-WASM
 * upgrade with only overrideProvider supplied. Restoration does the same.
 */
const CANISTER_ID = "7hfb6-caaaa-aaaar-qadga-cai";
const ARCHIVE_SHA256 = "455fcea61d679848761848db2d99ebb9b66a7cf060de350a4fdc5c680e5292c6";
const MODULE_SHA256 = "43c227300468dca111b676761f58afb065b064d14c18d439adfcb513be3400b2";
const ETHEREUM_RPC = "http://127.0.0.1:8545/";
// This is an explicit chain-42161 Anvil fixture, not a Nitro rollup simulation.
const ARBITRUM_RPC = "http://127.0.0.1:8546/";
const WASM_PAGE_BYTES = 65_536;

export type EvmRpcOverride = { pattern: string; replacement: string } | null;
export type LocalEvmRpcRoutingOptions = {
  gatewayUrl: string;
  expectedRootKeyBase64: string;
  controlUrl: string;
  instanceId: number;
  archivePath: string;
};
export type EvmRpcStableSnapshot = {
  override: EvmRpcOverride;
  stableBytes: number;
  roots: Record<string, { pages: number; sha256: string }>;
};
export type EvmRpcRoutingBaseline = EvmRpcStableSnapshot & {
  canisterId: typeof CANISTER_ID;
  /** Hash of the decompressed official executable. */
  moduleSha256: string;
  /** IC status hashes the installed input, including gzip when supplied. */
  installedModuleSha256: string;
  controller: string;
  nodesInSubnet: number;
  providerTableSha256: string;
};
export type EvmRpcBroadcastReplyLoss = {
  chainId: "1" | "42161";
  armedAt: string;
  releasedAt: string | null;
  raw: string | null;
  transactionHash: string | null;
  acceptedAt: string | null;
  matchingRequests: number;
  suppressedResponses: number;
  deliveredResponses: number;
  observedRawTransactions: string[];
};
type Provider = {
  providerId: bigint;
  chainId: bigint;
  access:
    | { Unauthenticated: { publicUrl: string } }
    | { Authenticated: { publicUrl: [] | [string]; auth:
      | { BearerToken: { url: string } }
      | { UrlParameter: { urlPattern: string } } } };
};
type ProviderActor = {
  getProviders: ActorMethod<[], Provider[]>;
  getNodesInSubnet: ActorMethod<[], number>;
};
type ManagementActor = {
  canister_status: ActorMethod<[{ canister_id: Principal }], {
    status: { running: null } | { stopped: null } | { stopping: null };
    settings: { controllers: Principal[] };
    module_hash: [] | [Uint8Array];
  }>;
  install_code: ActorMethod<[{
    mode: { upgrade: [] };
    canister_id: Principal;
    wasm_module: Uint8Array;
    arg: Uint8Array;
    sender_canister_version: [];
  }], undefined>;
  stored_chunks: ActorMethod<[{ canister_id: Principal }], Array<{ hash: Uint8Array }>>;
  upload_chunk: ActorMethod<[{ canister_id: Principal; chunk: Uint8Array }], { hash: Uint8Array }>;
  clear_chunk_store: ActorMethod<[{ canister_id: Principal }], undefined>;
  install_chunked_code: ActorMethod<[{
    mode: { upgrade: [] }; target_canister: Principal; store_canister: [];
    chunk_hashes_list: Array<{ hash: Uint8Array }>; wasm_module_hash: Uint8Array;
    arg: Uint8Array; sender_canister_version: [];
  }], undefined>;
};

// Exact hosts in v2.8.0 src/providers.rs. Ankr shares a hostname across chains,
// so its first path segment is part of its identity. Sepolia, Base, Optimism,
// custom providers, malformed routes and unknown hosts have no fallback.
const ETHEREUM_HOSTS = new Set([
  "cloudflare-eth.com", "ethereum-rpc.publicnode.com",
  "ethereum.blockpi.network", "ethereum.public.blockpi.network",
  "eth-mainnet.g.alchemy.com", "eth.llamarpc.com",
]);
const ARBITRUM_HOSTS = new Set([
  "arb-mainnet.g.alchemy.com", "arbitrum.blockpi.network",
  "arbitrum.public.blockpi.network", "arbitrum-one-rpc.publicnode.com",
  "arbitrum.llamarpc.com",
]);

export function providerChainFromOriginalUrl(value: string): "1" | "42161" | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (url.hostname === "rpc.ankr.com") {
    const segment = url.pathname.split("/")[1];
    return segment === "eth" ? "1" : segment === "arbitrum" ? "42161" : null;
  }
  if (ETHEREUM_HOSTS.has(url.hostname)) return "1";
  if (ARBITRUM_HOSTS.has(url.hostname)) return "42161";
  return null;
}

/**
 * Rust-regex substitution strips query strings, auth headers (by EVM RPC), and
 * credential path suffixes. Only a provider hostname and Ankr chain segment
 * reach the local proxy. The final catch-all keeps unknown/custom URLs local
 * too, where they fail explicitly instead of contacting an external provider.
 */
export function routingOverride(proxyPort: number): Exclude<EvmRpcOverride, null> {
  assertPort(proxyPort);
  return {
    pattern: "(?s)^(?:https://(?:(rpc\\.ankr\\.com)/(eth|arbitrum)(?:/[^?#]*)?|([^/?#:@]+)(?:/[^?#]*)?)(?:\\?[^#]*)?(?:#.*)?|.*)$",
    replacement: `http://localhost:${proxyPort}/provider/\${1}\${3}/\${2}`,
  };
}

export function encodeEvmRpcOverrideUpgradeArgs(override: EvmRpcOverride): Uint8Array {
  const substitution = IDL.Record({ pattern: IDL.Text, replacement: IDL.Text });
  const installArgs = IDL.Record({
    demo: IDL.Opt(IDL.Bool),
    manageApiKeys: IDL.Opt(IDL.Vec(IDL.Principal)),
    logFilter: IDL.Opt(IDL.Variant({
      ShowAll: IDL.Null, HideAll: IDL.Null, ShowPattern: IDL.Text, HidePattern: IDL.Text,
    })),
    overrideProvider: IDL.Opt(IDL.Record({ overrideUrl: IDL.Opt(substitution) })),
    nodesInSubnet: IDL.Opt(IDL.Nat32),
  });
  return new Uint8Array(IDL.encode([installArgs], [{
    demo: [], manageApiKeys: [], logFilter: [], nodesInSubnet: [],
    overrideProvider: [{ overrideUrl: override === null ? [] : [override] }],
  }]));
}

/** Starts only when called. Does not change EVM RPC or either chain's state. */
export async function startLocalEvmRpcRoutingProxy(options: { port: number; enableBroadcastReplyLoss?: boolean }) {
  assertPort(options.port);
  if (options.port === 8545 || options.port === 8546 || options.port === 8000) {
    throw new Error("Routing proxy requires a separate loopback port");
  }
  await Promise.all([
    assertFixtureNode(ETHEREUM_RPC, "0x1", /^anvil\b/iu),
    assertFixtureNode(ARBITRUM_RPC, "0xa4b1", /^anvil\b/iu),
  ]);
  const requests = { ethereum: 0, arbitrum: 0, rejected: 0, failed: 0 };
  let broadcastReplyLoss: EvmRpcBroadcastReplyLoss | null = null;
  const server = createServer(async (request, response) => {
    // Explicitly enabled fixture control is unreachable through the provider
    // substitution. It affects only this proxy's two unforked loopback nodes.
    // No success is invented: a fault selects a transaction only after Anvil
    // returns its actual hash, independently checked against the signed bytes.
    if (options.enableBroadcastReplyLoss && request.url?.startsWith("/__fixture_control/")) {
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.method === "GET" && request.url === "/__fixture_control/state") {
        reply(200, { broadcastReplyLoss, requests }); return;
      }
      if (request.method === "POST" && request.url === "/__fixture_control/release") {
        request.resume();
        if (broadcastReplyLoss && broadcastReplyLoss.releasedAt === null) {
          broadcastReplyLoss.releasedAt = new Date().toISOString();
        }
        reply(200, { broadcastReplyLoss, requests }); return;
      }
      if (request.method === "POST" && request.url === "/__fixture_control/arm") {
        if (broadcastReplyLoss?.releasedAt === null) {
          request.resume(); reply(409, { error: "A broadcast reply-loss fault is already active" }); return;
        }
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!input || typeof input !== "object" || !("chainId" in input) ||
              (input.chainId !== "1" && input.chainId !== "42161")) {
            reply(400, { error: "An explicit fixture chainId is required" }); return;
          }
          broadcastReplyLoss = {
            chainId: input.chainId, armedAt: new Date().toISOString(), releasedAt: null,
            raw: null, transactionHash: null, acceptedAt: null,
            matchingRequests: 0, suppressedResponses: 0, deliveredResponses: 0,
            observedRawTransactions: [],
          };
          reply(200, { broadcastReplyLoss, requests }); return;
        } catch {
          reply(400, { error: "Invalid local fixture control request" }); return;
        }
      }
      request.resume(); reply(400, { error: "Unknown local fixture control" }); return;
    }
    const match = /^\/provider\/([a-z0-9.-]+)\/(eth|arbitrum)?$/u.exec(request.url ?? "");
    const chain = match
      ? providerChainFromOriginalUrl(`https://${match[1]}/${match[2] ?? ""}`)
      : null;
    if (request.method !== "POST" || chain === null) {
      requests.rejected++;
      request.resume();
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unknown local fixture provider route" }));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const raw = signedBroadcastRaw(body);
      const armedFault = broadcastReplyLoss;
      if (armedFault?.chainId === chain && armedFault.releasedAt === null && raw !== null &&
          !armedFault.observedRawTransactions.includes(raw)) {
        armedFault.observedRawTransactions.push(raw);
      }
      const upstream = await fetch(chain === "1" ? ETHEREUM_RPC : ARBITRUM_RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body, redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      chain === "1" ? requests.ethereum++ : requests.arbitrum++;
      const responseBytes = Buffer.from(await upstream.arrayBuffer());
      const fault = broadcastReplyLoss;
      if (fault?.chainId === chain && raw !== null) {
        if (fault.raw === null && fault.releasedAt === null && upstream.ok && acceptedBroadcastHash(responseBytes, raw) !== null) {
          fault.raw = raw;
          fault.transactionHash = keccak256(raw);
          fault.acceptedAt = new Date().toISOString();
        }
        if (fault.raw === raw) {
          fault.matchingRequests++;
          if (fault.releasedAt === null) {
            fault.suppressedResponses++;
            // A real accepted broadcast has already occurred. Suppress every
            // provider's response for these exact signed bytes until release,
            // including later "already known" responses from the real node.
            response.writeHead(503, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "Injected local fixture loss of broadcast response" }));
            return;
          }
          fault.deliveredResponses++;
        }
      }
      // Preserve the node's exact response bytes/status. Do not normalize,
      // invent or intercept JSON-RPC results, including transaction responses.
      response.writeHead(upstream.status, { "content-type": "application/json" });
      response.end(responseBytes);
    } catch {
      requests.failed++;
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Local fixture RPC unavailable" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    override: routingOverride(options.port),
    requests,
    get broadcastReplyLoss() { return broadcastReplyLoss; },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function signedBroadcastRaw(body: Buffer): string | null {
  try {
    const value = JSON.parse(body.toString("utf8")) as { method?: unknown; params?: unknown };
    if (value.method !== "eth_sendRawTransaction" || !Array.isArray(value.params) || value.params.length !== 1) return null;
    const raw: unknown = value.params[0];
    return typeof raw === "string" && /^0x(?:[0-9a-fA-F]{2})+$/u.exec(raw)?.[0] === raw ? raw.toLowerCase() : null;
  } catch { return null; }
}

function acceptedBroadcastHash(body: Buffer, raw: string): string | null {
  try {
    const value = JSON.parse(body.toString("utf8")) as { result?: unknown; error?: unknown };
    return value.error === undefined && typeof value.result === "string" && value.result.toLowerCase() === keccak256(raw)
      ? value.result.toLowerCase() : null;
  } catch { return null; }
}

/** Read-only inspection; API key bytes are never returned or logged. */
export async function inspectLocalEvmRpcFixture(options: LocalEvmRpcRoutingOptions): Promise<EvmRpcRoutingBaseline> {
  const { management, provider, identity, archive } = await localActors(options);
  const status = await management.canister_status({ canister_id: Principal.fromText(CANISTER_ID) });
  const installedModuleSha256 = status.module_hash.length === 1 ? hex(status.module_hash[0]!) : "";
  if (!("running" in status.status) || ![MODULE_SHA256, ARCHIVE_SHA256].includes(installedModuleSha256)) {
    throw new Error("Local EVM RPC is not the running pinned v2.8.0 module");
  }
  const controller = identity.getPrincipal().toText();
  if (status.settings.controllers.length !== 1 || status.settings.controllers[0]!.toText() !== controller) {
    throw new Error("Local EVM RPC does not have its expected fixture controller");
  }
  const providers = await provider.getProviders();
  verifyProviderRoutes(providers);
  const stable = await readEvmRpcStableSnapshot(options);
  if (sha256(archive) !== ARCHIVE_SHA256) throw new Error("Pinned archive changed during inspection");
  return {
    ...stable, canisterId: CANISTER_ID, moduleSha256: MODULE_SHA256, installedModuleSha256, controller,
    nodesInSubnet: await provider.getNodesInSubnet(),
    providerTableSha256: sha256(Buffer.from(JSON.stringify(providers, (_, value) => typeof value === "bigint" ? value.toString() : value))),
  };
}

/** Explicit mutation boundary. Caller must arrange an idle qualification window. */
export async function upgradeLocalEvmRpcRouting(
  options: LocalEvmRpcRoutingOptions,
  baseline: EvmRpcRoutingBaseline,
  override: Exclude<EvmRpcOverride, null>,
): Promise<EvmRpcRoutingBaseline> {
  const before = await inspectLocalEvmRpcFixture(options);
  assertPreserved(baseline, before);
  if (!sameOverride(before.override, baseline.override)) throw new Error("EVM RPC override changed since baseline");
  const match = /^http:\/\/localhost:([0-9]+)\/provider\/\$\{1\}\$\{3\}\/\$\{2\}$/u.exec(override.replacement);
  if (!match || !sameOverride(override, routingOverride(Number(match[1])))) {
    throw new Error("Only this helper's local routing override may be installed");
  }
  await sameWasmUpgrade(options, override);
  const after = await inspectLocalEvmRpcFixture(options);
  assertPreserved(baseline, after);
  if (!sameOverride(after.override, override)) throw new Error("EVM RPC did not retain the requested routing override");
  return after;
}

/** Restore before closing the proxy. Safe to retry after a lost upgrade reply. */
export async function restoreLocalEvmRpcRouting(
  options: LocalEvmRpcRoutingOptions,
  baseline: EvmRpcRoutingBaseline,
  installedOverride: Exclude<EvmRpcOverride, null>,
): Promise<EvmRpcRoutingBaseline> {
  const before = await inspectLocalEvmRpcFixture(options);
  assertPreserved(baseline, before);
  if (sameOverride(before.override, baseline.override)) return before;
  if (!sameOverride(before.override, installedOverride)) throw new Error("Refusing to overwrite an unexpected EVM RPC override during restoration");
  await sameWasmUpgrade(options, baseline.override);
  const after = await inspectLocalEvmRpcFixture(options);
  assertPreserved(baseline, after);
  if (!sameOverride(after.override, baseline.override)) throw new Error("EVM RPC routing restoration did not persist");
  return after;
}

async function sameWasmUpgrade(options: LocalEvmRpcRoutingOptions, override: EvmRpcOverride): Promise<void> {
  const { management, archive } = await localActors(options);
  const canister = Principal.fromText(CANISTER_ID);
  const wasm = gunzipSync(archive);
  // Preserve the exact original module hash too: IC hashes compressed install
  // input when gzip is supplied, although the executable is equivalent. The
  // pinned 3.1MB executable requires checked chunk upload. The fixture's chunk
  // store must be empty before use and is restored to empty afterward.
  if ((await management.stored_chunks({ canister_id: canister })).length !== 0) {
    throw new Error("Fixture EVM RPC has a nonempty chunk store; refusing to overwrite it");
  }
  try {
    const hashes: Array<{ hash: Uint8Array }> = [];
    for (let offset = 0; offset < wasm.length; offset += 1_000_000) {
      const chunk = wasm.subarray(offset, offset + 1_000_000);
      const uploaded = await management.upload_chunk({ canister_id: canister, chunk });
      if (hex(uploaded.hash) !== sha256(chunk)) throw new Error("Uploaded fixture WASM chunk hash differs");
      hashes.push(uploaded);
    }
    await management.install_chunked_code({
      mode: { upgrade: [] }, target_canister: canister, store_canister: [],
      chunk_hashes_list: hashes, wasm_module_hash: new Uint8Array(Buffer.from(MODULE_SHA256, "hex")),
      arg: encodeEvmRpcOverrideUpgradeArgs(override), sender_canister_version: [],
    });
  } finally {
    await management.clear_chunk_store({ canister_id: canister });
  }
  if ((await management.stored_chunks({ canister_id: canister })).length !== 0) throw new Error("Fixture chunk store did not return to empty");
}

function assertPreserved(before: EvmRpcRoutingBaseline, after: EvmRpcRoutingBaseline): void {
  const withoutOverride = (value: EvmRpcRoutingBaseline) => ({
    canisterId: value.canisterId, moduleSha256: value.moduleSha256,
    controller: value.controller, nodesInSubnet: value.nodesInSubnet,
    providerTableSha256: value.providerTableSha256,
    roots: Object.fromEntries(Object.entries(value.roots).filter(([id]) => id !== "8")),
  });
  if (JSON.stringify(withoutOverride(before)) !== JSON.stringify(withoutOverride(after))) {
    throw new Error("EVM RPC state outside the provider override changed; preserve evidence and inspect before continuing");
  }
}

/**
 * Read-only decoding of ic-stable-structures0.6.9's documented MGR v1/SCL v1
 * layout, the exact version in v2.8.0 Cargo.lock. No stable bytes are persisted.
 * Sources: https://github.com/dfinity/stable-structures/blob/v0.6.9/src/memory_manager.rs
 * https://github.com/dfinity/stable-structures/blob/v0.6.9/src/cell.rs
 */
export async function readEvmRpcStableSnapshot(options: Pick<LocalEvmRpcRoutingOptions, "controlUrl" | "instanceId">): Promise<EvmRpcStableSnapshot> {
  const control = localUrl(options.controlUrl);
  if (!Number.isSafeInteger(options.instanceId) || options.instanceId < 0) throw new Error("Invalid local PocketIC instance");
  const deadline = Date.now() + 30_000;
  let result: unknown;
  while (Date.now() < deadline) {
    const response = await fetch(new URL(`instances/${options.instanceId}/read/get_stable_memory`, control), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ canister_id: Buffer.from(Principal.fromText(CANISTER_ID).toUint8Array()).toString("base64") }),
      signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (response.status === 409) { await response.body?.cancel(); await delay(100); continue; }
    if (response.status !== 200) throw new Error(`PocketIC stable-memory read failed: HTTP ${response.status}`);
    result = await response.json();
    break;
  }
  if (!result || typeof result !== "object" || !("blob" in result) || typeof result.blob !== "string") {
    throw new Error("PocketIC did not return a stable-memory snapshot");
  }
  const memory = Buffer.from(result.blob, "base64");
  try {
    return decodeStableSnapshot(memory);
  } finally {
    memory.fill(0);
  }
}

function decodeStableSnapshot(memory: Buffer): EvmRpcStableSnapshot {
  if (memory.length < WASM_PAGE_BYTES || memory.toString("ascii", 0, 3) !== "MGR" || memory[3] !== 1) {
    throw new Error("Unexpected pinned EVM RPC stable-memory manager layout");
  }
  const bucketCount = memory.readUInt16LE(4);
  const bucketBytes = memory.readUInt16LE(6) * WASM_PAGE_BYTES;
  if (!bucketBytes || bucketCount > 32_768 || WASM_PAGE_BYTES + bucketCount * bucketBytes > memory.length) {
    throw new Error("Invalid EVM RPC stable bucket layout");
  }
  const roots: EvmRpcStableSnapshot["roots"] = {};
  let override: EvmRpcOverride | undefined;
  for (let id = 0; id < 255; id++) {
    const pagesBig = memory.readBigUInt64LE(40 + id * 8);
    if (!pagesBig) continue;
    if (pagesBig * BigInt(WASM_PAGE_BYTES) > BigInt(memory.length)) throw new Error("Invalid stable memory size");
    const pages = Number(pagesBig);
    const buckets: Buffer[] = [];
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      if (memory[2080 + bucket] === id) buckets.push(memory.subarray(
        WASM_PAGE_BYTES + bucket * bucketBytes, WASM_PAGE_BYTES + (bucket + 1) * bucketBytes,
      ));
    }
    if (buckets.length * bucketBytes < pages * WASM_PAGE_BYTES) throw new Error("Truncated stable memory allocation");
    const joined = Buffer.concat(buckets);
    try {
      const region = joined.subarray(0, pages * WASM_PAGE_BYTES);
      roots[String(id)] = { pages, sha256: sha256(region) };
      if (id === 8) {
        if (region.toString("ascii", 0, 3) !== "SCL" || region[3] !== 1) throw new Error("Unexpected EVM RPC override cell layout");
        const length = region.readUInt32LE(4);
        if (length > region.length - 8) throw new Error("Truncated EVM RPC override cell");
        const decoded: unknown = JSON.parse(region.toString("utf8", 8, 8 + length));
        if (!decoded || typeof decoded !== "object" || !("override_url" in decoded)) throw new Error("Invalid stored EVM RPC override");
        const substitution = decoded.override_url;
        if (substitution === null) override = null;
        else if (substitution && typeof substitution === "object" && "pattern" in substitution && "replacement" in substitution && typeof substitution.pattern === "string" && typeof substitution.replacement === "string") {
          override = { pattern: substitution.pattern, replacement: substitution.replacement };
        } else throw new Error("Invalid stored EVM RPC substitution");
      }
    } finally { joined.fill(0); }
  }
  if (override === undefined) throw new Error("Pinned EVM RPC override cell is missing");
  return { override, stableBytes: memory.length, roots };
}

async function localActors(options: LocalEvmRpcRoutingOptions) {
  const gateway = localUrl(options.gatewayUrl);
  localUrl(options.controlUrl);
  const archive = await readFile(options.archivePath);
  if (sha256(archive) !== ARCHIVE_SHA256 || sha256(gunzipSync(archive)) !== MODULE_SHA256) {
    throw new Error("EVM RPC archive does not match the pinned official v2.8.0 artifact");
  }
  // Same deterministic fixture controller as provision/local_fixtures.ts.
  // That module is Bun-only; this helper also loads under Node/Playwright.
  const identity = Ed25519KeyIdentity.generate(createHash("sha256").update("neutron-pocketic-ledger-minter-v1").digest());
  const agent = await HttpAgent.create({ host: gateway.href, identity });
  await agent.fetchRootKey();
  if (!options.expectedRootKeyBase64 || !agent.rootKey || Buffer.from(agent.rootKey).toString("base64") !== options.expectedRootKeyBase64) {
    throw new Error("Local fixture root key does not match the recorded runtime");
  }
  const management = Actor.createActor<ManagementActor>(managementIdl, {
    agent, canisterId: Principal.managementCanister(), effectiveCanisterId: Principal.fromText(CANISTER_ID),
  });
  const provider = Actor.createActor<ProviderActor>(providerIdl, { agent, canisterId: CANISTER_ID });
  return { management, provider, identity, archive };
}

function verifyProviderRoutes(providers: Provider[]): void {
  const counts = { "1": 0, "42161": 0 };
  for (const provider of providers) {
    const urls = "Unauthenticated" in provider.access ? [provider.access.Unauthenticated.publicUrl] : [
      ...provider.access.Authenticated.publicUrl,
      "BearerToken" in provider.access.Authenticated.auth
        ? provider.access.Authenticated.auth.BearerToken.url
        : provider.access.Authenticated.auth.UrlParameter.urlPattern.replace("{API_KEY}", "fixture-key"),
    ];
    for (const url of urls) {
      const chain = providerChainFromOriginalUrl(url);
      const expected = provider.chainId === 1n ? "1" : provider.chainId === 42161n ? "42161" : null;
      if (chain !== expected) throw new Error(`Pinned provider ${provider.providerId} has an unexpected fixture route`);
    }
    if (provider.chainId === 1n) counts["1"]++;
    if (provider.chainId === 42161n) counts["42161"]++;
  }
  if (providers.length !== 26 || counts["1"] !== 6 || counts["42161"] !== 5) {
    throw new Error("Installed EVM RPC provider table differs from pinned v2.8.0");
  }
}

async function assertFixtureNode(url: string, chainId: string, clientPattern: RegExp): Promise<void> {
  for (const [method, expected] of [["eth_chainId", chainId], ["web3_clientVersion", clientPattern]] as const) {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Local fixture chain readiness failed");
    const value = await response.json() as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
    if (value.jsonrpc !== "2.0" || value.id !== 1 || value.error !== undefined || typeof value.result !== "string" ||
      (typeof expected === "string" ? value.result.toLowerCase() !== expected : !expected.test(value.result))) {
      throw new Error("Local fixture identity does not match its configured Anvil chain");
    }
  }
}

function localUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("EVM RPC qualification requires explicit loopback endpoints");
  }
  return url;
}
function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid local fixture proxy port");
}
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function hex(value: Uint8Array): string { return Buffer.from(value).toString("hex"); }
function sameOverride(left: EvmRpcOverride, right: EvmRpcOverride): boolean {
  return left === null || right === null ? left === right : left.pattern === right.pattern && left.replacement === right.replacement;
}

const providerIdl: IDL.InterfaceFactory = ({ IDL }) => IDL.Service({
  getProviders: IDL.Func([], [IDL.Vec(IDL.Record({
    providerId: IDL.Nat64, chainId: IDL.Nat64,
    access: IDL.Variant({
      Unauthenticated: IDL.Record({ publicUrl: IDL.Text }),
      Authenticated: IDL.Record({ publicUrl: IDL.Opt(IDL.Text), auth: IDL.Variant({
        BearerToken: IDL.Record({ url: IDL.Text }), UrlParameter: IDL.Record({ urlPattern: IDL.Text }),
      }) }),
    }),
  }))], ["query"]),
  getNodesInSubnet: IDL.Func([], [IDL.Nat32], ["query"]),
});
const managementIdl: IDL.InterfaceFactory = ({ IDL }) => IDL.Service({
  canister_status: IDL.Func([IDL.Record({ canister_id: IDL.Principal })], [IDL.Record({
    status: IDL.Variant({ running: IDL.Null, stopping: IDL.Null, stopped: IDL.Null }),
    settings: IDL.Record({ controllers: IDL.Vec(IDL.Principal) }),
    module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
  })], []),
  install_code: IDL.Func([IDL.Record({
    mode: IDL.Variant({ upgrade: IDL.Opt(IDL.Record({
      skip_pre_upgrade: IDL.Opt(IDL.Bool),
      wasm_memory_persistence: IDL.Opt(IDL.Variant({ keep: IDL.Null, replace: IDL.Null })),
    })) }),
    canister_id: IDL.Principal, wasm_module: IDL.Vec(IDL.Nat8), arg: IDL.Vec(IDL.Nat8),
    sender_canister_version: IDL.Opt(IDL.Nat64),
  })], [], []),
  stored_chunks: IDL.Func([IDL.Record({ canister_id: IDL.Principal })], [IDL.Vec(IDL.Record({ hash: IDL.Vec(IDL.Nat8) }))], []),
  upload_chunk: IDL.Func([IDL.Record({ canister_id: IDL.Principal, chunk: IDL.Vec(IDL.Nat8) })], [IDL.Record({ hash: IDL.Vec(IDL.Nat8) })], []),
  clear_chunk_store: IDL.Func([IDL.Record({ canister_id: IDL.Principal })], [], []),
  install_chunked_code: IDL.Func([IDL.Record({
    mode: IDL.Variant({ upgrade: IDL.Opt(IDL.Record({
      skip_pre_upgrade: IDL.Opt(IDL.Bool),
      wasm_memory_persistence: IDL.Opt(IDL.Variant({ keep: IDL.Null, replace: IDL.Null })),
    })) }),
    target_canister: IDL.Principal, store_canister: IDL.Opt(IDL.Principal),
    chunk_hashes_list: IDL.Vec(IDL.Record({ hash: IDL.Vec(IDL.Nat8) })),
    wasm_module_hash: IDL.Vec(IDL.Nat8), arg: IDL.Vec(IDL.Nat8), sender_canister_version: IDL.Opt(IDL.Nat64),
  })], [], []),
});
