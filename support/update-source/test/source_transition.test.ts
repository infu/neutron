import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import msgpack from "tiny-msgpack";
import { hashContent } from "neutron-tools/src/hash.ts";
import { packageArchiveFilename } from "neutron-tools/src/package_archive.ts";
import { neutronAppSourceRepositoryPath } from "neutron-tools/src/package_record.ts";
import { serializeRepositoryReleaseRecord } from "neutron-tools/src/repository.ts";
import { updateSourceOrigin } from "../src/http.ts";
import { inspectUpdatePackage, packageHeaders, releaseHeaders, sourceHeaders, sha256Hex, PACKAGE_CONTENT_TYPE, RELEASE_CONTENT_TYPE, SOURCE_CONTENT_TYPE, PACKAGE_MAX_AGE_SECONDS, RELEASE_MAX_AGE_SECONDS, SOURCE_MAX_AGE_SECONDS, type InspectedUpdatePackage } from "../src/model.ts";
import { publishPackageFiles, type PublishOptions } from "../src/publish.ts";
import { loadReleaseCatalog, resolveReleaseCatalogPackageFiles } from "../src/release_catalog.ts";
import { loadSourceTransition, parseSourceTransition, type SourceTransition } from "../src/source_transition.ts";
import { MemoryAssetState, storedAsset } from "./memory_asset.ts";

const oldSource = "233tv-xiaaa-aaaay-aacta-cai";
const newSource = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const oldOrigin = updateSourceOrigin({ canisterId: oldSource });
const newOrigin = updateSourceOrigin({ canisterId: newSource });
const publisher = "publisher";
const roots: string[] = [];
const text = (value: string) => new TextEncoder().encode(value);

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function archive(id: string, version: number, updateSource: string): { bytes: Uint8Array; manifest: object } {
  const module = text('module { public class Init() { public func ping() : Text { "ok" } } }');
  const entry = hashContent(module);
  const manifest = { format: 3, id, name: id, version, update_source: updateSource, entry, func: { ping: { type: "update", async: false } } };
  return { manifest, bytes: msgpack.encode({ "neutron.json": gzipSync(text(JSON.stringify(manifest))), "web/index.html": gzipSync(text("<main></main>")), [`mo/${entry}.mo`]: gzipSync(module), ...(id === "kernel" ? { "connection-providers.json": gzipSync(text(JSON.stringify({ schema: "neutron.connection-provider-support.v1", providers: [] }))) } : {}) }) };
}

function candidate(id = "alpha", version = 101, target = newSource): InspectedUpdatePackage {
  const bytes = archive(id, version, target).bytes;
  const file = `${id}.neutron`;
  const { hostedSource: _source, ...metadata } = inspectUpdatePackage(file, bytes);
  return { file, bytes, ...metadata };
}

function transitionFor(candidates: readonly InspectedUpdatePackage[]): SourceTransition {
  return parseSourceTransition({ format: 1, from_source: oldSource, to_source: newSource, packages: candidates.map(({ record }) => ({ id: record.id, version: record.version, sha256: record.sha256 })) });
}

function seed(state: MemoryAssetState, item: InspectedUpdatePackage): void {
  state.seed(item.releasePath, storedAsset({ bytes: item.releaseBytes, contentType: RELEASE_CONTENT_TYPE, headers: releaseHeaders(sha256Hex(item.releaseBytes)), maxAge: RELEASE_MAX_AGE_SECONDS }));
  state.seed(item.packagePath, storedAsset({ bytes: item.bytes, contentType: PACKAGE_CONTENT_TYPE, headers: packageHeaders(item.record.sha256), maxAge: PACKAGE_MAX_AGE_SECONDS }));
  if (item.hostedSource) state.seed(item.hostedSource.path, storedAsset({ bytes: item.hostedSource.bytes, contentType: SOURCE_CONTENT_TYPE, headers: sourceHeaders(item.hostedSource.sha256), maxAge: SOURCE_MAX_AGE_SECONDS }));
}

function publication(selected = [candidate()]) {
  const old = new MemoryAssetState();
  old.permissions.get("Commit")!.add(publisher);
  const next = new MemoryAssetState();
  for (const item of selected) { seed(next, item); seed(old, candidate(item.record.id, 100, oldSource)); }
  const calls: { origin: string; oldCommits: number; credentials: RequestCredentials | undefined; authorization: string | null }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ origin: url.origin, oldCommits: old.commits, credentials: init?.credentials, authorization: new Headers(init?.headers).get("Authorization") });
    if (url.origin === oldOrigin) return old.fetch(oldOrigin)(input, init);
    if (url.origin === newOrigin) return next.fetch(newOrigin)(input, init);
    throw new Error("Unexpected origin");
  }) as typeof globalThis.fetch;
  const options: PublishOptions = { canisterId: oldSource, origin: oldOrigin, port: old.actor(publisher), fetch, transition: transitionFor(selected), read: async (file) => selected.find((item) => item.file === file)!.bytes,
    inspect: (file) => selected.find((item) => item.file === file)!,
    readSource: async (file) => selected.find((item) => item.hostedSource && file.includes(item.hostedSource.sha256))!.hostedSource!.bytes };
  return { old, next, calls, options, files: selected.map(({ file }) => file) };
}

describe("explicit source transitions", () => {
  test("pins exact releases and rejects malformed, duplicate, same-source or unscoped input", () => {
    const base = { format: 1, from_source: oldSource, to_source: newSource, packages: [{ id: "alpha", version: 101, sha256: "a".repeat(64) }] };
    expect(parseSourceTransition(base).toSource).toBe(newSource);
    expect(() => parseSourceTransition({ ...base, allowAnyVersion: true })).toThrow("must contain exactly");
    expect(() => parseSourceTransition({ ...base, to_source: oldSource })).toThrow("different sources");
    expect(() => parseSourceTransition({ ...base, packages: [] })).toThrow("exact package entries");
    expect(() => parseSourceTransition({ ...base, packages: [...base.packages, ...base.packages] })).toThrow("repeats an app ID");
    expect(() => parseSourceTransition({ ...base, packages: [{ ...base.packages[0], version: 101.5 }] })).toThrow("invalid release version");
    expect(() => parseSourceTransition({ ...base, packages: [{ ...base.packages[0], sha256: "A".repeat(64) }] })).toThrow("lowercase package SHA-256");
  });

  test("validates real catalog archives only for the exact opt-in subset", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "neutron-source-transition-")); roots.push(root);
    const items = [candidate(), candidate("bravo", 100, oldSource)];
    for (const item of items) {
      const directory = path.join(root, "apps", item.record.id); await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "neutron.json"), JSON.stringify(archive(item.record.id, item.record.version, item.record.id === "alpha" ? newSource : oldSource).manifest));
      await writeFile(path.join(directory, packageArchiveFilename(item.record.id, item.record.version)), item.bytes);
    }
    const catalogPath = path.join(root, "catalog.json");
    await writeFile(catalogPath, JSON.stringify({ format: 1, update_source: oldSource, packages: items.map(({ record }) => ({ id: record.id, directory: `apps/${record.id}` })) }));
    const catalog = await loadReleaseCatalog(catalogPath, { repositoryRoot: root });
    await expect(resolveReleaseCatalogPackageFiles(catalog)).rejects.toThrow(`must use update source ${oldSource}`);
    const transition = transitionFor([items[0]!]);
    await expect(resolveReleaseCatalogPackageFiles(catalog, { transition })).resolves.toHaveLength(2);
    // Both selected manifests disagree with this sidecar. Concurrent file reads
    // may report either mismatch first; both must reject before publication.
    await expect(resolveReleaseCatalogPackageFiles(catalog, { transition: transitionFor([items[1]!]) })).rejects.toThrow("must use update source");
    await expect(resolveReleaseCatalogPackageFiles(catalog, { transition: { ...transition, fromSource: newSource } })).rejects.toThrow("different sources");
    await expect(resolveReleaseCatalogPackageFiles(catalog, { transition: transitionFor([candidate("missing")]) })).rejects.toThrow("absent from the selected catalog");
    await expect(resolveReleaseCatalogPackageFiles(catalog, { transition: { ...transition, packages: [{ ...transition.packages[0]!, sha256: "0".repeat(64) }] } })).rejects.toThrow("pinned version and digest");
    const filename = path.join(root, "transition.json");
    await writeFile(filename, JSON.stringify({ format: 1, from_source: oldSource, to_source: newSource, packages: transition.packages }));
    expect(await loadSourceTransition(filename)).toEqual(transition);
  });

  test("checks all new-source public bytes before one old-source commit; exact retry is receipt-v2 unchanged", async () => {
    const selected = [candidate("alpha"), candidate("kernel")];
    const { old, calls, options, files } = publication(selected);
    const first = await publishPackageFiles(files, options);
    expect(first).toMatchObject({ protocol: "neutron-update-source-publish-v2", atomic: true, batch_id: "1" });
    expect(first.packages.every(({ status }) => status === "published")).toBe(true);
    const remote = calls.filter(({ origin }) => origin === newOrigin);
    expect(remote).toHaveLength(4);
    expect(remote.every((call) => call.oldCommits === 0 && call.credentials === "omit" && call.authorization === null)).toBe(true);
    const second = await publishPackageFiles(files, options);
    expect(old.commits).toBe(1);
    expect(second.batch_id).toBeNull();
    expect(second.packages.every(({ status }) => status === "unchanged")).toBe(true);
  });

  test("verifies offered source at the new canonical origin, retains exact copies at both sources", async () => {
    const item = candidate();
    const sourceBytes = new Uint8Array(gzipSync(msgpack.encode({ format: 1, package: { id: item.record.id, version: item.record.version }, files: [{ path: "apps/alpha/neutron.json", mode: 0o644, content: text(JSON.stringify({ id: "alpha", version: 101 })) }] })));
    const digest = sha256Hex(sourceBytes); const sourcePath = neutronAppSourceRepositoryPath(digest);
    item.hostedSource = { url: `${newOrigin}${sourcePath}`, path: sourcePath, revision: `source-sha256:${digest}`, sha256: digest, size: sourceBytes.byteLength, package: { id: "alpha", version: 101 }, buildInputs: [], file: `unused/${digest}.source.v1.msgpack.gz`, bytes: sourceBytes };
    const missingSource = publication([item]);
    missingSource.next.assets.delete(sourcePath);
    await expect(publishPackageFiles(missingSource.files, missingSource.options)).rejects.toThrow("Complete App Source for 'alpha' is unavailable");
    expect(missingSource.old.commits).toBe(0);
    expect(missingSource.old.calls.filter((call) => /^(create_batch|create_chunk|commit_batch):/.test(call))).toEqual([]);
    const { old, next, options, files } = publication([item]);
    const first = await publishPackageFiles(files, options);
    expect(first.packages[0]!.source).toMatchObject({ url: `${newOrigin}${sourcePath}`, sha256: digest, status: "published" });
    expect(next.fetchedPaths).toContain(sourcePath);
    expect(old.assets.get(sourcePath)!.bytes).toEqual(sourceBytes);
    const retry = await publishPackageFiles(files, options);
    expect(retry.packages[0]!.source!.status).toBe("unchanged");
    next.assets.delete(sourcePath);
    const alreadyCommitted = await publishPackageFiles(files, options);
    expect(alreadyCommitted.batch_id).toBeNull();
    expect(alreadyCommitted.packages[0]!.source!.status).toBe("unchanged");
    expect(old.commits).toBe(1);
  });

  test("a lost old-source commit reply can be reconciled after the new source changes or becomes unavailable", async () => {
    const { old, next, options, files, calls } = publication();
    const port = options.port;
    const commit = port.commitBatch.bind(port);
    port.commitBatch = async (...args) => { await commit(...args); throw new Error("commit response lost"); };
    await expect(publishPackageFiles(files, options)).rejects.toThrow("commit response lost");
    expect(old.commits).toBe(1);
    const previousTargetReads = calls.filter(({ origin }) => origin === newOrigin).length;
    next.assets.clear();
    const receipt = await publishPackageFiles(files, options);
    expect(receipt.batch_id).toBeNull();
    expect(receipt.packages.every(({ status }) => status === "unchanged")).toBe(true);
    expect(old.commits).toBe(1);
    expect(calls.filter(({ origin }) => origin === newOrigin)).toHaveLength(previousTargetReads);
  });

  test("a missing, private, unapproved, corrupt or uncertified target aborts before any mutation", async () => {
    for (const kind of ["missing", "private", "unapproved", "corrupt", "uncertified"] as const) {
      const item = candidate(); const { old, next, options, files } = publication([item]);
      if (kind === "missing") next.assets.delete(item.packagePath);
      if (kind === "unapproved") next.assets.delete(item.releasePath);
      if (kind === "corrupt") next.assets.get(item.packagePath)!.bytes[0]! ^= 1;
      if (kind === "private" || kind === "uncertified") {
        const fetch = options.fetch!;
        options.fetch = (async (input, init) => {
          const response = await fetch(input, init);
          if (new URL(input instanceof Request ? input.url : input.toString()).origin !== newOrigin) return response;
          if (kind === "private") return new Response(null, { status: 403, headers: response.headers });
          response.headers.delete("ic-certificate"); return response;
        }) as typeof globalThis.fetch;
      }
      await expect(publishPackageFiles(files, options)).rejects.toThrow();
      expect(old.calls.filter((call) => /^(create_batch|create_chunk|commit_batch):/.test(call))).toEqual([]);
      expect(old.commits).toBe(0);
    }
  });

  test("transition cannot bypass embedded source, canonical origin, or old-source release invariants", async () => {
    const wrong = publication([candidate("alpha", 101, oldSource)]);
    await expect(publishPackageFiles(wrong.files, wrong.options)).rejects.toThrow("must name the exact new update source");
    const redirected = publication(); redirected.options.origin = "https://example.com";
    await expect(publishPackageFiles(redirected.files, redirected.options)).rejects.toThrow("canonical certified origin");
    const scope = publication(); scope.options.transition = transitionFor([candidate("bravo")]);
    await expect(publishPackageFiles(scope.files, scope.options)).rejects.toThrow("absent from the selected catalog");
    for (const version of [101, 102]) {
      const { old, options, files } = publication();
      seed(old, candidate("alpha", version, oldSource));
      await expect(publishPackageFiles(files, options)).rejects.toThrow(version === 101 ? "different digest" : "Refusing to downgrade");
      expect(old.commits).toBe(0);
    }
    const changedRemote = publication();
    const item = candidate(); const record = { ...item.record, version: 102 };
    const bytes = serializeRepositoryReleaseRecord(record);
    changedRemote.next.seed(item.releasePath, storedAsset({ bytes, contentType: RELEASE_CONTENT_TYPE, headers: releaseHeaders(sha256Hex(bytes)), maxAge: RELEASE_MAX_AGE_SECONDS }));
    await expect(publishPackageFiles(changedRemote.files, changedRemote.options)).rejects.toThrow("exact approved transition release");
    expect(changedRemote.old.commits).toBe(0);
  });
});
