import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compilerSourceFingerprint } from "../src/compiler_fingerprint.ts";

test("compiler fingerprint binds only the compiler, tools, and root toolchain", async () => {
  await withFixture(async (root) => {
    const first = await compilerSourceFingerprint(root);
    expect(await compilerSourceFingerprint(root)).toBe(first);

    await writeFile(path.join(root, "apps", "wagyu", "source.ts"), "changed");
    expect(await compilerSourceFingerprint(root)).toBe(first);

    await writeFile(
      path.join(root, "packages", "neutron-tools", "source.ts"),
      "changed",
    );
    const toolsChanged = await compilerSourceFingerprint(root);
    expect(toolsChanged).not.toBe(first);

    await writeFile(
      path.join(root, "packages", "neutron-motoko-wasm", "compiler.wasm"),
      "changed",
    );
    const compilerRuntimeChanged = await compilerSourceFingerprint(root);
    expect(compilerRuntimeChanged).not.toBe(toolsChanged);

    await writeFile(path.join(root, "package.json"), '{"workspaces":[]}');
    expect(await compilerSourceFingerprint(root)).not.toBe(
      compilerRuntimeChanged,
    );
  });
});

test("compiler fingerprint ignores generated directories and rejects symlinks", async () => {
  await withFixture(async (root) => {
    const first = await compilerSourceFingerprint(root);
    await mkdir(
      path.join(root, "packages", "neutron-compiler", "node_modules", "x"),
      { recursive: true },
    );
    await writeFile(
      path.join(
        root,
        "packages",
        "neutron-compiler",
        "node_modules",
        "x",
        "generated.js",
      ),
      "generated",
    );
    await writeFile(
      path.join(
        root,
        "packages",
        "neutron-compiler",
        "tsconfig.tsbuildinfo",
      ),
      "generated build graph",
    );
    expect(await compilerSourceFingerprint(root)).toBe(first);

    await symlink(
      path.join(root, "package.json"),
      path.join(root, "packages", "neutron-compiler", "linked.json"),
    );
    await expect(compilerSourceFingerprint(root)).rejects.toThrow(
      "contains symlink",
    );
  });
});

async function withFixture(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-compiler-input-"));
  try {
    await Promise.all([
      mkdir(path.join(root, "packages", "neutron-compiler"), {
        recursive: true,
      }),
      mkdir(path.join(root, "packages", "neutron-motoko-wasm"), {
        recursive: true,
      }),
      mkdir(path.join(root, "packages", "neutron-security"), {
        recursive: true,
      }),
      mkdir(path.join(root, "packages", "neutron-tools"), {
        recursive: true,
      }),
      mkdir(path.join(root, "apps", "wagyu"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(root, "package.json"), '{"workspaces":["packages/*"]}'),
      writeFile(
        path.join(root, "packages", "neutron-compiler", "source.ts"),
        "compiler",
      ),
      writeFile(
        path.join(root, "packages", "neutron-motoko-wasm", "compiler.wasm"),
        "compiler runtime",
      ),
      writeFile(
        path.join(root, "packages", "neutron-security", "source.ts"),
        "security",
      ),
      writeFile(
        path.join(root, "packages", "neutron-tools", "source.ts"),
        "tools",
      ),
      writeFile(path.join(root, "apps", "wagyu", "source.ts"), "wagyu"),
    ]);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
