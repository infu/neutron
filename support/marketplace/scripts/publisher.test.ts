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
import { decode, encode, json } from "./operator-wire.ts";
import { Fee, FeeRequest, Info, Listing, ListingReply, Submit, SubmitReply, TRUSTED_FIRST_PARTY_PUBLISHER, UploadBegin, UploadChunk, UploadFinish, UploadReply, preparePublisher, publish, type PublisherOptions, type Transport } from "./publisher.ts";

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

function mock(trustedDirect = false) {
  let loseMethod: string | undefined, lost = false, candidateCount = 0;
  let listing: { owner: string; revision: bigint; fields: Record<string, unknown> } | undefined;
  const updates: { method: string; args: string; cycles: bigint }[] = [], quotes: { argsBytes: bigint; storage: bigint }[] = [], queries: string[] = [];
  const uploads = new Map<string, any>();
  const bodies = new Map<string, Uint8Array>();
  const io: Transport = {
    async callerPrincipal() { return TRUSTED_FIRST_PARTY_PUBLISHER; },
    async query(_target, method, args) {
      queries.push(method);
      if (method === "marketplace_info") return encode(Info, { canister: p, fees: { version: 1n } });
      if (method !== "fee_quote") throw new Error(`Unexpected query ${method}`);
      if (trustedDirect) throw new Error("Trusted direct publication must not request a fee quote.");
      const q = decode<any>(FeeRequest, args); quotes.push({ argsBytes: q.processingBytes, storage: q.newStorageBytes });
      return encode(Fee, { feeVersion: 1n, processingCycles: 100n + q.processingBytes, storageCycles: 10n * q.newStorageBytes, totalCycles: 100n + q.processingBytes + 10n * q.newStorageBytes, processingBytes: q.processingBytes, newStorageBytes: q.newStorageBytes });
    },
    async update(target, targetNeutron, method, args, cycles) {
      expect(target.canister).toBe(p.toText()); expect(targetNeutron).toBe(trustedDirect ? TRUSTED_FIRST_PARTY_PUBLISHER : neutron);
      if (trustedDirect) expect(cycles).toBe(0n); else expect(cycles).toBeGreaterThan(0n);
      updates.push({ method, args: hex(args), cycles });
      let response: Uint8Array;
      if (method === "listing_save") {
        const { expectedRevision, feeVersion: _feeVersion, ...fields } = decode<any>(Listing, args);
        // Match Catalog.save: an owner replay with identical listing fields
        // returns the existing revision before evaluating expectedRevision.
        if (listing && listing.owner !== targetNeutron) response = encode(ListingReply, { err: { code: "listing", message: "The listing belongs to another publisher." } });
        else if (listing && json(listing.fields) === json(fields)) response = encode(ListingReply, { ok: { appId: fields.appId, revision: listing.revision } });
        else if (listing && expectedRevision[0] !== listing.revision) response = encode(ListingReply, { err: { code: "listing", message: "The listing changed. Review its current revision before saving." } });
        else if (!listing && expectedRevision.length && expectedRevision[0] !== 0n) response = encode(ListingReply, { err: { code: "listing", message: "This listing does not exist at the expected revision." } });
        else { listing = { owner: targetNeutron, revision: (listing?.revision ?? 0n) + 1n, fields }; response = encode(ListingReply, { ok: { appId: fields.appId, revision: listing.revision } }); }
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
        response = encode(SubmitReply, { ok: { ...v, id: 99n, publisher: trustedDirect ? Principal.fromText(TRUSTED_FIRST_PARTY_PUBLISHER) : p, listingRevision: listing?.revision ?? 0n, digest: pkg.digest, sourceDigest: source ? [source.digest] : [], state: { pending: null }, published: false, createdAtNs: 1n, updatedAtNs: 1n } });
      } else throw new Error(`Unexpected update ${method}`);
      if (!lost && method === loseMethod) { lost = true; throw new Error("simulated response loss after effect"); }
      return response;
    },
  };
  return { io, updates, quotes, queries, uploads, bodies, listing: () => listing, candidateCount: () => candidateCount, lose: (method: string) => { loseMethod = method; } };
}

const trustedOptions = (options: PublisherOptions): PublisherOptions => ({ ...options, neutron: undefined, trustedDirect: { caller: TRUSTED_FIRST_PARTY_PUBLISHER } });

fixtureTest("default review validates package and complete source, quotes all costs, sends no updates", async (f) => {
  const m = mock(), prepared = await preparePublisher(f.packageFile, f.listingFile);
  const report = await publish(prepared, f.options, m.io);
  expect(m.updates).toEqual([]); expect(report.files.map(v => v.purpose)).toEqual(["package", "source"]);
  expect(report.steps.map(v => v.method)).toEqual(["listing_save", "upload_begin", "upload_chunk", "upload_finish", "upload_begin", "upload_chunk", "upload_finish", "candidate_submit"]);
  expect(m.quotes.filter(q => q.storage > 0n).map(q => q.storage)).toEqual(prepared.files.map(file => BigInt(file.bytes.length)));
  expect(report.estimatedRemainingCycles).toBe(report.steps.reduce((n, s) => n + BigInt(s.cycles), 0n).toString());
  const saved = JSON.parse(await readFile(f.options.journal, "utf8"));
  expect(saved.fingerprint).toBe(hashContent(text(json({ canister: p.toText(), neutron, network: "local", requestId: f.options.requestId, appId: prepared.appId, version: prepared.version, dependencies: prepared.dependencies, listing: prepared.listing ?? null, files: report.files }))));
  expect(saved.mode).toBeUndefined(); expect(saved.caller).toBeUndefined();
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

fixtureTest("trusted publication verifies declared and actual principals before any request", async (f) => {
  const m = mock(true), prepared = await preparePublisher(f.packageFile), options = trustedOptions(f.options);
  await expect(publish(prepared, { ...options, trustedDirect: { caller: neutron }, execute: true }, m.io)).rejects.toThrow("configured first-party publisher");
  m.io.callerPrincipal = async () => neutron;
  await expect(publish(prepared, { ...options, execute: true }, m.io)).rejects.toThrow("signing principal does not match");
  delete m.io.callerPrincipal;
  await expect(publish(prepared, { ...options, execute: true }, m.io)).rejects.toThrow("actual signing principal");
  await expect(publish(prepared, { ...options, execute: true })).rejects.toThrow("actual signing principal");
  expect(m.queries).toEqual([]); expect(m.updates).toEqual([]);
});

fixtureTest("trusted review and execution use the ordinary ABI without a Neutron or cycle quotes", async (f) => {
  const m = mock(true), prepared = await preparePublisher(f.packageFile, f.listingFile), options = trustedOptions(f.options);
  const reviewed = await publish(prepared, options, m.io);
  expect(m.updates).toEqual([]); expect(m.queries).toEqual(["marketplace_info"]);
  expect(reviewed.estimatedRemainingCycles).toBe("0"); expect(reviewed.candidate).toBeNull();
  expect(reviewed.steps.every(step => step.cycles === "0")).toBe(true);
  const executed = await publish(prepared, { ...options, execute: true, maxCycles: 0n }, m.io);
  expect(m.updates.map(update => update.method)).toEqual(["listing_save", "upload_begin", "upload_chunk", "upload_finish", "upload_begin", "upload_chunk", "upload_finish", "candidate_submit"]);
  expect(m.updates.every(update => update.cycles === 0n)).toBe(true);
  const abis: Record<string, IDL.Type> = { listing_save: Listing, upload_begin: UploadBegin, upload_chunk: UploadChunk, upload_finish: UploadFinish, candidate_submit: Submit };
  for (const update of m.updates) {
    expect(decode<{ feeVersion: bigint }>(abis[update.method]!, Buffer.from(update.args, "hex")).feeVersion).toBe(1n);
  }
  expect(m.quotes).toEqual([]); expect(executed.attemptedCycles).toBe("0");
  expect(executed.candidate?.publisher.toText()).toBe(TRUSTED_FIRST_PARTY_PUBLISHER);
  expect(executed.candidate?.id).toBe(99n);
  expect(hex(executed.candidate!.digest)).toBe(prepared.files[0]!.digest);
  expect(hex(executed.candidate!.sourceDigest[0]!)).toBe(prepared.files[1]!.digest);
  const saved = JSON.parse(await readFile(f.options.journal, "utf8"));
  expect(saved.mode).toBe("trusted_direct"); expect(saved.caller).toBe(TRUSTED_FIRST_PARTY_PUBLISHER); expect(saved.neutron).toBeUndefined();
});

for (const method of ["upload_begin", "upload_chunk", "upload_finish", "candidate_submit"]) {
  fixtureTest(`trusted lost ${method} reply retains exact original IDs and zero-cycle bytes`, async (f) => {
    const m = mock(true), prepared = await preparePublisher(f.packageFile), options = { ...trustedOptions(f.options), execute: true };
    m.lose(method);
    await expect(publish(prepared, options, m.io)).rejects.toThrow("same journal and request ID");
    const dispatched = m.updates.at(-1)!;
    const interrupted = JSON.parse(await readFile(f.options.journal, "utf8"));
    expect(interrupted.steps.at(-1).outcome).toBe("unknown");
    const resumed = await publish(prepared, options, m.io);
    expect(m.updates.filter(update => update.method === dispatched.method && update.args === dispatched.args)).toEqual([dispatched, dispatched]);
    expect(m.updates.every(update => update.cycles === 0n)).toBe(true); expect(m.quotes).toEqual([]);
    expect(resumed.candidateId).toBe("99"); expect(resumed.candidate?.publisher.toText()).toBe(TRUSTED_FIRST_PARTY_PUBLISHER);
    expect(m.candidateCount()).toBe(1); expect(m.uploads.size).toBe(2);
    const count = m.updates.length;
    await publish(prepared, options, m.io);
    expect(m.updates).toHaveLength(count);
  });
}

fixtureTest("ordinary and trusted journals cannot be resumed as the other authority", async (f) => {
  const ordinary = mock(), trusted = mock(true), prepared = await preparePublisher(f.packageFile);
  await publish(prepared, f.options, ordinary.io);
  await expect(publish(prepared, { ...trustedOptions(f.options), execute: true }, trusted.io)).rejects.toThrow("different package bytes");
  const direct = { ...trustedOptions(f.options), journal: path.join(f.root, "trusted.json") };
  await publish(prepared, direct, trusted.io);
  await expect(publish(prepared, { ...f.options, journal: direct.journal, execute: true }, ordinary.io)).rejects.toThrow("different package bytes");
  expect(ordinary.updates).toEqual([]); expect(trusted.updates).toEqual([]);
});

fixtureTest("trusted authority cannot bypass exact source and dependency validation", async (f) => {
  const m = mock(true), prepared = await preparePublisher(f.packageFile), options = { ...trustedOptions(f.options), execute: true };
  const source = prepared.files.pop()!;
  await expect(publish(prepared, options, m.io)).rejects.toThrow("offered source must remain");
  prepared.files.push(source); prepared.dependencies.push({ appId: "wallet", minVersion: 100n });
  await expect(publish(prepared, options, m.io)).rejects.toThrow("dependencies differ");
  expect(m.queries).toEqual([]); expect(m.updates).toEqual([]);
});

for (const trustedDirect of [false, true]) {
  const mode = trustedDirect ? "trusted" : "ordinary";
  fixtureTest(`${mode} lost listing reply resumes exact fields without duplicating its revision`, async (f) => {
    const m = mock(trustedDirect), prepared = await preparePublisher(f.packageFile, f.listingFile);
    const options = { ...(trustedDirect ? trustedOptions(f.options) : f.options), execute: true };
    m.lose("listing_save");
    await expect(publish(prepared, options, m.io)).rejects.toThrow("same journal and request ID");
    const first = m.updates[0]!;
    expect(m.listing()?.revision).toBe(1n); expect(m.uploads.size).toBe(0);
    expect(JSON.parse(await readFile(options.journal, "utf8")).steps[0].outcome).toBe("unknown");
    const resumed = await publish(prepared, options, m.io);
    expect(m.updates.filter(update => update.method === "listing_save")).toEqual([first, first]);
    expect(m.listing()?.revision).toBe(1n); expect(resumed.candidateId).toBe("99");
    expect(m.candidateCount()).toBe(1); expect(m.uploads.size).toBe(2);
    const journal = JSON.parse(await readFile(options.journal, "utf8"));
    expect(journal.steps[0].attempts).toBe(2); expect(journal.steps[0].outcome).toBe("complete");
    expect(decode<{ ok: { revision: bigint } }>(ListingReply, Buffer.from(journal.steps[0].replyHex, "hex")).ok.revision).toBe(1n);
  });

  fixtureTest(`${mode} lost listing reply detects a concurrent edit before uploading`, async (f) => {
    const m = mock(trustedDirect), prepared = await preparePublisher(f.packageFile, f.listingFile);
    const options = { ...(trustedDirect ? trustedOptions(f.options) : f.options), execute: true };
    m.lose("listing_save");
    await expect(publish(prepared, options, m.io)).rejects.toThrow("same journal and request ID");
    const first = m.updates[0]!;
    const original = decode<Record<string, unknown>>(Listing, Buffer.from(first.args, "hex"));
    const changed = await m.io.update(options.target, trustedDirect ? TRUSTED_FIRST_PARTY_PUBLISHER : neutron, "listing_save", encode(Listing, { ...original, expectedRevision: [1n], title: "Concurrent publisher edit" }), first.cycles);
    expect(decode<{ ok: { revision: bigint } }>(ListingReply, changed).ok.revision).toBe(2n);
    await expect(publish(prepared, options, m.io)).rejects.toThrow("The listing changed");
    expect(m.updates.at(-1)).toEqual(first);
    expect(m.listing()?.revision).toBe(2n); expect(m.listing()?.fields.title).toBe("Concurrent publisher edit");
    expect(m.updates.every(update => update.method === "listing_save")).toBe(true);
    expect(m.uploads.size).toBe(0); expect(m.candidateCount()).toBe(0);
    const journal = JSON.parse(await readFile(options.journal, "utf8"));
    expect(journal.steps).toHaveLength(1); expect(journal.steps[0].outcome).toBe("rejected");
  });
}
