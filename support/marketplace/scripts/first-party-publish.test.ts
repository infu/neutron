// All rights reserved. See ../LICENSE.
import { expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "fflate";
import msgpack from "tiny-msgpack";
import { hashContent } from "neutron-tools/src/hash.ts";
import { formatAppVersion } from "neutron-tools/src/version.ts";
import { repositoryReleasePath, type RepositoryReleaseRecord } from "neutron-tools/src/repository.ts";
import { repositoryBetaReleasePath, repositoryChannelsPath } from "neutron-tools/src/release_channels.ts";
import { hostedSourceArtifactPath, packageHeaders, releaseHeaders, sourceHeaders, sha256Hex, PACKAGE_CONTENT_TYPE, SOURCE_CONTENT_TYPE } from "../../update-source/src/model.ts";
import { prepareTrustedCatalog, publishTrustedCatalog, TRUSTED_PUBLISHER_CALLER, AUTOMATED_PUBLICATION_ANALYSIS, type TrustedCatalog, type TrustedPublishTransport, type BatchReceipt, type LegacyBatchReceipt, type PublishOptions } from "./first-party-publish.ts";
import { catalogRequestId, legacyCatalogRequestId, resolvePublicationIdentity, main as publishCatalogMain } from "./publish-catalog.ts";
import { json } from "./operator-wire.ts";

const canister = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const caller = Principal.fromText(TRUSTED_PUBLISHER_CALLER);
const text = (value: string) => new TextEncoder().encode(value);
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");

async function fixture(root: string, dependency?: { app: string; min_version: number }, version = 100) {
  const packages = [];
  for (const id of ["alpha", "beta"]) {
    const directory = path.join(root, id); await mkdir(directory);
    const module = text('module { public class Init() { public func ping() : Text { "ok" } } }'), entry = hashContent(module);
    const manifest = text(JSON.stringify({ format: 3, id, name: id, version, update_source: canister, entry, func: { ping: { type: "update", async: false } }, ...(dependency ? { dependencies: { provider: { ...dependency, functions: ["ping"] } } } : {}) }));
    const source = gzipSync(msgpack.encode({ format: 1, package: { id, version }, files: [{ path: `apps/${id}/neutron.json`, mode: 0o644, content: manifest }] }));
    const sourceHash = hashContent(source);
    const license = text("License fixture"), notice = text("Application fixture"), thirdParty = text("Third-party fixture");
    const reference = (file: string, content: Uint8Array) => ({ path: file, sha256: hashContent(content), bytes: content.length });
    const record = { format: 1, package: { id, version, manifest: reference("neutron.json", manifest) }, license: { id: "LicenseRef-Neutron-Sovereign-Application-License-1.0", texts: [{ id: "LicenseRef-Neutron-Sovereign-Application-License-1.0", ...reference("legal/LICENSE.APP.txt", license) }] }, source: { kind: "https", revision: `source-sha256:${sourceHash}`, url: `https://${canister}.icp0.io/repo/v1/sources/${sourceHash}.source.v1.msgpack.gz`, sha256: sourceHash, bytes: source.length }, dependencies: dependency ? [{ alias: "provider", ...dependency, functions: ["ping"] }] : [], notices: [reference("legal/APPLICATION-NOTICE.txt", notice), reference("legal/THIRD_PARTY_NOTICES.md", thirdParty)], memory: null, build: { inputs: [], commands: [] } };
    const files = { "neutron.json": manifest, [`mo/${entry}.mo`]: module, "web/index.html": text("<main></main>"), "legal/LICENSE.APP.txt": license, "legal/APPLICATION-NOTICE.txt": notice, "legal/THIRD_PARTY_NOTICES.md": thirdParty, "legal/package-record.v1.json": text(JSON.stringify(record)) };
    const archive = msgpack.encode(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, gzipSync(content)])));
    const packageFile = path.join(directory, `${id}.v${formatAppVersion(version)}.neutron`);
    await writeFile(path.join(directory, "neutron.json"), manifest); await writeFile(packageFile, archive);
    const sourceFile = hostedSourceArtifactPath(packageFile, sourceHash);
    await mkdir(path.dirname(sourceFile), { recursive: true }); await writeFile(sourceFile, source);
    packages.push({ id, directory });
  }
  const catalog = await prepareTrustedCatalog({ configPath: path.join(root, "catalog.json"), updateSource: canister, packages });
  const options: PublishOptions = { publisher: TRUSTED_PUBLISHER_CALLER, requestId: "release-100", journal: path.join(root, "catalog-journal.json"), execute: true };
  return { root, catalog, options };
}
function caseTest(name: string, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, dependency?: { app: string; min_version: number }, version = 100) {
  test(name, async () => { const root = await mkdtemp(path.join(tmpdir(), "first-party-publish-")); try { await run(await fixture(root, dependency, version)); } finally { await rm(root, { recursive: true, force: true }); } }, 30_000);
}

function mock(catalog: TrustedCatalog) {
  const assets = new Map<string, { body: Uint8Array; headers: [string, string][] }>();
  const updates: { kind: string; id: string }[] = [], reads: string[] = [];
  let batch: BatchReceipt | null = null, loseReply = false;
  const proof: [string, string][] = [["ic-certificate", "certificate=:YQ==:, tree=:Yg==:, expr_path=:Yw==:, version=2"], ["ic-certificateexpression", "default_certification(ValidationArgs{})"]];
  const setRecord = (pathname: string, record: RepositoryReleaseRecord) => {
    const body = text(JSON.stringify(record));
    assets.set(pathname, { body, headers: [["content-type", "application/json"], ...releaseHeaders(sha256Hex(body))] });
  };
  const publishAssets = (channel: "stable" | "beta" = "beta", ids = catalog.releases.map(release => release.record.id)) => {
    for (const release of catalog.releases.filter(release => ids.includes(release.record.id))) {
      const body = text(JSON.stringify(release.record));
      assets.set(channel === "beta" ? release.releasePath : repositoryReleasePath(release.record.id), { body, headers: [["content-type", "application/json"], ...releaseHeaders(sha256Hex(body))] });
      assets.set(release.packagePath, { body: release.prepared.files[0]!.bytes, headers: [["content-type", PACKAGE_CONTENT_TYPE], ...packageHeaders(release.record.sha256)] });
      if (release.source) assets.set(release.source.path, { body: release.prepared.files.find(file => file.purpose === "source")!.bytes, headers: [["content-type", SOURCE_CONTENT_TYPE], ...sourceHeaders(release.source.sha256)] });
    }
  };
  const transport: TrustedPublishTransport = {
    caller,
    async stage(release, options) {
      updates.push({ kind: `stage:${release.record.id}`, id: options.requestId });
      expect(assets.has(release.releasePath)).toBe(false); // No partial beta exposure while staging.
      return { candidateId: BigInt(catalog.releases.indexOf(release) + 1), appId: release.record.id, version: BigInt(release.record.version), digest: Buffer.from(release.record.sha256, "hex"), sourceDigest: release.source ? [Buffer.from(release.source.sha256, "hex")] : [], publisher: caller };
    },
    async batchStatus() { reads.push("batch"); return batch; },
    async publishBatch(request) {
      updates.push({ kind: "batch", id: request.requestId });
      expect(request.operation).toBe("publish"); expect(request.channel).toBe("beta");
      expect(request.analysis).toBe(AUTOMATED_PUBLICATION_ANALYSIS);
      batch = { operation: "publish", channel: "beta", id: 44n, owner: caller, publisher: caller, requestId: request.requestId, analysis: request.analysis, createdAtNs: 1n, entries: request.candidates.map((candidate, index) => { const release = catalog.releases[Number(candidate.candidateId) - 1]!; return { candidateId: candidate.candidateId, appId: release.record.id, version: BigInt(release.record.version), digest: candidate.expectedDigest, sourceDigest: candidate.expectedSourceDigest, auditId: BigInt(index + 20) }; }) };
      publishAssets("beta", batch.entries.map(entry => entry.appId));
      if (loseReply) { loseReply = false; throw new Error("lost batch reply"); }
      return batch;
    },
  };
  const fetcher = (async (input: string | URL | Request) => {
    const pathname = new URL(String(input)).pathname; reads.push(pathname);
    if (pathname === repositoryChannelsPath()) {
      const body = text(JSON.stringify({ protocol: "neutron-repo-channels-v1", source: canister }));
      return new Response(body, { status: 200, headers: [...proof, ["content-type", "application/json"], ...releaseHeaders(sha256Hex(body))] });
    }
    const asset = assets.get(pathname);
    return new Response(asset ? Uint8Array.from(asset.body) : null, { status: asset ? 200 : 404, headers: [...proof, ...(asset?.headers ?? [])] });
  }) as typeof fetch;
  return { transport, fetcher, assets, reads, updates, publishAssets, setRecord, lose: () => { loseReply = true; }, batch: () => batch };
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
  if (result.action !== "publication_review") throw new Error("Expected publication review.");
  expect(result.action).toBe("publication_review"); expect(result.changedAppIds).toEqual(["alpha", "beta"]);
  expect(result.operation).toBe("publish"); expect(result.channel).toBe("beta");
  expect(result.packages.every(release => release.release_path === repositoryBetaReleasePath(release.id))).toBe(true);
  expect(result.analysis).toContain("not a manual malware"); expect(m.updates).toEqual([]);
  await expect(readFile(f.options.journal)).rejects.toThrow();
});

caseTest("all releases stage before one batch, then second run remotely verifies unchanged", async f => {
  const m = mock(f.catalog), options = { ...f.options, fetch: m.fetcher };
  const first = await publishTrustedCatalog(f.catalog, options, m.transport);
  expect(first.batch_id).toBe("44"); expect(m.updates.map(value => value.kind)).toEqual(["stage:alpha", "stage:beta", "batch"]);
  expect(first.operation).toBe("publish"); expect(first.channel).toBe("beta");
  expect(f.catalog.releases.every(release => !m.assets.has(repositoryReleasePath(release.record.id)))).toBe(true);
  const journal = JSON.parse(await readFile(f.options.journal, "utf8"));
  expect(journal.operation).toBe("publish"); expect(journal.channel).toBe("beta");
  expect(journal.batch.operation).toBe("publish"); expect(journal.batch.channel).toBe("beta");
  const count = m.updates.length, readCount = m.reads.length;
  const second = await publishTrustedCatalog(f.catalog, options, m.transport);
  if (second.action !== "publication_verified") throw new Error("Expected verified publication.");
  expect(second.batch_id).toBeNull(); expect(second.packages.map(value => value.status)).toEqual(["unchanged", "unchanged"]);
  expect(second.packages[0]!.release_digest).toBe(sha256Hex(m.assets.get(f.catalog.releases[0]!.releasePath)!.body));
  expect(second.packages.every(value => value.source?.status === "unchanged")).toBe(true);
  expect(m.updates).toHaveLength(count); expect(m.reads.length - readCount).toBe(8);
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

caseTest("mixed catalog retains stable releases and publishes only changed entries to beta", async f => {
  const m = mock(f.catalog); m.publishAssets("stable", ["alpha"]);
  const beta = f.catalog.releases[1]!;
  m.setRecord(repositoryReleasePath("beta"), { ...beta.record, version: 100 });
  const stable = new Map(["alpha", "beta"].map(id => [id, hex(m.assets.get(repositoryReleasePath(id))!.body)]));
  const options = { ...f.options, fetch: m.fetcher };
  const result = await publishTrustedCatalog(f.catalog, options, m.transport);
  if (result.action !== "publication_verified") throw new Error("Expected verified publication.");
  expect(m.updates.map(value => value.kind)).toEqual(["stage:beta", "batch"]);
  expect(result.packages.map(value => [value.id, value.channel, value.status, value.release_path])).toEqual([
    ["alpha", "stable", "unchanged", repositoryReleasePath("alpha")],
    ["beta", "beta", "published", repositoryBetaReleasePath("beta")],
  ]);
  expect(m.assets.has(repositoryBetaReleasePath("alpha"))).toBe(false);
  for (const [id, bytes] of stable) expect(hex(m.assets.get(repositoryReleasePath(id))!.body)).toBe(bytes);
  const repeat = await publishTrustedCatalog(f.catalog, options, m.transport);
  expect(repeat.batch_id).toBeNull();
  expect(m.updates).toHaveLength(2);
}, undefined, 200);

caseTest("existing exact stable archives remain unchanged when beta has never been published", async f => {
  const m = mock(f.catalog); m.publishAssets("stable");
  const result = await publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, m.transport);
  if (result.action !== "publication_verified") throw new Error("Expected verified publication.");
  expect(result.batch_id).toBeNull(); expect(m.updates).toEqual([]);
  expect(result.packages.every(value => value.channel === "stable" && value.status === "unchanged")).toBe(true);
  expect(result.packages.every(value => value.release_path === repositoryReleasePath(value.id))).toBe(true);
});

for (const channel of ["stable", "beta"] as const) {
  caseTest(`${channel} prevents globally lower versions or same-version digest changes`, async f => {
    const m = mock(f.catalog), release = f.catalog.releases[0]!;
    const pathname = channel === "stable" ? repositoryReleasePath(release.record.id) : release.releasePath;
    m.setRecord(pathname, { ...release.record, version: 101 });
    await expect(publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, m.transport)).rejects.toThrow("Refusing to downgrade");
    m.setRecord(pathname, { ...release.record, sha256: "a".repeat(64) });
    await expect(publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, m.transport)).rejects.toThrow("already contains different bytes");
    expect(m.updates).toEqual([]);
  });
}

caseTest("same version with different stable and beta bytes is rejected", async f => {
  const m = mock(f.catalog), release = f.catalog.releases[0]!;
  m.publishAssets("stable");
  m.setRecord(release.releasePath, { ...release.record, sha256: "a".repeat(64) });
  await expect(publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, m.transport)).rejects.toThrow("Stable and beta offer different bytes");
  expect(m.updates).toEqual([]);
});

for (const failure of ["missing", "proof", "source", "malformed"] as const) {
  caseTest(`channel descriptor ${failure} prevents publication`, async f => {
    const m = mock(f.catalog);
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await m.fetcher(input, init);
      if (new URL(String(input)).pathname !== repositoryChannelsPath()) return response;
      if (failure === "missing") return new Response(null, { status: 404, headers: response.headers });
      if (failure === "proof") { response.headers.delete("ic-certificate"); return response; }
      const body = text(JSON.stringify(failure === "source" ? { protocol: "neutron-repo-channels-v1", source: TRUSTED_PUBLISHER_CALLER } : { protocol: "unsupported", source: canister }));
      const headers = new Headers(response.headers); headers.set("etag", sha256Hex(body));
      return new Response(body, { headers });
    }) as typeof fetch;
    await expect(publishTrustedCatalog(f.catalog, { ...f.options, fetch: fetcher }, m.transport)).rejects.toThrow();
    expect(m.updates).toEqual([]); expect(m.reads).toEqual([repositoryChannelsPath()]);
    await expect(readFile(f.options.journal)).rejects.toThrow();
  });
}

caseTest("an invalid beta proof cannot fall back to an exact stable release", async f => {
  const m = mock(f.catalog); m.publishAssets("stable");
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await m.fetcher(input, init);
    if (new URL(String(input)).pathname === f.catalog.releases[0]!.releasePath) response.headers.delete("ic-certificate");
    return response;
  }) as typeof fetch;
  await expect(publishTrustedCatalog(f.catalog, { ...f.options, fetch: fetcher }, m.transport)).rejects.toThrow("certified HTTP v2 proof");
  expect(m.updates).toEqual([]);
});

caseTest("a receipt cannot relabel the committed beta batch as stable", async f => {
  const m = mock(f.catalog), publish = m.transport.publishBatch;
  m.transport.publishBatch = async request => ({ ...await publish(request), channel: "stable" } as unknown as BatchReceipt);
  await expect(publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, m.transport)).rejects.toThrow("batch operation, channel");
  const saved = JSON.parse(await readFile(f.options.journal, "utf8")); expect(saved.batch).toBeNull(); expect(saved.batchRequested).toBe(true);
  const count = m.updates.length;
  const result = await publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, m.transport);
  expect(result.batch_id).toBeNull(); expect(result.reconciled_batch_id).toBe("44"); expect(m.updates).toHaveLength(count);
});

caseTest("retained journals cannot change the operation or channel", async f => {
  const m = mock(f.catalog), options = { ...f.options, fetch: m.fetcher };
  await publishTrustedCatalog(f.catalog, options, m.transport);
  const saved = JSON.parse(await readFile(f.options.journal, "utf8")), reads = m.reads.length, writes = m.updates.length;
  for (const invalid of [{ ...saved, operation: "promote" }, { ...saved, channel: "stable" }, { ...saved, format: "marketplace-first-party-publish-v1" }]) {
    await writeFile(f.options.journal, JSON.stringify(invalid));
    await expect(publishTrustedCatalog(f.catalog, options, m.transport)).rejects.toThrow("original publication");
  }
  expect(m.reads).toHaveLength(reads); expect(m.updates).toHaveLength(writes);
});

for (const newer of ["stable", "beta"] as const) {
  caseTest(`dependencies use the newest approved head when ${newer} is newer`, async f => {
    const m = mock(f.catalog), dependency = { ...f.catalog.releases[0]!.record, id: "provider" };
    m.setRecord(repositoryReleasePath("provider"), { ...dependency, version: newer === "stable" ? 110 : 100 });
    m.setRecord(repositoryBetaReleasePath("provider"), { ...dependency, version: newer === "beta" ? 110 : 100 });
    const result = await publishTrustedCatalog(f.catalog, { ...f.options, execute: false, fetch: m.fetcher }, m.transport);
    expect(result.action).toBe("publication_review");
    expect(m.reads.filter(value => value === repositoryReleasePath("provider"))).toHaveLength(1);
    expect(m.reads.filter(value => value === repositoryBetaReleasePath("provider"))).toHaveLength(1);
    expect(m.updates).toEqual([]);
  }, { app: "provider", min_version: 105 });
}

caseTest("dependency beta proof failures abort even when stable is sufficient", async f => {
  const m = mock(f.catalog);
  m.setRecord(repositoryReleasePath("provider"), { ...f.catalog.releases[0]!.record, id: "provider", version: 110 });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await m.fetcher(input, init);
    if (new URL(String(input)).pathname === repositoryBetaReleasePath("provider")) response.headers.delete("ic-certificate");
    return response;
  }) as typeof fetch;
  await expect(publishTrustedCatalog(f.catalog, { ...f.options, fetch: fetcher }, m.transport)).rejects.toThrow("certified HTTP v2 proof");
  expect(m.updates).toEqual([]);
}, { app: "provider", min_version: 100 });

async function retainLegacy(f: Awaited<ReturnType<typeof fixture>>, phase: { requested?: boolean; staged?: number; changed?: string[]; completed?: boolean } = {}) {
  const changedAppIds = phase.changed ?? f.catalog.releases.map(release => release.record.id);
  const staged = f.catalog.releases.filter(release => changedAppIds.includes(release.record.id)).slice(0, phase.staged ?? changedAppIds.length).map((release, index) => ({ candidateId: String(index + 31), appId: release.record.id, version: String(release.record.version), digest: release.record.sha256, sourceDigest: release.source?.sha256 ?? null }));
  const receipt: LegacyBatchReceipt = { id: 88n, owner: caller, publisher: caller, requestId: f.options.requestId, analysis: AUTOMATED_PUBLICATION_ANALYSIS, createdAtNs: 999n, entries: staged.map((candidate, index) => ({ candidateId: BigInt(candidate.candidateId), appId: candidate.appId, version: BigInt(candidate.version), digest: Buffer.from(candidate.digest, "hex"), sourceDigest: candidate.sourceDigest ? [Buffer.from(candidate.sourceDigest, "hex")] : [], auditId: BigInt(index + 501) })) };
  const fingerprint = sha256Hex(text(json({ canister: f.catalog.canister, caller: TRUSTED_PUBLISHER_CALLER, publisher: f.options.publisher, requestId: f.options.requestId, analysis: AUTOMATED_PUBLICATION_ANALYSIS, releases: f.catalog.releases.map(release => ({ record: release.record, source: release.source, dependencies: release.prepared.dependencies, listing: release.prepared.listing ?? null })) })));
  const journal = { format: "marketplace-first-party-publish-v1", fingerprint, requestId: f.options.requestId, canister: f.catalog.canister, caller: TRUSTED_PUBLISHER_CALLER, publisher: f.options.publisher, changedAppIds, staged, batchRequested: phase.requested ?? true, batch: phase.completed ? { id: String(receipt.id), owner: caller.toText(), publisher: caller.toText(), requestId: receipt.requestId, analysis: receipt.analysis, createdAtNs: String(receipt.createdAtNs), entries: staged.map((candidate, index) => ({ ...candidate, auditId: String(receipt.entries[index]!.auditId) })) } : null };
  const original = json(journal);
  await writeFile(f.options.journal, original);
  return { journal, receipt, original };
}

caseTest("legacy lost reply reconciles original stable receipt and source without beta requests or rewriting history", async f => {
  const m = mock(f.catalog), retained = await retainLegacy(f);
  m.publishAssets("stable");
  m.transport.legacyBatchStatus = async requestId => { m.reads.push(`legacy:${requestId}`); expect(requestId).toBe(f.options.requestId); return retained.receipt; };
  const uploadFile = `${f.options.journal}.alpha.upload.json`, uploadBytes = "original candidate/upload outcome";
  await writeFile(uploadFile, uploadBytes);
  for (const execute of [false, true, true]) {
    const result = await publishTrustedCatalog(f.catalog, { ...f.options, execute, fetch: m.fetcher }, m.transport);
    expect(result).toMatchObject({ action: "publication_verified", operation: "reconcile_legacy_publish", channel: "stable", requestId: f.options.requestId, batch_id: null, reconciled_batch_id: "88" });
    if (result.action !== "publication_verified") throw new Error("Expected verified legacy recovery.");
    expect(result.packages.every(release => release.channel === "stable" && release.status === "unchanged" && release.source?.status === "unchanged" && release.release_path === repositoryReleasePath(release.id))).toBe(true);
    expect(await readFile(f.options.journal, "utf8")).toBe(retained.original);
    expect(await readFile(uploadFile, "utf8")).toBe(uploadBytes);
  }
  expect(m.updates).toEqual([]);
  expect(m.reads).not.toContain("batch"); expect(m.reads).not.toContain(repositoryChannelsPath());
  expect(m.reads.some(value => value.includes("/beta/"))).toBe(false);
  expect(m.reads.filter(value => value.startsWith("legacy:"))).toHaveLength(3);
});

caseTest("default beta invocation finds the old byte-derived journal and its custom retained request", async f => {
  const oldHash = sha256Hex(text(json({ canister: f.catalog.canister, publisher: TRUSTED_PUBLISHER_CALLER, releases: f.catalog.releases.map(release => ({ record: release.record, source: release.source, dependencies: release.prepared.dependencies, listing: release.prepared.listing ?? null })) })));
  expect(legacyCatalogRequestId(f.catalog)).toBe(oldHash); expect(catalogRequestId(f.catalog)).not.toBe(oldHash);
  f.options.journal = path.join(f.root, `${oldHash}.json`); f.options.requestId = "custom-original-stable-request";
  const retained = await retainLegacy(f), m = mock(f.catalog);
  const identity = await resolvePublicationIdentity(f.catalog, { journalDirectory: f.root });
  expect(identity).toEqual({ requestId: f.options.requestId, journal: f.options.journal });
  m.transport.legacyBatchStatus = async requestId => { m.reads.push(`legacy:${requestId}`); return null; };
  await expect(publishTrustedCatalog(f.catalog, { ...f.options, ...identity, fetch: m.fetcher }, m.transport)).rejects.toThrow("outcome remains unresolved");
  expect(m.reads).toEqual([`legacy:${f.options.requestId}`]); expect(m.updates).toEqual([]);
  await expect(readFile(path.join(f.root, `publish-beta-${catalogRequestId(f.catalog)}.json`))).rejects.toThrow();
  expect(await readFile(f.options.journal, "utf8")).toBe(retained.original);
  await expect(resolvePublicationIdentity(f.catalog, { journalDirectory: f.root, journal: path.join(f.root, "replacement.json") })).rejects.toThrow("Reconcile the original publication");
});

caseTest("an explicit custom predecessor journal retains its ID and a changed requested ID fails before remote calls", async f => {
  const retained = await retainLegacy(f), m = mock(f.catalog);
  expect(await resolvePublicationIdentity(f.catalog, { journalDirectory: f.root, journal: f.options.journal })).toEqual({ requestId: f.options.requestId, journal: f.options.journal });
  const identity = await resolvePublicationIdentity(f.catalog, { journalDirectory: f.root, journal: f.options.journal, requestId: "replacement" });
  await expect(publishTrustedCatalog(f.catalog, { ...f.options, ...identity, fetch: m.fetcher }, m.transport)).rejects.toThrow("original publication");
  expect(m.reads).toEqual([]); expect(m.updates).toEqual([]); expect(await readFile(f.options.journal, "utf8")).toBe(retained.original);
});

for (const failure of ["null", "error", "enoent", "unsupported"] as const) caseTest(`legacy ${failure} status never falls through to beta or trusts a saved completion`, async f => {
  const retained = await retainLegacy(f, { completed: true }), m = mock(f.catalog); m.publishAssets("stable");
  if (failure !== "unsupported") m.transport.legacyBatchStatus = async () => {
    if (failure === "null") return null;
    if (failure === "enoent") throw Object.assign(new Error("status unavailable"), { code: "ENOENT" });
    throw new Error("status unavailable");
  };
  await expect(publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, m.transport)).rejects.toThrow();
  expect(m.reads).toEqual([]); expect(m.updates).toEqual([]); expect(await readFile(f.options.journal, "utf8")).toBe(retained.original);
});

for (const staged of [0, 1, 2]) caseTest(`legacy precommit phase with ${staged} staged candidates cannot silently become beta`, async f => {
  const retained = await retainLegacy(f, { requested: false, staged }), m = mock(f.catalog);
  m.transport.legacyBatchStatus = async requestId => { m.reads.push(`legacy:${requestId}`); return null; };
  await expect(publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, m.transport)).rejects.toThrow("stopped before requesting its stable commit");
  expect(m.reads).toEqual([`legacy:${f.options.requestId}`]); expect(m.updates).toEqual([]);
  expect(await readFile(f.options.journal, "utf8")).toBe(retained.original);
});

caseTest("legacy unchanged catalog verifies stable package/source postflight without inventing a batch", async f => {
  const retained = await retainLegacy(f, { requested: false, changed: [] }), m = mock(f.catalog); m.publishAssets("stable");
  const result = await publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, m.transport);
  expect(result).toMatchObject({ operation: "reconcile_legacy_publish", channel: "stable", batch_id: null, reconciled_batch_id: null });
  expect(m.updates).toEqual([]); expect(m.reads).not.toContain(repositoryChannelsPath());
  expect(await readFile(f.options.journal, "utf8")).toBe(retained.original);
});

caseTest("legacy mutable fields, staged identities and commit phase must match original evidence before queries", async f => {
  const retained = await retainLegacy(f), m = mock(f.catalog);
  const { journal } = retained;
  const mutations = [
    { ...journal, requestId: "another" }, { ...journal, canister: TRUSTED_PUBLISHER_CALLER }, { ...journal, caller: canister },
    { ...journal, changedAppIds: ["alpha", "alpha"] }, { ...journal, changedAppIds: ["foreign"] },
    { ...journal, staged: journal.staged.slice(0, 1) }, { ...journal, staged: [journal.staged[0], journal.staged[0]] },
    { ...journal, staged: journal.staged.map(candidate => ({ ...candidate, sourceDigest: "a".repeat(64) })) },
    { ...journal, operation: "publish", channel: "beta" },
  ];
  for (const mutation of mutations) {
    await writeFile(f.options.journal, json(mutation));
    await expect(publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, m.transport)).rejects.toThrow();
    expect(await readFile(f.options.journal, "utf8")).toBe(json(mutation));
  }
  expect(m.reads).toEqual([]); expect(m.updates).toEqual([]);
});

caseTest("legacy original receipt validates owner, request, exact candidates and source digests", async f => {
  const retained = await retainLegacy(f), m = mock(f.catalog); m.publishAssets("stable");
  const receipt = retained.receipt;
  const mutations: LegacyBatchReceipt[] = [
    { ...receipt, owner: Principal.fromText(canister) }, { ...receipt, publisher: Principal.fromText(canister) },
    { ...receipt, requestId: "another" }, { ...receipt, analysis: "another review" },
    { ...receipt, entries: receipt.entries.slice(0, 1) }, { ...receipt, entries: [receipt.entries[0]!, receipt.entries[0]!] },
    { ...receipt, entries: receipt.entries.map(entry => ({ ...entry, candidateId: entry.candidateId + 1n })) },
    { ...receipt, entries: receipt.entries.map(entry => ({ ...entry, sourceDigest: [] })) },
    { ...receipt, entries: receipt.entries.map(entry => ({ ...entry, digest: Buffer.from("a".repeat(64), "hex") })) },
  ];
  for (const mutation of mutations) {
    m.transport.legacyBatchStatus = async () => mutation;
    await expect(publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, m.transport)).rejects.toThrow("Legacy publication receipt");
    expect(await readFile(f.options.journal, "utf8")).toBe(retained.original);
  }
  expect(m.reads).toEqual([]); expect(m.updates).toEqual([]);
});

caseTest("a previously saved legacy receipt cannot change ID, audit identity or timestamp during reconciliation", async f => {
  const retained = await retainLegacy(f, { completed: true }), m = mock(f.catalog); m.publishAssets("stable");
  for (const mutation of [
    { ...retained.receipt, id: 89n }, { ...retained.receipt, createdAtNs: 1000n },
    { ...retained.receipt, entries: retained.receipt.entries.map(entry => ({ ...entry, auditId: entry.auditId + 1n })) },
  ]) {
    m.transport.legacyBatchStatus = async () => mutation;
    await expect(publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, m.transport)).rejects.toThrow("receipt already retained");
  }
  expect(m.reads).toEqual([]); expect(m.updates).toEqual([]); expect(await readFile(f.options.journal, "utf8")).toBe(retained.original);
});

for (const failure of ["beta_only", "superseded", "source", "package", "proof"] as const) caseTest(`legacy ${failure} postflight cannot certify recovery or start a replacement`, async f => {
  const retained = await retainLegacy(f), m = mock(f.catalog);
  m.transport.legacyBatchStatus = async () => retained.receipt;
  m.publishAssets(failure === "beta_only" ? "beta" : "stable");
  const release = f.catalog.releases[0]!;
  if (failure === "superseded") m.setRecord(repositoryReleasePath(release.record.id), { ...release.record, version: release.record.version + 1 });
  if (failure === "source") m.assets.get(release.source!.path)!.body = text("corrupt source");
  if (failure === "package") m.assets.get(release.packagePath)!.body = text("corrupt package");
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await m.fetcher(input, init); if (failure === "proof") response.headers.delete("ic-certificate"); return response;
  }) as typeof fetch;
  await expect(publishTrustedCatalog(f.catalog, { ...f.options, fetch: fetcher }, m.transport)).rejects.toThrow();
  expect(m.updates).toEqual([]); expect(m.reads).not.toContain("batch"); expect(m.reads).not.toContain(repositoryChannelsPath());
  expect(await readFile(f.options.journal, "utf8")).toBe(retained.original);
});

caseTest("changed retained catalog listings fail legacy fingerprint validation rather than create beta identity", async f => {
  const retained = await retainLegacy(f), m = mock(f.catalog);
  f.catalog.releases[0]!.prepared.listing = { appId: "alpha", title: "Changed", summary: "Changed", description: "Changed", priceUsdMicros: 0n, iconArtifact: [], screenshots: [], expectedRevision: [1n] };
  await expect(publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, m.transport)).rejects.toThrow("original publication");
  expect(m.reads).toEqual([]); expect(m.updates).toEqual([]); expect(await readFile(f.options.journal, "utf8")).toBe(retained.original);
});

caseTest("an explicitly selected beta journal can retain the predecessor-shaped filename", async f => {
  const m = mock(f.catalog);
  f.options.journal = path.join(f.root, `${legacyCatalogRequestId(f.catalog)}.json`);
  f.options.requestId = catalogRequestId(f.catalog);
  await publishTrustedCatalog(f.catalog, { ...f.options, fetch: m.fetcher }, m.transport);
  const identity = await resolvePublicationIdentity(f.catalog, { journalDirectory: f.root, journal: f.options.journal });
  const count = m.updates.length;
  expect((await publishTrustedCatalog(f.catalog, { ...f.options, ...identity, fetch: m.fetcher }, m.transport)).batch_id).toBeNull();
  expect(m.updates).toHaveLength(count);
});

test("CLI custom legacy journal reviews the retained stable outcome and disables private artifact authorization without execute", async () => {
  const temporaryDirectory = path.resolve(import.meta.dir, "../../../tmp");
  await mkdir(temporaryDirectory, { recursive: true });
  const root = await mkdtemp(path.join(temporaryDirectory, "legacy-publication-cli-"));
  try {
    const f = await fixture(root);
    const retained = await retainLegacy(f), m = mock(f.catalog); m.publishAssets("stable");
    const catalogFile = path.join(f.root, "catalog.json");
    await writeFile(catalogFile, json({ format: 1, update_source: canister, packages: f.catalog.releases.map(release => ({ id: release.record.id, directory: release.record.id })) }));
    m.transport.legacyBatchStatus = async requestId => { expect(requestId).toBe(f.options.requestId); return retained.receipt; };
    let output = "";
    await publishCatalogMain(["--catalog", catalogFile, "--journal", f.options.journal], {
      environment: async options => {
        expect(options.allowArtifactAuthorization).toBe(false);
        return { transport: m.transport, fetch: m.fetcher };
      },
      write: value => { output += value; },
    });
    expect(JSON.parse(output)).toMatchObject({ operation: "reconcile_legacy_publish", channel: "stable", requestId: f.options.requestId, batch_id: null, reconciled_batch_id: "88" });
    expect(m.updates).toEqual([]); expect(m.reads).not.toContain(repositoryChannelsPath());
    expect(await readFile(f.options.journal, "utf8")).toBe(retained.original);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
