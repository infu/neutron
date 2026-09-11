// All rights reserved. See ../../LICENSE.
import assert from "node:assert/strict";
import { download, sha256 } from "../../scripts/audit-download.ts";
import { installFixture, session, type IntegrationCase } from "./helpers.ts";

export const cases: IntegrationCase[] = [{
  name: "auditor CLI verifies streamed protocol artifacts and retained review access",
  scope: "http",
  async run() {
    const { pic, shutdown } = await session();
    try {
      const fixture = await installFixture(pic, "certification_fixture", "test/certification_fixture.mo");
      const paths: string[] = await fixture.actor.initialize();
      const subnet = await pic.getCanisterSubnetId(fixture.canisterId);
      assert.ok(subnet);
      const rootKey = new Uint8Array(await pic.getPubKey(subnet));
      const credential = "0".repeat(63) + "3";
      const time = await pic.getTime();
      const current = (path: string, token = credential) => download({ actor: fixture.actor, canister: fixture.canisterId.toText(), rootKey, path, token, expectedDigest: /\/([0-9a-f]{64})\./.exec(path)![1]!, nowNs: BigInt(time) * 1_000_000n });
      const packageBytes = await current(paths[0]!);
      assert.ok(packageBytes.length > 1_000_000);
      assert.equal(sha256(packageBytes), /\/([0-9a-f]{64})\./.exec(paths[0]!)![1]);
      const sourceBytes = await current(paths[1]!);
      assert.equal(new TextDecoder().decode(sourceBytes), "private-offered-source");
      await fixture.actor.revokeCandidate();
      await current(paths[0]!); // Assigned auditors retain review access.
      await assert.rejects(() => current(paths[0]!, "0".repeat(63) + "1"));
      await fixture.actor.removeAuditor();
      await assert.rejects(() => current(paths[0]!));
    } finally { await shutdown(); }
  },
}];
