// All rights reserved. See ../LICENSE.
import { expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "fflate";
import msgpack from "tiny-msgpack";
import { hashContent } from "neutron-tools/src/hash.ts";
import { hostedSourceArtifactPath, packageHeaders, releaseHeaders, sourceHeaders, sha256Hex, PACKAGE_CONTENT_TYPE, SOURCE_CONTENT_TYPE } from "../../update-source/src/model.ts";
import { prepareTrustedCatalog, publishTrustedCatalog, TRUSTED_PUBLISHER_CALLER, AUTOMATED_PUBLICATION_ANALYSIS, type TrustedCatalog, type TrustedPublishTransport, type BatchReceipt, type PublishOptions } from "./first-party-publish.ts";

const canister = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const caller = Principal.fromText(TRUSTED_PUBLISHER_CALLER);
const text = (value: string) => new TextEncoder().encode(value);
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");

async function fixture(root: string) {
  const packages = [];
  for (const id of ["alpha", "beta"]) {
    const directory = path.join(root, id); await mkdir(directory);
    const module = text('module { public class Init() { public func ping() : Text { "ok" } } }'), entry = hashContent(module);
    const manifest = text(JSON.stringify({ format: 3, id, name: id, version: 100, update_source: canister, entry, func: { ping: { type: "update", async: false } } }));
    const source = gzipSync(msgpack.encode({ format: 1, package: { id, version: 100 }, files: [{ path: `apps/${id}/neutron.json`, mode: 0o644, content: manifest }] }));
    const sourceHash = hashContent(source);
    const license = text("License fixture"), notice = text("Application fixture"), thirdParty = text("Third-party fixture");
    const reference = (file: string, content: Uint8Array) => ({ path: file, sha256: hashContent(content), bytes: content.length });
    const record = { format: 1, package: { id, version: 100, manifest: reference("neutron.json", manifest) }, license: { id: "LicenseRef-Neutron-Sovereign-Application-License-1.0", texts: [{ id: "LicenseRef-Neutron-Sovereign-Application-License-1.0", ...reference("legal/LICENSE.APP.txt", license) }] }, source: { kind: "https", revision: `source-sha256:${sourceHash}`, url: `https://${canister}.icp0.io/repo/v1/sources/${sourceHash}.source.v1.msgpack.gz`, sha256: sourceHash, bytes: source.length }, dependencies: [], notices: [reference("legal/APPLICATION-NOTICE.txt", notice), reference("legal/THIRD_PARTY_NOTICES.md", thirdParty)], memory: null, build: { inputs: [], commands: [] } };
    const files = { "neutron.json": manifest, [`mo/${entry}.mo`]: module, "web/index.html": text("<main></main>"), "legal/LICENSE.APP.txt": license, "legal/APPLICATION-NOTICE.txt": notice, "legal/THIRD_PARTY_NOTICES.md": thirdParty, "legal/package-record.v1.json": text(JSON.stringify(record)) };
    const archive = msgpack.encode(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, gzipSync(content)])));
    const packageFile = path.join(directory, `${id}.v0.1.0.neutron`);
    await writeFile(path.join(directory, "neutron.json"), manifest); await writeFile(packageFile, archive);
    const sourceFile = hostedSourceArtifactPath(packageFile, sourceHash);
    await mkdir(path.dirname(sourceFile), { recursive: true }); await writeFile(sourceFile, source);
    packages.push({ id, directory });
  }
  const catalog = await prepareTrustedCatalog({ configPath: path.join(root, "catalog.json"), updateSource: canister, packages });
  const options: PublishOptions = { publisher: TRUSTED_PUBLISHER_CALLER, requestId: "release-100", journal: path.join(root, "catalog-journal.json"), execute: true };
  return { root, catalog, options };
}
function caseTest(name: string, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  test(name, async () => { const root = await mkdtemp(path.join(tmpdir(), "first-party-publish-")); try { await run(await fixture(root)); } finally { await rm(root, { recursive: true, force: true }); } }, 30_000);
}

function mock(catalog: TrustedCatalog) {
  const assets = new Map<string, { body: Uint8Array; headers: [string, string][] }>();
  const updates: { kind: string; id: string }[] = [], reads: string[] = [];
  let batch: BatchReceipt | null = null, loseReply = false;
  const proof: [string, string][] = [["ic-certificate", "certificate=:YQ==:, tree=:Yg==:, expr_path=:Yw==:, version=2"], ["ic-certificateexpression", "default_certification(ValidationArgs{})"]];
  const publishAssets = () => {
    for (const release of catalog.releases) {
      const body = text(JSON.stringify(release.record));
      assets.set(release.releasePath, { body, headers: [["content-type", "application/json"], ...releaseHeaders(sha256Hex(body))] });
      assets.set(release.packagePath, { body: release.prepared.files[0]!.bytes, headers: [["content-type", PACKAGE_CONTENT_TYPE], ...packageHeaders(release.record.sha256)] });
      if (release.source) assets.set(release.source.path, { body: release.prepared.files.find(file => file.purpose === "source")!.bytes, headers: [["content-type", SOURCE_CONTENT_TYPE], ...sourceHeaders(release.source.sha256)] });
    }
  };
  const transport: TrustedPublishTransport = {
    caller,
    async stage(release, options) {
      updates.push({ kind: `stage:${release.record.id}`, id: options.requestId });
      expect(assets.size).toBe(0); // No partial catalog exposure while staging.
      return { candidateId: BigInt(catalog.releases.indexOf(release) + 1), appId: release.record.id, version: BigInt(release.record.version), digest: Buffer.from(release.record.sha256, "hex"), sourceDigest: release.source ? [Buffer.from(release.source.sha256, "hex")] : [], publisher: caller };
    },
    async batchStatus() { reads.push("batch"); return batch; },
    async publishBatch(request) {
      updates.push({ kind: "batch", id: request.requestId });
      expect(request.candidates).toHaveLength(catalog.releases.length);
      expect(request.analysis).toBe(AUTOMATED_PUBLICATION_ANALYSIS);
      batch = { id: 44n, owner: caller, publisher: caller, requestId: request.requestId, analysis: request.analysis, createdAtNs: 1n, entries: request.candidates.map((candidate, index) => ({ candidateId: candidate.candidateId, appId: catalog.releases[index]!.record.id, version: BigInt(catalog.releases[index]!.record.version), digest: candidate.expectedDigest, sourceDigest: candidate.expectedSourceDigest, auditId: BigInt(index + 20) })) };
      publishAssets();
      if (loseReply) { loseReply = false; throw new Error("lost batch reply"); }
      return batch;
    },
  };
  const fetcher = (async (input: string | URL | Request) => {
    const pathname = new URL(String(input)).pathname; reads.push(pathname);
    const asset = assets.get(pathname);
    return new Response(asset ? Uint8Array.from(asset.body) : null, { status: asset ? 200 : 404, headers: [...proof, ...(asset?.headers ?? [])] });
  }) as typeof fetch;
  return { transport, fetcher, assets, reads, updates, publishAssets, lose: () => { loseReply = true; }, batch: () => batch };
}

caseTest("exact first-party caller is required before remote calls or writes", async f => {
  const m = mock(f.catalog);
  await expect(publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, { ...m.transport, caller: Principal.fromText(canister) })).rejects.toThrow("exact assigned Blast");
  await expect(publishTrustedCatalog(f.catalog, { ...f.options, publisher: canister, fetch: m.fetcher }, m.transport)).rejects.toThrow("listings must belong");
  expect(m.reads).toEqual([]); expect(m.updates).toEqual([]);
});

caseTest("review inspects catalog without writes and describes automated checks truthfully", async f => {
  const m = mock(f.catalog);
  const result = await publishTrustedCatalog(f.catalog, { ...f.options, execute: false, fetch: m.fetcher }, m.transport);
  expect(result.action).toBe("publication_review"); expect(result.changedAppIds).toEqual(["alpha", "beta"]);
  expect(result.analysis).toContain("not a manual malware"); expect(m.updates).toEqual([]);
  await expect(readFile(f.options.journal)).rejects.toThrow();
});

caseTest("all releases stage before one batch, then second run remotely verifies unchanged", async f => {
  const m = mock(f.catalog), options = { ...f.options, fetch: m.fetcher };
  const first = await publishTrustedCatalog(f.catalog, options, m.transport);
  expect(first.batch_id).toBe("44"); expect(m.updates.map(value => value.kind)).toEqual(["stage:alpha", "stage:beta", "batch"]);
  const count = m.updates.length, readCount = m.reads.length;
  const second = await publishTrustedCatalog(f.catalog, options, m.transport);
  if (second.action !== "publication_verified") throw new Error("Expected verified publication.");
  expect(second.batch_id).toBeNull(); expect(second.packages.map(value => value.status)).toEqual(["unchanged", "unchanged"]);
  expect(second.packages[0]!.release_digest).toBe(sha256Hex(m.assets.get(f.catalog.releases[0]!.releasePath)!.body));
  expect(second.packages.every(value => value.source?.status === "unchanged")).toBe(true);
  expect(m.updates).toHaveLength(count); expect(m.reads.length - readCount).toBe(7);
});

caseTest("lost atomic commit reply reconciles original batch without upload or approval replay", async f => {
  const m = mock(f.catalog), options = { ...f.options, fetch: m.fetcher }; m.lose();
  await expect(publishTrustedCatalog(f.catalog, options, m.transport)).rejects.toThrow("lost batch reply");
  const saved = JSON.parse(await readFile(f.options.journal, "utf8")); expect(saved.batchRequested).toBe(true); expect(saved.batch).toBeNull();
  const count = m.updates.length;
  const result = await publishTrustedCatalog(f.catalog, options, m.transport);
  expect(result.batch_id).toBeNull(); expect(result.reconciled_batch_id).toBe("44"); expect(m.updates).toHaveLength(count);
});

caseTest("source corruption fails postflight and retries never republish a completed batch", async f => {
  const m = mock(f.catalog), options = { ...f.options, fetch: m.fetcher };
  const publish = m.transport.publishBatch;
  m.transport.publishBatch = async request => { const receipt = await publish(request); m.assets.get(f.catalog.releases[0]!.source!.path)!.body = text("corrupt"); return receipt; };
  await expect(publishTrustedCatalog(f.catalog, options, m.transport)).rejects.toThrow("expected");
  const count = m.updates.length;
  expect(JSON.parse(await readFile(f.options.journal, "utf8")).batch.id).toBe("44");
  await expect(publishTrustedCatalog(f.catalog, options, m.transport)).rejects.toThrow("expected"); expect(m.updates).toHaveLength(count);
  m.publishAssets(); expect((await publishTrustedCatalog(f.catalog, options, m.transport)).batch_id).toBeNull(); expect(m.updates).toHaveLength(count);
});

caseTest("new invocation recognizes already-current exact releases without staging or batch calls", async f => {
  const m = mock(f.catalog); m.publishAssets();
  f.catalog.releases[0]!.prepared.listing = { appId: "alpha", title: "New metadata", summary: "Summary", description: "Description", priceUsdMicros: 0n, iconArtifact: [], screenshots: [], expectedRevision: [1n] };
  const result = await publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, m.transport);
  expect(result.batch_id).toBeNull(); expect(m.updates).toEqual([]); expect(m.reads).not.toContain("batch");
  expect(result.skippedListingAppIds).toEqual(["alpha"]);
});

caseTest("paid artifact postflight preserves private no-store rather than requiring public caching", async f => {
  const m = mock(f.catalog); m.publishAssets();
  for (const [pathname, asset] of m.assets) if (!pathname.includes("/releases/")) {
    asset.headers = [...asset.headers.filter(([name]) => name.toLowerCase() !== "cache-control"), ["cache-control", "private, no-store"]];
  }
  const result = await publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, m.transport);
  expect(result.action).toBe("publication_verified"); expect(result.batch_id).toBeNull(); expect(m.updates).toEqual([]);
});

caseTest("revoked or changed current release does not trigger automatic reapproval", async f => {
  const m = mock(f.catalog), options = { ...f.options, fetch: m.fetcher };
  await publishTrustedCatalog(f.catalog, options, m.transport);
  m.assets.delete(f.catalog.releases[0]!.releasePath);
  const count = m.updates.length;
  await expect(publishTrustedCatalog(f.catalog, options, m.transport)).rejects.toThrow("Any completed batch stays retained"); expect(m.updates).toHaveLength(count);
});

caseTest("wrong candidate source or changed journal identity prevents promotion", async f => {
  const m = mock(f.catalog), options = { ...f.options, fetch: m.fetcher }, stage = m.transport.stage;
  m.transport.stage = async (release, value) => ({ ...await stage(release, value), sourceDigest: [] });
  await expect(publishTrustedCatalog(f.catalog, options, m.transport)).rejects.toThrow("Staged candidate");
  expect(m.updates.map(value => value.kind)).toEqual(["stage:alpha"]);
  await expect(publishTrustedCatalog(f.catalog, { ...options, requestId: "different-id" }, m.transport)).rejects.toThrow("original publication");
});
