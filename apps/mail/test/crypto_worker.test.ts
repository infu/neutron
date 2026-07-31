import { describe, expect, test } from "bun:test";
import {
  DerivedPublicKey,
  VetKey,
  augmentedHashToG1,
} from "@dfinity/vetkeys";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { MailTransportSession } from "../src/crypto_vault.ts";
import {
  MailCryptoWorkerRuntime,
  type MailCryptoWorkerResult,
  type MailWorkerCachePublicInfo,
  type MailWorkerCacheScope,
  type MailWorkerLiveGeneration,
} from "../src/crypto_worker.ts";
import { computeMailKeyFingerprint } from "../src/protocol.ts";

describe("Mail crypto worker cache ordering", () => {
  test("retains an older save when rotation keeps it as previous", async () => {
    const generation7 = keyFixture("7", 0x7103n);
    const generation8 = keyFixture("8", 0x8107n);
    const cache = new DelayedCache();
    const runtime = runtimeWith(cache, generation7.handle);
    await configure(runtime, 1, generation7.publicInfo, null);
    await begin(runtime, 2, "7");

    const completing = runtime.handle({
      id: 3,
      type: "complete_unlock",
      epoch: "7",
      encryptedVetKey: bytes(192, 0x31),
    });
    await cache.saveStarted.promise;
    const resetting = runtime.handle({ id: 4, type: "reset" });
    const rotating = configure(
      runtime,
      5,
      generation8.publicInfo,
      generation7.publicInfo,
    );
    await nextMicrotask();
    expect(cache.clearCalls).toBe(0);
    expect(cache.prunedEpochs.at(-1)).toEqual(["7"]);

    cache.releaseSave.resolve(undefined);
    await Promise.all([completing, resetting, rotating]);

    expect(cache.clearCalls).toBe(0);
    expect([...cache.records.keys()]).toEqual(["7"]);
    expect(cache.prunedEpochs.at(-1)).toEqual(["7", "8"]);
  });

  test("prunes an older save when rotation no longer retains it", async () => {
    const generation7 = keyFixture("7", 0x7103n);
    const generation8 = keyFixture("8", 0x8107n);
    const cache = new DelayedCache();
    const runtime = runtimeWith(cache, generation7.handle);
    await configure(runtime, 1, generation7.publicInfo, null);
    await begin(runtime, 2, "7");

    const completing = runtime.handle({
      id: 3,
      type: "complete_unlock",
      epoch: "7",
      encryptedVetKey: bytes(192, 0x41),
    });
    await cache.saveStarted.promise;
    const resetting = runtime.handle({ id: 4, type: "reset" });
    const rotating = configure(runtime, 5, generation8.publicInfo, null);

    cache.releaseSave.resolve(undefined);
    await Promise.all([completing, resetting, rotating]);

    expect(cache.clearCalls).toBe(0);
    expect(cache.records.size).toBe(0);
    expect(cache.prunedEpochs.at(-1)).toEqual(["8"]);
  });

  test("clear_cache waits behind and erases an older in-flight save", async () => {
    const generation7 = keyFixture("7", 0x7103n);
    const cache = new DelayedCache();
    const runtime = runtimeWith(cache, generation7.handle);
    await configure(runtime, 1, generation7.publicInfo, null);
    await begin(runtime, 2, "7");

    const completing = runtime.handle({
      id: 3,
      type: "complete_unlock",
      epoch: "7",
      encryptedVetKey: bytes(192, 0x51),
    });
    await cache.saveStarted.promise;
    const clearing = runtime.handle({ id: 4, type: "clear_cache" });
    await nextMicrotask();
    expect(cache.clearCalls).toBe(0);

    cache.releaseSave.resolve(undefined);
    await expect(completing).resolves.toMatchObject({
      type: "status",
      status: { currentUnlocked: true },
    });
    await expect(clearing).resolves.toEqual({ type: "cache_cleared" });

    expect(cache.clearCalls).toBe(1);
    expect(cache.records.size).toBe(0);
  });

  test("clear_cache discards a staged restored handle", async () => {
    const generation7 = keyFixture("7", 0x7103n);
    const cache = new DelayedCache();
    cache.loadResult = {
      publicInfo: generation7.publicInfo,
      handle: generation7.handle,
    };
    const runtime = runtimeWith(cache, generation7.handle);

    await runtime.handle({
      id: 1,
      type: "prepare_cache",
      scope: SCOPE,
      current: {
        epoch: "7",
        keyName: "key_1",
        publicFingerprint: generation7.publicInfo.publicFingerprint,
      },
      previous: null,
    });
    await expect(runtime.handle({ id: 2, type: "clear_cache" }))
      .resolves.toEqual({ type: "cache_cleared" });
    const configured = await configure(
      runtime,
      3,
      generation7.publicInfo,
      null,
    );

    expect(configured).toMatchObject({
      type: "status",
      status: { currentUnlocked: false },
    });
  });
});

class DelayedCache {
  readonly records = new Map<string, MailWorkerCachePublicInfo>();
  readonly saveStarted = deferred<void>();
  readonly releaseSave = deferred<void>();
  readonly prunedEpochs: string[][] = [];
  loadResult: {
    publicInfo: MailWorkerCachePublicInfo;
    handle: VetKey;
  } | null = null;
  clearCalls = 0;

  async load(): Promise<{
    publicInfo: MailWorkerCachePublicInfo;
    handle: VetKey;
  } | null> {
    return this.loadResult;
  }

  async save(
    _scope: MailWorkerCacheScope,
    publicInfo: MailWorkerCachePublicInfo,
    _handle: VetKey,
  ): Promise<void> {
    this.saveStarted.resolve(undefined);
    await this.releaseSave.promise;
    this.records.set(publicInfo.epoch, publicInfo);
  }

  async prune(
    _scope: MailWorkerCacheScope,
    live: readonly MailWorkerLiveGeneration[],
  ): Promise<void> {
    const keep = new Set(live.map((generation) => generation.epoch));
    this.prunedEpochs.push([...keep].sort());
    for (const epoch of this.records.keys()) {
      if (!keep.has(epoch)) this.records.delete(epoch);
    }
  }

  async clear(): Promise<void> {
    this.clearCalls += 1;
    this.records.clear();
  }
}

class FakeTransportSession implements MailTransportSession<VetKey> {
  consumed = false;
  readonly #handle: VetKey;

  constructor(handle: VetKey) {
    this.#handle = handle;
  }

  publicKeyBytes(): Uint8Array {
    return bytes(48, 0x91);
  }

  consume(): VetKey {
    if (this.consumed) throw new Error("already consumed");
    this.consumed = true;
    return this.#handle;
  }
}

function runtimeWith(
  cache: DelayedCache,
  handle: VetKey,
): MailCryptoWorkerRuntime {
  return new MailCryptoWorkerRuntime(
    () => undefined,
    cache,
    () => new FakeTransportSession(handle),
  );
}

async function configure(
  runtime: MailCryptoWorkerRuntime,
  id: number,
  current: MailWorkerCachePublicInfo,
  previous: MailWorkerCachePublicInfo | null,
): Promise<MailCryptoWorkerResult> {
  return runtime.handle({
    id,
    type: "configure",
    scope: SCOPE,
    current,
    previous,
  });
}

async function begin(
  runtime: MailCryptoWorkerRuntime,
  id: number,
  epoch: string,
): Promise<void> {
  const result = await runtime.handle({ id, type: "begin_unlock", epoch });
  expect(result).toMatchObject({ type: "unlock_request", epoch });
}

function keyFixture(
  epoch: string,
  secretScalar: bigint,
): {
  publicInfo: MailWorkerCachePublicInfo;
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
  return {
    handle,
    publicInfo: {
      canisterPrincipal: SCOPE.canisterPrincipal,
      slot: "mailbox",
      suite: 1,
      keyName: "key_1",
      epoch,
      publicFingerprint: sha256(contextPublicKey),
      fingerprint: computeMailKeyFingerprint({
        suite: 1,
        epoch: BigInt(epoch),
        contextPublicKey,
        effectiveIbeIdentity,
      }),
      contextPublicKey,
      effectiveIbeIdentity,
    },
  };
}

const SCOPE: MailWorkerCacheScope = {
  app: "mail",
  canisterPrincipal: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  installationUid: "17",
  browserOriginNonce: "0123456789abcdef0123456789abcdef",
  browserOriginAuthorityEpoch: "3",
};

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve(value: Value): void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function nextMicrotask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from(
    { length },
    (_, index) => (seed + index * 29) & 0xff,
  );
}
