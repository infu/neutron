import { expect, test } from "bun:test";
import { encodeFunctionData, erc20Abi } from "viem";
import { address, type Operation, type TransactionIntent } from "../src/data.ts";
import { knownApprovals, parseAllowanceResult } from "../src/known_approvals.ts";

test("only an exact allowance uint256 response can support zero-allowance review", () => {
  expect(parseAllowanceResult(`0x${"0".repeat(64)}`)).toBe("0");
  expect(parseAllowanceResult(`0x${"f".repeat(64)}`)).toBe(((1n << 256n) - 1n).toString());
  for (const malformed of ["0x", "0x1", `0x${"0".repeat(63)}`, `0x${"0".repeat(128)}`, `0x${"z".repeat(64)}`]) {
    expect(() => parseAllowanceResult(malformed)).toThrow("did not return an ERC-20 allowance");
  }
});

const OWNER = `0x${"11".repeat(20)}`;
const TOKEN = `0x${"ab".repeat(20)}`;
const SPENDER: `0x${string}` = `0x${"cd".repeat(20)}`;
const OTHER_TOKEN = `0x${"ef".repeat(20)}`;
const HASH = `0x${"12".repeat(32)}`;
const REPLACEMENT_HASH = `0x${"34".repeat(32)}`;

function approval(to = TOKEN, amount = 100n): TransactionIntent {
  return {
    transactionType: "eip1559", gasLimit: "50000", maxFeePerGas: "2",
    maxPriorityFeePerGas: "1", gasPrice: null, to, value: "0", accessList: [],
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SPENDER, amount] }),
  };
}
function receipt(transactionHash = HASH, status = "0x1"): string {
  return JSON.stringify({ transactionHash, status, blockNumber: "0x1", blockHash: `0x${"56".repeat(32)}` });
}
function operation(patch: Partial<Operation> = {}): Operation {
  return {
    caller: { appId: "uniswap", installationUid: "1", endpoint: "background" },
    operationId: "1", requestId: "1".repeat(32), accountId: "main", chainId: "1",
    kind: "transaction", status: "confirmed", address: OWNER,
    transactionHash: HASH, replacementTransactionHash: null,
    signature: null, message: null, reviewRevision: "1", review: null,
    tokenEvidence: null,
    receiptJson: receipt(), finality: "included", createdAtNs: "1", updatedAtNs: "2",
    intent: { transaction: approval() },
    preparedTransaction: { ...approval(), chainId: "1", nonce: "0" },
    ...patch,
  };
}
function replacement(patch: Partial<Operation> = {}): Operation {
  return operation({
    operationId: "2", requestId: "2".repeat(32), transactionHash: REPLACEMENT_HASH,
    receiptJson: receipt(REPLACEMENT_HASH),
    intent: { replacement: { operationId: "1", cancel: false, maxFeePerGas: "4", maxPriorityFeePerGas: "2" } },
    preparedTransaction: { ...approval(), chainId: "1", nonce: "0", maxFeePerGas: "4", maxPriorityFeePerGas: "2" },
    ...patch,
  });
}
const pair = { key: `1:${TOKEN}:${SPENDER}`, token: address(TOKEN), spender: address(SPENDER) };

test("known approvals include a confirmed replacement's resolved transaction when the original is replaced", () => {
  const original = operation({ status: "replaced", receiptJson: null, replacementTransactionHash: REPLACEMENT_HASH });
  const confirmed = replacement();
  expect(confirmed.intent.transaction).toBeUndefined();
  expect(knownApprovals([original, confirmed], "1")).toEqual([pair]);
});

test("submitted, prepared and unresolved replacements do not imply that their approvals were mined", () => {
  for (const status of ["prepared", "signing", "signed", "submitted", "unknown", "failed", "rejected", "reverted", "replaced"]) {
    const pending = replacement({ status, receiptJson: null });
    expect(knownApprovals([pending], "1")).toEqual([]);
  }
  expect(knownApprovals([operation({ status: "submitted", receiptJson: null })], "1")).toEqual([]);
});

test("successful cancellation replacements are self transfers, not token approvals", () => {
  const canceled = replacement({
    intent: { replacement: { operationId: "1", cancel: true, maxFeePerGas: "4", maxPriorityFeePerGas: "2" } },
    preparedTransaction: { ...approval(), chainId: "1", nonce: "0", to: OWNER, data: "0x" },
  });
  expect(knownApprovals([operation({ status: "replaced", receiptJson: null }), canceled], "1")).toEqual([]);
});

test("replacement discovery requires its own resolved calldata and never copies the replaced intent", () => {
  const original = operation({ status: "replaced", receiptJson: null });
  expect(knownApprovals([original, replacement({ preparedTransaction: null })], "1")).toEqual([]);
  const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [SPENDER, 100n] });
  expect(knownApprovals([replacement({ preparedTransaction: { ...approval(), data: transfer, chainId: "1", nonce: "0" } })], "1")).toEqual([]);
});

test("only successful receipts for the operation's signed hash establish a known approval", () => {
  for (const receiptJson of [null, "null", "{broken", "[]", receipt(HASH, "0x0"), receipt(REPLACEMENT_HASH), JSON.stringify({ status: "0x1" })]) {
    expect(knownApprovals([operation({ receiptJson })], "1")).toEqual([]);
  }
  expect(knownApprovals([operation({ transactionHash: null })], "1")).toEqual([]);
  expect(knownApprovals([operation({ status: "unknown" })], "1")).toEqual([]);
  expect(knownApprovals([operation({ receiptJson: receipt(HASH, "1"), finality: "included" })], "1")).toEqual([pair]);
});

test("ordinary approvals and revocations retain one known pair without claiming the current allowance", () => {
  const revoked = operation({ operationId: "3", preparedTransaction: { ...approval(TOKEN, 0n), chainId: "1", nonce: "1" } });
  const mixedCase = operation({ preparedTransaction: { ...approval(address(TOKEN)), chainId: "1", nonce: "2" } });
  expect(knownApprovals([operation(), revoked, mixedCase, replacement()], "1")).toEqual([pair]);
  expect(knownApprovals([operation({ preparedTransaction: null })], "1")).toEqual([pair]);
});

test("selected-chain discovery and result keys keep the same addresses on different networks distinct", () => {
  const ethereum = operation();
  const arbitrum = operation({ chainId: "42161", preparedTransaction: { ...approval(), chainId: "42161", nonce: "0" } });
  expect(knownApprovals([ethereum, arbitrum], "1")).toEqual([pair]);
  expect(knownApprovals([ethereum, arbitrum], "42161")).toEqual([{ ...pair, key: `42161:${TOKEN}:${SPENDER}` }]);
  expect(knownApprovals([replacement({ preparedTransaction: { ...approval(), chainId: "42161", nonce: "0" } })], "1")).toEqual([]);
  expect(knownApprovals([operation({ preparedTransaction: { ...approval(OTHER_TOKEN), chainId: "1", nonce: "0" } })], "1")[0]?.token).toBe(address(OTHER_TOKEN));
});
