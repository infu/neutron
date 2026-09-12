import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { completeIntent, listIntents, loadIntent, parseState, readIdentity, saveIntent, type Kernel } from "../src/store_state.ts";
import { makeTransport, type QueryAgent } from "../src/transport.ts";
import { CONTRACT } from "../src/protocol.ts";
import { blobResultType, draftPageType, draftType, kernelBoundary, stateResultType, stateType, textResultType } from "./kernel_boundary.ts";

const owner = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
const seed = new Uint8Array(32).fill(29);

test("fresh Kernel self-call omits seed and Feedback initializes without rejecting that valid state", async () => {
  const fresh = kernelBoundary(stateType, { owner, seed: [] });
  expect(fresh).toEqual({ owner: owner.toText() });
  expect(parseState(fresh)).toEqual({ owner: owner.toText(), seed: null });
  let stored: Uint8Array | null = null;
  let writes = 0;
  const kernel = {
    querySelf: async () => kernelBoundary(stateType, { owner, seed: stored ? [stored] : [] }),
    updateSelf: async (method: string, args: unknown[]) => {
      expect(method).toBe("feedback_initialize"); writes += 1;
      stored ??= new Uint8Array(args[0] as Uint8Array);
      return kernelBoundary(stateResultType, { ok: { owner, seed: [stored] } });
    },
  } as unknown as Kernel;
  const initialized = await readIdentity(kernel);
  expect(writes).toBe(1); expect(stored?.length).toBe(32);
  expect(initialized.state.seed).toEqual(stored);
  expect(initialized.identity.getPrincipal().toText()).toBe(Ed25519KeyIdentity.generate(stored!).getPrincipal().toText());
  await readIdentity(kernel);
  expect(writes).toBe(1);
});

test("existing managed-memory seed survives the real opt-blob sidecar without initialization", async () => {
  let writes = 0;
  const boundary = kernelBoundary(stateType, { owner, seed: [seed] });
  expect(boundary).toEqual({ owner: owner.toText(), seed });
  const kernel = { querySelf: async () => boundary, updateSelf: async () => { writes += 1; throw new Error("Must not replace an existing seed"); } } as unknown as Kernel;
  const restored = await readIdentity(kernel);
  expect(restored.identity.getPrincipal().toText()).toBe(Ed25519KeyIdentity.generate(seed).getPrincipal().toText());
  expect(restored.state.seed).toEqual(seed); expect(writes).toBe(0);
});

test("a malformed existing seed remains an error and is never silently regenerated", async () => {
  let writes = 0;
  const kernel = { querySelf: async () => kernelBoundary(stateType, { owner, seed: [new Uint8Array(31)] }), updateSelf: async () => { writes += 1; } } as unknown as Kernel;
  await expect(readIdentity(kernel)).rejects.toThrow("preserved");
  expect(writes).toBe(0);
});

test("saved request lookup handles direct opt blobs and absent top-level options", async () => {
  const value = { method: "reply", args: { requestId: "once", threadId: "1", body: "Original text" } };
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const kernel = { querySelf: async (_method: string, args: unknown[]) => kernelBoundary(draftType, args[0] === "request:once" ? [bytes] : []) } as unknown as Kernel;
  expect(await loadIntent(kernel, "once")).toEqual(value);
  expect(await loadIntent(kernel, "missing")).toBeNull();
});

test("saved request pagination accepts omitted final-page nextCursor and present direct text", async () => {
  const value = { method: "thread_create", args: { requestId: "once", kind: "feedback", title: "A thought", body: "Original text", appId: null } };
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const pages = [
    { items: [{ id: "request:once", value: bytes }], nextCursor: ["request:once"] },
    { items: [], nextCursor: [] },
  ];
  const kernel = { querySelf: async () => kernelBoundary(draftPageType, pages.shift()) } as unknown as Kernel;
  expect(await listIntents(kernel)).toEqual({ items: [{ id: "request:once", value }], nextCursor: "request:once" });
  expect(kernelBoundary(draftPageType, { items: [], nextCursor: [] })).toEqual({ items: [] });
  expect(await listIntents(kernel, "request:once")).toEqual({ items: [], nextCursor: null });
});

test("saved request writes handle Kernel-unwrapped success values and retain their exact bytes", async () => {
  const writes: { method: string; value: Uint8Array }[] = [];
  const kernel = { updateSelf: async (method: string, args: unknown[]) => {
    const input = args[0] as { id: string; value: Uint8Array };
    writes.push({ method, value: input.value });
    return kernelBoundary(textResultType, { ok: input.id });
  } } as unknown as Kernel;
  const args = { requestId: "once", body: "The exact original body" };
  await saveIntent(kernel, "once", "reply", args);
  await completeIntent(kernel, "once", "reply", args);
  expect(writes.map(write => write.method)).toEqual(["feedback_save_draft", "feedback_complete_draft"]);
  expect(writes[0]!.value).toEqual(writes[1]!.value);
});

test("protocol broker unwraps its Result blob through the real Kernel boundary before Candid decoding", async () => {
  const protocolReply = new Uint8Array(IDL.encode(CONTRACT.read_delegate_set!.returns, [{ ok: null }]));
  const kernel = { updateSelf: async () => kernelBoundary(blobResultType, { ok: protocolReply }) } as unknown as Kernel;
  const transport = makeTransport({ kernel, agent: {} as QueryAgent });
  expect(await transport.update("read_delegate_set", [{ browser: Ed25519KeyIdentity.generate(seed).getPrincipal() }])).toEqual({ ok: null });
});
