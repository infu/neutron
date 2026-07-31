import { afterAll, expect, test } from "bun:test";
import {
  callToolWithAttachments,
  installAttachmentWindowListener,
} from "../src/app_attachments.ts";

const originalWindow = globalThis.window;
const canisterId = "4caro-hl777-77775-aaaba-cai";
const kernelOrigin = `https://${canisterId}.icp0.io`;
const appHref =
  `https://ahello--${canisterId}.icp0.io/app/hello/index.html`;

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
  installAttachmentWindowListener();
  return fake;
}

afterAll(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

test("generic cross-app attachment transport remains available", async () => {
  const fake = installFakeWindow();
  const channel = new MessageChannel();
  channel.port2.addEventListener("message", (event) => {
    const message = event.data as Record<string, any>;
    if (message.type !== "neutron:msgbus:attachment:exec") return;
    expect(message.payload).toMatchObject({
      action: "tools.call",
      payload: {
        target: "app:files:background",
        name: "files.receive",
        arguments: { name: "note.txt" },
      },
    });
    expect(message.attachments).toHaveLength(1);
    expect([...new Uint8Array(message.attachments[0].data)]).toEqual([
      1, 2, 3, 4,
    ]);
    const reply = Uint8Array.from([9, 8]).buffer;
    channel.port2.postMessage(
      {
        type: "neutron:msgbus:attachment:response",
        version: 1,
        id: message.id,
        ok: { stored: true },
        attachments: [
          {
            name: "receipt",
            mediaType: "application/octet-stream",
            byteLength: 2,
            data: reply,
          },
        ],
      },
      [reply],
    );
  });
  channel.port2.start();
  fake.dispatch(channel.port1);

  const input = Uint8Array.from([1, 2, 3, 4]).buffer;
  const result = await callToolWithAttachments(
    {
      target: "app:files:background",
      name: "files.receive",
      arguments: { name: "note.txt" },
    },
    [
      {
        name: "body",
        mediaType: "application/octet-stream",
        byteLength: 4,
        data: input,
      },
    ],
    { timeoutSeconds: 1 },
  );
  expect(result.value).toEqual({ stored: true });
  expect([...new Uint8Array(result.attachments[0]!.data)]).toEqual([9, 8]);
  channel.port2.close();
});
