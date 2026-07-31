import { expect, test } from "bun:test";
import type { PackagedNeutronManifest } from "neutron-tools/src/schema.js";
import { planMemoryMigrations } from "../src/memory_migrations.ts";

const hash = (digit: string): string => digit.repeat(64);
const schema = (entry: string) => ({ entry, hash: entry });

function kernel(): PackagedNeutronManifest {
  return {
    format: 3,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: hash("a"),
  };
}

function managedApp(version: number): PackagedNeutronManifest {
  const schemas = Object.fromEntries(
    [1, 2, 3, 4]
      .filter((schemaVersion) => schemaVersion <= version)
      .map((schemaVersion) => [
        String(schemaVersion),
        schema(hash(String(schemaVersion))),
      ]),
  );
  const migrations = [
    { from: 1, to: 2, entry: hash("4") },
    { from: 2, to: 3, entry: hash("5") },
    { from: 3, to: 4, entry: hash("6") },
  ].filter((edge) => edge.to <= version);
  return {
    format: 3,
    id: "hello",
    name: "Hello",
    version: 99 + version,
    entry: hash("b"),
    memory: {
      hello: {
        version,
        schemas,
        migrations,
      },
    },
  };
}

test("planner selects the unique direct-install path from v1 to v3", () => {
  const oldApp = managedApp(1);
  const nextApp = managedApp(3);
  const plan = planMemoryMigrations(
    { kernel: kernel(), hello: oldApp },
    { kernel: kernel(), hello: nextApp },
  );

  expect(plan.upgrades).toEqual([
    {
      kind: "migrate",
      owner: "hello",
      memoryId: "hello",
      from: 1,
      to: 3,
      oldSchemaEntry: hash("1"),
      path: [
        { from: 1, to: 2, entry: hash("4") },
        { from: 2, to: 3, entry: hash("5") },
      ],
    },
  ]);
});

test("planner bridges several skipped app releases through one complete lineage", () => {
  const plan = planMemoryMigrations(
    { kernel: kernel(), hello: managedApp(1) },
    { kernel: kernel(), hello: managedApp(4) },
  );

  expect(plan.upgrades).toEqual([
    {
      kind: "migrate",
      owner: "hello",
      memoryId: "hello",
      from: 1,
      to: 4,
      oldSchemaEntry: hash("1"),
      path: [
        { from: 1, to: 2, entry: hash("4") },
        { from: 2, to: 3, entry: hash("5") },
        { from: 3, to: 4, entry: hash("6") },
      ],
    },
  ]);
});

test("planner rejects ambiguous migration paths", () => {
  const next = managedApp(3);
  next.memory!.hello!.migrations!.push({
    from: 1,
    to: 3,
    entry: hash("6"),
  });
  expect(() =>
    planMemoryMigrations(
      { kernel: kernel(), hello: managedApp(1) },
      { kernel: kernel(), hello: next },
    ),
  ).toThrow(/ambiguous migration paths/);
});

test("planner rejects backward edges and cycles before path selection", () => {
  const backward = managedApp(3);
  backward.memory!.hello!.migrations!.push({
    from: 3,
    to: 2,
    entry: hash("7"),
  });
  expect(() =>
    planMemoryMigrations(
      { kernel: kernel(), hello: managedApp(1) },
      { kernel: kernel(), hello: backward },
    ),
  ).toThrow(/not forward-only/);

  const cyclic = managedApp(3);
  cyclic.memory!.hello!.migrations!.push({
    from: 2,
    to: 1,
    entry: hash("8"),
  });
  expect(() =>
    planMemoryMigrations(
      { kernel: kernel(), hello: managedApp(1) },
      { kernel: kernel(), hello: cyclic },
    ),
  ).toThrow(/not forward-only/);
});

test("planner rejects an upgrade with a missing intermediate migration edge", () => {
  const next = managedApp(3);
  next.memory!.hello!.migrations = next.memory!.hello!.migrations!.filter(
    ({ from, to }) => from !== 2 || to !== 3,
  );
  expect(() =>
    planMemoryMigrations(
      { kernel: kernel(), hello: managedApp(1) },
      { kernel: kernel(), hello: next },
    ),
  ).toThrow(/no migration path from v1 to v3/);
});

test("planner makes app uninstall explicitly destructive", () => {
  const plan = planMemoryMigrations(
    { kernel: kernel(), hello: managedApp(3) },
    { kernel: kernel() },
  );
  expect(plan.removedApps).toEqual(["hello"]);
  expect(plan.destructiveMemoryRoots).toEqual([
    { owner: "hello", memoryId: "hello" },
  ]);
  expect(plan.upgrades[0]).toMatchObject({
    kind: "retire",
    reason: "app-uninstall",
    owner: "hello",
    memoryId: "hello",
    from: 3,
  });
});

test("planner rejects silent memory removal from an installed app", () => {
  const next = managedApp(3);
  delete next.memory;
  expect(() =>
    planMemoryMigrations(
      { kernel: kernel(), hello: managedApp(3) },
      { kernel: kernel(), hello: next },
    ),
  ).toThrow(/without declaring retired/);
});

test("explicit retirement is scoped and another app may use the same local id", () => {
  const retired = managedApp(3);
  retired.memory!.hello!.retired = true;
  const plan = planMemoryMigrations(
    { kernel: kernel(), hello: managedApp(3) },
    { kernel: kernel(), hello: retired },
  );
  expect(plan.upgrades[0]).toMatchObject({
    kind: "retire",
    reason: "memory-retirement",
    memoryId: "hello",
  });

  const claimant = managedApp(3);
  claimant.id = "claimant";
  claimant.name = "Claimant";
  expect(
    planMemoryMigrations(
      { kernel: kernel(), hello: retired },
      { kernel: kernel(), hello: retired, claimant },
    ).upgrades,
  ).toEqual([
    {
      kind: "initialize",
      owner: "claimant",
      memoryId: "hello",
      to: 3,
    },
  ]);
});

test("planner upgrades equal app-local ids independently", () => {
  const oldVault = managedApp(1);
  oldVault.id = "vault";
  oldVault.name = "Vault";
  const nextVault = managedApp(2);
  nextVault.id = "vault";
  nextVault.name = "Vault";

  const plan = planMemoryMigrations(
    { kernel: kernel(), hello: managedApp(1), vault: oldVault },
    { kernel: kernel(), hello: managedApp(2), vault: nextVault },
  );

  expect(plan.upgrades).toEqual([
    expect.objectContaining({
      kind: "migrate",
      owner: "hello",
      memoryId: "hello",
      from: 1,
      to: 2,
    }),
    expect.objectContaining({
      kind: "migrate",
      owner: "vault",
      memoryId: "hello",
      from: 1,
      to: 2,
    }),
  ]);
  expect(plan.destructiveMemoryRoots).toEqual([]);
});

test("planner derives same-owner consumed roots for commit-atomic retirement", () => {
  const oldApp = managedApp(1);
  oldApp.memory!.hello_aux = {
    version: 1,
    schemas: { "1": schema(hash("6")) },
    migrations: [],
  };

  const nextApp = managedApp(2);
  nextApp.memory!.hello!.migrations![0]!.consume = ["hello_aux"];
  nextApp.memory!.hello_aux = {
    version: 1,
    schemas: { "1": schema(hash("6")) },
    migrations: [],
    retired: true,
  };

  const plan = planMemoryMigrations(
    { kernel: kernel(), hello: oldApp },
    { kernel: kernel(), hello: nextApp },
  );
  expect(plan.upgrades).toEqual([
    {
      kind: "migrate",
      owner: "hello",
      memoryId: "hello",
      from: 1,
      to: 2,
      oldSchemaEntry: hash("1"),
      path: [
        {
          from: 1,
          to: 2,
          entry: hash("4"),
          consume: ["hello_aux"],
        },
      ],
    },
    {
      kind: "retire",
      reason: "memory-retirement",
      owner: "hello",
      memoryId: "hello_aux",
      from: 1,
      oldSchemaEntry: hash("6"),
    },
  ]);
});

test("a migration cannot consume another app's memory", () => {
  const nextApp = managedApp(2);
  nextApp.memory!.hello!.migrations![0]!.consume = ["vault_state"];
  const vault = managedApp(1);
  vault.id = "vault";
  vault.name = "Vault";
  vault.memory = {
    vault_state: {
      version: 1,
      schemas: { "1": schema(hash("6")) },
      migrations: [],
    },
  };
  const retiredVault = structuredClone(vault);
  retiredVault.memory!.vault_state!.retired = true;

  expect(() =>
    planMemoryMigrations(
      { kernel: kernel(), hello: managedApp(1), vault },
      { kernel: kernel(), hello: nextApp, vault: retiredVault },
    ),
  ).toThrow(/not retired by the same app/);
});

test("fresh installs keep historical retired tombstones without creating roots", () => {
  const app = managedApp(2);
  app.memory!.hello_aux = {
    version: 1,
    schemas: { "1": schema(hash("6")) },
    migrations: [],
    retired: true,
  };
  const plan = planMemoryMigrations(
    { kernel: kernel() },
    { kernel: kernel(), hello: app },
  );
  expect(plan.upgrades).toEqual([
    { kind: "initialize", owner: "hello", memoryId: "hello", to: 2 },
  ]);
});
