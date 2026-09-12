import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { CONTRACT } from "../src/protocol.ts";
import { makeTransport, type QueryAgent } from "../src/transport.ts";
import type { Kernel } from "../src/store_state.ts";
import { PROTOCOL_CANISTER } from "../src/config.ts";

test("signed query transport bypasses app updates and decodes protocol integers exactly", async () => {
  const queries: unknown[] = [];
  const calls: unknown[] = [];
  const agent = { query: async (principal: Principal, input: { methodName: string; arg: ArrayBuffer }) => {
    queries.push({ principal: principal.toText(), input });
    expect(IDL.decode(CONTRACT.session!.args, input.arg)).toEqual([]);
    return { status: "replied", reply: { arg: IDL.encode(CONTRACT.session!.returns, [{ ok: { neutron: Principal.fromText(PROTOCOL_CANISTER), moderator: true, unreadReplies: 9007199254740993n } }]) } };
  } } as unknown as QueryAgent;
  const kernel = { updateSelf: async (...args: unknown[]) => { calls.push(args); } } as unknown as Kernel;
  const transport = makeTransport({ kernel, agent });
  const result = await transport.query<{ ok: { unreadReplies: bigint } }>("session");
  expect(result.ok.unreadReplies).toBe(9007199254740993n);
  expect(queries).toHaveLength(1); expect(calls).toHaveLength(0);
});

test("updates preserve Candid bytes and use only the invocation's pinned zero-cycle broker", async () => {
  let broker: unknown[] | undefined;
  const browser = Principal.selfAuthenticating(new Uint8Array(32).fill(17));
  const kernel = { updateSelf: async (...args: unknown[]) => {
    broker = args;
    return { ok: new Uint8Array(IDL.encode(CONTRACT.read_delegate_set!.returns, [{ ok: null }])) };
  } } as unknown as Kernel;
  const transport = makeTransport({ kernel, agent: {} as QueryAgent });
  expect(await transport.update("read_delegate_set", [{ browser }])).toEqual({ ok: null });
  expect(broker![0]).toBe("feedback_call"); expect(broker![2]).toBe(0);
  const call = (broker![1] as { method: string; args: Uint8Array }[])[0]!;
  expect(Object.keys(call).sort()).toEqual(["args", "method"]);
  expect(call.method).toBe("read_delegate_set");
  const decoded = IDL.decode(CONTRACT.read_delegate_set!.args, call.args)[0] as { browser: Principal };
  expect(decoded.browser.toText()).toBe(browser.toText());
});

test("query/update confusion and unknown/admin calls fail before any transport", async () => {
  const transport = makeTransport({ kernel: {} as Kernel, agent: {} as QueryAgent });
  await expect(transport.update("session", [])).rejects.toThrow("as a write");
  await expect(transport.query("thread_create", [])).rejects.toThrow("as a read");
  await expect(transport.update("moderator_set", [])).rejects.toThrow("does not expose");
});

test("protocol rejection and broker permission failures remain readable", async () => {
  const query = makeTransport({ kernel: {} as Kernel, agent: { query: async () => ({ status: "rejected", reject_message: "Protocol unavailable" }) } as unknown as QueryAgent });
  await expect(query.query("session")).rejects.toThrow("Protocol unavailable");
  const update = makeTransport({ kernel: { updateSelf: async () => ({ err: "permission_denied: Feedback update access is unavailable" }) } as unknown as Kernel, agent: {} as QueryAgent });
  await expect(update.update("read_delegate_set", [{ browser: Principal.fromText(PROTOCOL_CANISTER) }])).rejects.toThrow("Feedback update access is unavailable");
});
