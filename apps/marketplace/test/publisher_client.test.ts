import { beforeEach, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Principal } from "@dfinity/principal";
import { IDL } from "@dfinity/candid";
import type { MsgBusToolContext } from "neutron-tools/app";
import { CONTRACT, type Info, type WireApp, type WirePublisherProfile } from "../src/protocol.ts";
import type { PublisherProfileInput, PublisherProfileQuote } from "../src/view-types.ts";

// Isolate the transport mock from other client suites in the same Bun process.
if (process.env.NEUTRON_MARKETPLACE_PUBLISHER_CLIENT_CHILD !== "1") {
  test("publisher profiles preserve permanent identity and recover interrupted registration", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NEUTRON_MARKETPLACE_PUBLISHER_CLIENT_CHILD: "1" }, timeout: 30_000,
      });
      expect(result.stderr).toContain("0 fail");
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  }, 35_000);
} else {
  const owner = Principal.fromText("3rurp-vyaaa-aaaay-aacua-cai");
  const canister = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
  const profile = (overrides: Partial<WirePublisherProfile> = {}): WirePublisherProfile => ({
    publisherId: "aae", name: "AAE", description: "Independent Neutron apps", principal: owner,
    ratingCount: 4n, ratingTotal: 17n, totalUsers: 9_007_199_254_740_993n, statsComplete: true,
    createdAtNs: 1n, updatedAtNs: 2n, ...overrides,
  });
  const app = (appId: string): WireApp => ({
    appId, publisher: owner, publisherProfile: [{ publisherId: "aae", name: "AAE" }],
    title: appId, summary: "App summary", description: "App description", priceUsdMicros: 0n,
    revision: 1n, version: [1n], iconUrl: [], screenshots: [], iconArtifact: [], screenshotArtifacts: [],
    ratingCount: 2n, ratingTotal: 9n, acquisitionCounts: [{ free: 3n, paid: 0n }], owned: false, visible: true,
  });
  const input: PublisherProfileInput = { id: "aae", name: "AAE", description: "Independent Neutron apps" };
  const calls: Array<{ kind: "query" | "update" | "reserve"; method: string; args: any[]; cycles?: bigint }> = [];
  const kernelReads: string[] = [];
  let ownProfile: WirePublisherProfile | null = null;
  let publicProfile = profile();
  let catalogApps: WireApp[] = [];
  let catalogCursor: [] | [bigint] = [];
  let loseRegistrationReply = false;
  let info: Info;

  const actualTransport = await import("../src/transport.ts");
  mock.module("../src/transport.ts", () => ({ ...actualTransport, makeAgent: async () => ({}), makeTransport: () => ({
    query: async (method: string, args: any[] = []) => {
      calls.push({ kind: "query", method, args });
      if (method === "marketplace_info") return info;
      if (method === "publisher_profile_for") return { ok: ownProfile ? [ownProfile] : [] };
      if (method === "publisher_profile") return { ok: publicProfile };
      if (method === "publisher_profile_apps") return { ok: { apps: catalogApps, nextCursor: catalogCursor } };
      if (method === "catalog_query") return { ok: { apps: catalogApps, nextCursor: [], asOfNs: 0n, refreshing: false } };
      if (method === "app_detail") return { ok: { app: catalogApps.find(value => value.appId === args[0])!, candidate: [], audit: [], rating: [] } };
      throw new Error(`Unexpected direct query ${method}`);
    },
    reserve: async () => { calls.push({ kind: "reserve", method: "reserve", args: [] }); },
    update: async (method: string, args: any[], cycles: bigint) => {
      calls.push({ kind: "update", method, args, cycles });
      if (method === "publisher_profile_register") {
        expect(ownProfile).toBeNull();
        ownProfile = profile({ publisherId: args[0].publisherId, name: args[0].name, description: args[0].description });
        if (loseRegistrationReply) throw new Error("Registration reply interrupted");
        return { ok: ownProfile };
      }
      if (method === "publisher_profile_update") {
        expect(ownProfile).not.toBeNull();
        ownProfile = { ...ownProfile!, description: args[0].description };
        return { ok: ownProfile };
      }
      throw new Error(`Unexpected protocol update ${method}`);
    },
  }) }));
  const { protocolClient, clearClient, publisherInput, publisherView } = await import("../src/client.ts");
  const context = { signal: new AbortController().signal, kernel: {
    querySelf: async (method: string, args: unknown[]) => {
      kernelReads.push(method);
      expect(method).toBe("marketplace_state");
      expect(args).toEqual([null]);
      return { seed: [], canister: [canister.toText()], host: "https://icp-api.io", owner: owner.toText(), revision: 1 };
    },
    updateSelf: async () => { throw new Error("Profile reads/writes must not store another Neutron backend profile"); },
    listApps: async () => { kernelReads.push("listApps"); return { apps: [{ id: "wallet" }] }; },
  } } as unknown as MsgBusToolContext;

  beforeEach(() => {
    clearClient(); calls.length = 0; kernelReads.length = 0; ownProfile = null;
    publicProfile = profile(); catalogApps = []; catalogCursor = []; loseRegistrationReply = false;
    info = { version: 1n, canister, tokens: [],
      fees: { version: 3n, updateBase: 250_000_000n, updateByte: 19n, storageByteYear: 21n, purchase: 1n, withdraw: 1n, grant: 1n, xrc: 1n },
      referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n },
    };
  });

  test("publisher summaries use supplied aggregate statistics without rounding unique-user counts", () => {
    expect(publisherView(profile())).toEqual({
      ...input, principal: owner.toText(), rating: 4.25, ratingCount: 4,
      totalUsers: "9007199254740993", statsComplete: true,
    });
    expect(publisherView(profile({ statsComplete: false }))).toMatchObject({ rating: null, statsComplete: false });
    expect(publisherView(profile({ ratingCount: 0n, ratingTotal: 0n }))).toMatchObject({ rating: null, ratingCount: 0 });
  });

  test("IDs accept only 3–20 ASCII lowercase letters while names and descriptions have no invented length cap", () => {
    for (const id of ["aaa", "a".repeat(20)]) expect(publisherInput({ ...input, id }).id).toBe(id);
    for (const id of ["", "aa", "a".repeat(21), "AAE", "aae1", "aa-e", " aé", "aаe", "aae\n", " aae"]) {
      expect(() => publisherInput({ ...input, id })).toThrow("3–20 lowercase letters");
    }
    expect(publisherInput({ ...input, name: " \tAAE\r\n" }).name).toBe("AAE");
    expect(publisherInput({ ...input, name: "\u00a0\u0085\uFEFFAAE\u2003" }).name).toBe("AAE");
    expect(() => publisherInput({ ...input, name: " \t\r\n" })).toThrow("publisher name");
    expect(() => publisherInput({ ...input, name: "\u00a0\u0085\uFEFF\u2003" })).toThrow("publisher name");
    const long = { ...input, name: "n".repeat(300), description: "d".repeat(6000) };
    expect(publisherInput(long)).toEqual(long);
  });

  test("profiles and catalog pages query the protocol directly, use inline publisher summaries, and retain exact cursors", async () => {
    catalogApps = [app("kernel"), app("wallet"), app("marketplace"), app("uniswap")];
    catalogCursor = [9_007_199_254_740_993n];
    const client = await protocolClient(context);
    expect(await client.ownPublisherProfile()).toBeNull();
    expect((await client.publisherProfile("aae")).totalUsers).toBe("9007199254740993");
    const page = await client.publisherCatalog("aae", "9007199254740992");
    expect(page.nextCursor).toBe("9007199254740993");
    expect(page.items.map(value => ({ id: value.id, publisherId: value.publisherId, publisherName: value.publisherName, installed: value.installed }))).toEqual([
      { id: "wallet", publisherId: "aae", publisherName: "AAE", installed: true },
      { id: "uniswap", publisherId: "aae", publisherName: "AAE", installed: false },
    ]);
    expect(calls.map(call => call.method)).toEqual(["marketplace_info", "publisher_profile_for", "publisher_profile", "publisher_profile_apps"]);
    expect(calls.at(-1)?.args).toEqual([{ publisherId: "aae", cursor: [9_007_199_254_740_992n], limit: 24n }]);
    expect(calls[1]?.args[0].toText()).toBe(owner.toText());
    expect(kernelReads).toEqual(["marketplace_state", "listApps"]);
    expect(calls.every(call => call.kind === "query")).toBe(true);
  });

  test("storefront and detail map inline profiles, and legacy listings remain usable without extra profile reads", async () => {
    const legacy = app("legacy"); delete legacy.publisherProfile;
    catalogApps = [app("kernel"), app("wallet"), app("marketplace"), legacy];
    const client = await protocolClient(context);
    const page = await client.catalog({ tier: "free", window: "week", search: "" });
    expect(page.items.map(value => value.id)).toEqual(["wallet", "legacy"]);
    expect(page.items[0]).toMatchObject({ publisherId: "aae", publisherName: "AAE" });
    expect(page.items[1]).toMatchObject({ publisherId: null, publisherName: null, publisher: owner.toText() });
    expect(await client.detail("wallet")).toMatchObject({ publisherId: "aae", publisherName: "AAE" });
    expect(calls.map(call => call.method)).toEqual(["marketplace_info", "catalog_query", "app_detail"]);
    expect(calls.every(call => call.kind === "query")).toBe(true);
  });

  test("registration attaches exactly the reviewed encoded-request cycle estimate in one protocol update", async () => {
    const client = await protocolClient(context);
    const quoted = await client.quotePublisherProfile(input);
    expect(quoted).toMatchObject({ input, operation: "register", cycles: { schedule: "3", storage: "0" } });
    expect(calls.filter(call => call.kind !== "query")).toEqual([]);
    expect(await client.savePublisherProfile(input, quoted)).toMatchObject(input);
    const updates = calls.filter(call => call.kind === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ method: "publisher_profile_register", args: [{ publisherId: "aae", name: "AAE", description: input.description, feeVersion: 3n }], cycles: BigInt(quoted.cycles.total) });
    const encoded = IDL.encode(CONTRACT.publisher_profile_register!.args, updates[0]!.args);
    expect(updates[0]!.cycles).toBe(250_000_000n + BigInt(encoded.byteLength) * 19n);
    expect(calls.filter(call => call.kind === "reserve")).toHaveLength(1);
  });

  test("an interrupted registration is never reinterpreted as an edit that rolls back a later description", async () => {
    const client = await protocolClient(context);
    const quoted = await client.quotePublisherProfile(input);
    loseRegistrationReply = true;
    await expect(client.savePublisherProfile(input, quoted)).rejects.toThrow("Registration reply interrupted");
    expect(ownProfile).toMatchObject({ publisherId: "aae", description: input.description });
    ownProfile = { ...ownProfile!, description: "A newer description saved through another client" };
    const recovered = await client.savePublisherProfile(input, quoted);
    expect(recovered.description).toBe("A newer description saved through another client");
    expect(calls.filter(call => call.kind === "update").map(call => call.method)).toEqual(["publisher_profile_register"]);
    expect(calls.filter(call => call.kind === "reserve")).toHaveLength(1);
  });

  test("an unchanged description makes no paid update, while permanent ID and name remain immutable", async () => {
    ownProfile = profile();
    const client = await protocolClient(context);
    const quoted = await client.quotePublisherProfile(input);
    expect(quoted.operation).toBe("update");
    expect(await client.savePublisherProfile(input, quoted)).toMatchObject(input);
    await expect(client.quotePublisherProfile({ ...input, id: "other" })).rejects.toThrow("cannot be changed");
    await expect(client.quotePublisherProfile({ ...input, name: "Different Name" })).rejects.toThrow("cannot be changed");
    expect(calls.filter(call => call.kind !== "query")).toEqual([]);
  });

  test("description editing preserves Unicode name characters and the complete description text", async () => {
    const name = "ÁAE 日本語";
    ownProfile = profile({ name });
    const values = { ...input, name, description: "\u00a0 Updated description 日本語 \n" };
    expect(publisherInput(values).name).toBe(name);
    const client = await protocolClient(context);
    const quoted = await client.quotePublisherProfile(values);
    expect(quoted.input.name).toBe(name);
    expect(await client.savePublisherProfile(values, quoted)).toMatchObject(values);
    expect(calls.filter(call => call.kind === "update")).toMatchObject([{ method: "publisher_profile_update", args: [{ description: values.description, feeVersion: 3n }] }]);
  });

  test("changed reviewed input or cycle amounts require a fresh review before any update", async () => {
    const client = await protocolClient(context);
    const quoted = await client.quotePublisherProfile(input);
    await expect(client.savePublisherProfile({ ...input, description: "Not reviewed" }, quoted)).rejects.toThrow("details changed");
    for (const field of ["total", "processing", "storage", "schedule"] as const) {
      const altered: PublisherProfileQuote = { ...quoted, cycles: { ...quoted.cycles, [field]: String(BigInt(quoted.cycles[field]) + 1n) } };
      await expect(client.savePublisherProfile(input, altered)).rejects.toThrow("cost changed");
    }
    info.fees.updateByte = 20n;
    await expect(client.savePublisherProfile(input, quoted)).rejects.toThrow("cost changed");
    expect(calls.filter(call => call.kind !== "query")).toEqual([]);
  });

  test("an edit quote cannot register a missing profile or overwrite a different permanent identity", async () => {
    ownProfile = profile();
    const values = { ...input, description: "Edited" };
    const client = await protocolClient(context);
    const quoted = await client.quotePublisherProfile(values);
    ownProfile = null;
    await expect(client.savePublisherProfile(values, quoted)).rejects.toThrow("original publisher profile is unavailable");
    ownProfile = profile({ publisherId: "other" });
    await expect(client.savePublisherProfile(values, quoted)).rejects.toThrow("cannot be changed");
    expect(calls.filter(call => call.kind !== "query")).toEqual([]);
  });

  test("profile Candid contracts preserve exact principal, nat counts, optional owner result, and write shapes", () => {
    const roundtrip = (method: string, kind: "args" | "returns", values: unknown[]) => {
      const types = CONTRACT[method]![kind]; return IDL.decode(types, IDL.encode(types, values));
    };
    for (const method of ["publisher_profile", "publisher_profile_for", "publisher_profile_apps"]) expect(CONTRACT[method]!.update).toBeUndefined();
    for (const method of ["publisher_profile_register", "publisher_profile_update"]) expect(CONTRACT[method]!.update).toBe(true);
    const decoded = roundtrip("publisher_profile", "returns", [{ ok: profile() }])[0] as { ok: WirePublisherProfile };
    expect(decoded.ok).toEqual(profile());
    expect(roundtrip("publisher_profile_for", "returns", [{ ok: [] }])).toEqual([{ ok: [] }]);
    expect(roundtrip("publisher_profile_for", "args", [owner])).toEqual([owner]);
    expect(roundtrip("publisher_profile_register", "args", [{ publisherId: "aae", name: "AAE", description: "Apps", feeVersion: 3n }])).toEqual([{ publisherId: "aae", name: "AAE", description: "Apps", feeVersion: 3n }]);
    expect(roundtrip("publisher_profile_update", "args", [{ description: "Changed", feeVersion: 3n }])).toEqual([{ description: "Changed", feeVersion: 3n }]);
    expect(roundtrip("publisher_profile_apps", "returns", [{ ok: { apps: [app("wallet")], nextCursor: [9_007_199_254_740_993n] } }])).toEqual([{ ok: { apps: [{ ...app("wallet"), screenshotArtifacts: new BigUint64Array() }], nextCursor: [9_007_199_254_740_993n] } }]);
  });

  test("new optional publisher summaries decode legacy Candid app pages without discarding listing data", () => {
    const legacyApp = IDL.Record({ appId: IDL.Text, publisher: IDL.Principal, title: IDL.Text, summary: IDL.Text, description: IDL.Text,
      priceUsdMicros: IDL.Nat, revision: IDL.Nat64, version: IDL.Opt(IDL.Nat), iconUrl: IDL.Opt(IDL.Text), screenshots: IDL.Vec(IDL.Text),
      iconArtifact: IDL.Opt(IDL.Nat64), screenshotArtifacts: IDL.Vec(IDL.Nat64), ratingCount: IDL.Nat, ratingTotal: IDL.Nat,
      acquisitionCounts: IDL.Opt(IDL.Record({ free: IDL.Nat, paid: IDL.Nat })), owned: IDL.Bool, visible: IDL.Bool });
    const oldPage = IDL.Variant({ ok: IDL.Record({ apps: IDL.Vec(legacyApp), nextCursor: IDL.Opt(IDL.Nat64) }), err: IDL.Record({ code: IDL.Text, message: IDL.Text }) });
    const old = app("wallet"); delete old.publisherProfile;
    const bytes = IDL.encode([oldPage], [{ ok: { apps: [old], nextCursor: [] } }]);
    const decoded = IDL.decode(CONTRACT.publisher_apps!.returns, bytes)[0] as { ok: { apps: WireApp[] } };
    expect(decoded.ok.apps[0]).toEqual({ ...old, publisherProfile: [], screenshotArtifacts: new BigUint64Array() });
  });
}
