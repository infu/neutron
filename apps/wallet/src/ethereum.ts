import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  type Address,
  type Hex,
} from "viem";

export type EthereumProvider = {
  isMetaMask?: boolean;
  providers?: EthereumProvider[];
  request(args: {
    method: string;
    params?: readonly unknown[] | Record<string, unknown>;
  }): Promise<unknown>;
};

export type EthereumDepositPhase =
  | "connecting"
  | "switching-network"
  | "checking-allowance"
  | "clearing-allowance"
  | "approving"
  | "submitting"
  | "confirming";

export type EthereumDepositProgress = {
  phase: EthereumDepositPhase;
  transactionHash?: Hex;
};

export type EthereumDepositResult = {
  account: Address;
  approvalHashes: Hex[];
  transactionHash: Hex;
};

type SubmitEthereumDepositOptions = {
  amount: bigint;
  helperMode: "subaccount" | "legacy";
  helperAddress: string;
  minterAddress: string;
  principal: string;
  provider: EthereumProvider;
  subaccount: string;
  tokenAddress?: string | null;
  onProgress?: (progress: EthereumDepositProgress) => void;
  confirmationTimeoutMs?: number;
  pollIntervalMs?: number;
};

const MAINNET_CHAIN_ID = 1n;
const MAINNET_CHAIN_ID_HEX = "0x1";
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;

const depositHelperAbi = [
  {
    type: "function",
    name: "depositEth",
    stateMutability: "payable",
    inputs: [
      { name: "principal", type: "bytes32" },
      { name: "subaccount", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "depositErc20",
    stateMutability: "nonpayable",
    inputs: [
      { name: "erc20Address", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "principal", type: "bytes32" },
      { name: "subaccount", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

const legacyEthDepositHelperAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [{ name: "principal", type: "bytes32" }],
    outputs: [],
  },
] as const;

const legacyErc20DepositHelperAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "erc20Address", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "principal", type: "bytes32" },
    ],
    outputs: [],
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

const erc20Abi = [
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

export async function submitEthereumDeposit({
  amount,
  helperMode,
  helperAddress,
  minterAddress,
  principal,
  provider,
  subaccount,
  tokenAddress = null,
  onProgress = () => undefined,
  confirmationTimeoutMs = DEFAULT_CONFIRMATION_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: SubmitEthereumDepositOptions): Promise<EthereumDepositResult> {
  if (!provider) {
    throw new Error("MetaMask is not available in this browser");
  }
  if (amount <= 0n) throw new Error("Deposit amount must be greater than zero");

  const helper = checkedAddress(helperAddress, "deposit helper");
  const minter = checkedAddress(minterAddress, "minter");
  const principalWord = checkedBytes32(principal, "recipient");
  const subaccountWord = checkedBytes32(subaccount, "subaccount");
  const token = tokenAddress
    ? checkedAddress(tokenAddress, "token contract")
    : null;

  onProgress({ phase: "connecting" });
  const accounts = await request<unknown>(provider, "eth_requestAccounts");
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
    throw new Error("MetaMask did not return an Ethereum account");
  }
  const account = checkedAddress(accounts[0], "Ethereum account");

  await requireMainnet(provider, onProgress);
  await requireHelperIdentity(provider, helper, minter);
  if (token) await requireContract(provider, token, "token");
  const approvalHashes: Hex[] = [];

  if (token) {
    onProgress({ phase: "checking-allowance" });
    const allowance = await readAllowance(provider, token, account, helper);

    // Reset a different existing allowance first. This is compatible with
    // USDT and prevents a larger old helper allowance surviving the deposit.
    if (allowance !== 0n && allowance !== amount) {
      const resetHash = await sendTransaction(provider, {
        from: account,
        to: token,
        data: buildApproveData(helper, 0n),
      });
      approvalHashes.push(resetHash);
      onProgress({
        phase: "clearing-allowance",
        transactionHash: resetHash,
      });
      await requireSuccessfulReceipt(
        provider,
        resetHash,
        confirmationTimeoutMs,
        pollIntervalMs,
        "Allowance reset",
      );
    }

    if (allowance !== amount) {
      const approvalHash = await sendTransaction(provider, {
        from: account,
        to: token,
        data: buildApproveData(helper, amount),
      });
      approvalHashes.push(approvalHash);
      onProgress({ phase: "approving", transactionHash: approvalHash });
      await requireSuccessfulReceipt(
        provider,
        approvalHash,
        confirmationTimeoutMs,
        pollIntervalMs,
        "Token approval",
      );
    }

    const approved = await readAllowance(provider, token, account, helper);
    if (approved !== amount) {
      throw new Error("The token contract did not set the exact deposit allowance");
    }
  }

  onProgress({ phase: "submitting" });
  const transactionHash = await sendTransaction(provider, {
    from: account,
    to: helper,
    data: token
      ? helperMode === "subaccount"
        ? buildErc20DepositData(
            token,
            amount,
            principalWord,
            subaccountWord,
          )
        : buildLegacyErc20DepositData(token, amount, principalWord)
      : helperMode === "subaccount"
        ? buildEthDepositData(principalWord, subaccountWord)
        : buildLegacyEthDepositData(principalWord),
    ...(token ? {} : { value: quantityHex(amount) }),
  });
  onProgress({ phase: "confirming", transactionHash });
  await requireSuccessfulReceipt(
    provider,
    transactionHash,
    confirmationTimeoutMs,
    pollIntervalMs,
    "Deposit",
  );

  return { account, approvalHashes, transactionHash };
}

export function buildEthDepositData(
  principal: Hex,
  subaccount: Hex,
): Hex {
  return encodeFunctionData({
    abi: depositHelperAbi,
    functionName: "depositEth",
    args: [principal, subaccount],
  });
}

export function buildErc20DepositData(
  token: Address,
  amount: bigint,
  principal: Hex,
  subaccount: Hex,
): Hex {
  return encodeFunctionData({
    abi: depositHelperAbi,
    functionName: "depositErc20",
    args: [token, amount, principal, subaccount],
  });
}

export function buildApproveData(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
  });
}

export function buildLegacyEthDepositData(principal: Hex): Hex {
  return encodeFunctionData({
    abi: legacyEthDepositHelperAbi,
    functionName: "deposit",
    args: [principal],
  });
}

export function buildLegacyErc20DepositData(
  token: Address,
  amount: bigint,
  principal: Hex,
): Hex {
  return encodeFunctionData({
    abi: legacyErc20DepositHelperAbi,
    functionName: "deposit",
    args: [token, amount, principal],
  });
}

async function requireMainnet(
  provider: EthereumProvider,
  onProgress: (progress: EthereumDepositProgress) => void,
): Promise<void> {
  const current = await request<unknown>(provider, "eth_chainId");
  if (chainId(current) === MAINNET_CHAIN_ID) return;

  onProgress({ phase: "switching-network" });
  await request(provider, "wallet_switchEthereumChain", [
    { chainId: MAINNET_CHAIN_ID_HEX },
  ]);
  const switched = await request<unknown>(provider, "eth_chainId");
  if (chainId(switched) !== MAINNET_CHAIN_ID) {
    throw new Error("MetaMask must be connected to Ethereum Mainnet");
  }
}

async function readAllowance(
  provider: EthereumProvider,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
  const result = await request<unknown>(provider, "eth_call", [
    { from: owner, to: token, data },
    "latest",
  ]);
  if (!isHex(result)) throw new Error("The token returned an invalid allowance");
  return decodeFunctionResult({
    abi: erc20Abi,
    functionName: "allowance",
    data: result,
  });
}

async function requireHelperIdentity(
  provider: EthereumProvider,
  helper: Address,
  expectedMinter: Address,
): Promise<void> {
  await requireContract(provider, helper, "deposit helper");
  const data = encodeFunctionData({
    abi: helperIdentityAbi,
    functionName: "getMinterAddress",
  });
  const result = await request<unknown>(provider, "eth_call", [
    { to: helper, data },
    "latest",
  ]);
  if (!isHex(result)) {
    throw new Error("The deposit helper returned an invalid minter address");
  }
  const actualMinter = decodeFunctionResult({
    abi: helperIdentityAbi,
    functionName: "getMinterAddress",
    data: result,
  });
  if (actualMinter.toLowerCase() !== expectedMinter.toLowerCase()) {
    throw new Error("The deposit helper does not belong to this ckETH minter");
  }
}

async function requireContract(
  provider: EthereumProvider,
  address: Address,
  label: string,
): Promise<void> {
  const code = await request<unknown>(provider, "eth_getCode", [
    address,
    "latest",
  ]);
  if (!isHex(code) || !/[1-9a-f]/i.test(code.slice(2))) {
    throw new Error(`No ${label} contract exists on the selected network`);
  }
}

async function sendTransaction(
  provider: EthereumProvider,
  transaction: {
    from: Address;
    to: Address;
    data: Hex;
    value?: Hex;
  },
): Promise<Hex> {
  const result = await request<unknown>(provider, "eth_sendTransaction", [
    transaction,
  ]);
  if (!isTransactionHash(result)) {
    throw new Error("MetaMask returned an invalid transaction hash");
  }
  return result;
}

async function requireSuccessfulReceipt(
  provider: EthereumProvider,
  transactionHash: Hex,
  timeoutMs: number,
  pollIntervalMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const receipt = await request<unknown>(
      provider,
      "eth_getTransactionReceipt",
      [transactionHash],
    );
    if (receipt !== null) {
      if (!isRecord(receipt) || chainId(receipt.status) !== 1n) {
        throw new Error(`${label} transaction failed on Ethereum`);
      }
      return;
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`${label} transaction is still pending in MetaMask`);
}

async function request<T>(
  provider: EthereumProvider,
  method: string,
  params?: readonly unknown[] | Record<string, unknown>,
): Promise<T> {
  return (await provider.request({ method, ...(params ? { params } : {}) })) as T;
}

function checkedAddress(value: string, label: string): Address {
  if (!isAddress(value)) throw new Error(`Invalid ${label} address`);
  return getAddress(value);
}

function checkedBytes32(value: string, label: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Invalid ${label} bytes32 value`);
  }
  return value as Hex;
}

function quantityHex(value: bigint): Hex {
  return `0x${value.toString(16)}`;
}

function chainId(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  return BigInt(value);
}

function isHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value);
}

function isTransactionHash(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
