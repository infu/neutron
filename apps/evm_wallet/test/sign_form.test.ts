import { expect, test } from "bun:test";
import {
  createEvmWalletClient,
  EVM_WALLET_TARGET,
  EVM_WALLET_TOOLS,
  type EvmOperationResult,
  type EvmOperationStatusResult,
} from "neutron-tools/evm_wallet";
import type { JsonValue, MsgBusToolCall } from "neutron-tools/protocol";
import {
  checkSignatureRequest,
  createSignatureRequest,
  reviewSignatureRequest,
} from "../src/signature_request.ts";

const ADDRESS = `0x${"12".repeat(20)}`, OTHER_ADDRESS = `0x${"34".repeat(20)}`;
const REQUEST_ID = "abcdef0123456789abcdef0123456789";
const SIGNATURE = `0x${"ab".repeat(65)}`;
const TYPED_JSON = `{
  "types": {"EIP712Domain": [], "Permit": [{"name":"amount","type":"uint256"}]},
  "domain": {}, "primaryType": "Permit", "message": {"amount": 9007199254740993}
}`;

function message() {
  return createSignatureRequest("message", "Sign precisely: 雪 🌍\n", "42161", ADDRESS, REQUEST_ID);
}
function operation(patch: Partial<EvmOperationResult> = {}): EvmOperationResult {
  return {
    accountId: "main", chainId: "42161", requestId: REQUEST_ID,
    operationId: "9", kind: "message", status: "signed", address: ADDRESS,
    transactionHash: null, signature: SIGNATURE, message: null, reviewRevision: "1", receipt: null,
    ...patch,
  };
}
function walletFixture(options: {
  status?: EvmOperationStatusResult | (() => EvmOperationStatusResult | Promise<EvmOperationStatusResult>);
  effect?: () => EvmOperationResult | Promise<EvmOperationResult>;
  accountAddress?: string;
} = {}) {
  const calls: MsgBusToolCall[] = [];
  const client = createEvmWalletClient({
    async callTool<T extends JsonValue = JsonValue>(call: MsgBusToolCall): Promise<T> {
      calls.push(call);
      expect(call.target).toBe(EVM_WALLET_TARGET);
      if (call.name === EVM_WALLET_TOOLS.accounts) return {
        accounts: [{ accountId: "main", address: options.accountAddress ?? ADDRESS, publicKey: `0x02${"56".repeat(32)}`, keyFingerprint: `0x${"78".repeat(32)}`, namespaceVersion: "1" }],
      } as unknown as T;
      if (call.name === EVM_WALLET_TOOLS.operationStatus) {
        const status = typeof options.status === "function" ? await options.status() : options.status;
        return (status ?? { accountId: "main", chainId: "42161", requestId: REQUEST_ID, status: "not_found" }) as unknown as T;
      }
      if (call.name === EVM_WALLET_TOOLS.signMessage || call.name === EVM_WALLET_TOOLS.signTypedData) {
        return (options.effect ? await options.effect() : operation()) as unknown as T;
      }
      throw new Error(`Unexpected tool ${call.name}`);
    },
  });
  return { client, calls, effects: () => calls.filter((call) => call.name === EVM_WALLET_TOOLS.signMessage || call.name === EVM_WALLET_TOOLS.signTypedData) };
}

test("signature request preserves UTF-8 bytes and exact EIP-712 JSON without rounding integers", () => {
  expect(message().request).toMatchObject({ messageHex: "0x5369676e20707265636973656c793a20e99baa20f09f8c8d0a" });
  const typed = createSignatureRequest("typed_data", TYPED_JSON, "1", ADDRESS, REQUEST_ID);
  expect(typed.kind).toBe("typed_data");
  if (typed.kind !== "typed_data") throw new Error("Missing typed-data request");
  expect(typed.request.typedDataJson).toBe(TYPED_JSON);
  expect(typed.request.typedDataJson).toContain("9007199254740993");
  expect(() => createSignatureRequest("typed_data", "{broken", "1", ADDRESS, REQUEST_ID)).toThrow("JSON syntax");
});

test("explicit review checks the account and status then uses the public provider with the complete request", async () => {
  const request = message(), fixture = walletFixture();
  const result = await reviewSignatureRequest(fixture.client, request, ADDRESS);
  expect(fixture.calls.map((call) => call.name)).toEqual([EVM_WALLET_TOOLS.accounts, EVM_WALLET_TOOLS.operationStatus, EVM_WALLET_TOOLS.signMessage]);
  expect(fixture.effects()[0]?.arguments).toEqual(request.request);
  expect(result.status).toBe("signed");
  expect(result.signature).toBe(SIGNATURE);
});

test("a lost effect response recovers the backend signature with the live request ID and no second signature", async () => {
  const request = message();
  let signed = false;
  const fixture = walletFixture({
    status: () => signed ? operation() : { accountId: "main", chainId: "42161", requestId: REQUEST_ID, status: "not_found" },
    effect: () => { signed = true; throw new Error("response lost"); },
  });
  await expect(reviewSignatureRequest(fixture.client, request, ADDRESS)).rejects.toThrow("response lost");
  const recovered = await reviewSignatureRequest(fixture.client, request, ADDRESS);
  expect(recovered.signature).toBe(SIGNATURE);
  expect(recovered.requestId).toBe(REQUEST_ID);
  expect(fixture.effects()).toHaveLength(1);
  expect(request.request.requestId).toBe(REQUEST_ID);
});

test("status-only recovery never opens a signature review when the request is missing", async () => {
  const fixture = walletFixture();
  expect((await checkSignatureRequest(fixture.client, message(), ADDRESS)).status).toBe("not_found");
  expect(fixture.effects()).toHaveLength(0);
});

test("preparing, signing and unknown outcomes remain unresolved without replaying signatures", async () => {
  for (const status of ["preparing", "signing", "unknown"] as const) {
    const fixture = walletFixture({ status: operation({ status, signature: null }) });
    const result = await reviewSignatureRequest(fixture.client, message(), ADDRESS);
    expect(result.status).toBe(status);
    expect(result.signature).toBeNull();
    expect(fixture.effects()).toHaveLength(0);
  }
});

test("prepared requests reopen public review with the same ID and exact typed-data JSON", async () => {
  const request = createSignatureRequest("typed_data", TYPED_JSON, "42161", ADDRESS, REQUEST_ID);
  const fixture = walletFixture({ status: operation({ kind: "typed_data", status: "prepared", signature: null }), effect: () => operation({ kind: "typed_data" }) });
  await reviewSignatureRequest(fixture.client, request, ADDRESS);
  expect(fixture.effects()).toHaveLength(1);
  expect(fixture.effects()[0]?.name).toBe(EVM_WALLET_TOOLS.signTypedData);
  expect(fixture.effects()[0]?.arguments).toEqual(request.request);
  expect(fixture.effects()[0]?.arguments?.typedDataJson).toBe(TYPED_JSON);
});

test("rejected and failed requests are returned without silently creating another request", async () => {
  for (const status of ["rejected", "failed"] as const) {
    const fixture = walletFixture({ status: operation({ status, signature: null }) });
    expect((await reviewSignatureRequest(fixture.client, message(), ADDRESS)).status).toBe(status);
    expect(fixture.effects()).toHaveLength(0);
  }
});

test("account replacement, mismatched operation identity and status failures do not submit an effect", async () => {
  const request = message();
  const displayedReplacement = walletFixture();
  await expect(reviewSignatureRequest(displayedReplacement.client, request, OTHER_ADDRESS)).rejects.toThrow("wallet account changed");
  expect(displayedReplacement.calls).toHaveLength(0);
  const liveReplacement = walletFixture({ accountAddress: OTHER_ADDRESS });
  await expect(reviewSignatureRequest(liveReplacement.client, request, ADDRESS)).rejects.toThrow("wallet account changed");
  expect(liveReplacement.calls.map((call) => call.name)).toEqual([EVM_WALLET_TOOLS.accounts]);
  for (const patch of [{ requestId: "f".repeat(32) }, { address: OTHER_ADDRESS }, { kind: "typed_data" as const }]) {
    const fixture = walletFixture({ status: operation(patch) });
    await expect(reviewSignatureRequest(fixture.client, request, ADDRESS)).rejects.toThrow();
    expect(fixture.effects()).toHaveLength(0);
  }
  const failedStatus = walletFixture({ status: () => { throw new Error("status unavailable"); } });
  await expect(reviewSignatureRequest(failedStatus.client, request, ADDRESS)).rejects.toThrow("status unavailable");
  expect(failedStatus.effects()).toHaveLength(0);
});

test("an invalid effect response is not accepted as a completed signature", async () => {
  const request = message();
  const fixture = walletFixture({ effect: () => operation({ address: OTHER_ADDRESS }) });
  await expect(reviewSignatureRequest(fixture.client, request, ADDRESS)).rejects.toThrow("wallet account changed");
  const missingSignature = walletFixture({ status: operation({ signature: null }) });
  await expect(checkSignatureRequest(missingSignature.client, request, ADDRESS)).rejects.toThrow("no signature");
  expect(missingSignature.effects()).toHaveLength(0);
});
