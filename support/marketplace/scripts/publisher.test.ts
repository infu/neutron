// All rights reserved. See ../LICENSE.
import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "fflate";
import msgpack from "tiny-msgpack";
import { hashContent } from "neutron-tools/src/hash.ts";
import { hostedSourceArtifactPath } from "../../update-source/src/model.ts";
import { decode, encode } from "./operator-wire.ts";
import { Fee, FeeRequest, Info, Listing, Submit, SubmitReply, UploadBegin, UploadChunk, UploadFinish, UploadReply, preparePublisher, publish, type PublisherOptions, type Transport } from "./publisher.ts";

const p = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai"), neutron = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const text = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
// Real journal fsyncs can be delayed by concurrent compiler and integration work.
// Each test owns its cleanup until its async body settles, including after a
// runner timeout; another test never removes a still-running test's directory.
function fixtureTest(name: string, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  test(name, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "publisher-test-"));
    try { await run(await fixture(root)); }
    finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
}

async function fixture(root: string) {
  const module = text('module { public class Init() { public func ping() : Text { "ok" } } }'), entry = hashContent(module);
  const manifest = text(JSON.stringify({ format: 3, id: "alpha", name: "Alpha", version: 100, entry, func: { ping: { type: "update", async: false } } }));
  const source = gzipSync(msgpack.encode({ format: 1, package: { id: "alpha", version: 100 }, files: [{ path: "apps/alpha/neutron.json", mode: 0o644, content: manifest }] }));
  const sourceHash = hashContent(source);
  const license = text("License fixture"), notice = text("Application fixture"), thirdParty = text("Third-party fixture");
  const reference = (file: string, content: Uint8Array) => ({ path: file, sha256: hashContent(content), bytes: content.length });
  const record = {
    format: 1, package: { id: "alpha", version: 100, manifest: reference("neutron.json", manifest) },
    license: { id: "LicenseRef-Neutron-Sovereign-Application-License-1.0", texts: [{ id: "LicenseRef-Neutron-Sovereign-Application-License-1.0", ...reference("legal/LICENSE.APP.txt", license) }] },
    source: { kind: "https", revision: `source-sha256:${sourceHash}`, url: `https://${p.toText()}.icp0.io/repo/v1/sources/${sourceHash}.source.v1.msgpack.gz`, sha256: sourceHash, bytes: source.length },
    dependencies: [], notices: [reference("legal/APPLICATION-NOTICE.txt", notice), reference("legal/THIRD_PARTY_NOTICES.md", thirdParty)], memory: null, build: { inputs: [], commands: [] },
  };
  const files = { "neutron.json": manifest, [`mo/${entry}.mo`]: module, "web/index.html": text("<main></main>"), "legal/LICENSE.APP.txt": license, "legal/APPLICATION-NOTICE.txt": notice, "legal/THIRD_PARTY_NOTICES.md": thirdParty, "legal/package-record.v1.json": text(JSON.stringify(record)) };
  const archive = msgpack.encode(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, gzipSync(content)])));
  const packageFile = path.join(root, "alpha.neutron"); await writeFile(packageFile, archive);
  const sourceFile = hostedSourceArtifactPath(packageFile, sourceHash); await mkdir(path.dirname(sourceFile), { recursive: true }); await writeFile(sourceFile, source);
  const listingFile = path.join(root, "listing.json"); await writeFile(listingFile, JSON.stringify({ appId: "alpha", title: "Alpha", summary: "Test", description: "A test app", priceUsdMicros: "1000000", iconArtifact: null, screenshots: [], expectedRevision: null }));
  const options: PublisherOptions = { target: { canister: p.toText(), identity: "publisher-test", network: "local" }, neutron, requestId: "release-alpha-100", journal: path.join(root, "journal.json") };
  return { root, packageFile, sourceFile, listingFile, options, archive };
}

function mock() {
  let loseMethod: string | undefined, lost = false, candidateCount = 0;
  const updates: { method: string; args: string; cycles: bigint }[] = [], quotes: { argsBytes: bigint; storage: bigint }[] = [];
  const uploads = new Map<string, any>();
  const bodies = new Map<string, Uint8Array>();
  const io: Transport = {
    async query(_target, method, args) {
      if (method === "marketplace_info") return encode(Info, { canister: p, fees: { version: 1n } });
      if (method !== "fee_quote") throw new Error(`Unexpected query ${method}`);
      const q = decode<any>(FeeRequest, args); quotes.push({ argsBytes: q.processingBytes, storage: q.newStorageBytes });
      return encode(Fee, { feeVersion: 1n, processingCycles: 100n + q.processingBytes, storageCycles: 10n * q.newStorageBytes, totalCycles: 100n + q.processingBytes + 10n * q.newStorageBytes, processingBytes: q.processingBytes, newStorageBytes: q.newStorageBytes });
    },
    async update(target, targetNeutron, method, args, cycles) {
      expect(target.canister).toBe(p.toText()); expect(targetNeutron).toBe(neutron); expect(cycles).toBeGreaterThan(0n);
      updates.push({ method, args: hex(args), cycles });
      let response: Uint8Array;
      if (method === "listing_save") {
        const v = decode<any>(Listing, args); response = encode(IDL.Variant({ ok: IDL.Record({ appId: IDL.Text, revision: IDL.Nat64 }), err: IDL.Record({ code: IDL.Text, message: IDL.Text }) }), { ok: { appId: v.appId, revision: 0n } });
      } else if (method === "upload_begin") {
        const v = decode<any>(UploadBegin, args);
        if (!uploads.has(v.requestId)) { uploads.set(v.requestId, { ...v, uploadedBytes: 0n, state: { uploading: null }, artifactId: [] }); bodies.set(v.requestId, new Uint8Array()); }
        else expect(uploads.get(v.requestId).digest).toEqual(v.digest);
        response = encode(UploadReply, { ok: uploads.get(v.requestId) });
      } else if (method === "upload_chunk") {
        const v = decode<any>(UploadChunk, args), saved = uploads.get(v.requestId), body = bodies.get(v.requestId)!;
        if (v.offset === BigInt(body.length)) { const joined = new Uint8Array(body.length + v.bytes.length); joined.set(body); joined.set(v.bytes, body.length); bodies.set(v.requestId, joined); saved.uploadedBytes = BigInt(joined.length); }
        else expect(body.slice(Number(v.offset), Number(v.offset) + v.bytes.length)).toEqual(v.bytes);
        response = encode(UploadReply, { ok: saved });
      } else if (method === "upload_finish") {
        const v = decode<any>(UploadFinish, args), saved = uploads.get(v.requestId);
        expect(hashContent(bodies.get(v.requestId)!)).toBe(hex(saved.digest));
        saved.state = { attached: null }; if (!saved.artifactId.length) saved.artifactId = [BigInt(uploads.size + 10)];
        response = encode(UploadReply, { ok: saved });
      } else if (method === "candidate_submit") {
        const v = decode<any>(Submit, args), pkg = uploads.get("release-alpha-100:package"), source = uploads.get("release-alpha-100:source");
        candidateCount = 1;
        response = encode(SubmitReply, { ok: { ...v, id: 99n, publisher: p, listingRevision: 0n, digest: pkg.digest, sourceDigest: source ? [source.digest] : [], state: { pending: null }, published: false, createdAtNs: 1n, updatedAtNs: 1n } });
      } else throw new Error(`Unexpected update ${method}`);
      if (!lost && method === loseMethod) { lost = true; throw new Error("simulated response loss after effect"); }
      return response;
    },
  };
  return { io, updates, quotes, uploads, bodies, candidateCount: () => candidateCount, lose: (method: string) => { loseMethod = method; } };
}

fixtureTest("default review validates package and complete source, quotes all costs, sends no updates", async (f) => {
  const m = mock(), prepared = await preparePublisher(f.packageFile, f.listingFile);
  const report = await publish(prepared, f.options, m.io);
  expect(m.updates).toEqual([]); expect(report.files.map(v => v.purpose)).toEqual(["package", "source"]);
  expect(report.steps.map(v => v.method)).toEqual(["listing_save", "upload_begin", "upload_chunk", "upload_finish", "upload_begin", "upload_chunk", "upload_finish", "candidate_submit"]);
  expect(m.quotes.filter(q => q.storage > 0n).map(q => q.storage)).toEqual(prepared.files.map(file => BigInt(file.bytes.length)));
  expect(report.estimatedRemainingCycles).toBe(report.steps.reduce((n, s) => n + BigInt(s.cycles), 0n).toString());
});

for (const method of ["upload_begin", "upload_chunk", "upload_finish", "candidate_submit"]) {
  fixtureTest(`lost ${method} reply resumes original bytes and IDs without duplicate candidate`, async (f) => {
    const m = mock(), prepared = await preparePublisher(f.packageFile); m.lose(method);
    await expect(publish(prepared, { ...f.options, execute: true }, m.io)).rejects.toThrow("same journal and request ID");
    const dispatched = m.updates[m.updates.length - 1]!;
    const interrupted = JSON.parse(await readFile(f.options.journal, "utf8")); expect(interrupted.steps.at(-1).outcome).toBe("unknown");
    const resumed = await publish(prepared, { ...f.options, execute: true }, m.io);
    const repetitions = m.updates.filter(update => update.method === dispatched.method && update.args === dispatched.args);
    expect(repetitions).toHaveLength(2); expect(repetitions[0]?.cycles).toBe(repetitions[1]?.cycles);
    expect(resumed.candidateId).toBe("99"); expect(m.candidateCount()).toBe(1); expect(m.uploads.size).toBe(2);
    const count = m.updates.length; await publish(prepared, { ...f.options, execute: true }, m.io); expect(m.updates).toHaveLength(count);
  });
}

fixtureTest("missing or changed declared offered source prevents any upload", async (f) => {
  const m = mock(), prepared = await preparePublisher(f.packageFile);
  prepared.files.pop();
  await expect(publish(prepared, { ...f.options, execute: true }, m.io)).rejects.toThrow("offered source must remain");
  expect(m.updates).toHaveLength(0);
  await rm(f.sourceFile);
  await expect(preparePublisher(f.packageFile)).rejects.toThrow("Unable to read Complete App Source");
  await writeFile(f.sourceFile, new Uint8Array([1, 2, 3]));
  await expect(preparePublisher(f.packageFile)).rejects.toThrow("expected");
});

fixtureTest("declared dependency changes cannot bypass the packed manifest", async (f) => {
  const m = mock(), prepared = await preparePublisher(f.packageFile);
  prepared.dependencies.push({ appId: "wallet", minVersion: 100n });
  await expect(publish(prepared, { ...f.options, execute: true }, m.io)).rejects.toThrow("dependencies differ");
  expect(m.updates).toHaveLength(0);
});

fixtureTest("resume rejects changed listing/target and refuses mutable prepared bytes", async (f) => {
  const m = mock(), prepared = await preparePublisher(f.packageFile, f.listingFile);
  await publish(prepared, f.options, m.io);
  await expect(publish(prepared, { ...f.options, neutron: "r7inp-6aaaa-aaaaa-aaabq-cai", execute: true }, m.io)).rejects.toThrow("different package bytes");
  prepared.listing!.title = "Changed";
  await expect(publish(prepared, { ...f.options, execute: true }, m.io)).rejects.toThrow("different package bytes");
  prepared.files[0]!.bytes[0] ^= 1;
  await expect(publish(prepared, { ...f.options, execute: true }, m.io)).rejects.toThrow("bytes changed");
  expect(m.updates).toHaveLength(0);
});

fixtureTest("explicit maximum budget stops before the first paid update", async (f) => {
  const m = mock();
  await expect(publish(await preparePublisher(f.packageFile), { ...f.options, execute: true, maxCycles: 1n }, m.io)).rejects.toThrow("maximum cycle budget");
  expect(m.updates).toHaveLength(0);
});
