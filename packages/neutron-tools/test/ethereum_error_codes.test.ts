import { expect, test } from "bun:test";
import { serializeError, toError } from "../src/protocol.ts";

for (const code of [4001, 4100, 4902, -32603]) test(`Ethereum/RPC error ${code} survives the Kernel error round trip`, () => {
  const original = Object.assign(new Error("Wallet declined or could not complete the request"), { code });
  const wire = serializeError(original);
  expect(wire).toMatchObject({ code, message: original.message });
  const restored = toError(wire) as Error & { code: unknown };
  expect(restored.code).toBe(code);
  expect(restored.message).toBe(original.message);
  // Plain JSON errors returned by a provider also reach the app unchanged.
  expect((toError({ code, message: original.message }) as Error & { code: unknown }).code).toBe(code);
});

test("string policy codes retain their existing transport semantics", () => {
  const restored = toError(serializeError(Object.assign(new Error("Owner approval required"), { code: "OWNER_REQUIRED" }))) as Error & { code: unknown };
  expect(restored.code).toBe("OWNER_REQUIRED");
});

for (const code of [NaN, Infinity, -Infinity, 4001.5, Number.MAX_SAFE_INTEGER + 1]) test(`invalid numeric error code ${String(code)} is not retained`, () => {
  const wire = serializeError(Object.assign(new Error("Invalid provider error"), { code }));
  expect(Object.hasOwn(wire as object, "code")).toBe(false);
  expect(Object.hasOwn(toError({ code, message: "Invalid provider error" }), "code")).toBe(false);
});
