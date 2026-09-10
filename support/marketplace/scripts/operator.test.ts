// All rights reserved. See ../LICENSE.
import { describe, expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { readFile, stat } from "node:fs/promises";
import { gzipSync } from "fflate";
import msgpack from "tiny-msgpack";
import { hashContent } from "neutron-tools/src/hash.ts";
import { sha256, download, type HttpReader } from "./audit-download.ts";
import { inspectCandidate, stampInput } from "./operator.ts";
import { call, relay, encode, decode, RelayRequest, RelayReply, RELAY_METHODS, type CandidateValue } from "./operator-wire.ts";

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
  test("publisher/admin call is forwarded by actual Neutron with exact positive cycles", async () => {
    const argument = encode(IDL.Nat, 17n);
    const result = await relay(target, neutron, "admin_reserve_app", argument, 1234n, async args => {
      expect(args[2]).toBe(neutron); expect(args[3]).toBe("marketplace_marketplace_call");
      expect(args).not.toContain("--proxy");
      const forwarded = decode<{ canister: Principal; method: string; args: Uint8Array; cycles: bigint }>(RelayRequest, await readFile(args[args.indexOf("--args-file") + 1]!));
      expect(forwarded.canister.toText()).toBe(canister); expect(forwarded.method).toBe("admin_reserve_app"); expect(forwarded.cycles).toBe(1234n); expect([...forwarded.args]).toEqual([...argument]);
      return Buffer.from(encode(RelayReply, { ok: encode(IDL.Text, "reserved") })).toString("hex");
    });
    expect(decode<string>(IDL.Text, result)).toBe("reserved");
    expect(RELAY_METHODS.has("admin_reserve_app")).toBe(true); expect(RELAY_METHODS.has("admin_set_burn_account")).toBe(true); expect(RELAY_METHODS.has("admin_import_listings")).toBe(false);
  });
  test("ordinary updates cannot silently become free or use an invented proxy method", async () => {
    await expect(relay(target, neutron, "listing_save", new Uint8Array(), 0n)).rejects.toThrow("positive cycle");
    await expect(relay(target, neutron, "audit_stamp", new Uint8Array(), 1n)).rejects.toThrow("ordinary cycle-paying");
    await expect(relay(target, neutron, "admin_reconcile_forward", new Uint8Array(), 1n)).rejects.toThrow("ordinary cycle-paying");
    await expect(call({ ...target, identity: "" }, "audit_queue", new Uint8Array(), true)).rejects.toThrow("identity");
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
