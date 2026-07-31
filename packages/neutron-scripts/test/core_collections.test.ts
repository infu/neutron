import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const corePin =
  'core = "https://github.com/dfinity/motoko-core#v2.6.0"';

test("shipped Motoko apps use Core instead of legacy collection packages", async () => {
  const files = [
    ...(await scan("apps", (file) => file.endsWith(".mo"))),
    ...(await scan("support/dispenser/mo", (file) => file.endsWith(".mo"))),
  ];
  expect(files.length).toBeGreaterThan(0);

  for (const file of files) {
    const source = await readFile(file, "utf8");
    expect(source, relative(file)).not.toMatch(
      /"mo:(?:base|vector|rxmodb|stableheapbtreemap|motoko-hash-map)(?:\/|\")/,
    );
    expect(source, relative(file)).not.toMatch(/:=\s*Array\.concat\b/);
  }
});

test("every shipped app pins the current Core package", async () => {
  const manifests = [
    ...(await scan("apps", (file) => file.endsWith("/mops.toml"))),
    path.join(root, "support/dispenser/mops.toml"),
  ];
  expect(manifests.length).toBeGreaterThan(0);
  for (const manifest of manifests) {
    expect(await readFile(manifest, "utf8"), relative(manifest)).toContain(corePin);
  }
});

test("persistent stores use collections matching their access patterns", async () => {
  const kernel = await read("apps/kernel/backend/memory/kernel/v3.mo");
  const wallet = await read("apps/wallet/backend/memory/wallet/v1.mo");
  const dispenser = await read("support/dispenser/mo/main.mo");

  expect(kernel).toContain("assets : AssetMemory");
  expect(kernel).toContain("authorized : PrincipalSet");
  expect(kernel).toContain("replay_order : Queue.Queue<Blob>");
  expect(kernel).toContain(
    "reservations : Map.Map<Nat, BackendCallReservation>",
  );
  expect(wallet).toContain("ledgers : Map.Map<Principal, Ledger>");
  expect(dispenser).toContain("Map.empty<Principal");
  expect(dispenser).toContain("List.empty<Asset>()");
});

async function scan(
  directory: string,
  include: (file: string) => boolean,
): Promise<string[]> {
  const files: string[] = [];
  const target = path.join(root, directory);
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const absolute = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if ([".mops", "dist", "node_modules"].includes(entry.name)) continue;
      files.push(...(await scan(path.relative(root, absolute), include)));
    } else if (entry.isFile() && include(absolute)) {
      files.push(absolute);
    }
  }
  return files.sort();
}

async function read(file: string): Promise<string> {
  return readFile(path.join(root, file), "utf8");
}

function relative(file: string): string {
  return path.relative(root, file);
}
