import {
  getAddress,
  keccak256,
  recoverAddress,
  Transaction,
  type AccessList,
} from "ethers";

// Same fixed endpoint as neutron-provision/src/local_chain_services.ts. That
// service manager is Bun-only (import.meta.dir), whereas Playwright uses Node.
const LOCAL_ANVIL_RPC_URL = "http://127.0.0.1:8545";

const LOCAL_FUNDING_WEI = 10n * 10n ** 18n;
const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export type LocalEvmTransactionEvidence = {
  hash: string;
  from: string;
  to: string;
  valueWei: string;
  nonce: number;
  chainId: string;
  raw: string;
  blockNumber: string;
  gasUsed: string;
  effectiveGasPriceWei: string;
};

export type LocalEvmChain = {
  rpc<T = unknown>(method: string, params?: readonly unknown[]): Promise<T>;
  balance(address: string): Promise<bigint>;
  nonce(address: string): Promise<bigint>;
  fund(address: string): Promise<void>;
  evidence(hash: string): Promise<LocalEvmTransactionEvidence>;
};

/** Real local chain evidence; importing this module does not contact a node. */
export async function createLocalEvmChain(): Promise<LocalEvmChain> {
  const url = new URL(LOCAL_ANVIL_RPC_URL);
  if (url.href !== "http://127.0.0.1:8545/") {
    throw new Error("EVM wallet E2E requires the pinned local Anvil endpoint");
  }
  let nextId = 0;

  async function rpc<T = unknown>(
    method: string,
    params: readonly unknown[] = [],
  ): Promise<T> {
    const id = ++nextId;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Local Anvil ${method} failed: HTTP ${response.status}`);
    }
    const body = object(await response.json(), `${method} response`);
    if (body.jsonrpc !== "2.0" || body.id !== id) {
      throw new Error(`Local Anvil ${method} returned an invalid RPC envelope`);
    }
    if (body.error !== undefined) {
      const error = object(body.error, `${method} error`);
      throw new LocalRpcError(method, error.code, error.message);
    }
    if (!("result" in body)) {
      throw new Error(`Local Anvil ${method} omitted its result`);
    }
    return body.result as T;
  }

  async function assertLocalChain(): Promise<void> {
    const [clientVersion, chainId] = await Promise.all([
      rpc("web3_clientVersion"),
      rpc("eth_chainId"),
    ]);
    if (typeof clientVersion !== "string" || !/^anvil\b/iu.test(clientVersion)) {
      throw new Error("EVM wallet E2E requires a running Anvil node");
    }
    if (quantity(chainId, "chain ID") !== 1n) {
      throw new Error("EVM wallet E2E requires local Anvil chain ID 1");
    }
  }

  async function balance(address: string): Promise<bigint> {
    return quantity(
      await rpc("eth_getBalance", [getAddress(address), "latest"]),
      "balance",
    );
  }

  await assertLocalChain();
  return {
    rpc,
    balance,
    async nonce(address) {
      return quantity(
        await rpc("eth_getTransactionCount", [getAddress(address), "latest"]),
        "nonce",
      );
    },
    async fund(address) {
      const account = getAddress(address);
      await assertLocalChain();
      await rpc("anvil_setBalance", [account, `0x${LOCAL_FUNDING_WEI.toString(16)}`]);
      if (await balance(account) !== LOCAL_FUNDING_WEI) {
        throw new Error("Local Anvil did not set the E2E account balance to 10 ETH");
      }
    },
    async evidence(hash) {
      const expectedHash = hex(hash, 32, "transaction hash");
      const [transactionValue, receiptValue] = await Promise.all([
        rpc("eth_getTransactionByHash", [expectedHash]),
        rpc("eth_getTransactionReceipt", [expectedHash]),
      ]);
      const transaction = object(transactionValue, "mined transaction");
      const receipt = object(receiptValue, "transaction receipt");
      if (quantity(transaction.type, "transaction type") !== 2n) {
        throw new Error("EVM wallet E2E expected an EIP-1559 transaction");
      }
      if (quantity(receipt.status, "receipt status") !== 1n) {
        throw new Error("EVM wallet E2E transaction did not execute successfully");
      }

      // Reconstruct from the node's full transaction fields, including its
      // signature. This also supplies raw bytes on nodes without the raw RPC.
      const fromRpc = transactionFromRpc(transaction);
      let raw: string;
      try {
        raw = hex(await rpc("eth_getRawTransactionByHash", [expectedHash]), undefined, "raw transaction");
      } catch (error) {
        if (!(error instanceof LocalRpcError) || error.code !== -32601) throw error;
        raw = fromRpc.serialized;
      }
      const decoded = Transaction.from(raw);
      if (decoded.type !== 2 || !decoded.isSigned() || decoded.chainId !== 1n) {
        throw new Error("The raw transaction is not signed EIP-1559 on chain ID 1");
      }
      const r = BigInt(decoded.signature.r);
      const s = BigInt(decoded.signature.s);
      if (r <= 0n || r >= SECP256K1_ORDER || s <= 0n || s > SECP256K1_ORDER / 2n) {
        throw new Error("The transaction does not have a valid low-S signature");
      }
      if (
        keccak256(raw).toLowerCase() !== expectedHash ||
        decoded.hash?.toLowerCase() !== expectedHash ||
        hex(transaction.hash, 32, "RPC transaction hash") !== expectedHash ||
        hex(receipt.transactionHash, 32, "receipt transaction hash") !== expectedHash ||
        decoded.serialized.toLowerCase() !== raw.toLowerCase() ||
        fromRpc.serialized.toLowerCase() !== raw.toLowerCase()
      ) {
        throw new Error("Raw transaction, RPC transaction, receipt, and hash disagree");
      }
      const sender = recoverAddress(decoded.unsignedHash, decoded.signature);
      const recipient = address(decoded.to, "signed recipient");
      if (
        sender !== decoded.from ||
        sender !== address(transaction.from, "RPC sender") ||
        sender !== address(receipt.from, "receipt sender") ||
        recipient !== address(receipt.to, "receipt recipient") ||
        hex(transaction.blockHash, 32, "transaction block hash") !==
          hex(receipt.blockHash, 32, "receipt block hash") ||
        quantity(transaction.blockNumber, "transaction block number") !==
          quantity(receipt.blockNumber, "receipt block number")
      ) {
        throw new Error("Recovered transaction sender or inclusion evidence disagrees");
      }
      return {
        hash: expectedHash,
        from: sender,
        to: recipient,
        valueWei: decoded.value.toString(),
        nonce: decoded.nonce,
        chainId: decoded.chainId.toString(),
        raw,
        blockNumber: quantity(receipt.blockNumber, "receipt block number").toString(),
        gasUsed: quantity(receipt.gasUsed, "receipt gas used").toString(),
        effectiveGasPriceWei: quantity(receipt.effectiveGasPrice, "receipt gas price").toString(),
      };
    },
  };
}

function transactionFromRpc(transaction: Record<string, unknown>): Transaction {
  const nonce = quantity(transaction.nonce, "transaction nonce");
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Transaction nonce exceeds the evidence decoder's numeric range");
  }
  const parity = quantity(transaction.yParity ?? transaction.v, "signature parity");
  if (parity !== 0n && parity !== 1n) {
    throw new Error("EIP-1559 signature parity must be zero or one");
  }
  if (transaction.v !== undefined && quantity(transaction.v, "signature v") !== parity) {
    throw new Error("EIP-1559 signature parity and v disagree");
  }
  if (!Array.isArray(transaction.accessList)) {
    throw new Error("EIP-1559 transaction omitted its access list");
  }
  const accessList: AccessList = transaction.accessList.map((value) => {
    const entry = object(value, "access-list entry");
    if (!Array.isArray(entry.storageKeys)) {
      throw new Error("Access-list entry omitted its storage keys");
    }
    return {
      address: address(entry.address, "access-list address"),
      storageKeys: entry.storageKeys.map((key) => hex(key, 32, "storage key")),
    };
  });
  return Transaction.from({
    type: 2,
    chainId: quantity(transaction.chainId, "transaction chain ID"),
    nonce: Number(nonce),
    to: address(transaction.to, "RPC recipient"),
    value: quantity(transaction.value, "transaction value"),
    gasLimit: quantity(transaction.gas, "transaction gas limit"),
    maxFeePerGas: quantity(transaction.maxFeePerGas, "transaction max fee"),
    maxPriorityFeePerGas: quantity(transaction.maxPriorityFeePerGas, "transaction priority fee"),
    data: hex(transaction.input, undefined, "transaction input"),
    accessList,
    signature: {
      r: scalar(transaction.r, "signature r"),
      s: scalar(transaction.s, "signature s"),
      yParity: Number(parity) as 0 | 1,
    },
  });
}

class LocalRpcError extends Error {
  constructor(method: string, readonly code: unknown, message: unknown) {
    super(`Local Anvil ${method}: ${String(message)} (${String(code)})`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Local Anvil returned no valid ${label}`);
  }
  return value as Record<string, unknown>;
}

function quantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(value)) {
    throw new Error(`Local Anvil returned an invalid ${label} quantity`);
  }
  return BigInt(value);
}

function hex(value: unknown, bytes: number | undefined, label: string): string {
  if (
    typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/iu.test(value) ||
    (bytes !== undefined && value.length !== 2 + 2 * bytes)
  ) {
    throw new Error(`Local Anvil returned invalid ${label} bytes`);
  }
  return value.toLowerCase();
}

function address(value: unknown, label: string): string {
  return getAddress(hex(value, 20, label));
}

function scalar(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{1,64}$/iu.test(value)) {
    throw new Error(`Local Anvil returned an invalid ${label} scalar`);
  }
  return `0x${value.slice(2).padStart(64, "0")}`;
}
