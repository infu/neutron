import { expect, test } from "bun:test";
import { spawn } from "bun";

// Each scenario gets a real identity/keystore module in its own process. This
// avoids replacing shared SDK modules or IndexedDB globals used by engine and
// durable-storage tests in the same Bun run.
async function checkIdentity(body: string): Promise<void> {
  const identityUrl = new URL("../src/oc/identity.ts", import.meta.url).href;
  const keystoreUrl = new URL("../src/oc/keystore.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { DelegationChain, ECDSAKeyIdentity } from "@dfinity/identity";
    import {
      buildDelegationIdentity, derPublicKey, loadOrCreateSessionKey,
      restoreOcIdentity, saveOcSession,
    } from ${JSON.stringify(identityUrl)};
    import { KEYS, keystore } from ${JSON.stringify(keystoreUrl)};
    const kv = await keystore();
    const key = await loadOrCreateSessionKey();
    const issuer = await ECDSAKeyIdentity.generate();
    const validUntil = Date.now() + 60_000;
    const chain = await DelegationChain.create(issuer, key.getPublicKey(), new Date(validUntil));
    const profile = { ocPrincipal: issuer.getPrincipal().toText(), username: "retained", userId: "aaaaa-aa" };
    const stored = { chain: chain.toJSON(), expirationMs: validUntil, profile };
    ${body}
  `;
  const child = spawn([process.execPath, "-e", script], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, diagnostics: exitCode === 0 ? "" : stdout + stderr }).toEqual({
    exitCode: 0,
    diagnostics: "",
  });
}

test("concurrent cold-start callers use the same saved non-extractable signer", async () => {
  await checkIdentity(`
    await kv.del(KEYS.sessionKeyPair);
    const keys = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateSessionKey()));
    for (const candidate of keys) {
      assert.deepEqual(derPublicKey(candidate), derPublicKey(keys[0]));
      assert.equal(candidate.getKeyPair().privateKey.extractable, false);
    }
    const restored = await loadOrCreateSessionKey();
    assert.deepEqual(derPublicKey(restored), derPublicKey(keys[0]));
    const message = new TextEncoder().encode("restored signer proof");
    assert.equal(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, keys[0].getKeyPair().publicKey,
      await restored.sign(message), message,
    ), true);
  `);
});

test("failed key persistence is retryable and never returns an unsaved signer", async () => {
  await checkIdentity(`
    await kv.del(KEYS.sessionKeyPair);
    const set = kv.set;
    let fail = true;
    kv.set = async (name, value) => {
      if (name === KEYS.sessionKeyPair && fail) {
        fail = false;
        throw new Error("storage transaction aborted");
      }
      return set(name, value);
    };
    await assert.rejects(loadOrCreateSessionKey(), /storage transaction aborted/);
    assert.equal(await kv.get(KEYS.sessionKeyPair), undefined);
    const saved = await loadOrCreateSessionKey();
    const restored = await loadOrCreateSessionKey();
    assert.deepEqual(derPublicKey(saved), derPublicKey(restored));
  `);
});

test("session restore preserves the delegated principal and stored profile", async () => {
  await checkIdentity(`
    await saveOcSession(stored);
    const restored = await restoreOcIdentity(key);
    assert.ok(restored);
    assert.equal(restored.identity.getPrincipal().toText(), issuer.getPrincipal().toText());
    assert.deepEqual(restored.session.profile, profile);
    assert.equal(restored.session.expirationMs, validUntil);
    assert.deepEqual(restored.identity.getDelegation().toJSON(), chain.toJSON());
  `);
});

test("restore uses signed expiry even when cached expiry is stale or invalid", async () => {
  await checkIdentity(`
    for (const expirationMs of [Date.now() - 1, Date.now() + 9_000_000, NaN]) {
      await saveOcSession({ ...stored, expirationMs });
      const restored = await restoreOcIdentity(key);
      assert.ok(restored);
      assert.equal(restored.session.expirationMs, validUntil);
    }
  `);
});

test("an expired signed delegation cannot be restored using a future cached expiry", async () => {
  await checkIdentity(`
    const expired = await DelegationChain.create(issuer, key.getPublicKey(), new Date(Date.now() - 100));
    await saveOcSession({ ...stored, chain: expired.toJSON() });
    assert.equal(await restoreOcIdentity(key), null);
    assert.equal(await kv.get(KEYS.ocSession), undefined);
    assert.ok(await kv.get(KEYS.sessionKeyPair));
  `);
});

test("multi-hop sessions expire at the earliest signed hop", async () => {
  await checkIdentity(`
    const middle = await ECDSAKeyIdentity.generate();
    const earlier = Date.now() + 30_000;
    const first = await DelegationChain.create(issuer, middle.getPublicKey(), new Date(earlier));
    const multi = await DelegationChain.create(middle, key.getPublicKey(), new Date(validUntil), { previous: first });
    await saveOcSession({ ...stored, chain: multi.toJSON() });
    assert.equal((await restoreOcIdentity(key)).session.expirationMs, earlier);

    const expiredFirst = await DelegationChain.create(issuer, middle.getPublicKey(), new Date(Date.now() - 100));
    const invalid = await DelegationChain.create(middle, key.getPublicKey(), new Date(validUntil), { previous: expiredFirst });
    await saveOcSession({ ...stored, chain: invalid.toJSON() });
    assert.equal(await restoreOcIdentity(key), null);
  `);
});

test("a session delegated to a different stored signer is cleared instead of falsely restored", async () => {
  await checkIdentity(`
    await saveOcSession(stored);
    const replacement = await ECDSAKeyIdentity.generate();
    assert.equal(await restoreOcIdentity(replacement), null);
    assert.equal(await kv.get(KEYS.ocSession), undefined);
    assert.ok(await kv.get(KEYS.sessionKeyPair));
  `);
});

test("empty and malformed delegation records require authentication without deleting the signer", async () => {
  await checkIdentity(`
    for (const badChain of [{ ...chain.toJSON(), delegations: [] }, { delegations: "invalid" }, null]) {
      await saveOcSession({ ...stored, chain: badChain });
      assert.equal(await restoreOcIdentity(key), null);
      assert.equal(await kv.get(KEYS.ocSession), undefined);
      assert.ok(await kv.get(KEYS.sessionKeyPair));
    }
  `);
});

test("fresh canister delegations must target the actual session signer", async () => {
  await checkIdentity(`
    const hop = chain.delegations[0];
    const identity = buildDelegationIdentity(
      key, chain.publicKey, hop.delegation.pubkey,
      hop.delegation.expiration, hop.signature,
    );
    assert.equal(identity.getPrincipal().toText(), issuer.getPrincipal().toText());
    assert.throws(() => buildDelegationIdentity(
      issuer, chain.publicKey, hop.delegation.pubkey,
      hop.delegation.expiration, hop.signature,
    ), /does not match this session's signing key/);
  `);
});
