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
