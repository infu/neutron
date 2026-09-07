import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as app from "neutron-tools/app";
import {
  enabledDecoderPacks,
  installDecoderPack,
  invalidateDecoderPacks,
  readDecoderPacks,
  removeDecoderPack,
  setDecoderPackEnabled,
  subscribeDecoderPacks,
  type DecoderQuery,
} from "../src/decoders/store.ts";

let walletStateChanged: Parameters<typeof app.onAppStateChange>[1] | undefined;
const stateSubscription = spyOn(app, "onAppStateChange").mockImplementation((topic, listener) => {
  expect(topic).toBe("evm_wallet");
  walletStateChanged = listener;
  return () => {};
});
const publishState = spyOn(app, "publishAppStateChange").mockResolvedValue(undefined);
beforeEach(() => { publishState.mockClear(); publishState.mockResolvedValue(undefined); });
afterAll(() => { stateSubscription.mockRestore(); publishState.mockRestore(); });

const digest = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");
const document = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  format: 1, id: "example-vault", version: "1", name: "Example vault Ξ",
  description: "Explain a deposit at the exact configured deployment.",
  source: "https://example.invalid/unverified-source",
  deployments: [{ chainId: "1", address: `0x${"11".repeat(20)}` }],
  functions: [{ signature: "deposit(uint256 amount,address receiver)", title: "Deposit into vault", value: "zero",
    fields: [{ path: "args.0", label: "Deposit atoms", format: "integer" }, { path: "args.1", label: "Receiver", format: "address" }] }],
  ...overrides,
});
type Wire = {
  id: string; version: string; name: string; document_json: string; sha256: string;
  enabled: boolean; created_at: string; updated_at: string;
};
function stored(raw = document(), overrides: Partial<Wire> = {}): Wire {
  const parsed = JSON.parse(raw) as { id: string; version: string; name: string };
  return {
    id: parsed.id, version: parsed.version, name: parsed.name, document_json: raw, sha256: digest(raw),
    enabled: true, created_at: "1790000000000000001", updated_at: "1790000000000000002", ...overrides,
  };
}
const inventory = (rows: Wire[]): DecoderQuery => async () => ({ packs: rows });

test("reads the invocation inventory and preserves exact UTF-8 document bytes and timestamps", async () => {
  const raw = ` \n${JSON.stringify(JSON.parse(document()), null, 2)}\n\t`;
  const row = stored(raw);
  const calls: unknown[] = [];
  const rows = await readDecoderPacks(async (method, args) => {
    calls.push({ method, args });
    return { ok: { packs: [row] } };
  });
  expect(calls).toEqual([{ method: "evm_wallet_decoder_packs_v1", args: [null] }]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: row.id, name: "Example vault Ξ", version: "1", documentJson: raw, sha256: digest(raw),
    createdAtNs: row.created_at, updatedAtNs: row.updated_at, enabled: true, error: null,
  });
  expect(rows[0]!.pack?.functions[0]!.signature).toBe("deposit(uint256 amount,address receiver)");
  expect(Object.isFrozen(rows[0]!.pack)).toBe(true);
  expect(digest(raw)).not.toBe(digest(JSON.stringify(JSON.parse(raw))));
});

test("changed JSON bytes fail their digest while the record remains removable and inspectable", async () => {
  const row = stored();
  const changed = `${row.document_json}\n`;
  const rows = await readDecoderPacks(inventory([{ ...row, document_json: changed }]));
  expect(rows[0]).toMatchObject({ id: row.id, documentJson: changed, sha256: row.sha256, pack: null, enabled: true });
  expect(rows[0]!.error).toContain("does not match its digest");
  expect(enabledDecoderPacks(rows)).toEqual([]);
});

test("identity mismatch never activates a parsed pack under a different saved identity", async () => {
  for (const mismatch of [{ id: "other-vault" }, { version: "2" }, { name: "Other vault" }]) {
    const row = stored(document(), mismatch);
    const rows = await readDecoderPacks(inventory([row]));
    expect(rows[0]).toMatchObject({ id: row.id, version: row.version, name: row.name, pack: null });
    expect(rows[0]!.error).toContain("identity does not match");
    expect(enabledDecoderPacks(rows)).toEqual([]);
  }
});

test("disabled, future-format and malformed documents remain recoverable alongside valid packs", async () => {
  const enabled = stored(document({ id: "enabled" }));
  const disabled = stored(document({ id: "disabled" }), { enabled: false });
  const future = stored(document({ id: "future", format: 2 }));
  const invalidJson = "{ this is not JSON }";
  const malformed = stored(document({ id: "malformed" }), { document_json: invalidJson, sha256: digest(invalidJson) });
  const rows = await readDecoderPacks(inventory([enabled, disabled, future, malformed]));
  expect(rows.map(row => row.id)).toEqual(["enabled", "disabled", "future", "malformed"]);
  expect(rows[1]).toMatchObject({ enabled: false, error: null });
  expect(rows[1]!.pack).not.toBeNull();
  expect(rows[2]!.pack).toBeNull();
  expect(rows[2]!.error).toContain("Invalid decoder pack");
  expect(rows[3]).toMatchObject({ documentJson: invalidJson, pack: null });
  expect(rows[3]!.error).toBeString();
  expect(enabledDecoderPacks(rows)).toEqual([{ pack: rows[0]!.pack!, sha256: enabled.sha256 }]);
});

test("inventory transport and malformed envelope failures propagate instead of becoming an empty list", async () => {
  const failure = new Error("Invocation authorization changed");
  await expect(readDecoderPacks(async () => { throw failure; })).rejects.toBe(failure);
  await expect(readDecoderPacks(async () => ({ err: "Wallet backend unavailable" }))).rejects.toThrow("Wallet backend unavailable");
  for (const result of [null, [], {}, { packs: null }, { packs: {} }, { packs: [null] }, { packs: [{ ...stored(), enabled: "true" }] }]) {
    await expect(readDecoderPacks(async () => result)).rejects.toThrow();
  }
  expect(await readDecoderPacks(inventory([]))).toEqual([]);
});

test("invocation-scoped reads are fresh and cannot share another caller's pending result", async () => {
  const subscriptions = stateSubscription.mock.calls.length;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let callsA = 0, callsB = 0;
  let version = "1";
  const queryA: DecoderQuery = async () => {
    callsA++;
    await gate;
    return { packs: [stored(document({ id: "caller-a", version }))] };
  };
  const queryB: DecoderQuery = async () => {
    callsB++;
    return { packs: [stored(document({ id: "caller-b" }))] };
  };
  const pendingA = readDecoderPacks(queryA);
  expect((await readDecoderPacks(queryB))[0]!.id).toBe("caller-b");
  release();
  expect((await pendingA)[0]!.id).toBe("caller-a");
  version = "2";
  expect((await readDecoderPacks(queryA))[0]!.version).toBe("2");
  expect((await readDecoderPacks(queryB))[0]!.id).toBe("caller-b");
  expect([callsA, callsB]).toEqual([2, 2]);
  expect(stateSubscription.mock.calls.length).toBe(subscriptions);
});

test("invocation reads bypass a populated tile cache and do not overwrite it", async () => {
  invalidateDecoderPacks();
  const tileRow = stored(document({ id: "tile-pack" }));
  const query = spyOn(app, "querySelf").mockResolvedValue({ packs: [tileRow] });
  try {
    expect((await readDecoderPacks())[0]!.id).toBe("tile-pack");
    expect((await readDecoderPacks(inventory([stored(document({ id: "invocation-pack" }))])))[0]!.id).toBe("invocation-pack");
    expect((await readDecoderPacks())[0]!.id).toBe("tile-pack");
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    query.mockRestore();
    invalidateDecoderPacks();
  }
});

test("install and toggle send exact JSON, independent SHA-256 and explicit enabled state", async () => {
  const raw = `\n${document()}\n`;
  const row = stored(raw);
  const update = spyOn(app, "updateSelf").mockResolvedValue(row);
  let changes = 0;
  const unsubscribe = subscribeDecoderPacks(() => { changes++; });
  try {
    const saved = await installDecoderPack(raw);
    expect(update.mock.calls[0]).toEqual(["evm_wallet_decoder_set_v1", [{
      id: row.id, version: row.version, name: row.name, document_json: raw, sha256: digest(raw), enabled: true,
    }]]);
    expect(saved).toMatchObject({ documentJson: raw, enabled: true, error: null });
    expect(publishState).toHaveBeenCalledTimes(1);
    expect(publishState.mock.calls[0]).toEqual(["evm_wallet", expect.any(Number)]);
    update.mockResolvedValue({ ...row, enabled: false });
    const disabled = await setDecoderPackEnabled(saved, false);
    expect(update.mock.calls[1]).toEqual(["evm_wallet_decoder_set_v1", [{
      id: row.id, version: row.version, name: row.name, document_json: raw, sha256: digest(raw), enabled: false,
    }]]);
    expect(disabled).toMatchObject({ documentJson: raw, enabled: false });
    expect(changes).toBe(2);
    expect(publishState).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    update.mockRestore();
    invalidateDecoderPacks();
  }
});

test("invalid import JSON never writes and a rejected backend update does not announce success", async () => {
  const update = spyOn(app, "updateSelf").mockResolvedValue({ err: "Pack version must increase" });
  let changes = 0;
  const unsubscribe = subscribeDecoderPacks(() => { changes++; });
  try {
    await expect(installDecoderPack("{ invalid JSON")).rejects.toThrow();
    await expect(installDecoderPack(document({ format: 99 }))).rejects.toThrow("Invalid decoder pack");
    expect(update).not.toHaveBeenCalled();
    await expect(installDecoderPack(document())).rejects.toThrow("Pack version must increase");
    expect(update).toHaveBeenCalledTimes(1);
    expect(changes).toBe(0);
    expect(publishState).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
    update.mockRestore();
    invalidateDecoderPacks();
  }
});

test("remove calls only the decoder endpoint and invalid results do not notify listeners", async () => {
  const update = spyOn(app, "updateSelf").mockResolvedValue(true);
  let changes = 0;
  const unsubscribe = subscribeDecoderPacks(() => { changes++; });
  try {
    expect(await removeDecoderPack("example-vault")).toBe(true);
    expect(update.mock.calls[0]).toEqual(["evm_wallet_decoder_remove_v1", ["example-vault"]]);
    expect(changes).toBe(1);
    expect(publishState).toHaveBeenCalledTimes(1);
    update.mockResolvedValue("invalid response");
    await expect(removeDecoderPack("example-vault")).rejects.toThrow("Invalid decoder removal result");
    expect(changes).toBe(1);
    expect(publishState).toHaveBeenCalledTimes(1);
    unsubscribe();
    update.mockResolvedValue(false);
    expect(await removeDecoderPack("missing-vault")).toBe(false);
    expect(changes).toBe(1);
  } finally {
    unsubscribe();
    update.mockRestore();
    invalidateDecoderPacks();
  }
});

test("a Settings-only subscription reloads changed packs from another Wallet endpoint", async () => {
  invalidateDecoderPacks();
  const first = stored(), disabled = { ...first, enabled: false };
  const query = spyOn(app, "querySelf").mockResolvedValue({ packs: [first] });
  let changes = 0;
  const unsubscribe = subscribeDecoderPacks(() => { changes++; });
  try {
    expect(enabledDecoderPacks(await readDecoderPacks())).toHaveLength(1);
    query.mockResolvedValue({ packs: [disabled] });
    walletStateChanged!({ topic: "evm_wallet", revision: "remote-disable" });
    expect(changes).toBe(1);
    expect(enabledDecoderPacks(await readDecoderPacks())).toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(publishState).not.toHaveBeenCalled();
  } finally {
    unsubscribe(); query.mockRestore(); invalidateDecoderPacks();
  }
});

test("a remote removal fences an older inventory read so it cannot restore deleted definitions", async () => {
  invalidateDecoderPacks();
  let finishOld!: (value: { packs: Wire[] }) => void;
  const oldReply = new Promise<{ packs: Wire[] }>(resolve => { finishOld = resolve; });
  const query = spyOn(app, "querySelf").mockReturnValueOnce(oldReply).mockResolvedValue({ packs: [] });
  try {
    const oldRead = readDecoderPacks();
    walletStateChanged!({ topic: "evm_wallet", revision: "remote-remove" });
    expect(await readDecoderPacks()).toEqual([]);
    finishOld({ packs: [stored()] });
    expect(await oldRead).toHaveLength(1);
    expect(await readDecoderPacks()).toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
  } finally {
    finishOld({ packs: [] }); query.mockRestore(); invalidateDecoderPacks();
  }
});

test("notification failure does not undo a committed decoder save or retain stale local definitions", async () => {
  invalidateDecoderPacks();
  const row = stored();
  const query = spyOn(app, "querySelf").mockResolvedValue({ packs: [] });
  const update = spyOn(app, "updateSelf").mockResolvedValue(row);
  publishState.mockRejectedValue(new Error("The other Wallet endpoint closed"));
  try {
    expect(await readDecoderPacks()).toEqual([]);
    query.mockResolvedValue({ packs: [row] });
    expect(await installDecoderPack(row.document_json)).toMatchObject({ id: row.id, enabled: true });
    expect(enabledDecoderPacks(await readDecoderPacks())).toHaveLength(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(publishState).toHaveBeenCalledTimes(1);
  } finally {
    query.mockRestore(); update.mockRestore(); invalidateDecoderPacks();
  }
});
