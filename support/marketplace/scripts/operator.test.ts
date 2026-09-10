// All rights reserved. See ../LICENSE.
import { describe, expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "fflate";
import msgpack from "tiny-msgpack";
import { hashContent } from "neutron-tools/src/hash.ts";
import { sha256, download, type HttpReader } from "./audit-download.ts";
import { inspectCandidate, stampInput, main } from "./operator.ts";
import { call, adminCall, relay, encode, decode, result, RelayRequest, RelayReply, RELAY_METHODS, ADMIN_METHODS, type CandidateValue } from "./operator-wire.ts";

const canister = "233tv-xiaaa-aaaay-aacta-cai", neutron = "3rurp-vyaaa-aaaay-aacua-cai";
const target = { canister, identity: "marketplace-auditor", network: "ic" };
const bytes = (value: string) => new TextEncoder().encode(value);
function fixture() {
  const module = bytes('module { public class Init() { public func ping() : Text { "ok" } } }');
  const entry = hashContent(module);
  const files = { "neutron.json": bytes(JSON.stringify({ format: 3, id: "alpha", name: "Alpha", version: 100, entry, func: { ping: { type: "update", async: false } } })), "web/index.html": bytes("<main></main>"), [`mo/${entry}.mo`]: module };
  const packageBytes = msgpack.encode(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, gzipSync(content)])));
  const candidate: CandidateValue = { id: 1n, appId: "alpha", version: 100n, publisher: Principal.fromText(neutron), artifactId: 1n, sourceArtifactId: [], digest: Buffer.from(sha256(packageBytes), "hex"), sourceDigest: [], dependencies: [], state: { pending: null } };
  return { packageBytes, candidate };
}

describe("marketplace CLI identity and call routing", () => {
  test("icp arguments contain only a private binary file, removed after success", async () => {
    let filename = "";
    const secret = "review-secret-not-for-process-arguments";
    const request = encode(IDL.Text, secret);
    const reply = await call(target, "audit_access", request, false, async args => {
      expect(args.join(" ")).not.toContain(secret);
      expect(args).toContain("marketplace-auditor"); expect(args).not.toContain("--proxy"); expect(args).not.toContain("--query");
      filename = args[args.indexOf("--args-file") + 1]!;
      expect((await stat(filename)).mode & 0o777).toBe(0o600);
      expect(await readFile(filename)).toEqual(Buffer.from(request));
      return Buffer.from(encode(IDL.Text, "ok")).toString("hex");
    });
    expect(decode<string>(IDL.Text, reply)).toBe("ok");
    await expect(stat(filename)).rejects.toThrow();
  });
  test("temporary argument file is also removed after interrupted call", async () => {
    let filename = "";
    await expect(call(target, "audit_access", encode(IDL.Null, null), false, async args => { filename = args[args.indexOf("--args-file") + 1]!; throw new Error("interrupted"); })).rejects.toThrow("interrupted");
    await expect(stat(filename)).rejects.toThrow();
  });
  test("publisher calls retain the actual Neutron relay and exact positive cycles", async () => {
    const argument = encode(IDL.Nat, 17n);
    const result = await relay(target, neutron, "listing_save", argument, 1234n, async args => {
      expect(args[2]).toBe(neutron); expect(args[3]).toBe("marketplace_marketplace_call");
      expect(args).not.toContain("--proxy");
      const forwarded = decode<{ canister: Principal; method: string; args: Uint8Array; cycles: bigint }>(RelayRequest, await readFile(args[args.indexOf("--args-file") + 1]!));
      expect(forwarded.canister.toText()).toBe(canister); expect(forwarded.method).toBe("listing_save"); expect(forwarded.cycles).toBe(1234n); expect([...forwarded.args]).toEqual([...argument]);
      return Buffer.from(encode(RelayReply, { ok: encode(IDL.Text, "reserved") })).toString("hex");
    });
    expect(decode<string>(IDL.Text, result)).toBe("reserved");
    expect(RELAY_METHODS.has("listing_save")).toBe(true); expect(RELAY_METHODS.has("purchase")).toBe(true); expect(RELAY_METHODS.has("admin_import_listings")).toBe(false);
    expect([...ADMIN_METHODS].sort()).toEqual(["admin_auditor_set", "admin_reserve_app", "admin_set_burn_account", "rates_refresh"]);
    for (const method of ADMIN_METHODS) expect(RELAY_METHODS.has(method)).toBe(false);
  });
  test("ordinary updates cannot silently become free or use an invented proxy method", async () => {
    await expect(relay(target, neutron, "listing_save", new Uint8Array(), 0n)).rejects.toThrow("positive cycle");
    await expect(relay(target, neutron, "audit_stamp", new Uint8Array(), 1n)).rejects.toThrow("ordinary cycle-paying");
    await expect(relay(target, neutron, "admin_reconcile_forward", new Uint8Array(), 1n)).rejects.toThrow("ordinary cycle-paying");
    await expect(relay(target, neutron, "admin_auditor_set", new Uint8Array(), 1n)).rejects.toThrow("ordinary cycle-paying");
    await expect(adminCall(target, "listing_save", new Uint8Array())).rejects.toThrow("direct administrator");
    await expect(call({ ...target, identity: "" }, "audit_queue", new Uint8Array(), true)).rejects.toThrow("identity");
  });
});

describe("direct administrator commands", () => {
  const scope = ["--canister", canister, "--identity", "marketplace-admin", "--network", "ic"];
  const cases = [
    { command: "admin-auditor", method: "admin_auditor_set", args: ["--auditor", neutron, "--active", "true"], type: IDL.Record({ principal: IDL.Principal, active: IDL.Bool, feeVersion: IDL.Nat }), check: (value: any) => { expect(value.principal.toText()).toBe(neutron); expect(value.active).toBe(true); } },
    { command: "reserve-app", method: "admin_reserve_app", args: ["--app", "alpha", "--publisher", neutron, "--title", "Alpha"], type: IDL.Record({ appId: IDL.Text, publisher: IDL.Principal, title: IDL.Text, feeVersion: IDL.Nat }), check: (value: any) => { expect(value.appId).toBe("alpha"); expect(value.publisher.toText()).toBe(neutron); expect(value.title).toBe("Alpha"); } },
    { command: "burn-account", method: "admin_set_burn_account", args: ["--ledger", neutron, "--recipient", canister, "--subaccount", "ab".repeat(32)], type: IDL.Record({ ledger: IDL.Principal, account: IDL.Opt(IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })), feeVersion: IDL.Nat }), check: (value: any) => { expect(value.ledger.toText()).toBe(neutron); expect(value.account[0].owner.toText()).toBe(canister); expect(Buffer.from(value.account[0].subaccount[0]).toString("hex")).toBe("ab".repeat(32)); } },
    { command: "rates-refresh", method: "rates_refresh", args: [], type: IDL.Record({ feeVersion: IDL.Nat }), check: (_value: any) => {} },
  ];
  for (const command of cases) {
    test(`${command.command} reviews a direct zero-cycle call without Neutron arguments or execution`, async () => {
      let output = "";
      await main([command.command, ...command.args, "--fee-version", "7", ...scope], { write: text => { output += text; }, run: async () => { throw new Error("Review must not execute a call"); } });
      expect(JSON.parse(output)).toMatchObject({ action: "direct_admin_update", canister, identity: "marketplace-admin", network: "ic", method: command.method, attachedCycles: "0", requiresAssignedAdmin: true, input: { feeVersion: "7" } });
      expect(output).not.toContain("requiresExistingBackendReservation");
    });
    test(`${command.command} executes directly with explicit CLI identity and unchanged Candid fields`, async () => {
      let called = 0, output = "";
      // A nonempty result also exercises the Reserved success decoder used by
      // commands whose protocol result is an App or refreshed-rate records.
      const reply = encode(result(IDL.Record({ accepted: IDL.Bool })), { ok: { accepted: true } });
      await main([command.command, ...command.args, "--fee-version", "7", ...scope, "--execute"], {
        write: text => { output += text; },
        run: async args => {
          called++;
          expect(args.slice(0, 4)).toEqual(["canister", "call", canister, command.method]);
          expect(args[args.indexOf("--identity") + 1]).toBe("marketplace-admin");
          expect(args[args.indexOf("--network") + 1]).toBe("ic");
          expect(args).not.toContain("--query"); expect(args).not.toContain("--proxy");
          expect(args).not.toContain("marketplace_marketplace_call");
          const value = decode<any>(command.type, await readFile(args[args.indexOf("--args-file") + 1]!));
          expect(value.feeVersion).toBe(7n); command.check(value);
          return Buffer.from(reply).toString("hex");
        },
      });
      expect(called).toBe(1); expect(output.trim()).toBe(Buffer.from(reply).toString("hex"));
    });
  }
  test("a protocol authorization error is reported instead of printed as successful binary output", async () => {
    let output = "";
    await expect(main(["rates-refresh", "--fee-version", "0", ...scope, "--execute"], {
      write: value => { output += value; },
      run: async () => Buffer.from(encode(result(IDL.Null), { err: { code: "admin_required", message: "Only an assigned administrator may refresh rates." } })).toString("hex"),
    })).rejects.toThrow("admin_required: Only an assigned administrator");
    expect(output).toBe("");
  });
  test("admin commands still require an explicit identity and the retained feeVersion field", async () => {
    await expect(main(["rates-refresh", "--canister", canister, "--network", "ic", "--fee-version", "0"], { write: () => {} })).rejects.toThrow("--identity is required");
    await expect(main(["rates-refresh", ...scope], { write: () => {} })).rejects.toThrow("--fee-version is required");
  });
  test("the generic publisher relay still requires the Neutron and sends exact attached cycles", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "marketplace-relay-test-"));
    const filename = path.join(directory, "args.bin"), argument = encode(IDL.Nat, 19n);
    try {
      await writeFile(filename, argument);
      const args = ["relay", "--method", "listing_save", "--args-bin", filename, ...scope];
      await expect(main(args, { write: () => {} })).rejects.toThrow("--neutron is required");
      await expect(main([...args, "--neutron", neutron], { write: () => {} })).rejects.toThrow("--cycles is required");
      let called = 0;
      await main([...args, "--neutron", neutron, "--cycles", "1234", "--execute"], {
        write: () => {},
        run: async command => {
          called++; expect(command.slice(0, 4)).toEqual(["canister", "call", neutron, "marketplace_marketplace_call"]);
          const request = decode<any>(RelayRequest, await readFile(command[command.indexOf("--args-file") + 1]!));
          expect(request.canister.toText()).toBe(canister); expect(request.method).toBe("listing_save"); expect(request.cycles).toBe(1234n); expect(Buffer.from(request.args)).toEqual(Buffer.from(argument));
          return Buffer.from(encode(RelayReply, { ok: encode(IDL.Null, null) })).toString("hex");
        },
      });
      expect(called).toBe(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("auditor review and decisions", () => {
  test("valid archive is inspected without claiming a malware assessment", async () => {
    const f = fixture(); const inspection = await inspectCandidate(f.candidate, f.packageBytes);
    expect(inspection.checked.record.id).toBe("alpha"); expect(inspection.dependencies).toEqual([]);
  });
  test("candidate substitution and invented dependencies are rejected", async () => {
    const f = fixture();
    await expect(inspectCandidate({ ...f.candidate, version: 101n }, f.packageBytes)).rejects.toThrow("manifest/version/digest");
    await expect(inspectCandidate({ ...f.candidate, digest: new Uint8Array(32) }, f.packageBytes)).rejects.toThrow("manifest/version/digest");
    await expect(inspectCandidate({ ...f.candidate, dependencies: [{ appId: "wallet", minVersion: 1n }] }, f.packageBytes)).rejects.toThrow("dependencies");
  });
  test("candidate cannot attach a different offered source than package declaration", async () => {
    const f = fixture();
    await expect(inspectCandidate({ ...f.candidate, sourceArtifactId: [2n], sourceDigest: [new Uint8Array(32)] }, f.packageBytes, bytes("wrong"))).rejects.toThrow("offered-source digest");
  });
  test("rejection/revocation and all decisions require real analysis and retained ID", () => {
    const base = { requestId: "same-review", candidateId: "12", digest: "1".repeat(64), decision: "approved", analysis: "Inspected exact package and source." };
    expect(stampInput(base).candidateId).toBe(12n);
    expect(() => stampInput({ ...base, decision: "rejected" })).toThrow("reason");
    expect(() => stampInput({ ...base, decision: "revoked", reason: "   " })).toThrow("reason");
    expect(() => stampInput({ ...base, analysis: " " })).toThrow("analysis");
    expect(() => stampInput({ ...base, requestId: "" })).toThrow("request ID");
    expect(() => stampInput({ ...base, digest: "" })).toThrow("reviewed SHA-256");
    expect(stampInput({ ...base, sourceDigest: "2".repeat(64) }).expectedSourceDigest).toHaveLength(1);
    expect(stampInput({ ...base, decision: "rejected", reason: "Declared dependencies differ from archive." }).reason).toHaveLength(1);
  });
  test("HTTP stream cannot escape source or pass an uncertified response", async () => {
    const content = bytes("package"), digest = sha256(content), path = `/repo/v1/packages/${digest}.neutron`, token = "1".repeat(64);
    const actor: HttpReader = { http_request: async () => ({ status_code: 200, headers: [], body: content, streaming_strategy: [], upgrade: [] }), http_streaming_callback: async () => { throw new Error("unexpected"); } };
    await expect(download({ actor, canister, rootKey: new Uint8Array(32), path, token, expectedDigest: digest })).rejects.toThrow();
    actor.http_request = async () => ({ status_code: 200, headers: [], body: content, upgrade: [], streaming_strategy: [{ Callback: { callback: [Principal.fromText(neutron), "http_streaming_callback"], token: { path, sha256: Buffer.from(digest, "hex"), grant: [token], index: 1n } } }] });
    await expect(download({ actor, canister, rootKey: new Uint8Array(32), path, token, expectedDigest: digest })).rejects.toThrow("outside");
  });
});
