import { expect, test } from "bun:test";
import {
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
} from "viem";
import {
  buildApproveData,
  buildErc20DepositData,
  buildEthDepositData,
  buildLegacyErc20DepositData,
  buildLegacyEthDepositData,
  submitEthereumDeposit,
  type EthereumDepositProgress,
  type EthereumProvider,
} from "../src/ethereum.ts";

const account = "0x1111111111111111111111111111111111111111";
const helper = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const minter = "0x4444444444444444444444444444444444444444";
const principal = `0x${"01".repeat(32)}` as Hex;
const subaccount = `0x${"00".repeat(32)}` as Hex;
const hash1 = `0x${"1".padStart(64, "0")}` as Hex;
const hash2 = `0x${"2".padStart(64, "0")}` as Hex;
const hash3 = `0x${"3".padStart(64, "0")}` as Hex;
const hashes = [hash1, hash2, hash3] as const;

test("Wallet encodes the verified ckETH helper ABI", () => {
  expect(buildEthDepositData(principal, subaccount).slice(0, 10)).toBe(
    "0x17c819c4",
  );
  expect(
    buildErc20DepositData(token, 25n, principal, subaccount).slice(0, 10),
  ).toBe("0xdb9751af");
  expect(buildApproveData(helper, 25n).slice(0, 10)).toBe("0x095ea7b3");
  expect(buildLegacyEthDepositData(principal).slice(0, 10)).toBe(
    "0xb214faa5",
  );
  expect(
    buildLegacyErc20DepositData(token, 25n, principal).slice(0, 10),
  ).toBe("0x26b3293f");
});

test("ckETH deposits switch to mainnet and send value to the helper", async () => {
  const requests: Array<{ method: string; params?: unknown }> = [];
  let chain = "0xaa36a7";
  const provider: EthereumProvider = {
    async request({ method, params }) {
      requests.push({ method, params });
      if (method === "eth_requestAccounts") return [account];
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") {
        chain = "0x1";
        return null;
      }
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_call") {
        return encodeFunctionResult({
          abi: helperIdentityAbi,
          functionName: "getMinterAddress",
          result: minter,
        });
      }
      if (method === "eth_sendTransaction") return hashes[0];
      if (method === "eth_getTransactionReceipt") return { status: "0x1" };
      throw new Error(`Unexpected ${method}`);
    },
  };

  const result = await submitEthereumDeposit({
    amount: 12n,
    helperMode: "subaccount",
    helperAddress: helper,
    minterAddress: minter,
    principal,
    provider,
    subaccount,
    confirmationTimeoutMs: 10,
    pollIntervalMs: 0,
  });

  expect(result.transactionHash).toBe(hashes[0]);
  expect(requests.some(({ method }) => method === "wallet_switchEthereumChain"))
    .toBe(true);
  const sent = requests.find(({ method }) => method === "eth_sendTransaction");
  expect(sent?.params).toEqual([
    {
      from: account,
      to: helper,
      data: buildEthDepositData(principal, subaccount),
      value: "0xc",
    },
  ]);
});

test("ckERC20 deposits replace old allowance with an exact allowance", async () => {
  const transactions: Array<Record<string, unknown>> = [];
  const progress: EthereumDepositProgress[] = [];
  const allowances = [30n, 25n];
  const provider: EthereumProvider = {
    async request({ method, params }) {
      if (method === "eth_requestAccounts") return [account];
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_call") {
        const transaction = (params as [Record<string, unknown>])[0];
        if (transaction.to === helper) {
          return encodeFunctionResult({
            abi: helperIdentityAbi,
            functionName: "getMinterAddress",
            result: minter,
          });
        }
        return encodeFunctionResult({
          abi: allowanceAbi,
          functionName: "allowance",
          result: allowances.shift() ?? 25n,
        });
      }
      if (method === "eth_sendTransaction") {
        const transaction = (params as [Record<string, unknown>])[0];
        transactions.push(transaction);
        return hashes[transactions.length - 1];
      }
      if (method === "eth_getTransactionReceipt") return { status: "0x1" };
      throw new Error(`Unexpected ${method}`);
    },
  };

  const result = await submitEthereumDeposit({
    amount: 25n,
    helperMode: "subaccount",
    helperAddress: helper,
    minterAddress: minter,
    onProgress: (value) => progress.push(value),
    principal,
    provider,
    subaccount,
    tokenAddress: token,
    confirmationTimeoutMs: 10,
    pollIntervalMs: 0,
  });

  expect(result.approvalHashes).toEqual([hashes[0], hashes[1]]);
  expect(transactions).toHaveLength(3);
  expect(
    decodeFunctionData({ abi: approvalAbi, data: transactions[0]!.data as Hex }),
  ).toMatchObject({ functionName: "approve", args: [helper, 0n] });
  expect(
    decodeFunctionData({ abi: approvalAbi, data: transactions[1]!.data as Hex }),
  ).toMatchObject({ functionName: "approve", args: [helper, 25n] });
  expect(transactions[2]).toEqual({
    from: account,
    to: helper,
    data: buildErc20DepositData(token, 25n, principal, subaccount),
  });
  expect(progress.at(-1)).toEqual({
    phase: "confirming",
    transactionHash: hashes[2],
  });
});

test("Wallet rejects a helper that belongs to a different minter", async () => {
  let sent = false;
  const provider: EthereumProvider = {
    async request({ method }) {
      if (method === "eth_requestAccounts") return [account];
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_call") {
        return encodeFunctionResult({
          abi: helperIdentityAbi,
          functionName: "getMinterAddress",
          result: account,
        });
      }
      if (method === "eth_sendTransaction") {
        sent = true;
        return hash1;
      }
      throw new Error(`Unexpected ${method}`);
    },
  };

  await expect(
    submitEthereumDeposit({
      amount: 12n,
      helperMode: "legacy",
      helperAddress: helper,
      minterAddress: minter,
      principal,
      provider,
      subaccount,
      confirmationTimeoutMs: 10,
      pollIntervalMs: 0,
    }),
  ).rejects.toThrow("does not belong to this ckETH minter");
  expect(sent).toBe(false);
});

const allowanceAbi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const approvalAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const helperIdentityAbi = [
  {
    type: "function",
    name: "getMinterAddress",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;
