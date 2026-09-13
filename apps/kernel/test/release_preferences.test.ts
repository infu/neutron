import { expect, test } from "bun:test";
import {
  createReleasePreferencesService,
  type ReleasePreferences,
  type ReleasePreferencesActor,
  type ReleasePreferencesWire,
} from "../src/release_preferences.ts";

function fixture() {
  let current: ReleasePreferencesWire = { beta_enabled: false, revision: 0n };
  let reads = 0;
  const actor: ReleasePreferencesActor = {
    async get_release_preferences() {
      reads += 1;
      return { ...current };
    },
    async set_release_preferences(betaEnabled) {
      if (current.beta_enabled !== betaEnabled) {
        current = { beta_enabled: betaEnabled, revision: current.revision + 1n };
      }
      return { ...current };
    },
  };
  return {
    actor,
    service: createReleasePreferencesService(async () => actor),
    get reads() { return reads; },
    setCurrent(next: ReleasePreferencesWire) { current = next; },
  };
}

test("release preferences load Neutron authority every time and report effective changes", async () => {
  const f = fixture();
  expect(f.service.useStore.getState().preferences).toBeNull();
  const changes: Array<[ReleasePreferences, ReleasePreferences | null]> = [];
  const unsubscribe = f.service.subscribeReleasePreferences((next, previous) => {
    changes.push([next, previous]);
  });
  expect(await f.service.getReleasePreferences()).toEqual({ betaEnabled: false, revision: "0" });
  await f.service.getReleasePreferences();
  expect(f.reads).toBe(2);
  expect(changes).toHaveLength(1);
  expect(changes[0]?.[1]).toBeNull();
  expect(await f.service.setReleasePreferences(true)).toEqual({ betaEnabled: true, revision: "1" });
  await f.service.setReleasePreferences(true);
  expect(changes).toHaveLength(2);
  // Another device changes the durable preference, and a fresh read invalidates
  // the observed revision even when this browser did not issue the update.
  f.setCurrent({ beta_enabled: false, revision: 2n });
  expect(await f.service.getReleasePreferences()).toEqual({ betaEnabled: false, revision: "2" });
  expect(changes[2]).toEqual([
    { betaEnabled: false, revision: "2" },
    { betaEnabled: true, revision: "1" },
  ]);
  unsubscribe();
  await f.service.setReleasePreferences(true);
  expect(changes).toHaveLength(3);
});

test("a rejected update never presents beta as enabled", async () => {
  const f = fixture();
  await f.service.getReleasePreferences();
  const failed = deferred<ReleasePreferencesWire>();
  f.actor.set_release_preferences = () => failed.promise;
  const request = f.service.setReleasePreferences(true);
  expect(f.service.useStore.getState().saving).toBe(true);
  expect(f.service.useStore.getState().preferences?.betaEnabled).toBe(false);
  failed.reject(new Error("Not authorized"));
  await expect(request).rejects.toThrow("Not authorized");
  expect(f.service.useStore.getState()).toMatchObject({
    preferences: { betaEnabled: false, revision: "0" },
    saving: false,
    error: "Not authorized",
  });
});

test("an old query finishing after an update cannot undo the observed revision", async () => {
  const f = fixture();
  await f.service.getReleasePreferences();
  const oldRead = deferred<ReleasePreferencesWire>();
  f.actor.get_release_preferences = () => oldRead.promise;
  const read = f.service.getReleasePreferences();
  await Promise.resolve();
  await f.service.setReleasePreferences(true);
  oldRead.resolve({ beta_enabled: false, revision: 0n });
  expect(await read).toEqual({ betaEnabled: true, revision: "1" });
  expect(f.service.useStore.getState().preferences).toEqual({ betaEnabled: true, revision: "1" });
});

test("overlapping authoritative queries remain loading until both settle", async () => {
  const first = deferred<ReleasePreferencesWire>();
  const second = deferred<ReleasePreferencesWire>();
  let calls = 0;
  const f = fixture();
  f.actor.get_release_preferences = () => ++calls === 1 ? first.promise : second.promise;
  const a = f.service.getReleasePreferences();
  const b = f.service.getReleasePreferences();
  first.resolve({ beta_enabled: false, revision: 0n });
  await a;
  expect(f.service.useStore.getState().loading).toBe(true);
  second.resolve({ beta_enabled: true, revision: 1n });
  await b;
  expect(f.service.useStore.getState().loading).toBe(false);
});

test("release preferences preserve arbitrary Nat precision and reject conflicting revisions", async () => {
  const f = fixture();
  const revision = 2n ** 96n;
  f.setCurrent({ beta_enabled: true, revision });
  expect(await f.service.getReleasePreferences()).toEqual({ betaEnabled: true, revision: revision.toString() });
  f.setCurrent({ beta_enabled: false, revision });
  await expect(f.service.getReleasePreferences()).rejects.toThrow("conflicting release preferences");
  expect(f.service.useStore.getState().preferences?.betaEnabled).toBe(true);
});

test("malformed preferences and unavailable authority never fall back to beta permission", async () => {
  for (const wire of [
    null,
    { beta_enabled: "true", revision: 0n },
    { beta_enabled: true, revision: "0" },
    { beta_enabled: true, revision: -1n },
  ]) {
    const f = fixture();
    f.actor.get_release_preferences = async () => wire as ReleasePreferencesWire;
    await expect(f.service.getReleasePreferences()).rejects.toThrow("invalid release preferences");
    expect(f.service.useStore.getState().preferences).toBeNull();
  }
  const unavailable = createReleasePreferencesService(async () => { throw new Error("offline"); });
  await expect(unavailable.getReleasePreferences()).rejects.toThrow("offline");
  expect(unavailable.useStore.getState().preferences).toBeNull();
  await expect(unavailable.setReleasePreferences("true" as unknown as boolean)).rejects.toThrow("enabled or disabled");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
