import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { makeTransport, UPDATE_METHODS, type QueryAgent } from "../src/transport.ts";
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

const canisterId = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const grant = (method: string, principal = canisterId) => ({ scopeKind: "exact", principal, method });
const allGrants = () => ({ reservations: UPDATE_METHODS.map(method => grant(method)) });

test("existing exact access needs only a context-scoped read and no consent request", async () => {
  const calls: unknown[] = [];
  let requests = 0;
  const transport = makeTransport({ canisterId, agent: {} as QueryAgent, contract: {},
    kernel: { callTool: async (call: unknown) => { calls.push(call); return allGrants(); } } as unknown as Kernel,
    requestReservations: async () => { requests++; throw new Error("Existing access must not prompt again"); },
  });
  await transport.reserve();
  await transport.reserve();
  expect(UPDATE_METHODS).toHaveLength(15);
  expect(calls).toEqual(Array.from({ length: 2 }, () => ({ target: "kernel", name: "backend_calls.list", arguments: {} })));
  expect(requests).toBe(0);
});

test("reserve requests only missing exact methods and keeps unrelated grants", async () => {
  let reservations = [
    ...UPDATE_METHODS.slice(0, 12).map(method => grant(method)),
    grant(UPDATE_METHODS[12], "aaaaa-aa"),
    grant("other_method"),
    { scopeKind: "principal", principal: "aaaaa-aa" },
    { scopeKind: "method", method: "other_method" },
  ];
  const requests: unknown[] = [];
  const kernel = { callTool: async () => ({ reservations }) } as unknown as Kernel;
  const transport = makeTransport({ canisterId, agent: {} as QueryAgent, contract: {}, kernel,
    requestReservations: async (actualKernel, request) => {
      expect(actualKernel).toBe(kernel);
      requests.push(request);
      reservations = [...reservations, ...UPDATE_METHODS.slice(12).map(method => grant(method))];
      return { reservations };
    },
  });
  await transport.reserve();
  expect(requests).toEqual([{ actions: UPDATE_METHODS.slice(12).map(method => ({ kind: "reserve", scope: { kind: "exact", principal: canisterId, method } })) }]);
  await transport.reserve();
  expect(requests).toHaveLength(1);
  expect(reservations).toContainEqual(grant("other_method"));
});

test("a revoked exact grant is requested again after a fresh snapshot", async () => {
  let reservations = allGrants().reservations;
  const requests: unknown[] = [];
  const transport = makeTransport({ canisterId, agent: {} as QueryAgent, contract: {},
    kernel: { callTool: async () => ({ reservations }) } as unknown as Kernel,
    requestReservations: async (_kernel, request) => { requests.push(request); reservations = allGrants().reservations; return { reservations }; },
  });
  await transport.reserve();
  expect(requests).toEqual([]);
  reservations = reservations.filter(row => row.method !== "purchase");
  await transport.reserve();
  expect(requests).toEqual([{ actions: [{ kind: "reserve", scope: { kind: "exact", principal: canisterId, method: "purchase" } }] }]);
});

for (const value of [null, {}, { error: "list unavailable" }, { reservations: null }, { reservations: [null] }, { reservations: [{ scopeKind: "exact", principal: canisterId }] }, { reservations: [{ scopeKind: "exact", principal: canisterId, method: "" }] }, { reservations: [{ scopeKind: "unknown" }] }, { reservations: [...allGrants().reservations, {}] }]) {
  test(`malformed access snapshot is not treated as a grant: ${JSON.stringify(value)}`, async () => {
    let requested = false;
    const transport = makeTransport({ canisterId, agent: {} as QueryAgent, contract: {},
      kernel: { callTool: async () => value } as unknown as Kernel,
      requestReservations: async () => { requested = true; return allGrants(); },
    });
    await expect(transport.reserve()).rejects.toThrow("backend access is unavailable");
    expect(requested).toBe(false);
  });
}

test("access listing failure propagates without opening consent", async () => {
  let requested = false;
  const transport = makeTransport({ canisterId, agent: {} as QueryAgent, contract: {},
    kernel: { callTool: async () => { throw new Error("Neutron unavailable"); } } as unknown as Kernel,
    requestReservations: async () => { requested = true; return allGrants(); },
  });
  await expect(transport.reserve()).rejects.toThrow("Neutron unavailable");
  expect(requested).toBe(false);
});

test("declined access is not cached as granted and can be retried", async () => {
  let requests = 0, reads = 0;
  const transport = makeTransport({ canisterId, agent: {} as QueryAgent, contract: {},
    kernel: { callTool: async () => { reads++; return { reservations: [] }; } } as unknown as Kernel,
    requestReservations: async () => { requests++; if (requests === 1) throw new Error("Access declined"); return allGrants(); },
  });
  await expect(transport.reserve()).rejects.toThrow("Access declined");
  await transport.reserve();
  expect(requests).toBe(2);
  expect(reads).toBe(2);
});

for (const reply of [{ error: "Access declined" }, { reservations: [] }]) {
  test(`an unconfirmed access request does not complete setup: ${JSON.stringify(reply)}`, async () => {
    const transport = makeTransport({ canisterId, agent: {} as QueryAgent, contract: {},
      kernel: { callTool: async () => ({ reservations: [] }) } as unknown as Kernel,
      requestReservations: async () => reply,
    });
    await expect(transport.reserve()).rejects.toThrow("backend access");
  });
}
