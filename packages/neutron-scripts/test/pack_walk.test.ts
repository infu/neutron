import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packDirectory } from "../src/pack.ts";

test("packer rejects symlinked package inputs without writing an archive", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-pack-unreadable-"),
  );
  const archivePath = path.join(rootDir, "broken.v0.1.0.neutron");

  try {
    await fs.writeFile(
      path.join(rootDir, "neutron.json"),
      JSON.stringify({ id: "broken", version: 100 }),
    );
    await fs.mkdir(path.join(rootDir, "dist"));
    await fs.writeFile(path.join(rootDir, "outside.html"), "not package data");
    await fs.symlink(
      path.join(rootDir, "outside.html"),
      path.join(rootDir, "dist", "index.html"),
    );

    await expect(packDirectory(rootDir)).rejects.toThrow(
      "Package input must not be a symbolic link",
    );
    await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
