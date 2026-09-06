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
  evmCallContractInputSchema,
  evmCallContractOutputSchema,
  evmReplaceTransactionInputSchema,
  evmSendTransactionInputSchema,
  evmSignMessageInputSchema,
  evmSignTypedDataInputSchema,
  evmOperationOutputSchema,
  evmOperationStatusInputSchema,
  evmOperationStatusOutputSchema,
  parseEvmOperationStatusRequest,
  evmTransactionInputSchema,
  evmTransactionOutputSchema,
  parseEvmAccountsResult,
  parseEvmNetworksResult,
  evmEstimateTransactionInputSchema,
  evmEstimateTransactionOutputSchema,
  evmReplacementTransactionInputSchema,
  evmReplacementTransactionOutputSchema,
} from "neutron-tools/evm_wallet";
import {
  METHODS,
  parseAccounts,
  parseSnapshot,
  record,
  unwrap,
} from "./data.ts";
import {
  handleHumanEffect,
  handleRootEffect,
  invocationIdentity,
  operationJson,
} from "./provider.ts";
import { balances, readContract, callContract, estimateTransaction, transaction, replacementTransaction } from "./read_adapters.ts";
import { readBrowserOperation, reconcileBrowserOperation } from "./browser_operations.ts";

const bytesHex = (bytes: Uint8Array) =>
  `0x${[...bytes].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
exposeTool(
  EVM_WALLET_TOOLS.callContract,
  {
    title: "Read EVM contract result",
    description:
      "Read eth_call return bytes at the latest or an explicit block without downloading contract code. The browser contacts the configured RPC provider directly; no transaction is signed.",
    inputSchema: evmCallContractInputSchema,
    outputSchema: evmCallContractOutputSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  },
  callContract,
);
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
    const snapshot = record(unwrap(await context.kernel.querySelf(METHODS.snapshot, [null])), "wallet snapshot");
    let raw = snapshot.accounts;
    if (!Array.isArray(raw)) throw new Error("Invalid wallet accounts");
    if (raw.length === 0) raw = unwrap(await context.kernel.updateSelf(METHODS.accounts, [null], 120));
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
  balances,
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
  readContract,
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
    const saved = await readBrowserOperation(context.kernel, identity);
    if (!saved) return { ...request, status: "not_found" };
    if (
      saved.chainId !== request.chainId ||
      saved.accountId !== request.accountId
    )
      throw new Error("Operation status scope mismatch");
    const operation = await reconcileBrowserOperation(context.kernel, saved, context.signal ? { signal: context.signal } : {});
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
  transaction,
);
