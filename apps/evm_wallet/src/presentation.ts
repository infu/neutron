import { amount, decodeKnownCall, type Asset, type Network, type Operation } from "./data";
import { presentUniswapSwap } from "./swap_presentation.ts";
import { presentUniswapV4Swap } from "./v4_swap_presentation.ts";
import { presentPermit2Approval, presentUniswapLiquidity } from "./liquidity_presentation.ts";

export type PresentationField = { label: string; value: string };
export type OperationPresentation = {
  title: string;
  amount: string | null;
  amountLabel: string;
  description: string;
  parties: PresentationField[];
  contract: string | null;
  nativeValue: string | null;
  unlimitedApproval: boolean;
  tokenSymbol: string | null;
  tokenAddress?: string | null;
  advancedDetails?: PresentationField[];
  liquidity?: LiquidityPresentation;
  permit2Approval?: { token: string; spender: string; amount: string; expiration: string };
  swap?: {
    protocol?: "v3" | "v4";
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    amountOutMinimum: string;
    recipient: string;
    deadline: string;
    poolFee: string;
    inputNative: boolean;
    outputNative: boolean;
    poolKey?: { currency0: string; currency1: string; fee: string; tickSpacing: string; hooks: string };
    hookData?: string;
    minHopPriceX36?: string;
    refundRecipient?: string;
  };
};

export type LiquidityPresentation = {
  protocol: "v3" | "v4";
  action: "mint" | "increase" | "decrease" | "collect" | "close";
  tokenId?: string;
  token0?: string;
  token1?: string;
  liquidity?: string;
  amount0Max?: string;
  amount1Max?: string;
  amount0Min?: string;
  amount1Min?: string;
  collect0Max?: string;
  collect1Max?: string;
  recipient?: string;
  deadline?: string;
  tickLower?: string;
  tickUpper?: string;
  fee?: string;
  tickSpacing?: string;
  hooks?: string;
  hookData?: string;
  settlementCurrencies?: string[];
  refundRecipient?: string;
  nativeValue?: string;
};

const MAX_UINT256 = (2n ** 256n - 1n).toString();

/** Presentation comes from the exact candidate calldata, not the requesting app's description. */
export function presentOperation(
  operation: Operation,
  assets: readonly Asset[] = [],
  network?: Network,
): OperationPresentation {
  const tx = operation.preparedTransaction ?? operation.intent.transaction;
  const nativeSymbol = network?.nativeSymbol ?? "ETH";
  const base: OperationPresentation = {
    title: operation.kind === "message" ? "Sign message" : "Sign typed data",
    amount: null,
    amountLabel: "Amount",
    description: "Review what you are signing before confirming.",
    parties: [],
    contract: null,
    nativeValue: null,
    unlimitedApproval: false,
    tokenSymbol: null,
  };
  if (!tx) return base;

  const nativeValue = `${amount(tx.value)} ${nativeSymbol}`;
  if (operation.intent.replacement) {
    const cancel = operation.intent.replacement.cancel;
    const replacement = presentOperation({ ...operation, intent: { transaction: tx } }, assets, network);
    return {
      ...replacement,
      title: cancel ? "Cancel transaction" : "Speed up transaction",
      description: cancel
        ? "Send a replacement to try to cancel the pending transaction. The original may still complete first."
        : "Send the same transaction with a higher network fee. Only one transaction with this nonce can complete.",
      amount: cancel ? null : replacement.amount,
      nativeValue: cancel ? null : replacement.nativeValue,
    };
  }

  const swap = presentUniswapSwap(operation, assets) ?? presentUniswapV4Swap(operation, assets);
  if (swap) return swap;
  const liquidity = presentUniswapLiquidity(operation, assets) ?? presentPermit2Approval(operation, assets);
  if (liquidity) return liquidity;
  const decoded = decodeKnownCall(tx.data);
  const token = assets.find((asset) => asset.chainId === operation.chainId && asset.address.toLowerCase() === tx.to.toLowerCase());
  if (decoded) {
    const details = new Map(decoded.details);
    const approval = decoded.name === "ERC-20 approval";
    const atomic = details.get(approval ? "Allowance (atomic units)" : "Amount (atomic units)")!;
    const unlimitedApproval = approval && atomic === MAX_UINT256;
    const revoke = approval && atomic === "0";
    const tokenName = token?.symbol ?? "token";
    const displayAmount = unlimitedApproval
      ? `Unlimited${token ? ` ${token.symbol}` : " tokens"}`
      : token ? `${amount(atomic, token.decimals)} ${token.symbol}` : `${atomic} atomic units`;
    const parties: PresentationField[] = [];
    for (const label of ["Token owner", "Recipient", "Spender"]) {
      const value = details.get(label);
      if (value) parties.push({ label, value });
    }
    return {
      ...base,
      title: approval
        ? revoke ? `Revoke ${tokenName} allowance` : `Approve ${tokenName}`
        : `Send ${tokenName}`,
      amount: displayAmount,
      amountLabel: approval ? "Spending limit" : "Amount",
      description: approval
        ? revoke
          ? "Remove this spender's token allowance."
          : unlimitedApproval
            ? "Allow this spender to use any amount of this token, including tokens you receive later. This approval does not perform a swap or deposit liquidity."
            : "Allow this spender to use up to this amount. This approval does not perform a swap or deposit liquidity."
        : details.has("Token owner")
          ? "Transfer tokens from the listed owner to the recipient."
          : "Transfer tokens to the recipient.",
      parties,
      contract: tx.to,
      nativeValue: tx.value === "0" ? null : nativeValue,
      unlimitedApproval,
      tokenSymbol: token?.symbol ?? null,
      tokenAddress: tx.to,
    };
  }

  const nativeTransfer = tx.data === "0x";
  return {
    ...base,
    title: nativeTransfer ? `Send ${nativeSymbol}` : "Contract interaction",
    ...(nativeTransfer ? { tokenAddress: null } : {}),
    amount: nativeTransfer || tx.value !== "0" ? nativeValue : null,
    description: nativeTransfer ? "Transfer to the recipient." : "Interact with this contract. Review the requesting app and transaction details.",
    parties: [{ label: nativeTransfer ? "Recipient" : "Contract", value: tx.to }],
    contract: nativeTransfer ? null : tx.to,
    nativeValue: null,
  };
}

export function operationStatusLabel(status: string): string {
  return ({
    preparing: "Preparing",
    prepared: "Ready to confirm",
    signing: "Signing",
    signed: "Signed",
    submitted: "Pending",
    confirmed: "Confirmed",
    finalized: "Confirmed",
    unknown: "Checking transaction",
    failed: "Failed",
    reverted: "Failed",
    rejected: "Declined",
    replaced: "Replaced",
  } as Record<string, string>)[status] ?? status;
}

export function operationStatusMessage(status: string, kind = "transaction"): string {
  if (status === "signed" && kind !== "transaction") return "Your signature is ready.";
  return ({
    preparing: "Checking the transaction and network fee…",
    prepared: "Review and confirm when you are ready.",
    signing: "Signing your request…",
    signed: "Your transaction is signed. Checking whether the network has received it…",
    submitted: "Waiting for the network to confirm your transaction…",
    confirmed: "Your transaction was confirmed.",
    finalized: "Your transaction was confirmed.",
    unknown: "The network result is not confirmed yet. Your request is saved while we check.",
    failed: "The transaction did not complete. See the error for details.",
    reverted: "The network reverted this transaction. No transfer or contract action completed, but a network fee may have been charged.",
    rejected: "You declined this request.",
    replaced: "Another transaction replaced this request.",
  } as Record<string, string>)[status] ?? "";
}

export type TypedDataPresentation = {
  domainName: string | null;
  chainId: string | null;
  verifyingContract: string | null;
  primaryType: string | null;
  fields: PresentationField[];
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function unsafeNumber(value: unknown): boolean {
  if (typeof value === "number") return !Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.some(unsafeNumber);
  return object(value) !== null && Object.values(value as Record<string, unknown>).some(unsafeNumber);
}

function fieldValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "";
}

/** Plain text only; callers render these fields as text and retain the original JSON for review. */
export function presentTypedData(json: string): TypedDataPresentation | null {
  try {
    const parsed = object(JSON.parse(json));
    // A rounded JSON number cannot summarize an exact authorization. Fall back
    // to the original JSON as the primary review content in that case.
    if (!parsed || unsafeNumber(parsed)) return null;
    const domain = object(parsed.domain);
    const message = object(parsed.message);
    return {
      domainName: typeof domain?.name === "string" ? domain.name : null,
      chainId: domain?.chainId == null ? null : fieldValue(domain.chainId),
      verifyingContract: typeof domain?.verifyingContract === "string" ? domain.verifyingContract : null,
      primaryType: typeof parsed.primaryType === "string" ? parsed.primaryType : null,
      fields: Object.entries(message ?? {}).map(([label, value]) => ({ label, value: fieldValue(value) })),
    };
  } catch {
    return null;
  }
}
