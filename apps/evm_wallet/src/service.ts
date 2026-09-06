import {
  exposeTool,
  publishAppStateChange,
  type JsonObject,
} from "neutron-tools/app";
import {
  EVM_WALLET_TOOLS,
  evmAccountsInputSchema,
  evmAccountsOutputSchema,
  evmNetworksInputSchema,
  evmNetworksOutputSchema,
  evmBalancesInputSchema,
  evmBalancesOutputSchema,
  evmReadContractInputSchema,
  evmReadContractOutputSchema,
  evmReplaceTransactionInputSchema,
  evmSendTransactionInputSchema,
  evmSignMessageInputSchema,
  evmSignTypedDataInputSchema,
  evmOperationOutputSchema,
  evmOperationStatusInputSchema,
  evmOperationStatusOutputSchema,
  parseEvmBalancesRequest,
  parseEvmReadContractRequest,
  parseEvmOperationStatusRequest,
  evmTransactionInputSchema,
  evmTransactionOutputSchema,
  parseEvmTransactionRequest,
  parseEvmTransactionResult,
  parseEvmAccountsResult,
  parseEvmNetworksResult,
  parseEvmBalancesResult,
  parseEvmReadContractResult,
  evmEstimateTransactionInputSchema,
  evmEstimateTransactionOutputSchema,
  evmReplacementTransactionInputSchema,
  evmReplacementTransactionOutputSchema,
} from "neutron-tools/evm_wallet";
import {
  METHODS,
  parseAccounts,
  parseBalance,
  parseOperation,
  parseSnapshot,
  record,
  text,
  natural,
  unwrap,
  errorMessage,
} from "./data.ts";
import {
  handleHumanEffect,
  handleRootEffect,
  invocationIdentity,
  operationJson,
  quantity,
  receiptJson,
} from "./provider.ts";
import { estimateTransaction, replacementTransaction } from "./read_adapters.ts";

const bytesHex = (bytes: Uint8Array) =>
  `0x${[...bytes].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
exposeTool(
  EVM_WALLET_TOOLS.estimateTransaction,
  {
    title: "Estimate EVM transaction fees",
    description:
      "Estimate gas and current fees for exact transaction fields without creating a command, reserving a nonce or signing. Observations can span RPC calls and fees may change. Arbitrum total gas already includes posting costs; do not add them again.",
    inputSchema: evmEstimateTransactionInputSchema,
    outputSchema: evmEstimateTransactionOutputSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  },
  estimateTransaction,
);
exposeTool(
  EVM_WALLET_TOOLS.replacementTransaction,
  {
    title: "Check EVM replacement authorization",
    description:
      "Check whether this exact signed transaction belongs to an explicit replacement of the original Wallet request. This journal proof does not prove inclusion or success; read the transaction and receipt separately and require both pieces of evidence.",
    inputSchema: evmReplacementTransactionInputSchema,
    outputSchema: evmReplacementTransactionOutputSchema,
    annotations: { "neutron:effects": ["read"] },
  },
  replacementTransaction,
);
exposeTool(
  EVM_WALLET_TOOLS.accounts,
  {
    title: "EVM Wallet accounts",
    description:
      "Get the installed EVM Wallet's chain-key account and public key. This does not grant permission to sign or send transactions.",
    inputSchema: evmAccountsInputSchema,
    outputSchema: evmAccountsOutputSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  },
  async (_, context) => {
    const raw = unwrap(
      await context.kernel.updateSelf(METHODS.accounts, [null], 120),
    );
    const accounts = parseAccounts({ ok: raw });
    return parseEvmAccountsResult({
      accounts: accounts.map((a, i) => {
        const r = record((raw as unknown[])[i], "account");
        if (!(r.key_fingerprint instanceof Uint8Array))
          throw new Error("Invalid account key fingerprint");
        return {
          accountId: a.id,
          address: a.address,
          publicKey: bytesHex(a.publicKey),
          keyFingerprint: bytesHex(r.key_fingerprint),
          namespaceVersion: a.namespaceVersion,
        };
      }),
    }) as unknown as JsonObject;
  },
);
exposeTool(
  EVM_WALLET_TOOLS.networks,
  {
    title: "EVM Wallet networks",
    description:
      "Read EVM Wallet's configured networks. Every effect specifies its chain explicitly.",
    inputSchema: evmNetworksInputSchema,
    outputSchema: evmNetworksOutputSchema,
    annotations: { "neutron:effects": ["read"] },
  },
  async (_, context) => {
    const snapshot = parseSnapshot(
      await context.kernel.querySelf(METHODS.snapshot, [null]),
    );
    return parseEvmNetworksResult({
      networks: snapshot.networks.map((n) => ({
        chainId: n.chainId,
        name: n.name,
        nativeSymbol: n.nativeSymbol,
        nativeDecimals: "18",
        explorerUrl: n.explorerUrl,
        feeModel: "eip1559",
        finalityKind: n.chainId === "42161" ? "arbitrum" : "ethereum",
      })),
    }) as unknown as JsonObject;
  },
);
exposeTool(
  EVM_WALLET_TOOLS.balances,
  {
    title: "EVM Wallet balances",
    description:
      "Read native and explicitly requested ERC-20 balances at one observed block. Token discovery is not exhaustive.",
    inputSchema: evmBalancesInputSchema,
    outputSchema: evmBalancesOutputSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  },
  async (args, context) => {
    const request = parseEvmBalancesRequest(args),
      balance = parseBalance(
        await context.kernel.updateSelf(
          METHODS.balances,
          [
            {
              account_id: request.accountId,
              chain_id: request.chainId,
              tokens: request.tokens,
            },
          ],
          120,
        ),
      );
    if (
      balance.accountId !== request.accountId ||
      balance.chainId !== request.chainId
    )
      throw new Error("Wallet balance scope mismatch");
    return parseEvmBalancesResult({
      accountId: balance.accountId,
      chainId: balance.chainId,
      address: balance.address,
      nativeBalanceWei: balance.nativeBalance,
      tokens: balance.tokens.map((t) => ({
        address: t.address,
        balanceAtoms: t.balance,
        decimals: t.decimals === null ? null : String(t.decimals),
        symbol: t.symbol,
        error: t.error,
      })),
      blockNumber: balance.blockNumber,
      observedAtNs: balance.observedAtNs,
      completeness: "requested_only",
    }) as unknown as JsonObject;
  },
);
exposeTool(
  EVM_WALLET_TOOLS.readContract,
  {
    title: "Read EVM contract",
    description:
      "Make an eth_call on one explicit EVM network and return exact bytes and block evidence; no transaction is signed.",
    inputSchema: evmReadContractInputSchema,
    outputSchema: evmReadContractOutputSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  },
  async (args, context) => {
    const request = parseEvmReadContractRequest(args);
    const accounts = parseAccounts(
        await context.kernel.updateSelf(METHODS.accounts, [null], 120),
      ),
      account = accounts.find((a) => a.id === request.accountId);
    if (!account) throw new Error("Account unavailable");
    const read = record(
      unwrap(
        await context.kernel.updateSelf(
          METHODS.readContract,
          [
            {
              chain_id: request.chainId,
              to: request.to,
              data: request.data,
              block: "latest",
            },
          ],
          120,
        ),
      ),
      "contract read",
    );
    return parseEvmReadContractResult({
      accountId: request.accountId,
      chainId: natural(read.chain_id, "chain"),
      address: account.address,
      to: text(read.to, "to"),
      data: text(read.data, "data"),
      code: text(read.code, "code"),
      result: text(read.result, "result"),
      blockNumber: quantity(read.block_number, "block"),
      observedAtNs: natural(read.observed_at, "observation time"),
    }) as unknown as JsonObject;
  },
);
for (const entry of [
  {
    kind: "replacement",
    human: EVM_WALLET_TOOLS.replaceTransaction,
    root: EVM_WALLET_TOOLS.replaceTransactionRoot,
    schema: evmReplaceTransactionInputSchema,
    title: "Replace EVM transaction",
  },
  {
    kind: "transaction",
    human: EVM_WALLET_TOOLS.sendTransaction,
    root: EVM_WALLET_TOOLS.sendTransactionRoot,
    schema: evmSendTransactionInputSchema,
    title: "Send EVM transaction",
  },
  {
    kind: "message",
    human: EVM_WALLET_TOOLS.signMessage,
    root: EVM_WALLET_TOOLS.signMessageRoot,
    schema: evmSignMessageInputSchema,
    title: "Sign EVM personal message",
  },
  {
    kind: "typed_data",
    human: EVM_WALLET_TOOLS.signTypedData,
    root: EVM_WALLET_TOOLS.signTypedDataRoot,
    schema: evmSignTypedDataInputSchema,
    title: "Sign EVM typed data",
  },
] as const) {
  exposeTool(
    entry.human,
    {
      title: entry.title,
      description:
        "Open EVM Wallet to review this exact request. Reuse the same request ID and fields after uncertain outcomes.",
      inputSchema: entry.schema,
      outputSchema: evmOperationOutputSchema,
      annotations: {
        "neutron:audit": "metadata_only",
        "neutron:consent": "provider_once",
        "neutron:effects": ["write", "network", "user_visible_ui"],
      },
    },
    async (args, context) => {
      try {
        return await handleHumanEffect(entry.kind, args, context);
      } finally {
        void publishAppStateChange("evm_wallet", Date.now()).catch(
          () => undefined,
        );
      }
    },
  );
  exposeTool(
    entry.root,
    {
      title: `${entry.title} as root agent`,
      description:
        "Prepare and execute one exact EVM Wallet request through the active root-agent permission decision. If status is prepared after execution, review changed and requires a new approval; never claim a pending or unknown result completed.",
      inputSchema: entry.schema,
      outputSchema: evmOperationOutputSchema,
      annotations: {
        "neutron:audit": "metadata_only",
        "neutron:audience": "agent_root",
        "neutron:visibility": "same_app",
        "neutron:effects": ["write", "network"],
      },
    },
    async (args, context) => {
      try {
        return await handleRootEffect(entry.kind, args, context);
      } finally {
        void publishAppStateChange("evm_wallet", Date.now()).catch(
          () => undefined,
        );
      }
    },
  );
}
exposeTool(
  EVM_WALLET_TOOLS.operationStatus,
  {
    title: "EVM Wallet operation status",
    description:
      "Reconcile one saved request owned by the authenticated caller installation. This updates its journal and may rebroadcast the exact transaction bytes already approved and signed. It never creates a new transaction or repeats an uncertain signature.",
    inputSchema: evmOperationStatusInputSchema,
    outputSchema: evmOperationStatusOutputSchema,
    annotations: { "neutron:effects": ["read", "write", "network"] },
  },
  async (args, context) => {
    const request = parseEvmOperationStatusRequest(args),
      identity = invocationIdentity(context, request.requestId);
    let raw: unknown;
    try {
      raw = await context.kernel.updateSelf(
        METHODS.status,
        [{ identity, refresh: true }],
        120,
      );
    } catch (error) {
      if (errorMessage(error) === "not_found")
        return { ...request, status: "not_found" };
      throw error;
    }
    const r = record(raw, "status result");
    if (r.err === "not_found") return { ...request, status: "not_found" };
    const operation = parseOperation(raw);
    if (
      operation.chainId !== request.chainId ||
      operation.accountId !== request.accountId
    )
      throw new Error("Operation status scope mismatch");
    return operationJson(operation);
  },
);

exposeTool(
  EVM_WALLET_TOOLS.transaction,
  {
    title: "Read EVM transaction evidence",
    description:
      "Read public transaction fields and its canonical receipt by exact network and hash, independently of the app that submitted it.",
    inputSchema: evmTransactionInputSchema,
    outputSchema: evmTransactionOutputSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  },
  async (args, context) => {
    const request = parseEvmTransactionRequest(args);
    const result = record(
      unwrap(
        await context.kernel.updateSelf(
          "evm_wallet_transaction_v1",
          [
            {
              chain_id: request.chainId,
              transaction_hash: request.transactionHash,
              ...(request.walletRequest
                ? {
                    wallet_request: {
                      caller_app_id: request.walletRequest.callerAppId,
                      caller_installation_uid:
                        request.walletRequest.callerInstallationUid,
                      request_id: request.walletRequest.requestId,
                    },
                  }
                : {}),
            },
          ],
          120,
        ),
      ),
      "transaction evidence",
    );
    const tx = JSON.parse(text(result.transaction_json, "transaction JSON"));
    const observedAtNs = natural(result.observed_at, "observation time"),
      finality =
        result.finality == null ? null : text(result.finality, "finality");
    return parseEvmTransactionResult(
      {
        chainId: natural(result.chain_id, "chain"),
        transactionHash: text(result.transaction_hash, "hash"),
        transaction:
          tx === null
            ? null
            : {
                from: tx.from,
                to: tx.to,
                data: tx.input,
                valueWei: quantity(tx.value, "value"),
                nonce: quantity(tx.nonce, "nonce"),
                blockNumber:
                  tx.blockNumber == null
                    ? null
                    : quantity(tx.blockNumber, "block"),
                blockHash: tx.blockHash,
              },
        receipt: receiptJson(
          result.receipt_json == null
            ? null
            : text(result.receipt_json, "receipt JSON"),
          finality,
          observedAtNs,
        ),
        observedAtNs,
        source: "evm_rpc",
        walletRequestMatches: result.wallet_request_matches ?? null,
      },
      request,
    ) as unknown as JsonObject;
  },
);
