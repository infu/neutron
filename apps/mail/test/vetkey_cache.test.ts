import { describe, expect, test } from "bun:test";
import {
  DerivedPublicKey,
  VetKey,
  augmentedHashToG1,
} from "@dfinity/vetkeys";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type {
  BrowserSecretCache,
  BrowserSecretCacheKey,
  BrowserSecretCachePut,
} from "neutron-tools/browser_secret_cache";
import type {
  MailWorkerCachePublicInfo,
  MailWorkerCacheScope,
  MailWorkerLiveGeneration,
} from "../src/crypto_worker.ts";
import { computeMailKeyFingerprint } from "../src/protocol.ts";
import {
  MAIL_VETKEY_CACHE_TTL_MS,
  MailVetKeyCache,
} from "../src/vetkey_cache.ts";

const NOW = 10_000;

describe("Mail worker VetKey cache", () => {
  test("round-trips an authenticated key and public binding for exactly seven days", async () => {
    const backing = new MemorySecretCache();
    const cache = new MailVetKeyCache(backing, () => NOW);
    const fixture = keyFixture("7", 0x7103n);
    const serializedBefore = fixture.handle.serialize().slice();

    await cache.save(SCOPE, fixture.publicInfo, fixture.handle);

    expect(backing.puts).toBe(1);
    expect(backing.lastExpiry).toBe(NOW + MAIL_VETKEY_CACHE_TTL_MS);
    // Saving erased only a defensive serialization copy, never the library's
    // live VetKey backing bytes.
    expect(fixture.handle.serialize()).toEqual(serializedBefore);

    const restored = await cache.load(SCOPE, fixture.live);
    expect(restored?.publicInfo).toEqual(fixture.publicInfo);
    expect(restored?.handle.serialize()).toEqual(serializedBefore);
  });

  test("fails closed for a changed lifecycle fingerprint and prunes stale records", async () => {
    const backing = new MemorySecretCache();
    const cache = new MailVetKeyCache(backing, () => NOW);
    const fixture = keyFixture("7", 0x7103n);
    await cache.save(SCOPE, fixture.publicInfo, fixture.handle);

    const changed: MailWorkerLiveGeneration = {
      ...fixture.live,
      publicFingerprint: bytes(32, 0x99),
    };
    expect(await cache.load(SCOPE, changed)).toBeNull();

    await cache.prune(SCOPE, [changed]);
    expect(backing.records.size).toBe(0);
  });

  test("defers destructive pruning while a live fingerprint is unknown", async () => {
    const backing = new MemorySecretCache();
    const cache = new MailVetKeyCache(backing, () => NOW);
    const fixture = keyFixture("7", 0x7103n);
    await cache.save(SCOPE, fixture.publicInfo, fixture.handle);

    await cache.prune(SCOPE, [{
      ...fixture.live,
      publicFingerprint: null,
    }]);

    expect(backing.records.size).toBe(1);
    expect(await cache.load(SCOPE, fixture.live)).not.toBeNull();
  });

  test("rejects tampered plaintext before constructing a reusable handle", async () => {
    const backing = new MemorySecretCache();
    const cache = new MailVetKeyCache(backing, () => NOW);
    const fixture = keyFixture("7", 0x7103n);
    await cache.save(SCOPE, fixture.publicInfo, fixture.handle);
    const record = [...backing.records.values()][0]!;
    const last = record.secret.byteLength - 1;
    record.secret[last] = record.secret[last]! ^ 0xff;

    expect(await cache.load(SCOPE, fixture.live)).toBeNull();
  });
});

class MemorySecretCache implements BrowserSecretCache {
  readonly records = new Map<string, {
    binding: Uint8Array;
    secret: Uint8Array;
  }>();
  puts = 0;
  lastExpiry: number | null = null;

  async get(key: BrowserSecretCacheKey): Promise<Uint8Array | null> {
    const record = this.records.get(key.id);
    return record && same(record.binding, key.binding)
      ? record.secret.slice()
      : null;
  }

  async put(value: BrowserSecretCachePut): Promise<boolean> {
    this.puts += 1;
    this.lastExpiry = value.expiresAtMs;
    this.records.set(value.id, {
      binding: value.binding.slice(),
      secret: value.secret.slice(),
    });
    return true;
  }

  async prune(keep?: readonly BrowserSecretCacheKey[]): Promise<void> {
    if (keep === undefined) return;
    const retained = new Map(keep.map((key) => [key.id, key.binding]));
    for (const [id, record] of this.records) {
      const binding = retained.get(id);
      if (!binding || !same(binding, record.binding)) this.records.delete(id);
    }
  }

  close(): void {}
}

const SCOPE: MailWorkerCacheScope = {
  app: "mail",
  canisterPrincipal: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  installationUid: "17",
  browserOriginNonce: "0123456789abcdef0123456789abcdef",
  browserOriginAuthorityEpoch: "3",
};

function keyFixture(epoch: string, secretScalar: bigint): {
  publicInfo: MailWorkerCachePublicInfo;
  live: MailWorkerLiveGeneration;
  handle: VetKey;
} {
  const publicPoint = bls12_381.G2.Point.BASE.multiply(secretScalar);
  const derivedPublicKey = new DerivedPublicKey(publicPoint);
  const contextPublicKey = derivedPublicKey.publicKeyBytes();
  const effectiveIbeIdentity = bytes(32, Number(epoch));
  const handle = new VetKey(
    augmentedHashToG1(derivedPublicKey, effectiveIbeIdentity)
      .multiply(secretScalar),
  );
  const publicFingerprint = sha256(contextPublicKey);
  const publicInfo: MailWorkerCachePublicInfo = {
    canisterPrincipal: SCOPE.canisterPrincipal,
    slot: "mailbox",
    suite: 1,
    keyName: "test_key_1",
    epoch,
    publicFingerprint,
    contextPublicKey,
    effectiveIbeIdentity,
    fingerprint: computeMailKeyFingerprint({
      suite: 1,
      epoch: BigInt(epoch),
      contextPublicKey,
      effectiveIbeIdentity,
    }),
  };
  return {
    publicInfo,
    live: {
      epoch,
      keyName: publicInfo.keyName,
      publicFingerprint: publicFingerprint.slice(),
    },
    handle,
  };
}

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from(
    { length },
    (_, index) => (seed + index * 29) & 0xff,
  );
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
}
