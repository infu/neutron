import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { extractPublicTypeAliases, motokoTypeToIdl } from "neutron-scripts/src/method_schema.js";
import { encodeSelfCallResult, materializeSelfCallArguments, normalizeSelfCallResult } from "../../kernel/src/self_calls.ts";
import {
  finishSavedWalletTransfer,
  loadSavedWalletTransfers,
  parseTransferOperation,
  saveWalletTransfer,
  savedTransferArgs,
  transferIdBytes,
} from "../src/transfers.ts";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  } });
});
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
function intent(amount = "10") {
  return { ledger: "ryjl3-tyaaa-aaaaa-aaaba-cai", network: { internet_computer: null },
    amount, contact_id: "1", contact_revision: "7", address_id: "2",
    expected_destination: { internet_computer: { owner: "aaaaa-aa", subaccount: Uint8Array.from({ length: 32 }, (_, index) => index) } },
  };
}

test("a saved send reuses its ID after reload and retains exact binary subaccount", () => {
  const original = saveWalletTransfer("owner", intent());
  const restored = loadSavedWalletTransfers("owner")[0]!;
  expect(restored).toEqual(original);
  expect(savedTransferArgs(restored)).toEqual({ request_id: transferIdBytes(original.requestId), transfer: intent() });
  expect(saveWalletTransfer("owner", intent()).requestId).toBe(original.requestId);
  expect(loadSavedWalletTransfers("owner")).toHaveLength(1);
});

test("distinct transfer intents retain distinct recovery records and completion removes only its own", () => {
  const first = saveWalletTransfer("owner", intent());
  const second = saveWalletTransfer("owner", intent("20"));
  expect(first.requestId).not.toBe(second.requestId);
  finishSavedWalletTransfer("owner", first.requestId);
  expect(loadSavedWalletTransfers("owner")).toEqual([second]);
  expect(loadSavedWalletTransfers("another-owner")).toEqual([]);
});


test("unreadable persisted transfer never silently creates a fresh request", () => {
  storage.set("wallet:transfers:v2:corrupt-owner", "broken-json");
  expect(() => saveWalletTransfer("corrupt-owner", intent())).toThrow();
  expect(storage.get("wallet:transfers:v2:corrupt-owner")).toBe("broken-json");
});

test("opaque-origin storage denial still permits a stable prepared request ID", () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new DOMException("Opaque origin", "SecurityError"); } });
  const saved = saveWalletTransfer("opaque-owner", intent());
  expect(saveWalletTransfer("opaque-owner", intent())).toEqual(saved);
  expect(loadSavedWalletTransfers("opaque-owner")).toEqual([saved]);
  finishSavedWalletTransfer("opaque-owner", saved.requestId);
  expect(loadSavedWalletTransfers("opaque-owner")).toEqual([]);
});

test("backend unresolved outcome stays pending and malformed success is not accepted", () => {
  const operation = { request_id: new Uint8Array(16), ledger: "ryjl3-tyaaa-aaaaa-aaaba-cai", amount: "10", destination: "aaaaa-aa", status: { pending: null }, message: "Reply was lost" };
  expect(parseTransferOperation(operation)).toMatchObject({ status: "pending", receipt: null, message: "Reply was lost" });
  expect(() => parseTransferOperation({ ...operation, status: { succeeded: {}, pending: null } })).toThrow();
  expect(() => parseTransferOperation({ ...operation, request_id: new Uint8Array(15) })).toThrow();
  expect(() => parseTransferOperation({ ...operation, status: { succeeded: {} } })).toThrow();
});

test("an accepted minter burn remains separate from native settlement", () => {
  const record = { request_id: new Uint8Array(16), ledger: "ss2fx-dyaaa-aaaar-qacoq-cai", amount: "10", destination: "0x1111111111111111111111111111111111111111", native: true,
    status: { succeeded: { block_index: "42", duplicate: false, native: true } },
    settlement: { checked_at: "1", status: { pending: "Burn accepted; native payment pending" } } };
  expect(parseTransferOperation(record)).toMatchObject({ status: "succeeded", native: true, settlement: { status: "pending", transactionHash: null } });
  expect(parseTransferOperation({ ...record, settlement: { checked_at: "2", status: { confirmed: { transaction_hash: `0x${"a".repeat(64)}` } } } })).toMatchObject({ settlement: { status: "confirmed", transactionHash: `0x${"a".repeat(64)}` } });
});

test("actual private self-call Candid binding preserves default and binary ICRC subaccounts", () => {
  const aliases = extractPublicTypeAliases(readFileSync(new URL("../backend/main.mo", import.meta.url), "utf8"));
  const input = motokoTypeToIdl(aliases.wallet_transfer_v2_Input!, IDL, aliases);
  for (const subaccount of [null, new Uint8Array(32).fill(7)]) {
    const saved = saveWalletTransfer("owner", { ...intent(), expected_destination: { internet_computer: { owner: "aaaaa-aa", subaccount } } });
    const encoded = encodeSelfCallResult([savedTransferArgs(saved)]);
    const bound = materializeSelfCallArguments(encoded.value, encoded.blobs, [input]);
    expect(bound.args).toEqual([{ ...savedTransferArgs(saved), withdrawal_quote: null }]);
    expect(bound.binary.count).toBe(subaccount === null ? 1 : 2);
  }
});

test("actual Candid operation projection unwraps the result and preserves accepted native settlement", () => {
  const aliases = extractPublicTypeAliases(readFileSync(new URL("../backend/main.mo", import.meta.url), "utf8"));
  const output = motokoTypeToIdl(aliases.wallet_transfer_v2_Output!, IDL, aliases);
  const ledger = Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
  const receipt = { ledger, native: true, contact_id: 1n, address_id: 2n, amount: 10n, fee: 1n, block_index: 42n, secondary_block_index: [], duplicate: false };
  const native = { ok: { request_id: new Uint8Array(16), ledger, amount: 10n, native: true, destination: "0x1111111111111111111111111111111111111111", created_at_ns: 1n, message: [],
    status: { succeeded: receipt }, settlement: [{ checked_at: 2n, status: { pending: "Burn accepted; native payment pending" } }] } };
  const projected = normalizeSelfCallResult(native, output);
  expect(parseTransferOperation(projected)).toMatchObject({ ledger: ledger.toText(), amount: "10", status: "succeeded", native: true, settlement: { status: "pending" } });
});
