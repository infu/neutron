import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";
import { createMemoryLock } from "neutron-tools/src/memory.js";
import { packageArchiveFilename } from "neutron-tools/src/package_archive.js";
import type {
  NeutronManifest,
  NeutronMemoryConfig,
  PackagedNeutronManifest,
} from "neutron-tools/src/schema.js";

const decoder = new TextDecoder();
const releasedWallet307 = new URL(
  "../wallet.v0.3.7.neutron",
  import.meta.url,
);
const releasedWallet307Bytes = 677_271;
const releasedWallet307Sha256 =
  "20ba3b00349e9386713a789622ce6a570fc7123e7daf89cda38daedcfc74fac1";
const releasedWallet308 = new URL(
  "../wallet.v0.3.8.neutron",
  import.meta.url,
);
const releasedWallet308Bytes = 677_493;
const releasedWallet308Sha256 =
  "2f3626d2800ddf3e6c0734268c66627931c934811722d39de41c8d1505873858";
const releasedWallet309 = new URL(
  "../wallet.v0.3.9.neutron",
  import.meta.url,
);
const releasedWallet309Bytes = 677_558;
const releasedWallet309Sha256 =
  "6deaf1dc0a05582dfc7cd9db56f7e2bb9705df14e825bd817689d31a1e9e0398";
const releasedWallet310 = new URL(
  "../wallet.v0.3.10.neutron",
  import.meta.url,
);
const releasedWallet310Bytes = 677_819;
const releasedWallet310Sha256 =
  "a2077b5da0f5623b61e8f8a88f465bcac89ceb43908eed8fa9a5da5aa1aa7442";
const releasedWallet311 = new URL(
  "../wallet.v0.3.11.neutron",
  import.meta.url,
);
const releasedWallet311Bytes = 678_740;
const releasedWallet311Sha256 =
  "0a8395f04e6fbb83b2d579d72a77c9f3288261611c3a4b0bd369a6854e19eb46";
const kernel: PackagedNeutronManifest = {
  format: 3,
  id: "kernel",
  name: "Kernel",
  version: 100,
  entry: "f".repeat(64),
};

const allMemoryRoots = ["wallet", "wallet_bridge", "wallet_bridge_activity", "wallet_bridge_provider", "wallet_bridge_replacements", "wallet_commands", "wallet_refills", "wallet_transfers"] as const;
const addedMemoryRoots = ["wallet_bridge", "wallet_bridge_activity", "wallet_bridge_provider", "wallet_bridge_replacements", "wallet_refills", "wallet_transfers"] as const;

test("Wallet candidate keeps the original root and initializes independent journals", async () => {
  const [productionBytes, sourceText, lockText] = await Promise.all([
    readFile(new URL("../wallet.v0.3.2.neutron", import.meta.url)),
    readFile(new URL("../neutron.json", import.meta.url), "utf8"),
    readFile(new URL("../neutron.lock.json", import.meta.url), "utf8"),
  ]);
  expect(productionBytes.byteLength).toBe(575_530);
  expect(createHash("sha256").update(productionBytes).digest("hex")).toBe(
    "830e8cb4e59bcb73deed3024f704c373f6cce744ccf850efea65eac74b545b43",
  );
  const production = packageManifest(productionBytes);
  const source = JSON.parse(sourceText) as NeutronManifest;
  const lock = JSON.parse(lockText) as ReturnType<typeof createMemoryLock>;
  expect(production).toMatchObject({ id: "wallet", version: 302 });
  expect(Object.keys(source.memory ?? {}).sort()).toEqual([...allMemoryRoots]);
  const productionWallet = requiredMemory(production, "wallet");
  expect(sourceShape(productionWallet)).toEqual(requiredMemory(source, "wallet"));
  expect(lock.memory.wallet).toEqual(createMemoryLock(production).memory.wallet);

  for (const memoryId of ["wallet_commands", ...addedMemoryRoots]) {
    expect(requiredMemory(source, memoryId)).toEqual({
      version: 1,
      schemas: { "1": { src: `memory/${memoryId}/v1.mo` } },
      migrations: [],
    });
    expect(lock.memory[memoryId]?.schemas["1"]?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(lock.memory[memoryId]?.schemas["1"]?.entry).toMatch(/^[a-f0-9]{64}$/);
    expect(lock.memory[memoryId]?.migrations).toEqual({});
  }
  const candidate: PackagedNeutronManifest = {
    ...production,
    ...source,
    entry: production.entry,
    memory: Object.fromEntries(allMemoryRoots.map((memoryId) => [
      memoryId,
      packageMemory(requiredMemory(source, memoryId), lock.memory[memoryId]),
    ])),
  };
  expect(planMemoryMigrations({ kernel }, { kernel, wallet: candidate })).toEqual({
    upgrades: allMemoryRoots.map((memoryId) => ({ kind: "initialize", owner: "wallet", memoryId, to: 1 })),
    removedApps: [],
    destructiveMemoryRoots: [],
  });
  expect(planMemoryMigrations({ kernel, wallet: production }, { kernel, wallet: candidate })).toEqual({
    upgrades: allMemoryRoots.map((memoryId) => memoryId === "wallet"
      ? { kind: "keep", owner: "wallet", memoryId, version: 1 }
      : { kind: "initialize", owner: "wallet", memoryId, to: 1 }),
    removedApps: [],
    destructiveMemoryRoots: [],
  });
});

// These immutable archives cover the production schema baseline and later
// releases carrying wallet_commands, then the published four-root Wallet315.
// Skipping app versions keeps every existing v1 root and initializes only the
// missing journals. Wallet326 added the independent refill journal; subsequent
// code releases retain that root alongside every earlier memory lineage.
test("Current Wallet archive keeps every predecessor root and initializes only missing journals", async () => {
  const source = JSON.parse(await readFile(new URL("../neutron.json", import.meta.url), "utf8")) as NeutronManifest;
  expect(source.version).toBeGreaterThan(315);
  const candidateBytes = await readFile(new URL(`../${packageArchiveFilename("wallet", source.version)}`, import.meta.url));
  const candidateFiles = unpackNeutronPackage(candidateBytes);
  const candidate = packageManifest(candidateBytes);
  expect(candidate.version).toBe(source.version);
  expect(Object.keys(candidate.memory ?? {}).sort()).toEqual([...allMemoryRoots]);
  const lock = JSON.parse(await readFile(new URL("../neutron.lock.json", import.meta.url), "utf8")) as ReturnType<typeof createMemoryLock>;
  expect(createMemoryLock(candidate)).toEqual(lock);
  for (const memoryId of allMemoryRoots) {
    expect(sourceShape(requiredMemory(candidate, memoryId))).toEqual(requiredMemory(source, memoryId));
  }
  const predecessors = [
    { version: 302, bytes: 575_530, sha256: "830e8cb4e59bcb73deed3024f704c373f6cce744ccf850efea65eac74b545b43" },
    { version: 303, bytes: 634_054, sha256: "df4d3689c30a119a91dbf97d4dcdb67bc0226cc0149ebdf24db6cbd78b9c74e9" },
    { version: 304, bytes: 634_055, sha256: "0b32d7afaad101955d94887833f499d7e76d92c413bb28ddd457b3712bd69ea9" },
    { version: 305, bytes: 609_359, sha256: "046983c724641e3043b8056bc1999c593ede7b381b258e56aeb4d4ccede63886" },
    { version: 306, bytes: 666_413, sha256: "bea0d49e351bb8efa04bf03057b4f9175474a54bd198b382add790718b7b8aae" },
    { version: 307, bytes: releasedWallet307Bytes, sha256: releasedWallet307Sha256 },
    { version: 308, bytes: releasedWallet308Bytes, sha256: releasedWallet308Sha256 },
    { version: 309, bytes: releasedWallet309Bytes, sha256: releasedWallet309Sha256 },
    { version: 310, bytes: releasedWallet310Bytes, sha256: releasedWallet310Sha256 },
    { version: 311, bytes: releasedWallet311Bytes, sha256: releasedWallet311Sha256 },
    { version: 312, bytes: 678_721, sha256: "6875f1f98ae7309fe84885ed77df9847c1c1ad03f5baa8d6aed4b00fb4f48129" },
    { version: 315, bytes: 753_979, sha256: "1d1156e18ee3116dbda8c8c410f6c4987ba062db345ddf169a822f3d3c20ffcd" },
    { version: 316, bytes: 768_823, sha256: "fd15c2f0a0fa53575f11e3a97ad75f85707f2f8c238c9ed4c5b252a178219d76" },
    { version: 317, bytes: 777_746, sha256: "599dcfdb5a75dc1924b5e0918ad2ef4e0f715317ddbc05d276a093b7b96d4711" },
    { version: 318, bytes: 800_371, sha256: "b49c0f364ca502ab248c91c92f021b5211f7cbf3c3159d19c31941917dd962e0" },
    { version: 319, bytes: 804_495, sha256: "dc2bf1557ddc121fb25d38e2075ae8864aea0eba7fe5d55301b0b2bd707517f6" },
    { version: 320, bytes: 806_428, sha256: "88769f296095a1a9c5ebd4200e8890fbc8640f6097e0f19fdeafe14d3afdf56f" },
    { version: 321, bytes: 810_689, sha256: "12e17e9cb83a65b2e4c1cce81a3c0ba88db27a7b64c9de363868c83698375b84" },
    { version: 322, bytes: 815_214, sha256: "16060e1485e0ffb80b813d4a5f5082735982f1502e43e3843f32c4b84baeabea" },
    { version: 323, bytes: 883_259, sha256: "dd413ebeece8ed14a7dd606df145f9aead7371fb569184051186f5b9b44cc1c9" },
    { version: 324, bytes: 884_423, sha256: "c0017c3480b778f62f6bf16430a077b75952596cf3a46fef9b8996aeaaf91c31" },
    { version: 325, bytes: 884_468, sha256: "3c8e7a30873fa8cb62a14af4f26bedce38939bc1912e2dc8a64ff9430f7ca6d8" },
    { version: 326, bytes: 926_070, sha256: "1c3f152b3c97a4a91c8ab5ddf3194938841f6745cbd4aab7ac5a0287e851dd53" },
  ];
  for (const predecessor of predecessors) {
    const bytes = await readFile(new URL(`../${packageArchiveFilename("wallet", predecessor.version)}`, import.meta.url));
    expect(bytes.byteLength).toBe(predecessor.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(predecessor.sha256);
    const production = packageManifest(bytes);
    expect(production.version).toBe(predecessor.version);
    if (predecessor.version === 315) {
      expect(Object.keys(production.memory ?? {}).sort()).toEqual([
        "wallet", "wallet_bridge", "wallet_commands", "wallet_transfers",
      ]);
    }
    for (const [memoryId, memory] of Object.entries(production.memory ?? {})) {
      expect(requiredMemory(candidate, memoryId)).toEqual(memory);
      expect(lock.memory[memoryId]).toEqual(createMemoryLock(production).memory[memoryId]);
    }
    if (predecessor.version >= 319) {
      // Code releases may change the backend entry (322 adds ledger selection),
      // while every released schema and its full dependency closure remain
      // immutable, including bridge identities and unresolved transfers.
      const productionFiles = unpackNeutronPackage(bytes);
      // A new independent refill root extends the lock. Every existing root's
      // lineage and schema dependency bytes remain unchanged.
      const releasedLock = JSON.parse(decoder.decode(productionFiles["neutron.lock.json"]!)) as ReturnType<typeof createMemoryLock>;
      const candidateLock = JSON.parse(decoder.decode(candidateFiles["neutron.lock.json"]!)) as ReturnType<typeof createMemoryLock>;
      for (const memoryId of Object.keys(releasedLock.memory)) {
        expect(candidateLock.memory[memoryId]).toEqual(releasedLock.memory[memoryId]);
      }
      const checkedModules = new Set<string>();
      function preserveModuleClosure(entry: string): void {
        if (checkedModules.has(entry)) return;
        checkedModules.add(entry);
        const modulePath = `mo/${entry}.mo`;
        expect(productionFiles[modulePath]).toBeDefined();
        expect(candidateFiles[modulePath]).toEqual(productionFiles[modulePath]);
        for (const match of decoder.decode(productionFiles[modulePath]!).matchAll(/^\s*import\s+\w+\s+"([a-f0-9]{64})"\s*;/gm)) {
          preserveModuleClosure(match[1]!);
        }
      }
      for (const memory of Object.values(production.memory ?? {})) {
        for (const schema of Object.values(memory.schemas ?? {})) {
          if (schema.entry === undefined) throw new Error("Published schema entry is missing");
          preserveModuleClosure(schema.entry);
        }
      }
      expect(checkedModules.size).toBeGreaterThan(7);
    }
    expect(planMemoryMigrations({ kernel, wallet: production }, { kernel, wallet: candidate })).toEqual({
      upgrades: allMemoryRoots.map((memoryId) => production.memory?.[memoryId]
        ? { kind: "keep", owner: "wallet", memoryId, version: 1 }
        : { kind: "initialize", owner: "wallet", memoryId, to: 1 }),
      removedApps: [],
      destructiveMemoryRoots: [],
    });
  }
  expect(planMemoryMigrations({ kernel }, { kernel, wallet: candidate })).toEqual({
    upgrades: allMemoryRoots.map((memoryId) => ({ kind: "initialize", owner: "wallet", memoryId, to: 1 })),
    removedApps: [],
    destructiveMemoryRoots: [],
  });
  expect(planMemoryMigrations({ kernel, wallet: candidate }, { kernel, wallet: candidate })).toEqual({
    upgrades: allMemoryRoots.map((memoryId) => ({ kind: "keep", owner: "wallet", memoryId, version: 1 })),
    removedApps: [],
    destructiveMemoryRoots: [],
  });
});

test("Wallet 0.3.8 keeps both exact Wallet 0.3.7 memory roots", async () => {
  await assertWalletCodeOnlyRelease({
    productionArchive: releasedWallet307,
    productionVersion: 307,
    productionBytes: releasedWallet307Bytes,
    productionSha256: releasedWallet307Sha256,
    candidateArchive: releasedWallet308,
    candidateVersion: 308,
  });
});

test("Wallet 0.3.9 keeps both exact production 0.3.8 memory roots", async () => {
  await assertWalletCodeOnlyRelease({
    productionArchive: releasedWallet308,
    productionVersion: 308,
    productionBytes: releasedWallet308Bytes,
    productionSha256: releasedWallet308Sha256,
    candidateArchive: new URL("../wallet.v0.3.9.neutron", import.meta.url),
    candidateVersion: 309,
  });
});

test("Wallet 0.3.10 keeps both exact production 0.3.9 memory roots", async () => {
  await assertWalletCodeOnlyRelease({
    productionArchive: releasedWallet309,
    productionVersion: 309,
    productionBytes: releasedWallet309Bytes,
    productionSha256: releasedWallet309Sha256,
    candidateArchive: new URL("../wallet.v0.3.10.neutron", import.meta.url),
    candidateVersion: 310,
  });
});

test("Wallet 0.3.11 keeps both exact production 0.3.10 memory roots", async () => {
  await assertWalletCodeOnlyRelease({
    productionArchive: releasedWallet310,
    productionVersion: 310,
    productionBytes: releasedWallet310Bytes,
    productionSha256: releasedWallet310Sha256,
    candidateArchive: new URL("../wallet.v0.3.11.neutron", import.meta.url),
    candidateVersion: 311,
  });
});

test("Wallet 0.3.12 keeps both exact production 0.3.11 memory roots", async () => {
  await assertWalletCodeOnlyRelease({
    productionArchive: releasedWallet311,
    productionVersion: 311,
    productionBytes: releasedWallet311Bytes,
    productionSha256: releasedWallet311Sha256,
    candidateArchive: new URL("../wallet.v0.3.12.neutron", import.meta.url),
    candidateVersion: 312,
  });
});

async function assertWalletCodeOnlyRelease(value: {
  productionArchive: URL;
  productionVersion: number;
  productionBytes: number;
  productionSha256: string;
  candidateArchive: URL;
  candidateVersion: number;
}): Promise<void> {
  const [productionBytes, candidateBytes, lockText] = await Promise.all([
    readFile(value.productionArchive),
    readFile(value.candidateArchive),
    readFile(new URL("../neutron.lock.json", import.meta.url), "utf8"),
  ]);
  expect(productionBytes.byteLength).toBe(value.productionBytes);
  expect(createHash("sha256").update(productionBytes).digest("hex")).toBe(
    value.productionSha256,
  );
  const production = packageManifest(productionBytes);
  const candidate = packageManifest(candidateBytes);
  expect(production).toMatchObject({
    id: "wallet",
    version: value.productionVersion,
  });
  expect(candidate).toMatchObject({
    id: "wallet",
    version: value.candidateVersion,
  });

  const lock = JSON.parse(lockText) as ReturnType<typeof createMemoryLock>;
  const productionLock = createMemoryLock(production);
  const candidateLock = createMemoryLock(candidate);
  for (const memoryId of ["wallet", "wallet_commands"]) {
    expect(requiredMemory(candidate, memoryId)).toEqual(
      requiredMemory(production, memoryId),
    );
    expect(lock.memory[memoryId]).toEqual(productionLock.memory[memoryId]);
    expect(candidateLock.memory[memoryId]).toEqual(
      productionLock.memory[memoryId],
    );
  }
  expect(
    planMemoryMigrations(
      { kernel, wallet: production },
      { kernel, wallet: candidate },
    ),
  ).toEqual({
    upgrades: [
      { kind: "keep", owner: "wallet", memoryId: "wallet", version: 1 },
      {
        kind: "keep",
        owner: "wallet",
        memoryId: "wallet_commands",
        version: 1,
      },
    ],
    removedApps: [],
    destructiveMemoryRoots: [],
  });
}

function packageManifest(bytes: Uint8Array): PackagedNeutronManifest {
  const manifest = unpackNeutronPackage(bytes)["neutron.json"];
  if (manifest === undefined) throw new Error("Missing packaged manifest");
  return JSON.parse(decoder.decode(manifest)) as PackagedNeutronManifest;
}

function requiredMemory(
  manifest: NeutronManifest,
  memoryId: string,
): NeutronMemoryConfig {
  const memory = manifest.memory?.[memoryId];
  if (memory === undefined) throw new Error(`Missing Wallet ${memoryId} root`);
  return memory;
}

function sourceShape(memory: NeutronMemoryConfig): NeutronMemoryConfig {
  return {
    ...memory,
    schemas: Object.fromEntries(
      Object.entries(memory.schemas ?? {}).map(
        ([version, { entry: _entry, hash: _hash, ...schema }]) => [
          version,
          schema,
        ],
      ),
    ),
    migrations: (memory.migrations ?? []).map(
      ({ entry: _entry, ...migration }) => migration,
    ),
  };
}

function packageMemory(
  source: NeutronMemoryConfig,
  lock: ReturnType<typeof createMemoryLock>["memory"][string] | undefined,
): NeutronMemoryConfig {
  if (lock === undefined) throw new Error("Missing Wallet memory lock root");
  return {
    ...source,
    schemas: Object.fromEntries(
      Object.entries(source.schemas ?? {}).map(([version, schema]) => {
        const locked = lock.schemas[version];
        if (locked === undefined) {
          throw new Error(`Missing Wallet memory schema lock v${version}`);
        }
        return [version, { ...schema, ...locked }];
      }),
    ),
    migrations: (source.migrations ?? []).map((migration) => {
      const key = `${migration.from}->${migration.to}`;
      const locked = lock.migrations[key];
      if (locked === undefined) {
        throw new Error(`Missing Wallet memory migration lock ${key}`);
      }
      return { ...migration, entry: locked };
    }),
  };
}
