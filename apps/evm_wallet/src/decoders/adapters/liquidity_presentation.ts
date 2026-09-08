import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, parseAbiParameters, type Hex } from "viem";
import { amount, type Asset, type Operation } from "../../data.ts";
import type { LiquidityPresentation, OperationPresentation, PresentationField } from "../../presentation.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const V3_MANAGER = "0xc36442b4a4522e871399cd717abdd847ab11fe88";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const MAX_UINT128 = 2n ** 128n - 1n;
const MAX_UINT160 = 2n ** 160n - 1n;
const NETWORKS: Record<string, { manager: string; wrapped: string }> = {
  "1": { manager: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e", wrapped: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" },
  "42161": { manager: "0xd88f38f930b7952f2db2432cb002e7abbf3dd869", wrapped: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1" },
};
const V3_ABI = parseAbi([
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable",
  "function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable",
  "function burn(uint256 tokenId) payable",
  "function refundETH() payable",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function sweepToken(address token,uint256 amountMinimum,address recipient) payable",
]);
const V4_ABI = parseAbi([
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function modifyLiquidities(bytes unlockData,uint256 deadline) payable",
]);
const PERMIT_ABI = parseAbi(["function approve(address token,address spender,uint160 amount,uint48 expiration)"]);
const UNLOCK = parseAbiParameters("bytes actions, bytes[] params");
const MINT = parseAbiParameters("(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,int24 tickLower,int24 tickUpper,uint256 liquidity,uint128 amount0Max,uint128 amount1Max,address recipient,bytes hookData");
const MODIFY = parseAbiParameters("uint256 tokenId,uint256 liquidity,uint128 amount0,uint128 amount1,bytes hookData");
const BURN = parseAbiParameters("uint256 tokenId,uint128 amount0,uint128 amount1,bytes hookData");
const PAIR = parseAbiParameters("address currency0,address currency1");
const CURRENCY = parseAbiParameters("address currency");
const TAKE_PAIR = parseAbiParameters("address currency0,address currency1,address recipient");
const SWEEP = parseAbiParameters("address currency,address recipient");

function equal(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
function ordered(a: string, b: string): boolean { return BigInt(a) < BigInt(b); }
function display(value: string, address: string | undefined, operation: Operation, assets: readonly Asset[], native = true): string {
  if (address && equal(address, ZERO) && native) return `${amount(value)} ETH`;
  const token = address && assets.find(asset => asset.chainId === operation.chainId && equal(asset.address, address));
  return token ? `${amount(value, token.decimals)} ${token.symbol}` : `${value} atomic units${address ? ` · ${getAddress(address)}` : ""}`;
}
function resolveRecipient(address: string, operation: Operation, manager: string): string | null {
  if (equal(address, MSG_SENDER)) return operation.address ? getAddress(operation.address) : null;
  if (equal(address, ADDRESS_THIS)) return getAddress(manager);
  return getAddress(address);
}

// A recognized summary consumes the complete call sequence. Anything outside
// these flows remains available as an ordinary contract interaction.
function decodeV3(data: Hex) {
  const call = decodeFunctionData({ abi: V3_ABI, data });
  if (encodeFunctionData({ abi: V3_ABI, ...call }).toLowerCase() !== data.toLowerCase()) throw new Error("Noncanonical call");
  return call;
}
function decodeV4(data: Hex) {
  const call = decodeFunctionData({ abi: V4_ABI, data });
  if (encodeFunctionData({ abi: V4_ABI, ...call }).toLowerCase() !== data.toLowerCase()) throw new Error("Noncanonical call");
  return call;
}
function exactParams<T extends readonly import("viem").AbiParameter[]>(abi: T, data: Hex | undefined) {
  if (!data) throw new Error("Missing action parameters");
  const values = decodeAbiParameters(abi, data);
  if (encodeAbiParameters(abi, values as never).toLowerCase() !== data.toLowerCase()) throw new Error("Noncanonical action");
  return values;
}

function presentation(operation: Operation, assets: readonly Asset[], details: LiquidityPresentation): OperationPresentation {
  const tx = operation.preparedTransaction ?? operation.intent.transaction!;
  const adding = details.action === "mint" || details.action === "increase";
  const collecting = details.action === "collect";
  const mint = details.action === "mint";
  const parties: PresentationField[] = [];
  if (details.tokenId) parties.push({ label: "Position", value: `Uniswap ${details.protocol.toUpperCase()} · #${details.tokenId}` });
  if (!adding && !collecting && details.amount0Min !== undefined && details.amount1Min !== undefined) {
    parties.push({ label: "Minimum token 0", value: display(details.amount0Min!, details.token0, operation, assets) });
    parties.push({ label: "Minimum token 1", value: display(details.amount1Min!, details.token1, operation, assets) });
  }
  if (details.collectionRecipient) {
    parties.push(
      { label: "Collection destination", value: details.collectionRecipient },
      { label: "Minimum ETH forwarded", value: `${amount(details.nativePayoutMin!)} ETH` },
      { label: "Token swept from manager", value: details.sweptToken! },
      { label: "Minimum swept token forwarded", value: display(details.tokenPayoutMin!, details.sweptToken, operation, assets, false) },
    );
  }
  if (details.recipient) parties.push({ label: mint ? "Position owner" : details.collectionRecipient ? "Forwarding recipient" : "Recipient", value: details.recipient });
  if (adding && !mint && BigInt(tx.value) !== 0n) parties.push({ label: "Native funding", value: `${amount(tx.value)} ETH · excess refunded` });
  const advancedDetails: PresentationField[] = [
    { label: "Protocol", value: `Uniswap ${details.protocol.toUpperCase()}` },
    ...Object.entries(details).filter(([key]) => !["protocol", "action"].includes(key))
      .map(([label, value]) => ({ label, value: Array.isArray(value) ? value.join(", ") : String(value) })),
  ];
  const wrapped = NETWORKS[operation.chainId]?.wrapped;
  const inputCurrency = (token: string | undefined) => mint && details.protocol === "v3" && BigInt(tx.value) !== 0n && token && wrapped && equal(token, wrapped) ? ZERO : token;
  const amountText = adding ? [display(details.amount0Max!, inputCurrency(details.token0), operation, assets), display(details.amount1Max!, inputCurrency(details.token1), operation, assets)].join(" + ") : null;
  const intermediaryDescription = details.collectionRecipient
    ? `${collecting ? "Collect" : details.action === "close" && details.amount0Min === undefined ? "Collect the empty position's remaining tokens" : "Withdraw liquidity and collect"} into the NFT manager, then forward its WETH as ETH and the listed token.${details.action === "close" ? " Burn the emptied position NFT afterward." : ""} The forwarding currencies are not verified against this NFT; other collected tokens may remain in the manager.`
    : null;
  return {
    title: mint ? "Create liquidity position" : adding ? "Add liquidity" : collecting ? "Collect position fees" : details.action === "close" ? "Close liquidity position" : "Remove liquidity",
    amount: amountText,
    amountLabel: "Maximum deposit",
    description: intermediaryDescription ?? (mint ? "Deposit tokens into a Uniswap liquidity position. The position NFT goes to the listed owner."
      : adding ? "Add tokens to this position within the transaction's limits. Amounts use the position's on-chain token order."
      : collecting ? "Collect the position's accrued tokens. The received amounts depend on its on-chain balances."
      : details.action === "close" ? details.amount0Min !== undefined ? "Withdraw and collect this position's tokens, then burn its NFT. The transaction enforces the withdrawal minima." : "Collect the empty position's remaining tokens, then burn its NFT."
      : "Withdraw liquidity and collect tokens in this transaction. The transaction enforces the withdrawal minima."),
    parties, contract: tx.to,
    nativeValue: null,
    unlimitedApproval: false, tokenSymbol: null, advancedDetails, liquidity: details,
    ...(details.sweptToken ? { tokenAddresses: [details.sweptToken] } : {}),
  };
}

function v3Details(operation: Operation): LiquidityPresentation | null {
  const tx = operation.preparedTransaction ?? operation.intent.transaction!;
  const network = NETWORKS[operation.chainId];
  if (!network) return null;
  const outer = decodeV3(tx.data as Hex);
  const calls = outer.functionName === "multicall" ? outer.args[0].map(decodeV3) : [outer];
  const first = calls[0];
  const value = BigInt(tx.value);
  if (!first) return null;
  let cursor = 1;
  if (first.functionName === "mint" || first.functionName === "increaseLiquidity") {
    const p = first.args[0];
    if (p.amount0Min > p.amount0Desired || p.amount1Min > p.amount1Desired) return null;
    const details: LiquidityPresentation = {
      protocol: "v3", action: first.functionName === "mint" ? "mint" : "increase",
      amount0Max: p.amount0Desired.toString(), amount1Max: p.amount1Desired.toString(),
      amount0Min: p.amount0Min.toString(), amount1Min: p.amount1Min.toString(), deadline: p.deadline.toString(),
    };
    if (first.functionName === "mint") {
      const p = first.args[0];
      if (!ordered(p.token0, p.token1) || p.tickLower >= p.tickUpper || equal(p.recipient, ZERO)) return null;
      Object.assign(details, { token0: p.token0, token1: p.token1, recipient: p.recipient, fee: p.fee.toString(), tickLower: p.tickLower.toString(), tickUpper: p.tickUpper.toString() });
      if (value !== 0n) {
        const funded = equal(p.token0, network.wrapped) ? p.amount0Desired : equal(p.token1, network.wrapped) ? p.amount1Desired : null;
        if (funded !== value) return null;
      }
    } else details.tokenId = first.args[0].tokenId.toString();
    if (value !== 0n) {
      if (calls[cursor]?.functionName !== "refundETH") return null;
      if (value !== p.amount0Desired && value !== p.amount1Desired) return null;
      cursor++;
      details.nativeValue = value.toString();
      details.refundRecipient = operation.address;
    }
    return cursor === calls.length ? details : null;
  }
  if (value !== 0n) return null;
  let details: LiquidityPresentation;
  if (first.functionName === "decreaseLiquidity") {
    const p = first.args[0];
    if (p.liquidity === 0n) return null;
    details = { protocol: "v3", action: "decrease", tokenId: p.tokenId.toString(), liquidity: p.liquidity.toString(), amount0Min: p.amount0Min.toString(), amount1Min: p.amount1Min.toString(), deadline: p.deadline.toString() };
  } else if (first.functionName === "collect") {
    details = { protocol: "v3", action: "collect", tokenId: first.args[0].tokenId.toString() };
    cursor = 0;
  } else return null;
  const collect = calls[cursor++];
  if (collect?.functionName !== "collect" || collect.args[0].tokenId.toString() !== details.tokenId) return null;
  const c = collect.args[0];
  // A decrease followed by a limited collection may leave the withdrawn
  // balance in the NFT manager. Do not describe it as fully paid to the wallet.
  if (details.action === "decrease" && (c.amount0Max !== MAX_UINT128 || c.amount1Max !== MAX_UINT128)) return null;
  details.collect0Max = c.amount0Max.toString();
  details.collect1Max = c.amount1Max.toString();
  details.recipient = c.recipient;
  if (equal(c.recipient, ZERO)) {
    const unwrap = calls[cursor++], sweep = calls[cursor++];
    if (unwrap?.functionName !== "unwrapWETH9" || sweep?.functionName !== "sweepToken" || !equal(unwrap.args[1], sweep.args[2]) || equal(sweep.args[0], network.wrapped) || equal(unwrap.args[1], ZERO) || equal(unwrap.args[1], tx.to)) return null;
    details.recipient = unwrap.args[1];
    details.collectionRecipient = getAddress(tx.to);
    details.nativePayoutMin = unwrap.args[0].toString();
    details.sweptToken = getAddress(sweep.args[0]);
    details.tokenPayoutMin = sweep.args[1].toString();
    details.settlementCurrencies = [network.wrapped, sweep.args[0]];
  } else if (equal(c.recipient, tx.to)) return null;
  const burn = calls[cursor];
  if (burn?.functionName === "burn") {
    if (burn.args[0].toString() !== details.tokenId || c.amount0Max !== MAX_UINT128 || c.amount1Max !== MAX_UINT128) return null;
    details.action = "close";
    cursor++;
  }
  return cursor === calls.length ? details : null;
}

function v4Details(operation: Operation): LiquidityPresentation | null {
  const tx = operation.preparedTransaction ?? operation.intent.transaction!;
  const outer = decodeV4(tx.data as Hex);
  const calls = outer.functionName === "multicall" ? outer.args[0].map(decodeV4) : [outer];
  const modify = calls[0];
  if (calls.length !== 1 || modify?.functionName !== "modifyLiquidities") return null;
  const [unlock, deadline] = modify.args;
  const [actionsHex, params] = exactParams(UNLOCK, unlock);
  const actions = actionsHex.slice(2).match(/../g)?.map(value => Number.parseInt(value, 16)) ?? [];
  if (actions.length !== params.length || !actions.length) return null;
  const action = actions[0];
  let details: LiquidityPresentation;
  let currency0: string, currency1: string;
  let cursor = 1;
  let adding = false;
  if (action === 2) {
    const [key, lower, upper, liquidity, max0, max1, owner, hookData] = exactParams(MINT, params[0]);
    if (!ordered(key.currency0, key.currency1) || lower >= upper || liquidity === 0n) return null;
    const recipient = resolveRecipient(owner, operation, tx.to);
    if (!recipient || equal(recipient, ZERO) || equal(recipient, tx.to)) return null;
    details = { protocol: "v4", action: "mint", token0: key.currency0, token1: key.currency1, liquidity: liquidity.toString(), amount0Max: max0.toString(), amount1Max: max1.toString(), recipient, tickLower: lower.toString(), tickUpper: upper.toString(), fee: key.fee.toString(), tickSpacing: key.tickSpacing.toString(), hooks: key.hooks, hookData };
    if (actions[cursor] !== 13) return null;
    [currency0, currency1] = exactParams(PAIR, params[cursor++]);
    if (!equal(currency0, key.currency0) || !equal(currency1, key.currency1)) return null;
    adding = true;
  } else if (action === 0 || action === 1) {
    const [id, liquidity, amount0, amount1, hookData] = exactParams(MODIFY, params[0]);
    if (action === 0 && liquidity === 0n) return null;
    if (action === 1 && liquidity === 0n && (amount0 !== 0n || amount1 !== 0n)) return null;
    details = { protocol: "v4", action: action === 0 ? "increase" : liquidity === 0n ? "collect" : "decrease", tokenId: id.toString(), liquidity: liquidity.toString(), hookData };
    if (action === 0) {
      details.amount0Max = amount0.toString(); details.amount1Max = amount1.toString();
      if (actions[cursor] !== 18 || actions[cursor + 1] !== 18) return null;
      [currency0] = exactParams(CURRENCY, params[cursor++]);
      [currency1] = exactParams(CURRENCY, params[cursor++]);
      adding = true;
    } else {
      details.amount0Min = amount0.toString(); details.amount1Min = amount1.toString();
      if (actions[cursor] !== 17) return null;
      const p = exactParams(TAKE_PAIR, params[cursor++]);
      [currency0, currency1] = p;
      const recipient = resolveRecipient(p[2], operation, tx.to);
      if (!recipient || equal(recipient, ZERO) || equal(recipient, tx.to)) return null;
      details.recipient = recipient;
    }
  } else if (action === 3) {
    const [id, min0, min1, hookData] = exactParams(BURN, params[0]);
    if (actions[cursor] !== 17) return null;
    const p = exactParams(TAKE_PAIR, params[cursor++]);
    [currency0, currency1] = p;
    const recipient = resolveRecipient(p[2], operation, tx.to);
    if (!recipient || equal(recipient, ZERO) || equal(recipient, tx.to)) return null;
    details = { protocol: "v4", action: "close", tokenId: id.toString(), amount0Min: min0.toString(), amount1Min: min1.toString(), recipient, hookData };
  } else return null;
  if (!ordered(currency0, currency1)) return null;
  // For existing NFTs, currencies in settlement commands are not independent
  // proof of the NFT's PoolKey. Keep its token-0/token-1 limits explicitly atomic.
  details.settlementCurrencies = [currency0, currency1];
  details.deadline = deadline.toString();
  const value = BigInt(tx.value);
  if (adding && equal(currency0, ZERO)) {
    if (value.toString() !== details.amount0Max || actions[cursor] !== 20) return null;
    const [currency, target] = exactParams(SWEEP, params[cursor++]);
    const refund = resolveRecipient(target, operation, tx.to);
    if (!equal(currency, ZERO) || !refund || !operation.address || !equal(refund, operation.address)) return null;
    details.refundRecipient = refund; details.nativeValue = value.toString();
  } else if (value !== 0n) return null;
  return cursor === actions.length ? details : null;
}

export function presentUniswapLiquidity(operation: Operation, assets: readonly Asset[]): OperationPresentation | null {
  const tx = operation.preparedTransaction ?? operation.intent.transaction;
  const network = NETWORKS[operation.chainId];
  if (!tx || !network) return null;
  try {
    const details = equal(tx.to, V3_MANAGER) ? v3Details(operation) : equal(tx.to, network.manager) ? v4Details(operation) : null;
    return details ? presentation(operation, assets, details) : null;
  } catch { return null; }
}

export function presentPermit2Approval(operation: Operation, assets: readonly Asset[]): OperationPresentation | null {
  const tx = operation.preparedTransaction ?? operation.intent.transaction;
  if (!tx || !NETWORKS[operation.chainId] || !equal(tx.to, PERMIT2) || BigInt(tx.value) !== 0n) return null;
  try {
    const call = decodeFunctionData({ abi: PERMIT_ABI, data: tx.data as Hex });
    if (encodeFunctionData({ abi: PERMIT_ABI, ...call }).toLowerCase() !== tx.data.toLowerCase()) return null;
    const [token, spender, limit, expiration] = call.args;
    const asset = assets.find(asset => asset.chainId === operation.chainId && equal(asset.address, token));
    const unlimitedApproval = limit === MAX_UINT160;
    // Permit2 stores the approval block's timestamp for zero, and permits
    // spending until a later timestamp (including later blocks sharing it).
    const expiry = expiration === 0 ? "Approval block timestamp" : (() => {
      const ms = Number(expiration) * 1000;
      return Number.isFinite(ms) && ms <= 8.64e15 ? new Date(ms).toISOString().replace(".000Z", " UTC") : `${expiration} Unix seconds`;
    })();
    return {
      title: limit === 0n ? `Revoke ${asset?.symbol ?? "token"} allowance` : `Approve ${asset?.symbol ?? "token"} spending`,
      amount: unlimitedApproval ? `Unlimited ${asset?.symbol ?? "tokens"}` : display(limit.toString(), token, operation, assets, false),
      amountLabel: "Permit2 spending limit",
      description: limit === 0n ? "Remove this spender's Permit2 token allowance." : `Allow the listed spender to use this token through Permit2 until expiry.${expiration === 0 ? " Spending is allowed at the approval block's timestamp and expires once the block timestamp advances." : ""} This approval does not perform a swap or deposit liquidity.`,
      parties: [{ label: "Spender", value: spender }, { label: "Expires", value: expiry }],
      contract: tx.to, nativeValue: null, unlimitedApproval, tokenSymbol: asset?.symbol ?? null, tokenAddress: token,
      permit2Approval: { token, spender, amount: limit.toString(), expiration: expiration.toString() },
    };
  } catch { return null; }
}
