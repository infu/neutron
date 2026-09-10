import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { makeTransport, type QueryAgent } from "../src/transport.ts";
import type { Kernel } from "../src/store.ts";

test("queries bypass Neutron and every mutation uses its cycle-attaching relay", async () => {
  const calls: unknown[][] = [];
  let directQueries = 0;
  const transport = makeTransport({
    canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    contract: { list: { args: [], returns: [IDL.Text] }, purchase: { args: [IDL.Nat], returns: [IDL.Text], update: true } },
    agent: { query: async () => { directQueries++; return { status: "replied", reply: { arg: IDL.encode([IDL.Text], ["catalog"]) } }; } } as unknown as QueryAgent,
    kernel: { updateSelf: async (...args: unknown[]) => { calls.push(args); return new Uint8Array(IDL.encode([IDL.Text], ["accepted"])); } } as unknown as Kernel,
  });
  expect(await transport.query("list")).toBe("catalog");
  expect(calls).toHaveLength(0);
  expect(await transport.update("purchase", [7n], 25000000n)).toBe("accepted");
  expect(directQueries).toBe(1);
  expect(calls[0]?.[0]).toBe("marketplace_call");
  expect((calls[0]?.[1] as Array<Record<string, unknown>>)[0]?.cycles).toBe("25000000");
  await expect(transport.query("purchase", [7n])).rejects.toThrow("read");
  await expect(transport.update("list", [], 0n)).rejects.toThrow("write");
});
