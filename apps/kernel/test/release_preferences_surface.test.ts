import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assemble, type AssemblyManifest } from "neutron-compiler/src/assemble.ts";
import { unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { hashContent, removeCommentsAndEmptyLines } from "neutron-scripts/src/walk.ts";
import { scopedPhysicalStem } from "neutron-tools/src/physical_names.ts";

const [manifestText, backend] = await Promise.all([
  readFile(new URL("../neutron.json", import.meta.url), "utf8"),
  readFile(new URL("../backend/main.mo", import.meta.url), "utf8"),
]);
const manifest = JSON.parse(manifestText) as AssemblyManifest;
const assembled = assemble({
  kernel: { ...manifest, entry: manifest.src!.replace(/\.mo$/, "") },
});
const memoryBinding = (id: string) =>
  `NeutronMemory_${scopedPhysicalStem("kernel", id)}`;

test("release preference methods retain owner authorization in the source manifest and assembled actor", () => {
  for (const [name, mode, actorMode] of [
    ["get_release_preferences", "query", "query"],
    ["set_release_preferences", "update", "shared"],
  ] as const) {
    expect(manifest.func?.[name]).toEqual({ type: mode, async: false });
    expect(backend).toContain(`public func /*${mode}*/${name}(`);
    const method = assembled.match(new RegExp(
      `public ${actorMode}\\(\\{ caller = NeutronCaller \\}\\) func ${name}\\([^\\n]+\\) : async [^\\n]+ \\{([^]*?)\\n    \\};`,
    ));
    expect(method).not.toBeNull();
    expect(method![1]!.trim()).toMatch(new RegExp(
      `^assert\\(NeutronKernel\\.is_authorized\\(NeutronCaller\\)\\);\\s+NeutronKernel\\.${name}\\(NeutronRequest\\s*\\)$`,
    ));
  }
});

test("release preference methods expose a unit query and Boolean update returning the versioned preference", () => {
  expect(backend).toMatch(
    /public type ReleasePreferences\s*=\s*\{\s*beta_enabled\s*:\s*Bool;\s*revision\s*:\s*Nat;\s*\}/,
  );
  expect(backend).toMatch(
    /public type get_release_preferences_Input\s*=\s*\(\(\)\);/,
  );
  expect(backend).toMatch(
    /public type set_release_preferences_Input\s*=\s*\(beta_enabled\s*:\s*Bool\);/,
  );
  for (const name of ["get_release_preferences", "set_release_preferences"]) {
    expect(backend).toContain(`public type ${name}_Output = ReleasePreferences;`);
  }
});

test("release preferences use their own managed memory root in the Kernel initialization contract", () => {
  expect(manifest.memory?.kernel_release_preferences).toEqual({
    version: 1,
    schemas: { "1": { src: "memory/release_preferences/v1.mo" } },
    migrations: [],
  });
  expect(manifest.init_arg).toEqual([
    "memory_kernel",
    "memory_kernel_activation",
    "memory_kernel_cycle_calls",
    "memory_kernel_release_preferences",
    "deployment_id",
    "active_app_instance_inventory",
    "canister_principal",
  ]);
  expect(backend).toMatch(
    /ownerCycleMem\s*:\s*OwnerCycleMemory\.Mem,\s*releasePreferenceMem\s*:\s*ReleasePreferenceMemory\.Mem,/,
  );
  const stem = scopedPhysicalStem("kernel", "kernel_release_preferences");
  expect(assembled).toContain(
    `import NeutronMemorySchema_${stem}_v1 "memory/release_preferences/v1";`,
  );
  expect(assembled).toContain(
    `let NeutronMemoryStore_${stem}:NeutronMemoryType_${stem} = #v1(NeutronMemorySchema_${stem}_v1.init());`,
  );
  expect(assembled).toContain(
    `transient let #v1(${memoryBinding("kernel_release_preferences")}) = NeutronMemoryStore_${stem};`,
  );
  expect(assembled).toContain(
    `NeutronModule_a6_kernel.Init(${[
      "kernel", "kernel_activation", "kernel_cycle_calls", "kernel_release_preferences",
    ].map(memoryBinding).join(",")},`,
  );
});

test("adding release preferences preserves every released Kernel memory schema and its locked lineage", async () => {
  const [previousBytes, lockText] = await Promise.all([
    readFile(new URL("../kernel.v0.3.61.neutron", import.meta.url)),
    readFile(new URL("../neutron.lock.json", import.meta.url), "utf8"),
  ]);
  expect(previousBytes.length).toBe(2_477_271);
  expect(createHash("sha256").update(previousBytes).digest("hex")).toBe(
    "34a003ee2e01d045df211c0bf52609b472956f7f9ec5085c9a045d2457ef7ca4",
  );
  const previousFiles = unpackNeutronPackage(previousBytes);
  const previous = JSON.parse(
    new TextDecoder().decode(previousFiles["neutron.json"]!),
  ) as AssemblyManifest;
  const lock = JSON.parse(lockText);
  expect(previous.memory?.kernel_release_preferences).toBeUndefined();
  expect(Object.keys(previous.memory!).sort()).toEqual([
    "kernel", "kernel_activation", "kernel_cycle_calls",
  ]);
  for (const [id, released] of Object.entries(previous.memory!)) {
    const current = manifest.memory![id]!;
    expect(current.version).toBe(released.version);
    expect(Object.keys(current.schemas!).sort()).toEqual(Object.keys(released.schemas!).sort());
    for (const [version, schema] of Object.entries(released.schemas!)) {
      expect(current.schemas![version]).toEqual({ src: schema.src! });
      expect(lock.memory[id].schemas[version]).toEqual({
        hash: schema.hash,
        entry: schema.entry,
      });
      const source = await readFile(new URL(`../backend/${schema.src}`, import.meta.url), "utf8");
      expect(hashContent(removeCommentsAndEmptyLines(source))).toBe(schema.hash!);
    }
    expect(current.migrations).toEqual(released.migrations!.map(({ entry, ...migration }) => migration));
    expect(lock.memory[id].migrations).toEqual(Object.fromEntries(
      released.migrations!.map(({ from, to, entry }) => [`${from}->${to}`, entry]),
    ));
  }
});
