import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Principal } from "@dfinity/principal";
import {
  LOCAL_LEDGER_FIXTURES,
  LOCAL_SYSTEM_FIXTURES,
  encodeLocalIndexInitArgs,
  encodeLocalLedgerInitArgs,
  ensureLocalPocketIcFixtures,
  fundLocalPocketIcFixtures,
  localFixtureMinterIdentity,
  localPocketIcFixtureIds,
  resolveLocalFixtureArtifacts,
  type LocalFixtureClient,
  type LocalLedgerFixture,
  type PreparedLocalFixtureArtifacts,
} from "../src/local_fixtures.ts";

describe("PocketIC local fixture catalog", () => {
  test("records every full-protocol ledger/index and required system ID", () => {
    const fixtures = localPocketIcFixtureIds();
    expect(LOCAL_LEDGER_FIXTURES).toHaveLength(8);
    expect(LOCAL_LEDGER_FIXTURES.filter(({ source }) => source === "managed"))
      .toHaveLength(4);
    expect(
      LOCAL_LEDGER_FIXTURES.filter(
        ({ source }) => source === "ckbtc" || source === "cketh",
      ),
    ).toHaveLength(2);
    expect(Object.keys(fixtures)).toHaveLength(26);
    expect(fixtures.internet_identity).toBe(
      LOCAL_SYSTEM_FIXTURES.internet_identity,
    );
    for (const fixture of LOCAL_LEDGER_FIXTURES) {
      expect(fixtures[`${fixture.key}_ledger`]).toBe(fixture.canisterId);
      expect(fixtures[`${fixture.key}_index`]).toBe(fixture.indexCanisterId);
    }
    for (const canisterId of Object.values(fixtures)) {
      expect(Principal.fromText(canisterId).toText()).toBe(canisterId);
    }
  });

  test("uses one stable non-anonymous local minting identity", () => {
    const first = localFixtureMinterIdentity().getPrincipal().toText();
    const second = localFixtureMinterIdentity().getPrincipal().toText();
    expect(first).toBe(second);
    expect(first).not.toBe(Principal.anonymous().toText());
  });

  test("encodes direct binary Candid init arguments", () => {
    const fixture = LOCAL_LEDGER_FIXTURES.find(({ key }) => key === "ckbtc")!;
    const minter = localFixtureMinterIdentity().getPrincipal();
    const ledger = encodeLocalLedgerInitArgs(fixture, minter);
    const index = encodeLocalIndexInitArgs(fixture.canisterId);
    expect(new TextDecoder().decode(ledger.slice(0, 4))).toBe("DIDL");
    expect(new TextDecoder().decode(index.slice(0, 4))).toBe("DIDL");
    expect(ledger).toEqual(encodeLocalLedgerInitArgs(fixture, minter));
    expect(index).toEqual(encodeLocalIndexInitArgs(fixture.canisterId));
    expect(() =>
      encodeLocalLedgerInitArgs(LOCAL_LEDGER_FIXTURES[0]!, minter),
    ).toThrow("Cannot initialize PocketIC ledger");
  });
});

test("cold setup installs native suites and exactly four generic pairs", async () => {
  const calls: string[] = [];
  const artifacts = preparedArtifacts();
  let createPrincipal = "";
  const client: LocalFixtureClient = {
    async verifyInternetIdentity(canisterId) {
      calls.push(`ii:${canisterId}`);
    },
    async verifyLedgerPair(fixture) {
      calls.push(`verify:${fixture.key}`);
    },
    async ensureManagedLedgerPair(fixture, actualArtifacts) {
      expect(actualArtifacts).toBe(artifacts);
      calls.push(`ensure:${fixture.key}`);
    },
    async fundLedger() {
      throw new Error("not used");
    },
  };

  const fixtures = await ensureLocalPocketIcFixtures(
    {
      profile: "full_protocol_fixtures",
      gatewayUrl: "http://localhost:8000/",
      expectedRootKeyBase64: "AQ==",
      cacheDirectory: "/repo/.neutron/cache/fixtures",
      logger: { log() {} },
    },
    {
      createClient: async ({ identity }) => {
        createPrincipal = identity.getPrincipal().toText();
        return client;
      },
      resolveArtifacts: async ({ cacheDirectory }) => {
        expect(cacheDirectory).toBe("/repo/.neutron/cache/fixtures");
        return artifacts;
      },
      ensureNative: async (options) => {
        expect(options.ledgerArtifacts).toBe(artifacts);
        expect(options.fixtures.map(({ key }) => key)).toEqual([
          "ckbtc",
          "cketh",
        ]);
        calls.push("ensure-native");
        return {};
      },
    },
  );

  expect(createPrincipal).toBe(
    localFixtureMinterIdentity().getPrincipal().toText(),
  );
  expect(calls).toEqual([
    `ii:${LOCAL_SYSTEM_FIXTURES.internet_identity}`,
    "verify:icp",
    "verify:cycles",
    "ensure-native",
    "ensure:ckusdc",
    "ensure:ckusdt",
    "ensure:ckdoge",
    "ensure:cksol",
  ]);
  expect(fixtures).toEqual(localPocketIcFixtureIds());
});

test("minimal setup verifies only Internet Identity", async () => {
  const calls: string[] = [];
  const fixtures = await ensureLocalPocketIcFixtures(
    {
      profile: "minimal",
      gatewayUrl: "http://localhost:8000/",
      expectedRootKeyBase64: "AQ==",
      cacheDirectory: "/repo/.neutron/cache/fixtures",
    },
    {
      createClient: async () => ({
        async verifyInternetIdentity(canisterId) {
          calls.push(canisterId);
        },
        async verifyLedgerPair() {
          throw new Error("minimal must not verify ledgers");
        },
        async ensureManagedLedgerPair() {
          throw new Error("minimal must not install ledgers");
        },
        async fundLedger() {
          throw new Error("minimal must not fund ledgers");
        },
      }),
      resolveArtifacts: async () => {
        throw new Error("minimal must not resolve fixture artifacts");
      },
      ensureNative: async () => {
        throw new Error("minimal must not install native fixtures");
      },
    },
  );
  expect(calls).toEqual([LOCAL_SYSTEM_FIXTURES.internet_identity]);
  expect(fixtures).toEqual({
    internet_identity: LOCAL_SYSTEM_FIXTURES.internet_identity,
  });
});

test("post-deploy funding uses native deposits plus direct generic minting", async () => {
  const calls: Array<{
    key: string;
    caller: string;
    owner: string;
    target: bigint;
  }> = [];
  const owner = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
  let nativeOwner = "";
  const createClient = async ({ identity }: { identity: { getPrincipal(): Principal } }) => {
    const caller = identity.getPrincipal().toText();
    return {
      async verifyInternetIdentity() {},
      async verifyLedgerPair() {},
      async ensureManagedLedgerPair() {},
      async fundLedger(fixture, actualOwner, target) {
        calls.push({
          key: fixture.key,
          caller,
          owner: actualOwner.toText(),
          target,
        });
        return target;
      },
    } satisfies LocalFixtureClient;
  };
  const balances = await fundLocalPocketIcFixtures(
    {
      gatewayUrl: "http://localhost:8000/",
      expectedRootKeyBase64: "AQ==",
      canisterId: owner.toText(),
      stateDirectory: "/repo/.neutron/pocketic",
      cacheDirectory: "/repo/.neutron/cache/fixtures",
      targetWholeTokens: 2n,
      logger: { log() {} },
    },
    {
      createClient: createClient as never,
      fundNative: async (options) => {
        nativeOwner = options.owner.toText();
        expect(options.stateDirectory).toBe("/repo/.neutron/pocketic");
        return {
          ckbtc: 200_000_000n,
          cketh: 2_000_000_000_000_000_000n,
        };
      },
    },
  );

  expect(Object.keys(balances)).toEqual([
    "icp",
    "ckbtc",
    "cketh",
    "ckusdc",
    "ckusdt",
    "ckdoge",
    "cksol",
    "cycles",
  ]);
  expect(nativeOwner).toBe(owner.toText());
  expect(calls).toHaveLength(6);
  expect(calls[0]).toEqual({
    key: "icp",
    caller: Principal.anonymous().toText(),
    owner: owner.toText(),
    target: 200_000_000n,
  });
  expect(calls.find(({ key }) => key === "ckusdc")).toEqual({
    key: "ckusdc",
    caller: localFixtureMinterIdentity().getPrincipal().toText(),
    owner: owner.toText(),
    target: 2_000_000n,
  });
  expect(calls.at(-1)).toEqual({
    key: "cycles",
    caller: Principal.anonymous().toText(),
    owner: owner.toText(),
    target: 2_000_000_000_000n,
  });
});

test("secondary fleet funding skips scarce native deposits", async () => {
  const owner = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
  let nativeCalls = 0;
  const funded: string[] = [];
  const balances = await fundLocalPocketIcFixtures(
    {
      gatewayUrl: "http://localhost:8000/",
      expectedRootKeyBase64: "AQ==",
      canisterId: owner.toText(),
      stateDirectory: "/repo/.neutron/pocketic",
      cacheDirectory: "/repo/.neutron/cache/fixtures",
      targetWholeTokens: 2n,
      fundNativeChains: false,
      logger: { log() {} },
    },
    {
      createClient: (async () => ({
        async verifyInternetIdentity() {},
        async verifyLedgerPair() {},
        async ensureManagedLedgerPair() {},
        async fundLedger(
          fixture: LocalLedgerFixture,
          _actualOwner: Principal,
          target: bigint,
        ) {
          funded.push(fixture.key);
          return target;
        },
      })) as never,
      fundNative: async () => {
        nativeCalls += 1;
        return { ckbtc: 1n, cketh: 1n };
      },
    },
  );

  expect(nativeCalls).toBe(0);
  expect(funded).toEqual([
    "icp",
    "ckusdc",
    "ckusdt",
    "ckdoge",
    "cksol",
    "cycles",
  ]);
  expect(balances.ckbtc).toBe(0n);
  expect(balances.cketh).toBe(0n);
  expect(balances.cycles).toBe(2_000_000_000_000n);
});

test("pinned artifact resolver rejects bytes before caching them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-fixture-artifact-"));
  try {
    await expect(
      resolveLocalFixtureArtifacts({
        cacheDirectory: root,
        logger: { log() {} },
        fetcher: (async () =>
          new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("checksum mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function preparedArtifacts(): PreparedLocalFixtureArtifacts {
  return {
    ledger: { wasm: new Uint8Array([1]), moduleHashHex: "a".repeat(64) },
    index: { wasm: new Uint8Array([2]), moduleHashHex: "b".repeat(64) },
  };
}
