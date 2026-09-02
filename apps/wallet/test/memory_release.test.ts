import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";
import { createMemoryLock } from "neutron-tools/src/memory.js";
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
const kernel: PackagedNeutronManifest = {
  format: 3,
  id: "kernel",
  name: "Kernel",
  version: 100,
  entry: "f".repeat(64),
};

test("Wallet candidate keeps production wallet v1 and initializes wallet_commands v1", async () => {
  const [productionBytes, sourceText, lockText] = await Promise.all([
    readFile(new URL("../wallet.v0.3.2.neutron", import.meta.url)),
    readFile(new URL("../neutron.json", import.meta.url), "utf8"),
    readFile(new URL("../neutron.lock.json", import.meta.url), "utf8"),
  ]);

  // v0.3.2 is the immutable production Wallet baseline deliberately tracked in
  // this repository. Later code-only releases retained this same wallet v1 root.
  expect(productionBytes.byteLength).toBe(575_530);
  expect(createHash("sha256").update(productionBytes).digest("hex")).toBe(
    "830e8cb4e59bcb73deed3024f704c373f6cce744ccf850efea65eac74b545b43",
  );

  const production = packageManifest(productionBytes);
  const source = JSON.parse(sourceText) as NeutronManifest;
  const lock = JSON.parse(lockText) as ReturnType<typeof createMemoryLock>;
  expect(production).toMatchObject({ id: "wallet", version: 302 });
  expect(source).toMatchObject({ id: "wallet" });

  const productionWallet = requiredMemory(production, "wallet");
  const sourceWallet = requiredMemory(source, "wallet");
  const sourceCommands = requiredMemory(source, "wallet_commands");
  expect(sourceShape(productionWallet)).toEqual(sourceWallet);

  const productionLock = createMemoryLock(production);
  expect(lock.memory.wallet).toEqual(productionLock.memory.wallet);
  expect(sourceCommands).toEqual({
    version: 1,
    schemas: { "1": { src: "memory/wallet_commands/v1.mo" } },
    migrations: [],
  });
  const commandsLock = lock.memory.wallet_commands;
  if (commandsLock === undefined) {
    throw new Error("Missing Wallet wallet_commands memory lock");
  }
  expect(commandsLock.schemas["1"]?.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(commandsLock.schemas["1"]?.entry).toMatch(/^[a-f0-9]{64}$/);
  expect(commandsLock.migrations).toEqual({});

  const candidate: PackagedNeutronManifest = {
    ...production,
    ...source,
    entry: production.entry,
    memory: {
      wallet: productionWallet,
      wallet_commands: packageMemory(sourceCommands, commandsLock),
    },
  };

  expect(
    planMemoryMigrations({ kernel }, { kernel, wallet: candidate }),
  ).toEqual({
    upgrades: [
      { kind: "initialize", owner: "wallet", memoryId: "wallet", to: 1 },
      {
        kind: "initialize",
        owner: "wallet",
        memoryId: "wallet_commands",
        to: 1,
      },
    ],
    removedApps: [],
    destructiveMemoryRoots: [],
  });
  expect(
    planMemoryMigrations(
      { kernel, wallet: production },
      { kernel, wallet: candidate },
    ),
  ).toEqual({
    upgrades: [
      { kind: "keep", owner: "wallet", memoryId: "wallet", version: 1 },
      {
        kind: "initialize",
        owner: "wallet",
        memoryId: "wallet_commands",
        to: 1,
      },
    ],
    removedApps: [],
    destructiveMemoryRoots: [],
  });
});

test("Wallet 0.3.8 keeps both exact Wallet 0.3.7 memory roots", async () => {
  const [releasedBytes, sourceText, lockText] = await Promise.all([
    readFile(releasedWallet307),
    readFile(new URL("../neutron.json", import.meta.url), "utf8"),
    readFile(new URL("../neutron.lock.json", import.meta.url), "utf8"),
  ]);
  expect(releasedBytes.byteLength).toBe(releasedWallet307Bytes);
  expect(createHash("sha256").update(releasedBytes).digest("hex")).toBe(
    releasedWallet307Sha256,
  );

  const released = packageManifest(releasedBytes);
  const source = JSON.parse(sourceText) as NeutronManifest;
  const lock = JSON.parse(lockText) as ReturnType<typeof createMemoryLock>;
  expect(released).toMatchObject({ id: "wallet", version: 307 });
  expect(source).toMatchObject({ id: "wallet", version: 308 });

  const releasedLock = createMemoryLock(released);
  const candidateMemory = Object.fromEntries(
    ["wallet", "wallet_commands"].map((memoryId) => {
      const releasedRoot = requiredMemory(released, memoryId);
      const sourceRoot = requiredMemory(source, memoryId);
      expect(sourceShape(releasedRoot)).toEqual(sourceRoot);
      expect(lock.memory[memoryId]).toEqual(releasedLock.memory[memoryId]);
      return [memoryId, packageMemory(sourceRoot, lock.memory[memoryId])];
    }),
  );
  const candidate: PackagedNeutronManifest = {
    ...released,
    ...source,
    entry: released.entry,
    memory: candidateMemory,
  };

  expect(
    planMemoryMigrations(
      { kernel, wallet: released },
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
});

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
