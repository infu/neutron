import { afterAll, expect, test } from "bun:test";
import {
  SELF_CALL_BINARY_MAX_COUNT,
  callCanisterDialog,
  callSelfDialog,
  decodeSelfCallValue,
  disconnectMsgBus,
  encodeSelfCallValues,
  exposeTool,
  installMessageListener,
  requestBackendCallReservations,
  updateSelf,
} from "../src/app.ts";

const originalWindow = globalThis.window;
const canisterId = "4caro-hl777-77775-aaaba-cai";
const kernelOrigin = `https://${canisterId}.icp0.io`;
const appHref =
  `https://ahelloa--${canisterId}.icp0.io/app/hello/index.html`;

function installFakeWindow(): {
  dispatch(port: MessagePort): void;
} {
  const parent = {};
  const listeners: Array<(event: MessageEvent) => void> = [];
  const fake = {
    parent,
    origin: "null",
    location: { href: appHref },
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === "message") listeners.push(listener);
    },
    dispatch(port: MessagePort) {
      for (const listener of listeners) {
        listener({
          source: parent,
          origin: kernelOrigin,
          data: {
            type: "neutron:msgbus:connect",
            version: 1,
            sessionId: "0123456789abcdef0123456789abcdef",
          },
          ports: [port],
        } as unknown as MessageEvent);
      }
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fake,
  });
  installMessageListener(fake as unknown as Window);
  return fake;
}

afterAll(() => {
  disconnectMsgBus();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

test("querySelf/updateSelf snapshot nested binary leaves on the private port", async () => {
  const fake = installFakeWindow();
  const channel = new MessageChannel();
  const first = Uint8Array.from([1, 2, 3]);
  const second = Uint8Array.from([4, 5]);

  channel.port2.addEventListener("message", (event) => {
    const message = event.data as Record<string, any>;
    if (message.type !== "neutron:self-call:exec") return;
    expect(message).toMatchObject({
      version: 1,
      tool: "canister.update_self",
      method: "store",
      args: [{ content: null, nested: [{ body: null }] }],
    });
    expect(message.context).toBeUndefined();
    expect(message.blobs.map((blob: any) => blob.path)).toEqual([
      [0, "content"],
      [0, "nested", 0, "body"],
    ]);
    expect([...new Uint8Array(message.blobs[0].data)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(message.blobs[1].data)]).toEqual([4, 5]);

    const reply = Uint8Array.from([7, 8, 9]).buffer;
    channel.port2.postMessage(
      {
        type: "neutron:self-call:response",
        version: 1,
        id: message.id,
        ok: { receipt: null },
        blobs: [
          {
            path: ["receipt"],
            byteLength: 3,
            data: reply,
          },
        ],
      },
      [reply],
    );
  });
  channel.port2.start();
  fake.dispatch(channel.port1);

  const pending = updateSelf<{ receipt: Uint8Array }>("store", [
    { content: first, nested: [{ body: second }] },
  ]);
  first.fill(99);
  second.fill(88);
  const result = await pending;
  expect([...result.receipt]).toEqual([7, 8, 9]);
  expect(first.byteLength).toBe(3);
  expect(second.byteLength).toBe(2);
  channel.port2.close();
});

test("callSelfDialog sends exact nested binary snapshots and reconstructs its response", async () => {
  const fake = installFakeWindow();
  const channel = new MessageChannel();
  const left = Uint8Array.from([10, 20, 30]);
  const right = Uint8Array.from([40, 50]);

  channel.port2.addEventListener("message", (event) => {
    const message = event.data as Record<string, any>;
    if (message.type !== "neutron:self-call:exec") return;
    expect(message).toMatchObject({
      version: 1,
      tool: "canister.call_dialog",
      method: "store_with_consent",
      args: [
        {
          attachments: [
            { name: "left", bytes: null },
            { name: "right", bytes: null },
          ],
        },
      ],
    });
    expect(message.context).toBeUndefined();
    expect(message.blobs.map((blob: any) => blob.path)).toEqual([
      [0, "attachments", 0, "bytes"],
      [0, "attachments", 1, "bytes"],
    ]);
    expect(
      message.blobs.map((blob: any) => ({
        byteLength: blob.byteLength,
        data: [...new Uint8Array(blob.data)],
      })),
    ).toEqual([
      { byteLength: 3, data: [10, 20, 30] },
      { byteLength: 2, data: [40, 50] },
    ]);

    const firstReceipt = Uint8Array.from([60, 70]).buffer;
    const secondReceipt = Uint8Array.from([80]).buffer;
    channel.port2.postMessage(
      {
        type: "neutron:self-call:response",
        version: 1,
        id: message.id,
        ok: {
          receipt: {
            chunks: [null, null],
          },
        },
        blobs: [
          {
            path: ["receipt", "chunks", 0],
            byteLength: 2,
            data: firstReceipt,
          },
          {
            path: ["receipt", "chunks", 1],
            byteLength: 1,
            data: secondReceipt,
          },
        ],
      },
      [firstReceipt, secondReceipt],
    );
  });
  channel.port2.start();
  fake.dispatch(channel.port1);

  const pending = callSelfDialog<{
    receipt: { chunks: Uint8Array[] };
  }>("store_with_consent", [
    {
      attachments: [
        { name: "left", bytes: left },
        { name: "right", bytes: right },
      ],
    },
  ]);
  left.fill(99);
  right.fill(88);

  const result = await pending;
  expect(result.receipt.chunks.map((chunk) => [...chunk])).toEqual([
    [60, 70],
    [80],
  ]);
  channel.port2.close();
});

test("callCanisterDialog routes this Neutron through attachment-aware API1", async () => {
  const fake = installFakeWindow();
  const channel = new MessageChannel();
  const left = Uint8Array.from([1, 2]);
  const right = Uint8Array.from([3, 4, 5]);

  channel.port2.addEventListener("message", (event) => {
    const message = event.data as Record<string, any>;
    expect(message.type).toBe("neutron:self-call:exec");
    expect(message).toMatchObject({
      version: 1,
      tool: "canister.call_dialog",
      method: "save",
      args: [{ nested: { left: null }, repeated: [null] }],
    });
    expect(message.blobs.map((blob: any) => blob.path)).toEqual([
      [0, "nested", "left"],
      [0, "repeated", 0],
    ]);
    channel.port2.postMessage({
      type: "neutron:self-call:response",
      version: 1,
      id: message.id,
      ok: { saved: true },
      blobs: [],
    });
  });
  channel.port2.start();
  fake.dispatch(channel.port1);

  await expect(
    callCanisterDialog<{ saved: boolean }>({
      canister: canisterId,
      method: "save",
      args: [{ nested: { left }, repeated: [right] }],
    }),
  ).resolves.toEqual({ saved: true });
  channel.port2.close();
});

test("backend post-grant calls carry nested and repeated blobs on API1", async () => {
  const fake = installFakeWindow();
  const channel = new MessageChannel();
  const avatar = Uint8Array.from([9, 8, 7]);
  const first = Uint8Array.from([6, 5]);
  const second = Uint8Array.from([4]);

  channel.port2.addEventListener("message", (event) => {
    const message = event.data as Record<string, any>;
    expect(message.type).toBe("neutron:self-call:exec");
    expect(message).toMatchObject({
      version: 1,
      tool: "backend_calls.request",
      method: "configure",
      actions: [
        {
          kind: "reserve",
          scope: {
            kind: "method",
            method: "deliver",
          },
        },
      ],
      args: [
        {
          profile: { avatar: null },
          attachments: [null, null],
        },
      ],
    });
    expect(message.blobs.map((blob: any) => blob.path)).toEqual([
      [0, "profile", "avatar"],
      [0, "attachments", 0],
      [0, "attachments", 1],
    ]);
    expect(
      message.blobs.map((blob: any) => [...new Uint8Array(blob.data)]),
    ).toEqual([[9, 8, 7], [6, 5], [4]]);

    const receiptOne = Uint8Array.from([10, 11]).buffer;
    const receiptTwo = Uint8Array.from([12]).buffer;
    channel.port2.postMessage(
      {
        type: "neutron:self-call:response",
        version: 1,
        id: message.id,
        ok: {
          reservations: [],
          callResult: { receipts: [null, null] },
        },
        blobs: [
          {
            path: ["callResult", "receipts", 0],
            byteLength: 2,
            data: receiptOne,
          },
          {
            path: ["callResult", "receipts", 1],
            byteLength: 1,
            data: receiptTwo,
          },
        ],
      },
      [receiptOne, receiptTwo],
    );
  });
  channel.port2.start();
  fake.dispatch(channel.port1);

  const pending = requestBackendCallReservations<{
    reservations: [];
    callResult: { receipts: Uint8Array[] };
  }>({
    actions: [
      {
        kind: "reserve",
        scope: { kind: "method", method: "deliver" },
      },
    ],
    call: {
      method: "configure",
      args: [
        {
          profile: { avatar },
          attachments: [first, second],
        },
      ],
    },
  });
  avatar.fill(0);
  first.fill(0);
  second.fill(0);
  const result = await pending;
  expect(result.callResult.receipts.map((bytes) => [...bytes])).toEqual([
    [10, 11],
    [12],
  ]);
  channel.port2.close();
});

test("scoped kernel self calls carry hidden invocation metadata", async () => {
  const fake = installFakeWindow();
  const channel = new MessageChannel();
  const invocation = {
    id: "invocation-id-000000000001",
    rootId: "invocation-root-000000001",
    capability: "c".repeat(48),
  };
  exposeTool(
    "test.scoped_self_call",
    {
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
    },
    async (_args, context) => {
      const stored = await context.kernel.updateSelf<{ stored: boolean }>(
        "store",
        [{ left: new Uint8Array([1]), right: new Uint8Array([2, 3]) }],
      );
      return { stored: stored.stored };
    },
  );

  const finalResponse = new Promise<Record<string, unknown>>(
    (resolve, reject) => {
      channel.port2.addEventListener("message", (event) => {
        const message = event.data as Record<string, any>;
        if (message.type === "neutron:self-call:exec") {
          try {
            expect(message.context).toEqual({ invocation });
            expect(message.args).toEqual([
              { left: null, right: null },
            ]);
            expect(message.blobs.map((blob: any) => blob.path)).toEqual([
              [0, "left"],
              [0, "right"],
            ]);
            channel.port2.postMessage({
              type: "neutron:self-call:response",
              version: 1,
              id: message.id,
              ok: { stored: true },
              blobs: [],
            });
          } catch (error) {
            reject(error);
          }
          return;
        }
        if (message.type === "response" && message.id === 900) {
          resolve(message);
        }
      });
    },
  );
  channel.port2.start();
  fake.dispatch(channel.port1);
  channel.port2.postMessage({
    type: "exec",
    id: 900,
    payload: {
      action: "__neutron_msgbus_tools_call",
      payload: {
        name: "test.scoped_self_call",
        arguments: {},
      },
      context: { invocation },
    },
  });

  await expect(finalResponse).resolves.toMatchObject({
    type: "response",
    id: 900,
    ok: { stored: true },
  });
  channel.port2.close();
});

test("binary leaf count is 512 per direction and supports zero-byte leaves", () => {
  const accepted = Array.from(
    { length: SELF_CALL_BINARY_MAX_COUNT },
    () => new Uint8Array(0),
  );
  const encoded = encodeSelfCallValues(accepted);
  expect(encoded.blobs).toHaveLength(512);
  expect(encoded.blobs.every(({ byteLength }) => byteLength === 0)).toBe(true);

  expect(() =>
    encodeSelfCallValues([...accepted, new Uint8Array(0)]),
  ).toThrow(/binary field count/);
});

test("self-call encoder rejects accessors and decoder rejects unbound blobs", () => {
  let getterRan = false;
  const array: unknown[] = [];
  Object.defineProperty(array, "0", {
    enumerable: true,
    configurable: true,
    get() {
      getterRan = true;
      return new Uint8Array([1]);
    },
  });
  array.length = 1;
  expect(() => encodeSelfCallValues(array as never)).toThrow(/data properties/);
  expect(getterRan).toBe(false);

  expect(() =>
    decodeSelfCallValue(null, [
      { path: ["missing"], byteLength: 0, data: new ArrayBuffer(0) },
    ]),
  ).toThrow(/unbound binary field/);
});
