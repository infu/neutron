import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { MessageChannel } from "node:worker_threads";
import { unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import {
  normalizeToolDescriptor,
  type MsgBusToolDescriptor,
} from "neutron-tools/app";
import {
  WALLET_FUNDING_TOOL,
  handleWalletFunding,
  walletFundingInputSchema,
  walletFundingOutputSchema,
} from "../src/funding.ts";

const RELEASED_WALLET_V032 = new URL(
  "../wallet.v0.3.2.neutron",
  import.meta.url,
);
const RELEASED_WALLET_V032_BYTES = 575_530;
const RELEASED_WALLET_V032_SHA256 =
  "830e8cb4e59bcb73deed3024f704c373f6cce744ccf850efea65eac74b545b43";
const RELEASED_WALLET_V036 = new URL(
  "../wallet.v0.3.6.neutron",
  import.meta.url,
);
const RELEASED_WALLET_V036_BYTES = 666_413;
const RELEASED_WALLET_V036_SHA256 =
  "bea0d49e351bb8efa04bf03057b4f9175474a54bd198b382add790718b7b8aae";
const RELEASED_WALLET_V037 = new URL(
  "../wallet.v0.3.7.neutron",
  import.meta.url,
);
const RELEASED_WALLET_V037_BYTES = 677_271;
const RELEASED_WALLET_V037_SHA256 =
  "20ba3b00349e9386713a789622ce6a570fc7123e7daf89cda38daedcfc74fac1";

const decoder = new TextDecoder();

test("released Wallet 0.3.2 cannot expose successor provider funding", async () => {
  const archive = await readFile(RELEASED_WALLET_V032);
  expect(archive.byteLength).toBe(RELEASED_WALLET_V032_BYTES);
  expect(createHash("sha256").update(archive).digest("hex")).toBe(
    RELEASED_WALLET_V032_SHA256,
  );

  const unpacked = unpackNeutronPackage(new Uint8Array(archive));
  const manifest = decodeJson(unpacked["neutron.json"], "manifest") as {
    version?: unknown;
    func?: Record<string, unknown>;
    memory?: Record<string, unknown>;
    capabilities?: {
      preapproved_self_calls?: { methods?: unknown };
    };
  };
  const service = decodeText(unpacked["web/service.js"], "resident service");

  expect(manifest.version).toBe(302);
  expect(Object.keys(manifest.memory ?? {})).toEqual(["wallet"]);
  expect(manifest.func).not.toHaveProperty("wallet_funding_prepare_v1");
  expect(manifest.func).not.toHaveProperty("wallet_funding_execute_v1");
  expect(manifest.func).not.toHaveProperty("wallet_allowances_page_v1");
  expect(manifest.capabilities?.preapproved_self_calls?.methods).not.toContain(
    "wallet_transfer",
  );
  expect(service).not.toContain("wallet_fund_v1");
  expect(service).not.toContain("provider_once");
  expect(service).not.toContain("provider_approval.request");
});

test("released Wallet 0.3.6 keeps the legacy provider contract accepted by the successor", async () => {
  const archive = await readFile(RELEASED_WALLET_V036);
  expect(archive.byteLength).toBe(RELEASED_WALLET_V036_BYTES);
  expect(createHash("sha256").update(archive).digest("hex")).toBe(
    RELEASED_WALLET_V036_SHA256,
  );

  const unpacked = unpackNeutronPackage(new Uint8Array(archive));
  const manifest = decodeJson(unpacked["neutron.json"], "manifest") as {
    version?: unknown;
  };
  const service = decodeText(unpacked["web/service.js"], "resident service");
  expect(manifest.version).toBe(306);
  expect(service).toContain("wallet_fund_v1");
  expect(service).toContain("provider_approval.request");
  expect(service).toContain(
    '"neutron:audit":"metadata_only","neutron:consent":"provider_once","neutron:effects":["write","network","user_visible_ui"]',
  );
  expect(
    normalizeToolDescriptor({
      name: "wallet_fund_v1",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
      annotations: {
        "neutron:audit": "metadata_only",
        "neutron:consent": "provider_once",
        "neutron:effects": ["write", "network", "user_visible_ui"],
      },
    }).annotations,
  ).toMatchObject({ "neutron:consent": "provider_once" });
});

test("successor preserves the exact released Wallet 0.3.7 public funding descriptor", async () => {
  const archive = await readFile(RELEASED_WALLET_V037);
  expect(archive.byteLength).toBe(RELEASED_WALLET_V037_BYTES);
  expect(createHash("sha256").update(archive).digest("hex")).toBe(
    RELEASED_WALLET_V037_SHA256,
  );

  const unpacked = unpackNeutronPackage(new Uint8Array(archive));
  const manifest = decodeJson(unpacked["neutron.json"], "manifest") as {
    version?: unknown;
  };
  expect(manifest.version).toBe(307);

  const releasedDescriptor = (
    await listReleasedTools(
      decodeText(unpacked["web/service.js"], "resident service"),
    )
  ).find(({ name }) => name === WALLET_FUNDING_TOOL);
  if (releasedDescriptor === undefined) {
    throw new Error("Released Wallet is missing wallet_fund_v1");
  }
  expect(
    normalizeToolDescriptor({
      name: WALLET_FUNDING_TOOL,
      title: "Fund an app with Wallet",
      description:
        "Open Wallet to review and execute one exact ICRC token transfer or short-lived spending allowance.",
      inputSchema: walletFundingInputSchema,
      outputSchema: walletFundingOutputSchema,
      annotations: {
        "neutron:audit": "metadata_only",
        "neutron:consent": "provider_once",
        "neutron:effects": ["write", "network", "user_visible_ui"],
      },
    }),
  ).toEqual(releasedDescriptor);
});

test("successor Wallet fails closed on an older Kernel without provider UI", async () => {
  let selfCalls = 0;
  const controller = new AbortController();
  const context = {
    caller: {
      endpoint: "app:swap_fixture:tile",
      appId: "swap_fixture",
      role: "tile",
    },
    reportProgress: () => undefined,
    kernel: {
      updateSelf: async () => {
        selfCalls += 1;
        return null;
      },
    },
    signal: controller.signal,
    agentMode: false,
  } as unknown as Parameters<typeof handleWalletFunding>[1];

  await expect(
    handleWalletFunding(
      {
        requestId: "00112233445566778899aabbccddeeff",
        ledger: "xevnm-gaaaa-aaaar-qafnq-cai",
        amountAtoms: "1000000",
        validUntilNs: "1893456000000000000",
        route: {
          kind: "direct",
          to: "aaaaa-aa",
        },
      },
      context,
    ),
  ).rejects.toThrow(
    "Wallet funding requires a Kernel with provider UI support",
  );
  expect(selfCalls).toBe(0);
});

function decodeJson(bytes: Uint8Array | undefined, label: string): unknown {
  return JSON.parse(decodeText(bytes, label));
}

function decodeText(bytes: Uint8Array | undefined, label: string): string {
  if (bytes === undefined) {
    throw new Error(`Released Wallet archive is missing ${label}`);
  }
  return decoder.decode(bytes);
}

async function listReleasedTools(
  service: string,
): Promise<MsgBusToolDescriptor[]> {
  type WindowMessage = {
    data: unknown;
    source: unknown;
    origin: string;
    ports: MessagePort[];
  };
  const listeners: Array<(event: WindowMessage) => void> = [];
  const canisterId = "4caro-hl777-77775-aaaba-cai";
  const origin = `https://${canisterId}.icp0.io`;
  const parent = { postMessage: () => undefined };
  const window = {
    parent,
    location: { href: `${origin}/app/wallet/service.html` },
    addEventListener(type: string, listener: (event: WindowMessage) => void) {
      if (type === "message") listeners.push(listener);
    },
  };
  runInNewContext(service, {
    window,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    AbortController,
    DOMException,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Blob,
    crypto: globalThis.crypto,
    structuredClone,
    MessageChannel,
  });

  const channel = new MessageChannel();
  try {
    const tools = new Promise<MsgBusToolDescriptor[]>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Released Wallet tool discovery timed out")),
          1_000,
        );
        channel.port2.on("message", (message: unknown) => {
          if (!isRecord(message)) return;
          if (message.type === "exec" && typeof message.id === "number") {
            channel.port2.postMessage({
              type: "response",
              id: message.id,
              ok: null,
            });
            return;
          }
          if (message.type !== "response" || message.id !== 91) return;
          clearTimeout(timeout);
          if (!Array.isArray(message.ok)) {
            reject(new Error("Released Wallet returned an invalid tool list"));
            return;
          }
          resolve(
            JSON.parse(JSON.stringify(message.ok)) as MsgBusToolDescriptor[],
          );
        });
      },
    );
    channel.port2.start();
    for (const listener of listeners) {
      listener({
        data: {
          type: "neutron:msgbus:connect",
          version: 1,
          sessionId: "released-wallet-contract",
        },
        source: parent,
        origin,
        ports: [channel.port1 as unknown as MessagePort],
      });
    }
    channel.port2.postMessage({
      type: "exec",
      id: 91,
      payload: {
        action: "__neutron_msgbus_tools_list",
        payload: null,
      },
    });
    return await tools;
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
