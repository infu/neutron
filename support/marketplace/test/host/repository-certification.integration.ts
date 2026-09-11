// All rights reserved. See ../../LICENSE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyRequestResponsePair } from "@dfinity/response-verification";
import { createCertifiedAssetReader } from "../../../../packages/neutron-tools/src/certified_asset.ts";
import { parseRepositoryInfo, parseRepositoryManifest, parseRepositoryManifestIndex, parseRepositoryReleaseRecord, parseRepositorySetupUrl } from "../../../../packages/neutron-tools/src/repository.ts";
import { parseRepositoryAccessDescriptor } from "../../../../packages/neutron-tools/src/repository_access.ts";
import { installFixture, session, type IntegrationCase } from "./helpers.ts";

export const cases: IntegrationCase[] = [{
  name: "Repository metadata codecs, certified package absence, private HTTP and upgrade restoration",
  scope: "http",
  async run() {
    const { pic, shutdown } = await session();
    try {
      // Let PocketIC refill install-code instruction credit between the first
      // installation and the immediate upgrade without future certificates.
      await pic.setTime(new Date(Date.now() - 600_000));
      const fixture = await installFixture(pic, "repository_certification", "test/fixtures/Repository.mo");
      const { actor, canisterId, wasmPath } = fixture;
      await pic.advanceTime(600_000);
      await pic.tick();
      const subnet = await pic.getCanisterSubnetId(canisterId);
      const rootKey = new Uint8Array(await pic.getPubKey(subnet));
      const reader = createCertifiedAssetReader({ canisterId: canisterId.toText(), rootKey, readChunk: (input) => actor.read(input) });
      const json = async (path: string) => {
        const value = await reader.readRaw(path);
        assert.ok(value);
        return JSON.parse(new TextDecoder().decode(value));
      };
      assert.equal(parseRepositoryInfo(await json("/repo/v1/info.json")).protocol, "neutron-repo-v1");
      assert.deepEqual(parseRepositoryManifestIndex(await json("/repo/v1/manifests.json")).manifests, []);
      assert.deepEqual(parseRepositoryAccessDescriptor(await json("/repo/v1/access.json")), {
        protocol: "neutron-repo-access-v1", fee_version: "1", cycles: "0",
      });
      const prepared = await actor.prepare();
      const reference = parseRepositorySetupUrl(prepared.setupUrl);
      assert.equal(reference.repo, canisterId.toText());
      assert.equal(reference.manifest, prepared.manifestId);
      assert.equal(reference.digest, prepared.digest);
      const path = `/repo/v1/manifests/${prepared.manifestId}.json`;
      const bytes = await reader.readRaw(path);
      assert.ok(bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), prepared.digest);
      const manifest = parseRepositoryManifest(JSON.parse(new TextDecoder().decode(bytes)));
      assert.deepEqual(manifest.packages.map(({ id, version }) => [id, version]), [["repo_test", 100]]);
      const release = parseRepositoryReleaseRecord(await json("/repo/v1/releases/repo_test.json"));
      assert.equal(release.sha256, manifest.packages[0].sha256);
      const packagePath = `/repo/v1/packages/${release.sha256}.neutron`;
      // Exactly the certified Candid absence on which the Kernel authorizes
      // fallback to authenticated HTTP. Null content alone is insufficient.
      const packageReader = createCertifiedAssetReader({
        canisterId: canisterId.toText(), rootKey,
        readChunk: ({ index }) => actor.repo_package({ sha256: release.sha256, index }),
      });
      assert.equal(await packageReader.readRaw(packagePath), undefined);
      const absent = await actor.repo_package({ sha256: release.sha256, index: 0n });
      const tampered = createCertifiedAssetReader({ canisterId: canisterId.toText(), rootKey,
        readChunk: async () => ({ ...absent, witness: new Uint8Array([0]) }) });
      await assert.rejects(() => tampered.readRaw(packagePath));

      const request = (headers: [string, string][] = []) => ({ method: "GET", url: packagePath, headers, body: new Uint8Array(), certificate_version: [2] });
      const verify = async (req: ReturnType<typeof request>, response: any) => {
        const result = verifyRequestResponsePair(req, { status_code: response.status_code, headers: response.headers, body: Uint8Array.from(response.body) },
          canisterId.toUint8Array(), BigInt(Math.floor(await pic.getTime())) * 1_000_000n, 300_000_000_000n, rootKey, 2);
        assert.equal(result.verificationVersion, 2);
      };
      const denied = await actor.http_request(request());
      assert.equal(denied.status_code, 403);
      await verify(request(), denied);
      await actor.grant();
      const authenticated = request([["Authorization", `Bearer ${"0".repeat(63)}1`]]);
      const delivered = await actor.http_request(authenticated);
      assert.equal(delivered.status_code, 200);
      await verify(authenticated, delivered);
      assert.equal(createHash("sha256").update(Uint8Array.from(delivered.body)).digest("hex"), release.sha256);
      assert.equal(await packageReader.readRaw(packagePath), undefined);

      await pic.upgradeCanister({ canisterId, wasm: wasmPath, arg: new Uint8Array(),
        upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
      assert.deepEqual(await actor.prepare(), prepared);
      assert.deepEqual(await reader.readRaw(path), bytes);
      assert.equal(await packageReader.readRaw(packagePath), undefined);
      const restored = await actor.http_request(authenticated);
      assert.equal(restored.status_code, 200);
      await verify(authenticated, restored);
    } finally { await shutdown() }
  },
}, {
  name: "Repository two paid releases certify package absence before HTTP fallback and after upgrade",
  scope: "http",
  async run() {
    const { pic, shutdown } = await session();
    try {
      await pic.setTime(new Date(Date.now() - 600_000));
      const { actor, canisterId, wasmPath } = await installFixture(pic, "repository_certification", "test/fixtures/Repository.mo");
      await pic.advanceTime(600_000);
      await pic.tick();
      const rootKey = new Uint8Array(await pic.getPubKey(await pic.getCanisterSubnetId(canisterId)));
      const reader = createCertifiedAssetReader({ canisterId: canisterId.toText(), rootKey, readChunk: (input) => actor.read(input) });
      const json = async (path: string) => {
        const value = await reader.readRaw(path);
        assert.ok(value);
        return JSON.parse(new TextDecoder().decode(value));
      };
      const prepared = await actor.setupTwo();
      assert.equal(parseRepositoryInfo(await json("/repo/v1/info.json")).protocol, "neutron-repo-v1");
      assert.deepEqual(parseRepositoryManifestIndex(await json("/repo/v1/manifests.json")).manifests, []);
      assert.equal(parseRepositoryAccessDescriptor(await json("/repo/v1/access.json")).protocol, "neutron-repo-access-v1");
      const manifestPath = `/repo/v1/manifests/${prepared.manifestId}.json`;
      const manifest = parseRepositoryManifest(await json(manifestPath));
      assert.deepEqual(manifest.packages.map(({ id, version }) => [id, version]), [["paid_alpha", 100], ["paid_beta", 100]]);
      const verifyAbsent = async () => {
        for (const selected of manifest.packages) {
          const release = parseRepositoryReleaseRecord(await json(`/repo/v1/releases/${selected.id}.json`));
          assert.equal(release.sha256, selected.sha256);
          const packagePath = `/repo/v1/packages/${release.sha256}.neutron`;
          const packageReader = createCertifiedAssetReader({
            canisterId: canisterId.toText(), rootKey,
            readChunk: ({ index }) => actor.repo_package({ sha256: release.sha256, index }),
          });
          assert.equal(await packageReader.readRaw(packagePath), undefined,
            `${selected.id}: generic installer must verify certified absence before using private HTTP`);
        }
      };
      await verifyAbsent();
      await pic.upgradeCanister({ canisterId, wasm: wasmPath, arg: new Uint8Array(),
        upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
      assert.deepEqual(await actor.prepareTwo(), prepared);
      assert.deepEqual(parseRepositoryManifest(await json(manifestPath)), manifest);
      await verifyAbsent();
    } finally { await shutdown() }
  },
}];
