import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const mogen = path.join(repoRoot, "packages/neutron-scripts/src/mogen.ts");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

test("mogen preserves internal app export metadata", async () => {
  const cwd = await fixture(`module {
    public class Init() {
      public func /*internal:apps*/ list_contacts() : async* [Text] {
        ["Ada"]
      };
    };
  }`);

  const result = await runMogen(cwd);
  expect(result.exitCode).toBe(0);
  const manifest = JSON.parse(
    await fs.readFile(path.join(cwd, "neutron.json"), "utf8"),
  );
  expect(manifest.func.list_contacts).toEqual({
    type: "internal",
    async: "async*",
    expose: "apps",
  });
});

test("mogen rejects app exports on public actor methods", async () => {
  const cwd = await fixture(`module {
    public class Init() {
      public func /*update:apps*/ list_contacts() : [Text] { ["Ada"] };
    };
  }`);

  const result = await runMogen(cwd);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "Only internal functions can use the apps modifier",
  );
});

test("mogen preserves the method name for system-capability functions", async () => {
  const cwd = await fixture(`module {
    public class Init() {
      public func /*update*/ kernel_install_commit<system>(request : ()) : () {
        ignore request
      };
    };
  }`);

  const result = await runMogen(cwd);
  expect(result.exitCode).toBe(0);
  const manifest = JSON.parse(
    await fs.readFile(path.join(cwd, "neutron.json"), "utf8"),
  );
  expect(manifest.func.kernel_install_commit).toEqual({
    type: "update",
    async: false,
  });
  expect(Object.keys(manifest.func)).toEqual(["kernel_install_commit"]);
});

async function fixture(source: string): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "neutron-mogen-"));
  temporaryDirectories.push(cwd);
  await fs.mkdir(path.join(cwd, "backend"));
  await fs.writeFile(
    path.join(cwd, "neutron.json"),
    JSON.stringify({
      id: "contacts",
      name: "Contacts",
      version: 1,
      src: "main.mo",
    }),
  );
  await fs.writeFile(path.join(cwd, "backend/main.mo"), source);
  return cwd;
}

function runMogen(cwd: string): { exitCode: number; stderr: string } {
  const child = spawnSync(process.execPath, [mogen], {
    cwd,
    encoding: "utf8",
  });
  return {
    exitCode: child.status ?? -1,
    stderr: child.stderr,
  };
}
