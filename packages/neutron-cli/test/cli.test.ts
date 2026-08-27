import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../src/index.ts";

function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    logger: {
      log(value: unknown) {
        logs.push(String(value));
      },
      error(value: unknown) {
        errors.push(String(value));
      },
    },
  };
}

test("exposes only the package compiler", async () => {
  const output = capture();
  expect((await main(["help"], output.logger)).exitCode).toBe(0);
  expect(output.logs.join("\n")).toContain("neutron compile");
  expect(output.logs.join("\n")).not.toMatch(
    /\b(?:bootstrap|install|uninstall|proxy|url)\b/u,
  );
});

test("rejects removed deployment commands", async () => {
  const output = capture();
  expect((await main(["install"], output.logger)).exitCode).toBe(1);
  expect(output.errors).toEqual(["Unknown command: install"]);
});

test("compile requires packages and explicit output paths", async () => {
  const missingPackage = capture();
  expect((await main(["compile"], missingPackage.logger)).exitCode).toBe(1);
  expect(missingPackage.errors.join("\n")).toContain(
    "At least one --package path is required",
  );

  const missingOutput = capture();
  expect(
    (
      await main(
        ["compile", "--package", "kernel.v0.1.5.neutron"],
        missingOutput.logger,
      )
    ).exitCode,
  ).toBe(1);
  expect(missingOutput.errors.join("\n")).toContain("--wasm-out is required");
});

test("compile rejects non-production threshold-key environments before reading archives", async () => {
  const output = capture();
  expect(
    (
      await main(
        [
          "compile",
          "--package",
          "missing.neutron",
          "--wasm-out",
          "out.wasm",
          "--candid-out",
          "out.did",
          "--vetkeys-environment",
          "test_key_1",
        ],
        output.logger,
      )
    ).exitCode,
  ).toBe(1);
  expect(output.errors.join("\n")).toContain(
    "vetKeys environment must be production",
  );

  const local = capture();
  expect(
    (
      await main(
        [
          "compile",
          "--package",
          "missing.neutron",
          "--wasm-out",
          "out.wasm",
          "--candid-out",
          "out.did",
          "--vetkeys-environment",
          "local",
        ],
        local.logger,
      )
    ).exitCode,
  ).toBe(1);
  expect(local.errors.join("\n")).toContain(
    "requires verified PocketIC installation context; use neutron-provision",
  );
});

test("compile preserves the exact v25 contract for a released Kernel and app set", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "neutron-cli-v25-"));
  try {
    const output = capture();
    const wasmPath = path.join(directory, "neutron.wasm");
    const candidPath = path.join(directory, "neutron.did");
    const result = await main(
      [
        "compile",
        "--package",
        path.resolve(
          import.meta.dir,
          "../../neutron-compiler/test/fixtures/kernel.v0.3.15.neutron",
        ),
        "--package",
        path.resolve(import.meta.dir, "../../../apps/hello/hello.v0.2.1.neutron"),
        "--wasm-out",
        wasmPath,
        "--candid-out",
        candidPath,
      ],
      output.logger,
    );

    expect(result.exitCode).toBe(0);
    expect(output.errors).toEqual([]);
    expect(output.logs).toContain("Assembler: neutron_actor_v25");
    expect((await readFile(wasmPath)).byteLength).toBeGreaterThan(0);
    expect((await readFile(candidPath, "utf8"))).toContain("service");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
