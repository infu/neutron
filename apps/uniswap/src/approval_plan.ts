import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Address } from "viem";
import type { ActionPlan } from "./action_types.ts";
import { TOKEN_ABI, tokenRequiresApprovalReset, type Reader } from "./swap.ts";

export const PERMIT2 = getAddress("0x000000000022d473030f116ddee9f6b43ac78ba3");

const PERMIT2_ABI = parseAbi([
  "function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
]);

type ActionStep = ActionPlan["steps"][number];
type ApprovalInput = {
  chainId: string;
  accountId: string;
  owner: Address;
  token: Address;
  spender: Address;
  amount: string;
  symbol?: string;
};

function unsigned(value: string, bits: number, label: string): bigint {
  if (/^(?:0|[1-9][0-9]*)$/u.exec(value)?.[0] !== value) throw new Error(`${label} must be a uint${bits}.`);
  const parsed = BigInt(value);
  if (parsed >= 2n ** BigInt(bits)) throw new Error(`${label} must fit uint${bits}.`);
  return parsed;
}

/** Plan only: no approval is signed or submitted until the operation runs it. */
export async function planErc20Approval(read: Reader, input: ApprovalInput): Promise<ActionStep[]> {
  const amount = unsigned(input.amount, 256, "Approval amount");
  if (amount === 0n) return [];
  const owner = getAddress(input.owner), token = getAddress(input.token), spender = getAddress(input.spender);
  const result = await read(input.chainId, token, encodeFunctionData({ abi: TOKEN_ABI, functionName: "allowance", args: [owner, spender] }));
  const allowance = decodeFunctionResult({ abi: TOKEN_ABI, functionName: "allowance", data: result.data });
  if (allowance >= amount) return [];
  const step = (value: bigint, label: string): ActionStep => ({
    kind: "approval", label,
    transaction: { chainId: input.chainId, accountId: input.accountId, to: token, value: "0",
      data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [spender, value] }) },
  });
  const label = input.symbol ?? "token";
  // Ethereum's deployed USDT requires clearing a nonzero allowance first.
  // Ordinary ERC20s can replace it directly; symbols do not identify behavior.
  // Arbitrum USDT0 is different: ArbitrumExtensionV2 inherits the direct OZ
  // allowance assignment (verified implementation 0x3263cd783823d04a6b9819517e0e6840d37ca3f4).
  const requiresReset = tokenRequiresApprovalReset(input.chainId, token);
  return [
    ...(requiresReset && allowance > 0n ? [step(0n, `Reset ${label} approval`)] : []),
    step(amount, `Approve ${label}`),
  ];
}

export async function planPermit2Approval(read: Reader, input: ApprovalInput & { expiration: string; nowSeconds?: string }): Promise<ActionStep[]> {
  const amount = unsigned(input.amount, 160, "Permit2 approval amount");
  const expiration = unsigned(input.expiration, 48, "Permit2 expiration");
  if (amount === 0n) return [];
  const now = unsigned(input.nowSeconds ?? Math.floor(Date.now() / 1000).toString(), 48, "Current time");
  if (expiration <= now) throw new Error("Permit2 approval expiration has passed. Prepare a new operation.");
  const owner = getAddress(input.owner), token = getAddress(input.token), spender = getAddress(input.spender);
  const result = await read(input.chainId, PERMIT2, encodeFunctionData({ abi: PERMIT2_ABI, functionName: "allowance", args: [owner, token, spender] }));
  const [allowance, expires] = decodeFunctionResult({ abi: PERMIT2_ABI, functionName: "allowance", data: result.data });
  if (allowance >= amount && BigInt(expires) >= expiration) return [];
  return [{
    kind: "approval", label: `Authorize ${input.symbol ?? "token"} spending`,
    transaction: { chainId: input.chainId, accountId: input.accountId, to: PERMIT2, value: "0",
      // uint48 is exactly representable as a JavaScript number after the bound
      // check above; uint160 remains a bigint throughout.
      data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: "approve", args: [token, spender, amount, Number(expiration)] }) },
  }];
}

/** Authorize ERC20 → Permit2 → the exact router or position manager. Native
 * currency is supplied as transaction value and must not appear in tokens. */
export async function permit2ApprovalSteps(read: Reader, input: {
  chainId: string;
  accountId: string;
  accountAddress: Address;
  spender: Address;
  deadline: string;
  nowSeconds?: string;
  tokens: Array<{ address: Address; amount: string; symbol?: string }>;
}): Promise<ActionStep[]> {
  const steps: ActionStep[] = [];
  for (const token of input.tokens) {
    // Check the narrower Permit2 amount before planning the ERC20 allowance.
    if (unsigned(token.amount, 160, "Permit2 approval amount") === 0n) continue;
    const common = { chainId: input.chainId, accountId: input.accountId, owner: input.accountAddress,
      token: token.address, amount: token.amount, ...(token.symbol === undefined ? {} : { symbol: token.symbol }) };
    steps.push(...await planErc20Approval(read, { ...common, spender: PERMIT2 }));
    steps.push(...await planPermit2Approval(read, { ...common, spender: input.spender, expiration: input.deadline,
      ...(input.nowSeconds === undefined ? {} : { nowSeconds: input.nowSeconds }) }));
  }
  return steps;
}
