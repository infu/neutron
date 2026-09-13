// All rights reserved. See ../../LICENSE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyRequestResponsePair } from "@dfinity/response-verification";
import { createCertifiedAssetReader } from "../../../../packages/neutron-tools/src/certified_asset.ts";
import { parseRepositoryManifest, parseRepositoryReleaseRecord } from "../../../../packages/neutron-tools/src/repository.ts";
import { parseRepositoryChannelHeads, parseRepositoryChannelSelection, parseRepositoryChannelsDescriptor } from "../../../../packages/neutron-tools/src/release_channels.ts";
import { installFixture, session, type IntegrationCase } from "./helpers.ts";

export const cases: IntegrationCase[] = [{
  name: "Repository channel certification preserves stable bytes and beta proofs through keep upgrade",
  scope: "http",
  async run() {
    const { pic, shutdown } = await session();
    try {
      await pic.setTime(new Date(Date.now() - 600_000));
      const { actor, canisterId, wasmPath } = await installFixture(pic, "repository_channels_certification", "test/fixtures/RepositoryChannels.mo");
      await pic.advanceTime(600_000);
      await pic.tick();
      const rootKey = new Uint8Array(await pic.getPubKey(await pic.getCanisterSubnetId(canisterId)));
      const reader = createCertifiedAssetReader({ canisterId: canisterId.toText(), rootKey, readChunk: (input) => actor.read(input) });
      const read = async (path: string) => {
        const value = await reader.readRaw(path);
        assert.ok(value, `Missing certified ${path}`);
        return value;
      };
      const json = async (path: string) => JSON.parse(new TextDecoder().decode(await read(path)));
      assert.deepEqual(parseRepositoryChannelsDescriptor(await json("/repo/v1/channels.json")), {
        protocol: "neutron-repo-channels-v1", source: canisterId.toText(),
      });
      const stablePath = "/repo/v1/releases/channel_http.json";
      const betaPath = "/repo/v1/channels/beta/releases/channel_http.json";
      const headsPath = "/repo/v1/channels/apps/channel_http.json";
      const stableBytes = await read(stablePath);
      const betaBytes = await read(betaPath);
      const stable = parseRepositoryReleaseRecord(JSON.parse(new TextDecoder().decode(stableBytes)));
      const beta = parseRepositoryReleaseRecord(JSON.parse(new TextDecoder().decode(betaBytes)));
      assert.equal(stable.version, 100);
      assert.equal(beta.version, 101);
      const heads = parseRepositoryChannelHeads(await json(headsPath));
      assert.deepEqual(heads.stable.release, stable);
      assert.deepEqual(heads.beta.release, beta);
      assert.equal(heads.source, canisterId.toText());
      assert.equal(await reader.readRaw("/repo/v1/channels/beta/releases/missing_app.json"), undefined);
      const absent = await actor.read({ key: "/repo/v1/channels/beta/releases/missing_app.json", index: 0n });
      const tampered = createCertifiedAssetReader({ canisterId: canisterId.toText(), rootKey,
        readChunk: async () => ({ ...absent, witness: new Uint8Array([0]) }) });
      await assert.rejects(() => tampered.readRaw("/repo/v1/channels/beta/releases/missing_app.json"));

      const prepared = await actor.prepareBeta();
      const manifestPath = `/repo/v1/manifests/${prepared.manifestId}.json`;
      const sidecarPath = `/repo/v1/channels/manifests/${prepared.manifestId}.json`;
      const manifestBytes = await read(manifestPath);
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
      assert.equal(manifest.protocol, "neutron-repo-channel-manifest-v1");
      assert.equal(manifest.channel, "beta");
      // An old Kernel's v1 codec must fail before it can install beta bytes.
      assert.throws(() => parseRepositoryManifest(manifest));
      const sidecarBytes = await read(sidecarPath);
      const sidecar = parseRepositoryChannelSelection(JSON.parse(new TextDecoder().decode(sidecarBytes)));
      assert.equal(sidecar.manifest_id, prepared.manifestId);
      assert.equal(sidecar.manifest_sha256, createHash("sha256").update(manifestBytes).digest("hex"));
      assert.equal(sidecar.mode, "beta");
      assert.equal(sidecar.packages[0].sha256, beta.sha256);
      assert.equal(sidecar.packages[0].candidate_id, heads.beta.candidate_id);
      const request = { method: "GET", url: betaPath, headers: [], body: new Uint8Array(), certificate_version: [2] };
      const response = await actor.http_request(request);
      assert.equal(response.status_code, 200);
      const verified = verifyRequestResponsePair(request, { status_code: response.status_code, headers: response.headers, body: Uint8Array.from(response.body) },
        canisterId.toUint8Array(), BigInt(Math.floor(await pic.getTime())) * 1_000_000n, 300_000_000_000n, rootKey, 2);
      assert.equal(verified.verificationVersion, 2);

      await pic.upgradeCanister({ canisterId, wasm: wasmPath, arg: new Uint8Array(),
        upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
      assert.deepEqual(await actor.prepareBeta(), prepared);
      assert.deepEqual(await read(stablePath), stableBytes);
      assert.deepEqual(await read(betaPath), betaBytes);
      assert.deepEqual(await read(manifestPath), manifestBytes);
      assert.deepEqual(await read(sidecarPath), sidecarBytes);
      await actor.revokeBeta();
      const revoked = parseRepositoryChannelHeads(await json(headsPath));
      assert.equal(revoked.beta.candidate_id, heads.beta.candidate_id);
      assert.equal(revoked.beta.revision, heads.beta.revision);
      assert.equal(revoked.beta.release, null);
      assert.equal(await reader.readRaw(betaPath), undefined);
      assert.deepEqual(await read(stablePath), stableBytes);
      assert.deepEqual(await read(sidecarPath), sidecarBytes);
    } finally { await shutdown(); }
  },
}];
