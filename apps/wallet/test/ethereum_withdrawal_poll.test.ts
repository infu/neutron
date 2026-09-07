import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { refreshSubmittedWithdrawals } from "../src/ethereum_withdrawal_controller.ts";
import * as transfers from "../src/transfers.ts";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
const source = readFileSync(new URL("../src/index.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const transferPollState = useRef(");
const end = source.indexOf("\n  if (!snapshot)", start);
if (start < 0 || end < 0) throw new Error("Wallet withdrawal progress controller not found");
const controller = transformSync(source.slice(start, end), { loader: "tsx", target: "es2022" }).code;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("actual visible Wallet poll discovers Agent withdrawals, never resumes, and clears a reconciled local request", async () => {
  const owner = "withdraw-poll-owner";
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } });
  const ledger = "xevnm-gaaaa-aaaar-qafnq-cai";
  const saved = transfers.saveWalletTransfer(owner, { ledger, amount: "3000000", network: { ethereum_mainnet: null } });
  const agentId = "ab".repeat(16);
  const hash = `0x${"cd".repeat(32)}`;
  const makeWire = (id: string, confirmed: boolean) => ({
    request_id: transfers.transferIdBytes(id), ledger, amount: "3000000", destination: `0x${"11".repeat(20)}`, native: true,
    status: confirmed ? { succeeded: { block_index: "7", duplicate: false, native: true } } : { pending: null },
    ...(confirmed ? { settlement: { checked_at: "1", status: { confirmed: { transaction_hash: hash } } } } : {}),
  });
  let visible = true;
  let tick: (() => void) | null = null;
  let cleanup: (() => void) | null = null;
  let id = saved.requestId;
  let pending: transfers.WalletTransferOperation[] = [];
  const methods: string[] = [];
  const bindings = {
    ...transfers,
    snapshot: { owner }, surface: "tile", transferBusy: false,
    useRef: (current: unknown) => ({ current }),
    useEffect: (effect: () => () => void) => { cleanup = effect(); },
    document: { get visibilityState() { return visible ? "visible" : "hidden"; }, addEventListener: () => {}, removeEventListener: () => {} },
    window: { setInterval: (fn: () => void) => { tick = fn; return 1; }, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
    querySelf: async (method: string) => { methods.push(method); return [makeWire(id, false)]; },
    updateSelf: async (method: string) => {
      methods.push(method);
      if (method === "wallet_transfer_refresh_v2") return makeWire(id, true);
      if (method === "wallet_transfer_acknowledge_v2") return null;
      if (method === "wallet_refresh_balances") return {};
      throw new Error(`Automatic polling dispatched ${method}`);
    },
    refreshSubmittedWithdrawals,
    setPendingTransfers: (value: transfers.WalletTransferOperation[]) => { pending = value; },
    setSnapshot: () => {}, parseWalletSnapshotResult: (value: unknown) => value,
    publishWalletInvalidation: () => {},
  };
  new Function(...Object.keys(bindings), controller)(...Object.values(bindings));
  await flush();
  expect(methods).toEqual(["wallet_transfers_pending_v2", "wallet_transfer_refresh_v2", "wallet_transfer_acknowledge_v2", "wallet_refresh_balances"]);
  expect(pending[0]?.settlement?.status).toBe("confirmed");
  expect(transfers.loadSavedWalletTransfers(owner)).toEqual([]);

  // A new Agent request appears after mount, without an owner/dependency change.
  methods.length = 0;
  id = agentId;
  tick!();
  await flush();
  expect(pending).toHaveLength(1);
  expect(pending[0]?.requestId).toBe(agentId);
  expect(methods).toEqual(["wallet_transfers_pending_v2", "wallet_transfer_refresh_v2", "wallet_transfer_acknowledge_v2", "wallet_refresh_balances"]);
  methods.length = 0;
  visible = false;
  tick!();
  await flush();
  expect(methods).toEqual([]);
  cleanup!();
});

const destinationStart = source.indexOf('  const destinationView = useRef("");');
const destinationEnd = source.indexOf("\n  useEffect(() => {", destinationStart);
if (destinationStart < 0 || destinationEnd < 0) throw new Error("Wallet destination loader not found");
const destinationController = transformSync(source.slice(destinationStart, destinationEnd), { loader: "tsx", target: "es2022" }).code;

test("actual Ethereum destination loader skips Contacts for direct recipients and ignores an outdated Contacts failure", async () => {
  const errors: unknown[] = [];
  const queries: string[] = [];
  let rejectRead: ((reason: unknown) => void) | null = null;
  const make = (ethereumMode: "evm" | "address" | "contacts") => {
    const bindings = {
      ethereumMode, destinationLedgerId: "xevnm-gaaaa-aaaar-qafnq-cai", destinationNetwork: "ethereum_mainnet", destinationQuery: "",
      useRef: (current: unknown) => ({ current }), useCallback: (fn: unknown) => fn,
      setDestinationBusy: () => {}, setDestinationPage: () => {}, setError: (value: unknown) => errors.push(value),
      networkVariant: (network: string) => ({ [network]: null }), errorMessage: String,
      parseWalletContactDestinations: (value: unknown) => value,
      querySelf: (method: string) => { queries.push(method); return new Promise((_resolve, reject) => { rejectRead = reject; }); },
    };
    return new Function(...Object.keys(bindings), `${destinationController}\nreturn {loadDestinations, destinationView};`)(...Object.values(bindings)) as {
      loadDestinations: () => Promise<void>; destinationView: { current: string };
    };
  };
  await make("evm").loadDestinations();
  await make("address").loadDestinations();
  expect(queries).toEqual([]);
  const contacts = make("contacts");
  const pending = contacts.loadDestinations();
  expect(queries).toEqual(["wallet_contact_destinations"]);
  contacts.destinationView.current = "switched-to-direct-address";
  rejectRead!(new Error("Contacts unavailable"));
  await pending;
  expect(errors).toEqual([]);
});
