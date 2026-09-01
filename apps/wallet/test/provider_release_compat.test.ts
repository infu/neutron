import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { handleWalletFunding } from "../src/funding.ts";

const RELEASED_WALLET_V032 = new URL(
  "../wallet.v0.3.2.neutron",
  import.meta.url,
);
const RELEASED_WALLET_V032_BYTES = 575_530;
const RELEASED_WALLET_V032_SHA256 =
  "830e8cb4e59bcb73deed3024f704c373f6cce744ccf850efea65eac74b545b43";

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

test("successor Wallet fails closed on an older Kernel without provider approval", async () => {
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
    "Wallet funding requires a Kernel with provider approval support",
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
