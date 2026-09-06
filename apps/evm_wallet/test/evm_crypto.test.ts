import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

test("authoritative Motoko EVM cryptography matches independent vectors and rejects malformed requests", async () => {
  const result = await promisify(execFile)(process.execPath, [path.join(import.meta.dir, "evm_crypto_run.ts")], { cwd: path.join(import.meta.dir, ".."), maxBuffer: 4 * 1024 * 1024 });
  expect(result.stdout).toContain("EVM Motoko test passed: evm_crypto_protocol_test.mo");
  expect(result.stdout).toContain("EVM Motoko test passed: evm_crypto_secp_test.mo");
  expect(result.stdout).toContain("EVM Motoko test passed: evm_crypto_eip712_test.mo");
}, 180_000);
