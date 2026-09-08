import { describe, expect, test } from "bun:test";
import { createFundingRequest, createDirectFundingRequest, poolDepositAccount, parseFundingRequest } from "../src/funding.ts";
import { continueOperationFunding, type FundingOperation, type FundingStore } from "../src/funding_workflow.ts";
import { decodeIcrcAccount } from "neutron-tools/src/icrc_account.js";

const NOW = 1_788_000_000_000;
const POOL = "mohjv-bqaaa-aaaag-qjyia-cai";
const OWNER = "3rurp-vyaaa-aaaay-aacua-cai";
const ICP = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const USDC = "xevnm-gaaaa-aaaar-qafnq-cai";
const ID = "11".repeat(16), ID2 = "22".repeat(16);
const funding = (id = ID, nowMs = NOW) => createFundingRequest({ requestId: id, ledger: ICP, spender: POOL, amountAtoms: "1000000", nowMs });
const reply = (id = ID, status = "approved") => ({ status, commandId: `agent:${id}`, blockIndex: "42", duplicate: false, message: null });
function fixture(override: Partial<FundingOperation> = {}) {
  let record: FundingOperation = { id: "aa".repeat(16), input_json: "{}", plan_json: "{}", funding_json: "", state: "prepared", detail: "", result_json: "", revision: "0", created_at: String(NOW), updated_at: String(NOW), ...override };
  const events: string[] = [], calls: unknown[] = [];
  const store: FundingStore = {
    get: async () => structuredClone(record),
    update: async (value) => {
      if (value.expected_revision !== record.revision) throw new Error("Action changed; reload");
      events.push(`save:${value.state}`);
      record = { ...record, ...value, revision: String(BigInt(record.revision) + 1n) };
      return structuredClone(record);
    },
  };
  let send: (call: any) => Promise<any> = async (call) => reply(call.arguments.requestId);
  const client = { callTool: async (call: unknown) => { calls.push(call); events.push("wallet"); return send(call); } } as never;
  return { store, client, events, calls, read: () => structuredClone(record), setSend: (value: typeof send) => { send = value; } };
}

describe("operation funding", () => {
  test("normal Agent persists requests before Wallet UI and retains each result", async () => {
    const f = fixture();
    const result = await continueOperationFunding({ operation: f.read(), store: f.store, client: f.client, rootMode: false, nowMs: NOW,
      createRequests: () => [funding(), { ...funding(ID2), ledger: USDC }] });
    expect(result.status).toBe("ready");
    expect(f.events).toEqual(["save:prepared", "save:funding_requested", "wallet", "save:funding_requested", "wallet", "save:funding_requested", "save:funded"]);
    expect(f.calls.map((call: any) => call.name)).toEqual(["wallet_fund_v1", "wallet_fund_v1"]);
    expect(JSON.parse(f.read().result_json).results).toHaveLength(2);
  });

  test("root returns exact direct-call instructions, with no nested Wallet dispatch", async () => {
    const f = fixture();
    const result = await continueOperationFunding({ operation: f.read(), store: f.store, client: f.client, rootMode: true, nowMs: NOW, createRequests: () => [funding()] });
    expect(result.status).toBe("funding_required");
    expect(f.calls).toHaveLength(0);
    expect(result.fundingInstructions).toEqual([{ target: "app:wallet:background", name: "wallet_fund_root_v1", arguments: funding() }]);
    expect(f.read().state).toBe("funding_requested");
    const completed = await continueOperationFunding({ operation: f.read(), store: f.store, client: f.client, rootMode: true,
      nowMs: NOW, createRequests: () => { throw new Error("Must not recreate"); }, fundingResults: [reply()] });
    expect(completed.status).toBe("ready");
    expect(f.calls).toHaveLength(0);
  });

  test("a lost Wallet reply resumes exact bytes after reload without regenerating expired requests", async () => {
    const f = fixture();
    f.setSend(async () => { throw new Error("Reply lost after approval"); });
    const initial = await continueOperationFunding({ operation: f.read(), store: f.store, client: f.client, rootMode: false, nowMs: NOW, createRequests: () => [funding()] });
    expect(initial.status).toBe("pending");
    expect(f.read().state).toBe("funding_requested");
    f.setSend(async () => ({ ...reply(), duplicate: true }));
    const resumed = await continueOperationFunding({ operation: f.read(), store: f.store, client: f.client, rootMode: false,
      nowMs: NOW + 600_000, createRequests: () => { throw new Error("Uncertain requests must not renew"); } });
    expect(resumed.status).toBe("ready");
    expect(f.calls[1]).toEqual(f.calls[0]);
  });

  test("expired unsent requests renew under a journal revision before review", async () => {
    const f = fixture({ funding_json: JSON.stringify([funding()]) });
    const nowMs = NOW + 600_000;
    const result = await continueOperationFunding({ operation: f.read(), store: f.store, client: f.client, rootMode: true,
      nowMs, createRequests: (time) => [funding(ID2, time)] });
    expect(result.fundingInstructions[0]!.arguments.requestId).toBe(ID2);
    expect(f.events).toEqual(["save:prepared", "save:funding_requested"]);
  });

  test("a lost second leg never repeats the already acknowledged first leg", async () => {
    const f = fixture();
    f.setSend(async (call) => call.arguments.requestId === ID ? reply() : Promise.reject(new Error("Interrupted")));
    await continueOperationFunding({ operation: f.read(), store: f.store, client: f.client, rootMode: false, nowMs: NOW, createRequests: () => [funding(), funding(ID2)] });
    f.setSend(async () => reply(ID2));
    const result = await continueOperationFunding({ operation: f.read(), store: f.store, client: f.client, rootMode: false, nowMs: NOW, createRequests: () => [] });
    expect(result.status).toBe("ready");
    expect(f.calls.map((call: any) => call.arguments.requestId)).toEqual([ID, ID2, ID2]);
  });

  test("a stale journal revision dispatches no Wallet request", async () => {
    const f = fixture();
    const stale = f.read();
    await f.store.update({ ...stale, expected_revision: stale.revision, detail: "Other invocation" });
    await expect(continueOperationFunding({ operation: stale, store: f.store, client: f.client, rootMode: false, nowMs: NOW, createRequests: () => [funding()] })).rejects.toThrow("reload");
    expect(f.calls).toHaveLength(0);
  });

  test("an unrelated root funding acknowledgment cannot mark this operation funded", async () => {
    const f = fixture({ state: "funding_requested", funding_json: JSON.stringify([funding()]) });
    await expect(continueOperationFunding({ operation: f.read(), store: f.store, client: f.client, rootMode: true, nowMs: NOW,
      createRequests: () => [], fundingResults: [reply(ID2)] })).rejects.toThrow("does not match");
    expect(f.read().state).toBe("funding_requested");
  });

  test("normal Agent ignores supplied acknowledgments and obtains Wallet owner review", async () => {
    const f = fixture({ state: "funding_requested", funding_json: JSON.stringify([funding()]) });
    f.setSend(async () => reply(ID, "rejected"));
    const result = await continueOperationFunding({ operation: f.read(), store: f.store, client: f.client, rootMode: false, nowMs: NOW,
      createRequests: () => [], fundingResults: [reply()] });
    expect(result.status).toBe("rejected");
    expect(f.calls).toHaveLength(1);
    expect(f.read().state).toBe("funding_requested");
  });

  test("cancelled tracking cannot dispatch funding", async () => {
    const f = fixture();
    const controller = new AbortController(); controller.abort(new Error("Stopped"));
    await expect(continueOperationFunding({ operation: f.read(), store: f.store, client: f.client, rootMode: false, nowMs: NOW,
      createRequests: () => [funding()], signal: controller.signal })).rejects.toThrow("Stopped");
    expect(f.calls).toHaveLength(0);
  });

  test("pool dispatch and terminal states are never reset by funding continuation", async () => {
    for (const state of ["execution_requested", "uncertain", "protocol_complete", "settlement_pending", "cancelled"]) {
      const f = fixture({ state });
      const result = await continueOperationFunding({ operation: f.read(), store: f.store, client: f.client, rootMode: false, nowMs: NOW, createRequests: () => { throw new Error("No new funding"); } });
      expect(result.status).toBe("inactive"); expect(f.events).toHaveLength(0); expect(f.calls).toHaveLength(0);
    }
  });
});

describe("ICRC1 pool funding", () => {
  test("uses canonical owner-derived pool subaccount and includes precisely one deposit fee", () => {
    const request = createDirectFundingRequest({ requestId: ID, ledger: ICP, pool: POOL, owner: OWNER, amountAtoms: "1000000", feeAtoms: "10000", nowMs: NOW });
    expect(request.amountAtoms).toBe("1010000");
    expect(parseFundingRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
    const account = decodeIcrcAccount(request.route.to), owner = decodeIcrcAccount(OWNER).owner.toUint8Array();
    expect(account.owner.toText()).toBe(POOL);
    expect(account.subaccount![0]).toBe(owner.length);
    expect(Array.from(account.subaccount!.slice(1, owner.length + 1))).toEqual(Array.from(owner));
    expect(Array.from(account.subaccount!.slice(owner.length + 1))).toEqual(Array(31 - owner.length).fill(0));
  });

  test("does not let a principal subaccount become a different pool caller", () => {
    expect(() => poolDepositAccount(POOL, poolDepositAccount(POOL, OWNER))).toThrow("principals");
  });

  test("direct funding requires a transferred Wallet result", async () => {
    const request = createDirectFundingRequest({ requestId: ID, ledger: ICP, pool: POOL, owner: OWNER, amountAtoms: "1000000", feeAtoms: "10000", nowMs: NOW });
    const f = fixture();
    f.setSend(async () => reply(ID, "transferred"));
    const result = await continueOperationFunding({ operation: f.read(), store: f.store, client: f.client, rootMode: false, nowMs: NOW, createRequests: () => [request] });
    expect(result.status).toBe("ready");
    const wrong = fixture();
    const rejected = await continueOperationFunding({ operation: wrong.read(), store: wrong.store, client: wrong.client, rootMode: false, nowMs: NOW, createRequests: () => [request] });
    expect(rejected.status).toBe("pending");
    expect(rejected.message).toContain("does not match the saved route");
  });
});
