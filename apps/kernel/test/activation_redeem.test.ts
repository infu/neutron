import { expect, test } from "bun:test";
import { redeemActivation } from "../src/reducer/activation.ts";

const token = new Uint8Array(32);

test("accepts a committed activation result", async () => {
  let calls = 0;
  const result = await redeemActivation(
    {
      kernel_activation: async () => {
        calls += 1;
        return { authorized: null };
      },
      kernel_check_authorized: async () => false,
    },
    token,
  );
  expect(result).toEqual({ authorized: true });
  expect(calls).toBe(1);
});

test("confirms a lost activation response without replaying the bearer", async () => {
  let calls = 0;
  const result = await redeemActivation(
    {
      kernel_activation: async () => {
        calls += 1;
        throw new Error("response lost");
      },
      kernel_check_authorized: async () => true,
    },
    token,
  );
  expect(result).toEqual({ authorized: true });
  expect(calls).toBe(1);
});

test("reports an already-consumed activation", async () => {
  const result = await redeemActivation(
    {
      kernel_activation: async () => ({ already_activated: null }),
      kernel_check_authorized: async () => false,
    },
    token,
  );
  expect(result.authorized).toBe(false);
  if (result.authorized) throw new Error("expected failure");
  expect(result.message).toMatch(/already used/i);
});
