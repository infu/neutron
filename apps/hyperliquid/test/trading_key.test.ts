import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { signL1Action } from "@nktkas/hyperliquid/signing";
import {
  prepareTradingSession, getTradingSession, approveTradingSession,
  revokeTradingSession, getTradingSigner, type MasterTypedDataRequest,
  DefinitiveMasterSigningError,
} from "../src/trading_key";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture() {
  const master = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const binding = { walletAddress: master.address, installationId: crypto.randomUUID(), environment: "mainnet" as const };
  const server = {
    agents: [] as { address: string; name: string; validUntil: number | null }[],
    posts: [] as string[], signatures: [] as MasterTypedDataRequest[],
    timeout: false, acceptBeforeTimeout: false, infoError: false,
    exchangeError: null as string | null,
  };
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    if (url.endsWith("/info")) {
      if (server.infoError) throw new Error("Info unavailable");
      return new Response(JSON.stringify(server.agents));
    }
    expect(url).toBe("https://api.hyperliquid.xyz/exchange");
    const body = options.body as string;
    server.posts.push(body);
    if (server.timeout && !server.acceptBeforeTimeout) throw new Error("Lost exchange response");
    if (server.exchangeError !== null) return new Response(JSON.stringify({ status: "err", response: server.exchangeError }));
    const { action } = JSON.parse(body);
    server.agents = action.agentAddress === `0x${"00".repeat(20)}` ? [] : [
      { address: action.agentAddress, name: action.agentName, validUntil: Date.now() + 86_400_000 },
    ];
    if (server.timeout) throw new Error("Lost exchange response");
    return new Response(JSON.stringify({ status: "ok", response: { type: "default" } }));
  }) as typeof fetch;
  const sign = async (request: MasterTypedDataRequest) => {
    server.signatures.push(request);
    expect(Object.keys(request.typedData.message)).toEqual(["hyperliquidChain", "agentAddress", "agentName", "nonce"]);
    expect(request.chainId).toBe(42161);
    expect(request.typedData.types.EIP712Domain).toBeDefined();
    return await master.signTypedData(request.typedData);
  };
  return { binding, server, sign };
}

const l1 = (wallet: Awaited<ReturnType<typeof getTradingSigner>>) => signL1Action({
  wallet, action: { type: "cancel", cancels: [{ a: 0, o: 42 }] }, nonce: Date.now(), isTestnet: false,
});

test("device key authorizes through Wallet, signs locally, revokes by name and rotates to a fresh signer", async () => {
  const { binding, server, sign } = fixture();
  expect((await getTradingSession(binding)).state).toBe("missing");
  const prepared = await prepareTradingSession(binding);
  expect(prepared.state).toBe("unapproved");
  expect((await prepareTradingSession(binding)).agentAddress).toBe(prepared.agentAddress);
  expect(JSON.stringify(prepared)).not.toContain("privateKey");
  const active = await approveTradingSession(binding, sign, "01".repeat(16));
  expect(active.state).toBe("active");
  expect(active.operation?.state).toBe("confirmed");
  await approveTradingSession(binding, sign, "01".repeat(16));
  expect(server.posts).toHaveLength(1);
  expect(server.signatures).toHaveLength(1);
  const signer = await getTradingSigner(binding);
  expect((await l1(signer)).r).toHaveLength(66);
  const revoked = await revokeTradingSession(binding, sign, "02".repeat(16));
  expect(revoked.state).toBe("revoked");
  expect(JSON.parse(server.posts.at(-1)!).action).toMatchObject({
    agentAddress: `0x${"00".repeat(20)}`, agentName: prepared.agentName,
  });
  await expect(l1(signer)).rejects.toThrow();
  const fresh = await prepareTradingSession(binding);
  expect(fresh.agentAddress).not.toBe(prepared.agentAddress);
  expect(fresh.agentName).toBe(prepared.agentName);
  await approveTradingSession(binding, sign, "03".repeat(16));
  await expect(l1(signer)).rejects.toThrow();
});

test("lost responses retain immutable signing intent and only explicitly rebroadcast the same envelope", async () => {
  const { binding, server, sign } = fixture();
  server.timeout = true;
  const uncertain = await approveTradingSession(binding, sign, "10".repeat(16));
  expect(uncertain.operation?.state).toBe("unknown");
  await approveTradingSession(binding, sign, "10".repeat(16));
  expect(server.posts).toHaveLength(1);
  expect(server.signatures).toHaveLength(1);
  await expect(approveTradingSession(binding, sign, "11".repeat(16))).rejects.toThrow("Resume trading session request");
  server.timeout = false;
  const resolved = await approveTradingSession(binding, sign, "10".repeat(16), { rebroadcast: true });
  expect(resolved.state).toBe("active");
  expect(server.posts).toHaveLength(2);
  expect(server.posts[1]).toBe(server.posts[0]);
  expect(server.signatures).toHaveLength(1);
});

test("an accepted request with a lost response reconciles without signing or posting again", async () => {
  const { binding, server, sign } = fixture();
  server.timeout = true;
  server.acceptBeforeTimeout = true;
  expect((await approveTradingSession(binding, sign, "20".repeat(16))).operation?.state).toBe("unknown");
  expect((await approveTradingSession(binding, sign, "20".repeat(16))).state).toBe("active");
  expect(server.posts).toHaveLength(1);
  expect(server.signatures).toHaveLength(1);
});

test("a rejected replay cannot prove the original approval failed or make its key eligible for reuse", async () => {
  const { binding, server, sign } = fixture();
  server.timeout = true;
  const pending = await approveTradingSession(binding, sign, "21".repeat(16));
  server.timeout = false;
  server.exchangeError = "Nonce already used";
  const replay = await approveTradingSession(binding, sign, "21".repeat(16), { rebroadcast: true });
  expect(replay.state).toBe("approval_pending");
  expect(replay.operation?.state).toBe("unknown");
  expect(replay.operation?.error).toContain("original submission remains unresolved");
  expect(replay.agentAddress).toBe(pending.agentAddress);
  expect(server.posts[1]).toBe(server.posts[0]);
  expect(server.signatures).toHaveLength(1);
  await expect(approveTradingSession(binding, sign, "22".repeat(16))).rejects.toThrow("Resume trading session request");
  expect(server.signatures).toHaveLength(1);
});

test("external revocation or expiry permanently retires a local key; API outages do not imply revocation", async () => {
  const { binding, server, sign } = fixture();
  const active = await approveTradingSession(binding, sign, "30".repeat(16));
  server.infoError = true;
  expect((await getTradingSession(binding)).state).toBe("unknown");
  expect((await getTradingSession(binding, { refresh: false })).state).toBe("active");
  server.infoError = false;
  server.agents = [];
  expect((await getTradingSession(binding)).state).toBe("revoked");
  server.agents = [{ address: active.agentAddress!, name: active.agentName!, validUntil: null }];
  expect((await getTradingSession(binding)).state).toBe("revoked");
  const replacement = await prepareTradingSession(binding);
  expect(replacement.agentAddress).not.toBe(active.agentAddress);
  await approveTradingSession(binding, sign, "31".repeat(16));
  server.agents[0]!.validUntil = Date.now() - 1;
  expect((await getTradingSession(binding)).state).toBe("expired");
  const before = server.posts.length;
  expect((await approveTradingSession(binding, sign, "31".repeat(16), { rebroadcast: true })).state).toBe("expired");
  expect(server.posts).toHaveLength(before);
});

test("persisted keys are encrypted by a nonextractable key and cannot cross installation or environment bindings", async () => {
  const { binding } = fixture();
  const prepared = await prepareTradingSession(binding);
  expect((await getTradingSession({ ...binding, installationId: "another-installation" })).state).toBe("missing");
  expect((await getTradingSession({ ...binding, environment: "testnet" })).state).toBe("missing");
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("neutron-hyperliquid-trading-keys-v1", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const record = await new Promise<any>((resolve, reject) => {
    const key = JSON.stringify([binding.installationId, binding.environment, binding.walletAddress.toLowerCase()]);
    const request = database.transaction("records").objectStore("records").get(`session:${key}`);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  expect(record.agentAddress).toBe(prepared.agentAddress);
  expect(record.encryptionKey.extractable).toBe(false);
  await expect(crypto.subtle.exportKey("raw", record.encryptionKey)).rejects.toThrow();
  expect(record.ciphertext.byteLength).toBe(82);
  expect(record.iv.byteLength).toBe(12);
  expect(JSON.stringify(record)).not.toContain("privateKey");
});

test("a canceled setup never reaches Wallet signing or the exchange", async () => {
  const { binding, server, sign } = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(approveTradingSession(binding, sign, "40".repeat(16), { signal: controller.signal })).rejects.toThrow();
  expect(server.signatures).toHaveLength(0);
  expect(server.posts).toHaveLength(0);
});

test("approval on another device replaces the same named slot and retires the previous device key", async () => {
  const { binding, server, sign } = fixture();
  const first = await approveTradingSession(binding, sign, "50".repeat(16));
  const secondBinding = { ...binding, installationId: crypto.randomUUID() };
  const second = await approveTradingSession(secondBinding, sign, "51".repeat(16));
  expect(second.agentName).toBe(first.agentName);
  expect(second.agentAddress).not.toBe(first.agentAddress);
  expect(server.agents).toHaveLength(1);
  expect((await getTradingSession(binding)).state).toBe("revoked");
  expect(second.approvalEffect).toContain("other devices");
});

test("cancellation after Wallet signing retains its envelope and resumes without another signature", async () => {
  const { binding, server, sign } = fixture();
  const controller = new AbortController();
  const signThenCancel = async (request: MasterTypedDataRequest) => {
    const signature = await sign(request);
    controller.abort();
    return signature;
  };
  await expect(approveTradingSession(binding, signThenCancel, "60".repeat(16), { signal: controller.signal })).rejects.toThrow();
  expect(server.posts).toHaveLength(0);
  expect((await getTradingSession(binding, { refresh: false })).operation?.state).toBe("signed");
  expect((await approveTradingSession(binding, sign, "60".repeat(16))).state).toBe("active");
  expect(server.signatures).toHaveLength(1);
  expect(server.posts).toHaveLength(1);
});

test("durable Wallet rejection permits a fresh approval request without broadcasting the rejected action", async () => {
  const { binding, server, sign } = fixture();
  const reject = async () => { throw new DefinitiveMasterSigningError("Owner rejected the Wallet signing request"); };
  const denied = await approveTradingSession(binding, reject, "70".repeat(16));
  expect(denied.state).toBe("unapproved");
  expect(denied.operation?.state).toBe("rejected");
  expect(denied.operation?.error).toContain("Owner rejected");
  expect(server.posts).toHaveLength(0);
  const approved = await approveTradingSession(binding, sign, "71".repeat(16));
  expect(approved.state).toBe("active");
  expect(approved.agentAddress).toBe(denied.agentAddress);
  expect(server.posts).toHaveLength(1);
  expect(server.signatures).toHaveLength(1);
});

test("durable Wallet cancellation of revocation restores the existing active trading session", async () => {
  const { binding, server, sign } = fixture();
  const approved = await approveTradingSession(binding, sign, "72".repeat(16));
  const reject = async () => { throw new DefinitiveMasterSigningError("Wallet request canceled before signing"); };
  const denied = await revokeTradingSession(binding, reject, "73".repeat(16));
  expect(denied.state).toBe("active");
  expect(denied.agentAddress).toBe(approved.agentAddress);
  expect(denied.operation?.state).toBe("rejected");
  expect(server.posts).toHaveLength(1);
  const revoked = await revokeTradingSession(binding, sign, "74".repeat(16));
  expect(revoked.state).toBe("revoked");
  expect(server.posts).toHaveLength(2);
});

test("a signing transport error cannot masquerade as a definitive Wallet rejection", async () => {
  const { binding, server, sign } = fixture();
  const fail = async () => { throw new Error("Wallet response lost"); };
  await expect(approveTradingSession(binding, fail, "75".repeat(16))).rejects.toThrow();
  const pending = await getTradingSession(binding, { refresh: false });
  expect(pending.state).toBe("approval_pending");
  expect(pending.operation?.state).toBe("prepared");
  await expect(approveTradingSession(binding, sign, "76".repeat(16))).rejects.toThrow("Resume trading session request");
  expect(server.posts).toHaveLength(0);
  expect(server.signatures).toHaveLength(0);
});

test("an explicitly signed revoke resolves an abandoned approval and retires its key while preserving its original envelope", async () => {
  const { binding, server, sign } = fixture();
  server.timeout = true;
  const abandoned = await approveTradingSession(binding, sign, "80".repeat(16));
  const originalEnvelope = server.posts[0];
  server.timeout = false;
  const revoked = await revokeTradingSession(binding, sign, "81".repeat(16));
  expect(revoked.state).toBe("revoked");
  expect(revoked.operation?.state).toBe("confirmed");
  expect(revoked.operation?.supersedesRequestId).toBe("80".repeat(16));
  expect(revoked.recoveryNotice).toContain("may still arrive");
  expect(JSON.parse(server.posts[1]!).action.agentAddress).toBe(`0x${"00".repeat(20)}`);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("neutron-hyperliquid-trading-keys-v1", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const history = await new Promise<any>((resolve, reject) => {
    const key = JSON.stringify([binding.installationId, binding.environment, binding.walletAddress.toLowerCase()]);
    const request = database.transaction("records").objectStore("records").get(`operation:${key}:${"80".repeat(16)}`);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  expect(history.envelope).toBe(originalEnvelope);
  expect(history.state).toBe("unknown");
  const replacement = await approveTradingSession(binding, sign, "82".repeat(16));
  expect(replacement.state).toBe("active");
  expect(replacement.agentAddress).not.toBe(abandoned.agentAddress);
});

test("absent registration cannot confirm a prepared revocation that Wallet has not signed", async () => {
  const { binding, server, sign } = fixture();
  server.timeout = true;
  await approveTradingSession(binding, sign, "83".repeat(16));
  server.timeout = false;
  const fail = async () => { throw new Error("Wallet unavailable"); };
  await expect(revokeTradingSession(binding, fail, "84".repeat(16))).rejects.toThrow();
  const pending = await getTradingSession(binding);
  expect(pending.state).toBe("revocation_pending");
  expect(pending.operation?.state).toBe("prepared");
  expect(server.posts).toHaveLength(1);
  await expect(approveTradingSession(binding, sign, "85".repeat(16))).rejects.toThrow("Resume trading session request");
  expect((await revokeTradingSession(binding, sign, "84".repeat(16))).state).toBe("revoked");
  expect(server.posts).toHaveLength(2);
});

test("a lost zero-action acknowledgment stays pending and a newly authorized revoke can recover it", async () => {
  const { binding, server, sign } = fixture();
  server.timeout = true;
  await approveTradingSession(binding, sign, "86".repeat(16));
  server.acceptBeforeTimeout = true;
  const ambiguous = await revokeTradingSession(binding, sign, "87".repeat(16));
  expect(ambiguous.state).toBe("revocation_pending");
  expect(ambiguous.operation?.state).toBe("unknown");
  expect((await getTradingSession(binding)).state).toBe("revocation_pending");
  await expect(approveTradingSession(binding, sign, "88".repeat(16))).rejects.toThrow("Resume trading session request");
  server.timeout = false;
  const revoked = await revokeTradingSession(binding, sign, "89".repeat(16));
  expect(revoked.state).toBe("revoked");
  expect(revoked.operation?.supersedesRequestId).toBe("87".repeat(16));
  expect(server.posts).toHaveLength(3);
  expect(server.signatures).toHaveLength(3);
  expect(JSON.parse(server.posts[2]!).nonce).toBeGreaterThan(JSON.parse(server.posts[1]!).nonce);
});

test("denying recovery revocation preserves the unresolved approval and cannot enable signer reuse", async () => {
  const { binding, server, sign } = fixture();
  server.timeout = true;
  await approveTradingSession(binding, sign, "90".repeat(16));
  server.timeout = false;
  const reject = async () => { throw new DefinitiveMasterSigningError("Owner rejected revocation"); };
  const denied = await revokeTradingSession(binding, reject, "91".repeat(16));
  expect(denied.state).toBe("approval_pending");
  expect(denied.operation?.state).toBe("rejected");
  await expect(approveTradingSession(binding, sign, "92".repeat(16))).rejects.toThrow("Resume trading session request");
  expect(server.posts).toHaveLength(1);
  expect((await revokeTradingSession(binding, sign, "93".repeat(16))).state).toBe("revoked");
});
