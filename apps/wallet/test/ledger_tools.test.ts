import { expect, test } from "bun:test";
import { validateToolArguments, validateToolResult, type MsgBusToolDescriptor } from "neutron-tools/protocol";
import type { JsonObject, JsonValue, MsgBusToolContext } from "neutron-tools/app";
import {
  handleWalletAddLedger,
  handleWalletAddLedgerPresentation,
  handleWalletAddLedgerRoot,
  walletAddLedgerInputSchema,
  walletAddLedgerOutputSchema,
  type WalletLedgerServices,
} from "../src/ledger_tools.ts";

const ledger = "togwv-zqaaa-aaaal-qr7aa-cai";
const other = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const owner = "3rurp-vyaaa-aaaay-aacua-cai";
const descriptor = { name: "wallet_add_ledger_v1", inputSchema: walletAddLedgerInputSchema, outputSchema: walletAddLedgerOutputSchema } as MsgBusToolDescriptor;

function fixture(initial: string[] = [other]) {
  const selected = new Set(initial);
  const calls: Array<{ kind: string; value: unknown }> = [];
  const access = new Map<string, JsonObject>();
  let metadataError: Error | null = null;
  let replyLost = false;
  let metadataLedger = ledger;
  const abort = new AbortController();
  const snapshot = () => ({ owner, configured: true, ledgers: [...selected].map((principal, id) => ({ id: String(id), principal })) });
  const context = {
    audience: "agent_root", agentMode: true,
    caller: { appId: "agent", endpoint: "app:agent:tile:root", role: "tile", installationUid: "47" },
    signal: abort.signal,
    reportProgress() {},
    requestApproval: async (review: JsonObject) => { calls.push({ kind: "judge", value: review }); },
    presentUserInterface: async () => { throw new Error("Root must not open owner UI"); },
    kernel: {
      querySelf: async (method: string, args: JsonObject[]) => {
        calls.push({ kind: "query", value: method });
        if (method === "wallet_read_v1" && "snapshot" in args[0]!) return { snapshot: snapshot() };
        if (method === "wallet_read_v1" && "catalog" in args[0]!) return { catalog: [] };
        throw new Error(`Unexpected query ${method}`);
      },
      callTool: async (request: { name: string }) => {
        calls.push({ kind: "tool", value: request });
        if (request.name === "backend_calls.list") return { reservations: [...access.values()] };
        throw new Error("Access changes must use the scoped combined transport");
      },
      updateSelf: async (method: string, args: unknown[]) => {
        calls.push({ kind: "update", value: { method, args } });
        if (method !== "wallet_token_info_v1") throw new Error("Selection must use the reviewed combined transport");
        if (metadataError) throw metadataError;
        return {
          ledger: metadataLedger, account: { owner }, token_name: "Test token", token_symbol: "TEST",
          decimals: "6", fee_atoms: "0", balance_atoms: "9007199254740993000000", observed_at_ns: "1788900000000000000",
        };
      },
    },
  } as unknown as MsgBusToolContext;
  const services: WalletLedgerServices = {
    requestAccess: async (kernel, request) => {
      expect(kernel).toBe(context.kernel);
      calls.push({ kind: "access", value: request });
      for (const action of request.actions) {
        expect(action.kind).toBe("reserve");
        expect(action.scope).toEqual({ kind: "principal", principal: ledger });
        if (action.scope.kind === "principal") access.set(action.scope.principal, {
          scopeKind: "principal", principal: action.scope.principal,
        });
      }
      expect(request.call).toEqual({ method: "wallet_add_ledger_v1", args: [ledger] });
      // Model the backend's atomic additive method, not a stale full selection.
      selected.add(ledger);
      if (replyLost) { replyLost = false; throw new Error("reply lost after selection"); }
      return { callResult: snapshot() };
    },
    publish: async () => { calls.push({ kind: "publish", value: null }); },
  };
  return { context, calls, services, selected, access, abort,
    failMetadata: (error: Error) => { metadataError = error; },
    loseReply: () => { replyLost = true; },
    wrongMetadataLedger: () => { metadataLedger = other; },
  };
}

test("Root adds a custom ledger through exclusive principal access and returns compact live metadata", async () => {
  const f = fixture();
  const result = await handleWalletAddLedgerRoot({ ledger }, f.context, f.services);
  expect(result).toMatchObject({ ledger, selected: true, alreadySelected: false, metadataError: null,
    tokenInfo: { decimals: 6, feeAtoms: "0", balanceAtoms: "9007199254740993000000", account: owner },
  });
  expect(() => validateToolResult(descriptor, result)).not.toThrow();
  const request = f.calls.find(({ kind }) => kind === "access")!.value as { actions: unknown[] };
  expect(request.actions).toEqual([{ kind: "reserve", scope: { kind: "principal", principal: ledger } }]);
  expect(f.selected).toEqual(new Set([other, ledger]));
  expect(f.calls.some(({ kind }) => kind === "judge")).toBe(false);
  expect(JSON.stringify(result)).not.toContain("logo");
});

test("Root variant rejects caller-controlled mode without Kernel root audience before any reads or effects", async () => {
  const f = fixture();
  const { audience: _audience, ...unattested } = f.context;
  await expect(handleWalletAddLedgerRoot({ ledger }, unattested, f.services)).rejects.toThrow("root-agent attestation");
  expect(f.calls).toHaveLength(0);
});

test("public Root tool reviews the exact retained ledger without opening a tile", async () => {
  const f = fixture();
  await handleWalletAddLedger({ ledger }, f.context, f.services);
  const judge = f.calls.find(({ kind }) => kind === "judge")!;
  expect(judge.value).toMatchObject({ kind: "wallet_add_ledger", ledger, alreadySelected: false, symbol: null });
  expect(f.calls.indexOf(judge)).toBeLessThan(f.calls.findIndex(({ kind }) => kind === "access"));
});

test("Normal provider delegates one foreground Wallet review without performing reads or mutations", async () => {
  const f = fixture();
  const result = { ledger, selected: true, alreadySelected: false, tokenInfo: null, metadataError: "offline" };
  const requests: unknown[] = [];
  const context = { ...f.context, agentMode: false, audience: undefined,
    presentUserInterface: async (request: unknown) => { requests.push(request); return result; },
  } as unknown as MsgBusToolContext;
  await expect(handleWalletAddLedger({ ledger }, context, f.services)).resolves.toEqual(result);
  expect(requests).toEqual([{ tileId: "wallet", tool: "wallet_add_ledger_present_v1", arguments: { ledger } }]);
  expect(f.calls).toHaveLength(0);
});

test("private presentation requires Kernel foreground attestation and uses one combined access review", async () => {
  const f = fixture();
  await expect(handleWalletAddLedgerPresentation({ ledger }, f.context, f.services)).rejects.toThrow("foreground-tile attestation");
  expect(f.calls).toHaveLength(0);
  await handleWalletAddLedgerPresentation({ ledger }, { ...f.context, agentMode: false, audience: "foreground_tile" }, f.services);
  expect(f.calls.filter(({ kind }) => kind === "access")).toHaveLength(1);
  expect(f.calls.filter(({ kind }) => kind === "judge")).toHaveLength(0);
});

test("declined or cancelled Root review does not request access or select the ledger", async () => {
  for (const cancel of [false, true]) {
    const f = fixture();
    f.context.requestApproval = async () => { if (cancel) f.abort.abort(); else throw new Error("declined"); };
    await expect(handleWalletAddLedger({ ledger }, f.context, f.services)).rejects.toThrow();
    expect(f.calls.some(({ kind }) => kind === "access")).toBe(false);
    expect(f.selected.has(ledger)).toBe(false);
  }
});

test("same-ledger recovery after a lost reply keeps current selections and refreshes metadata", async () => {
  const f = fixture();
  f.loseReply();
  await expect(handleWalletAddLedgerRoot({ ledger }, f.context, f.services)).rejects.toThrow("reply lost");
  expect(f.selected).toEqual(new Set([other, ledger]));
  // A different owner/agent selection made between calls remains untouched.
  f.selected.add("xevnm-gaaaa-aaaar-qafnq-cai");
  const result = await handleWalletAddLedgerRoot({ ledger }, f.context, f.services);
  expect(result).toMatchObject({ selected: true, alreadySelected: true, metadataError: null });
  const actions = f.calls.filter(({ kind }) => kind === "access").map(({ value }) => (value as { actions: unknown[] }).actions);
  expect(actions.map((action) => action.length)).toEqual([1, 0]);
  expect(f.selected.size).toBe(3);
});

test("an already selected custom ledger still requires exclusive principal access", async () => {
  const f = fixture([other, ledger]);
  for (const method of ["icrc1_fee", "icrc1_transfer", "icrc2_approve"]) {
    f.access.set(`${ledger}:${method}`, { scopeKind: "exact", principal: ledger, method });
  }
  const result = await handleWalletAddLedgerRoot({ ledger }, f.context, f.services);
  expect(result).toMatchObject({ selected: true, alreadySelected: true });
  const request = f.calls.find(({ kind }) => kind === "access")!.value as { actions: unknown[] };
  expect(request.actions).toEqual([{ kind: "reserve", scope: { kind: "principal", principal: ledger } }]);
  expect(f.selected).toEqual(new Set([other, ledger]));
});

test("metadata failure is explicit after durable selection and never invents a zero balance", async () => {
  const f = fixture();
  f.failMetadata(new Error("ledger metadata temporarily unavailable"));
  const result = await handleWalletAddLedgerRoot({ ledger }, f.context, f.services);
  expect(result).toEqual({ ledger, selected: true, alreadySelected: false, tokenInfo: null, metadataError: "ledger metadata temporarily unavailable" });
  expect(f.selected.has(ledger)).toBe(true);
  expect(() => validateToolResult(descriptor, result)).not.toThrow();
});

test("metadata from another ledger is not passed to a swap planner", async () => {
  const f = fixture();
  f.wrongMetadataLedger();
  const result = await handleWalletAddLedgerRoot({ ledger }, f.context, f.services);
  expect(result).toMatchObject({ selected: true, tokenInfo: null, metadataError: "Wallet returned token information for another ledger" });
});

test("invalid ledger requests fail before any authority request", async () => {
  for (const args of [{ ledger: "aaaaa-aa" }, { ledger: "2vxsx-fae" }, { ledger: "invalid" }, { ledger, agentMode: true }]) {
    const f = fixture();
    await expect(handleWalletAddLedgerRoot(args, f.context, f.services)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  }
  expect(() => validateToolArguments(descriptor, { ledger, agentMode: true })).toThrow();
});
