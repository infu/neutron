import { beforeEach, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import type { MsgBusToolContext } from "neutron-tools/app";
import { CONTRACT, type Info } from "../src/protocol.ts";

if (process.env.NEUTRON_MARKETPLACE_SOURCE_GRANT_CHILD !== "1") {
  test("source access uses the retained Candid request and keeps bearer credentials out of errors", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NEUTRON_MARKETPLACE_SOURCE_GRANT_CHILD: "1" }, timeout: 30_000,
      });
      expect(result.stderr).toContain("0 fail");
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  }, 35_000);
} else {
  const canister = "sj2r4-haaaa-aaaay-aadgq-cai", owner = "3rurp-vyaaa-aaaay-aacua-cai";
  const token = "ae".repeat(32), requestId = "ab".repeat(16);
  const paths = ["aa", "bb"].map(prefix => `/repo/v1/packages/${prefix.repeat(32)}.neutron`);
  const request = () => ({ request_id: requestId, token, paths: [...paths], fee_version: 7n });
  const cycles = 250_000_000n;
  const info: Info = {
    version: 1n, canister: Principal.fromText(canister), tokens: [],
    fees: { version: 99n, updateBase: 100n, updateByte: 2n, storageByteYear: 3n, purchase: 200n, withdraw: 200n, grant: 300n, xrc: 400n },
    referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n },
  };
  // Independent source ABI, rather than the app's own type used on both sides:
  // a camelCase fee or request field must fail the wire-contract assertion.
  const requestType = IDL.Record({ request_id: IDL.Text, token: IDL.Text, paths: IDL.Vec(IDL.Text), fee_version: IDL.Nat });
  const receiptType = IDL.Record({ request_id: IDL.Text, paths: IDL.Vec(IDL.Text), accepted_cycles: IDL.Nat });
  const resultType = IDL.Variant({ ok: receiptType, err: IDL.Record({ code: IDL.Text, message: IDL.Text }) });
  const receipt = () => ({ ok: { request_id: requestId, paths: [...paths], accepted_cycles: cycles } });
  type Relay = { canister: string; method: string; args: Uint8Array; cycles: string };
  const calls = { queries: [] as string[], reservations: 0, updates: [] as Array<{ method: string; input: Relay; timeout: number }> };
  let reply: unknown;
  let relayError: Error | null;
  let reservationEffect: (() => void) | null;
  const actualTransport = await import("../src/transport.ts");
  mock.module("../src/transport.ts", () => ({
    ...actualTransport,
    makeAgent: async () => ({
      query: async (_canister: Principal, input: { methodName: string }) => {
        calls.queries.push(input.methodName);
        if (input.methodName !== "marketplace_info") throw new Error("Unexpected source-grant query");
        return { status: "replied", reply: { arg: IDL.encode(CONTRACT.marketplace_info!.returns, [info]) } };
      },
    }),
  }));
  const { clearClient, protocolClient } = await import("../src/client.ts");
  const context = (signal = new AbortController().signal) => ({ signal, kernel: {
    querySelf: async (method: string) => {
      if (method !== "marketplace_state") throw new Error("Unexpected local query");
      return { seed: [], canister: [canister], host: "https://icp-api.io", owner, revision: 1 };
    },
    callTool: async (input: { target: string; name: string }) => {
      expect(input).toEqual({ target: "kernel", name: "backend_calls.list", arguments: {} });
      calls.reservations++;
      reservationEffect?.();
      return { reservations: actualTransport.UPDATE_METHODS.map(method => ({ scopeKind: "exact", principal: canister, method })) };
    },
    updateSelf: async (method: string, args: Relay[], timeout: number) => {
      calls.updates.push({ method, input: structuredClone(args[0]!), timeout });
      if (relayError) throw relayError;
      return reply instanceof Uint8Array ? reply : new Uint8Array(IDL.encode([resultType], [reply]));
    },
  } }) as unknown as MsgBusToolContext;
  beforeEach(() => {
    clearClient(); reply = receipt(); relayError = null; reservationEffect = null;
    calls.queries.length = 0; calls.reservations = 0; calls.updates.length = 0;
  });

  test("sends one exact source request and reviewed cycle amount through the existing relay", async () => {
    const client = await protocolClient(context());
    const input = request();
    await client.grantSourceAccess(input, cycles);
    expect(calls.queries).toEqual(["marketplace_info"]);
    expect(calls.reservations).toBe(1);
    expect(calls.updates).toHaveLength(1);
    const sent = calls.updates[0]!;
    expect(sent.method).toBe("marketplace_call");
    expect(sent.timeout).toBe(0);
    expect(sent.input.canister).toBe(canister);
    expect(sent.input.method).toBe("repo_access_v1");
    expect(sent.input.cycles).toBe(String(cycles));
    expect(IDL.decode([requestType], sent.input.args)).toEqual([input]);
    expect(sent.input.args).toEqual(new Uint8Array(IDL.encode([requestType], [input])));
    expect(input).toEqual(request());
  });

  test("accepts a replay receipt that charges fewer than the reviewed cycles", async () => {
    reply = { ok: { ...receipt().ok, accepted_cycles: 0n } };
    await (await protocolClient(context())).grantSourceAccess(request(), cycles);
    expect(calls.updates).toHaveLength(1);
  });

  for (const [label, changed] of [
    ["request identity", { ...receipt().ok, request_id: "cd".repeat(16) }],
    ["extra path", { ...receipt().ok, paths: [...paths, `/repo/v1/packages/${"cc".repeat(32)}.neutron`] }],
    ["missing path", { ...receipt().ok, paths: [paths[0]!] }],
    ["reordered paths", { ...receipt().ok, paths: [...paths].reverse() }],
    ["excess charge", { ...receipt().ok, accepted_cycles: cycles + 1n }],
  ] as const) {
    test(`rejects a mismatched ${label} receipt without exposing the private bearer`, async () => {
      reply = { ok: changed };
      let error: unknown;
      try { await (await protocolClient(context())).grantSourceAccess(request(), cycles); }
      catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Source access could not be confirmed. Continue this same installation to reconcile its saved access request.");
      expect(String(error)).not.toContain(token);
      expect(calls.updates).toHaveLength(1);
    });
  }

  for (const failure of ["remote protocol error", "transport rejection", "malformed Candid reply"] as const) {
    test(`${failure} text cannot leak the bearer and retry preserves identical bytes`, async () => {
      if (failure === "remote protocol error") reply = { err: { code: `invalid_${token}`, message: `Rejected secret request ${token}` } };
      else if (failure === "transport rejection") relayError = new Error(`Failed sending bearer ${token}`);
      else reply = new TextEncoder().encode(`Not Candid: ${token}`);
      const client = await protocolClient(context());
      let error: unknown;
      try { await client.grantSourceAccess(request(), cycles); }
      catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("same installation");
      expect(String(error)).not.toContain(token);
      expect((error as Error).stack).not.toContain(token);
      expect((error as Error).cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain(token);
      const first = calls.updates[0]!;
      reply = receipt(); relayError = null;
      await client.grantSourceAccess(request(), cycles);
      expect(calls.updates).toHaveLength(2);
      expect(calls.updates[1]).toEqual(first);
    });
  }

  test("cancellation before reservation or dispatch cannot send a charged source request", async () => {
    const controller = new AbortController();
    const client = await protocolClient(context(controller.signal));
    controller.abort();
    await expect(client.grantSourceAccess(request(), cycles)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.reservations).toBe(0);
    expect(calls.updates).toEqual([]);
    const second = new AbortController();
    const next = await protocolClient(context(second.signal));
    reservationEffect = () => second.abort();
    await expect(next.grantSourceAccess(request(), cycles)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.reservations).toBe(1);
    expect(calls.updates).toEqual([]);
  });

  test("a settings change during reservation prevents dispatch against the old source", async () => {
    const client = await protocolClient(context());
    reservationEffect = clearClient;
    await expect(client.grantSourceAccess(request(), cycles)).rejects.toThrow("settings changed");
    expect(calls.updates).toEqual([]);
  });
}
