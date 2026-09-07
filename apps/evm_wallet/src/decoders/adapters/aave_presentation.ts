import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { amount, type Asset, type Operation } from "../../data.ts";
import type { OperationPresentation, PresentationField } from "../../presentation.ts";

// Aave V3 Ethereum Core and Arbitrum, reviewed 2026-09-07 against:
// https://github.com/bgd-labs/aave-address-book/blob/12963110f29699d214531b9ab4c7cfcec460c298/src/AaveV3Ethereum.sol
// https://github.com/bgd-labs/aave-address-book/blob/12963110f29699d214531b9ab4c7cfcec460c298/src/AaveV3Arbitrum.sol
// Recognition depends on the chain, destination and complete candidate bytes.
// Neither the requesting app nor its description confers protocol identity.
const MARKETS: Record<string, { name: string; pool: string; rewards: string; gateway: string; weth: string; aWeth: string; wethDebt: string }> = {
  "1": {
    name: "Ethereum Core", pool: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", rewards: "0x8164cc65827dcfe994ab23944cbc90e0aa80bfcb",
    gateway: "0xd01607c3c5ecaba394d8be377a08590149325722", weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", wethDebt: "0xea51d7853eefb32b6ee06b1c12e6dcca88be0ffe",
    aWeth: "0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8",
  },
  "42161": {
    name: "Arbitrum", pool: "0x794a61358d6845594f94dc1db02a252b5b4814ad", rewards: "0x929ec64c34a17401f460460d4b9390518e5b473e",
    gateway: "0x5283beced7adf6d003225c13896e536f2d4264ff", weth: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", wethDebt: "0x0c84331e39d6658cd6e6b9ba04736cc4c4734351",
    aWeth: "0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8",
  },
};
const MAX = 2n ** 256n - 1n;
const POOL = parseAbi([
  "function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)",
  "function withdraw(address asset,uint256 amount,address to) returns (uint256)",
  "function borrow(address asset,uint256 amount,uint256 interestRateMode,uint16 referralCode,address onBehalfOf)",
  "function repay(address asset,uint256 amount,uint256 interestRateMode,address onBehalfOf) returns (uint256)",
  "function repayWithATokens(address asset,uint256 amount,uint256 interestRateMode) returns (uint256)",
  "function setUserUseReserveAsCollateral(address asset,bool useAsCollateral)",
  "function setUserEMode(uint8 categoryId)",
]);
const REWARDS = parseAbi([
  "function claimRewards(address[] assets,uint256 amount,address to,address reward) returns (uint256)",
  "function claimRewardsToSelf(address[] assets,uint256 amount,address reward) returns (uint256)",
  "function claimAllRewards(address[] assets,address to) returns (address[],uint256[])",
  "function claimAllRewardsToSelf(address[] assets) returns (address[],uint256[])",
]);
// Current immutable gateways use the no-rate-mode borrow/repay selectors.
// Their first address argument is retained for interface compatibility and
// ignored by the contract; POOL is immutable. Old rate-mode selectors must not
// be summarized as if these gateways support them.
const GATEWAY = parseAbi([
  "function depositETH(address pool,address onBehalfOf,uint16 referralCode) payable",
  "function withdrawETH(address pool,uint256 amount,address to)",
  "function borrowETH(address pool,uint256 amount,uint16 referralCode)",
  "function repayETH(address pool,uint256 amount,address onBehalfOf) payable",
]);
const DELEGATION = parseAbi(["function approveDelegation(address delegatee,uint256 amount)"]);
const APPROVAL = parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]);
const field = (label: string, value: string | bigint | number): PresentationField => ({ label, value: String(value) });
const addressField = (label: string, address: string) => field(label, getAddress(address));

/** Exact-byte descriptions shared by the owner dialog and Agent review. */
export function presentAave(operation: Operation, assets: readonly Asset[]): OperationPresentation | null {
  const tx = operation.preparedTransaction ?? operation.intent.transaction;
  const market = MARKETS[operation.chainId];
  if (!tx || !market) return null;
  const destination = tx.to.toLowerCase();
  if (![market.pool, market.rewards, market.gateway, market.wethDebt, market.aWeth].includes(destination)) return null;
  if (destination !== market.gateway && tx.value !== "0") return null;
  try {
    const sender = getAddress(operation.address);
    const metadata = (address: string) => assets.find((asset) => asset.chainId === operation.chainId && asset.address.toLowerCase() === address.toLowerCase());
    const display = (atomic: bigint, address: string) => {
      const token = metadata(address);
      return token ? `${amount(atomic.toString(), token.decimals)} ${token.symbol}` : `${atomic} atomic units`;
    };
    const base: OperationPresentation = {
      title: "Aave interaction", amount: null, amountLabel: "Amount", description: "", parties: [],
      contract: tx.to, nativeValue: null, unlimitedApproval: false, tokenSymbol: null,
      advancedDetails: [field("Aave V3 market", market.name), field("Onchain expiry", "None")],
    };
    const withAsset = (address: string) => ({ ...base, tokenSymbol: metadata(address)?.symbol ?? null, tokenAddress: getAddress(address),
      ...(metadata(address) ? { amountDecimals: metadata(address)!.decimals } : {}),
    });
    // MAX quantities mean a balance/debt at execution or an unlimited grant.
    // They are not a currently known amount that can receive a USD estimate.
    const quantity = (atomic: bigint) => atomic === MAX ? {} : { amountAtoms: atomic.toString() };
    const advanced = (method: string, fields: PresentationField[] = []) => [...base.advancedDetails!, field("Method", method), ...fields];
    if (destination === market.aWeth) {
      const decoded = decodeFunctionData({ abi: APPROVAL, data: tx.data as Hex });
      if (encodeFunctionData({ abi: APPROVAL, ...decoded }).toLowerCase() !== tx.data.toLowerCase()) return null;
      const [spender, atomic] = decoded.args;
      return { ...base, title: atomic === 0n ? "Revoke aWETH allowance" : "Approve aWETH", amountLabel: "Spending limit",
        amount: atomic === MAX ? "Unlimited aWETH" : `${amount(atomic.toString())} aWETH`, ...quantity(atomic), amountDecimals: 18, tokenSymbol: "aWETH", tokenAddress: getAddress(market.aWeth), unlimitedApproval: atomic === MAX,
        description: atomic === 0n ? "Remove this spender's permission to transfer your supplied WETH position."
          : "Allow this spender to transfer your aWETH, which represents your supplied WETH position. The native withdrawal gateway uses aWETH to withdraw and unwrap WETH. This approval does not itself withdraw funds.",
        parties: [addressField("Spender", spender), field("Position owner", sender), addressField("Supplied token", market.aWeth)],
        advancedDetails: advanced(decoded.functionName, [field("Allowance (atomic units)", atomic), addressField("Underlying asset", market.weth)]),
      };
    }
    if (destination === market.wethDebt) {
      const decoded = decodeFunctionData({ abi: DELEGATION, data: tx.data as Hex });
      if (encodeFunctionData({ abi: DELEGATION, ...decoded }).toLowerCase() !== tx.data.toLowerCase()) return null;
      const [delegatee, atomic] = decoded.args;
      return { ...base, title: atomic === 0n ? "Revoke Aave credit delegation" : "Approve Aave credit delegation", amountLabel: "Borrowing limit",
        amount: atomic === MAX ? "Unlimited WETH credit" : `${amount(atomic.toString())} WETH credit`, ...quantity(atomic), amountDecimals: 18, tokenSymbol: "WETH", tokenAddress: getAddress(market.weth), unlimitedApproval: atomic === MAX,
        description: atomic === 0n ? "Remove this delegatee's permission to borrow WETH against your collateral. Existing debt remains."
          : "Allow this delegatee to borrow WETH against your collateral up to this limit. You remain responsible for the debt and interest. This authorization does not itself borrow funds.",
        parties: [addressField("Delegatee", delegatee), field("Debt owner", sender), addressField("Underlying asset", market.weth)],
        advancedDetails: advanced(decoded.functionName, [field("Allowance (atomic units)", atomic), addressField("Variable debt token", market.wethDebt)]),
      };
    }
    if (destination === market.gateway) {
      const decoded = decodeFunctionData({ abi: GATEWAY, data: tx.data as Hex });
      if (encodeFunctionData({ abi: GATEWAY, ...decoded }).toLowerCase() !== tx.data.toLowerCase()) return null;
      const details = (fields: PresentationField[] = []) => advanced(decoded.functionName, [addressField("Immutable Aave Pool", market.pool), addressField("Legacy pool argument (unused)", decoded.args[0]), addressField("Underlying asset", market.weth), ...fields]);
      const native = { ...base, tokenSymbol: "ETH", tokenAddress: null, amountDecimals: 18 };
      switch (decoded.functionName) {
        case "depositETH": {
          const [, beneficiary, referral] = decoded.args;
          return { ...native, title: "Supply ETH to Aave", amountLabel: "You supply", amount: `${amount(tx.value)} ETH`, amountAtoms: tx.value,
            description: "Wrap the sent ETH into WETH and supply it to Aave. The beneficiary receives aWETH and controls the supplied position.",
            parties: [addressField("Position beneficiary", beneficiary), field("Paid by", sender)],
            advancedDetails: details([field("Native payment (wei)", tx.value), field("Referral code", referral)]),
          };
        }
        case "withdrawETH": {
          if (tx.value !== "0") return null;
          const [, atomic, recipient] = decoded.args;
          return { ...native, title: "Withdraw ETH from Aave", amountLabel: "You withdraw", amount: atomic === MAX ? "Entire supplied WETH balance as ETH" : `${amount(atomic.toString())} ETH`, ...quantity(atomic),
            description: "Use your aWETH to withdraw WETH and receive unwrapped ETH. The gateway needs sufficient aWETH allowance at execution; pool liquidity and collateral checks still apply.",
            parties: [addressField("Recipient", recipient), field("Position owner", sender)],
            advancedDetails: details([field("Amount (wei)", atomic), ...(atomic === MAX ? [field("Amount semantics", "Entire aWETH balance at execution")] : [])]),
          };
        }
        case "borrowETH": {
          if (tx.value !== "0") return null;
          const [, atomic, referral] = decoded.args;
          return { ...native, title: "Borrow ETH from Aave", amountLabel: "You receive", amount: `${amount(atomic.toString())} ETH`, ...quantity(atomic),
            description: "Borrow WETH against your collateral at a variable rate and receive unwrapped ETH. You owe the WETH debt plus interest; collateral can be liquidated.",
            parties: [field("Recipient", sender), field("Debt owner", sender), field("Interest rate mode", "Variable (2)")],
            advancedDetails: details([field("Amount (wei)", atomic), field("Referral code", referral)]),
          };
        }
        case "repayETH": {
          const [, atomic, borrower] = decoded.args;
          return { ...native, title: "Repay Aave debt with ETH", amountLabel: "ETH sent (maximum)", amount: `${amount(tx.value)} ETH`, amountAtoms: tx.value,
            description: "Wrap ETH to repay the listed WETH debt. Unused ETH is refunded to your wallet. If the debt to repay exceeds the ETH sent, the transaction reverts.",
            parties: [field("Repayment target", atomic === MAX ? "Entire outstanding WETH debt" : `Up to ${amount(atomic.toString())} WETH debt`), addressField("Debt owner", borrower), field("Refund recipient", sender), field("Interest rate mode", "Variable (2)")],
            advancedDetails: details([field("Native payment budget (wei)", tx.value), field("Repayment amount (wei)", atomic), ...(atomic === MAX ? [field("Amount semantics", "Entire WETH debt at execution, requiring sufficient native payment budget")] : [])]),
          };
        }
      }
    }
    if (destination === market.pool) {
      const decoded = decodeFunctionData({ abi: POOL, data: tx.data as Hex });
      if (encodeFunctionData({ abi: POOL, ...decoded }).toLowerCase() !== tx.data.toLowerCase()) return null;
      switch (decoded.functionName) {
        case "supply": {
          const [asset, atomic, beneficiary, referral] = decoded.args;
          return { ...withAsset(asset), title: "Supply to Aave", amountLabel: "You supply", amount: display(atomic, asset), ...quantity(atomic),
            description: "Supply wallet tokens to earn a variable rate. The beneficiary receives the aTokens and controls the supplied position.",
            parties: [addressField("Asset", asset), addressField("Position beneficiary", beneficiary), field("Paid by", sender)],
            advancedDetails: advanced(decoded.functionName, [field("Amount (atomic units)", atomic), field("Referral code", referral)]),
          };
        }
        case "withdraw": {
          const [asset, atomic, recipient] = decoded.args;
          return { ...withAsset(asset), title: "Withdraw from Aave", amountLabel: "You withdraw", amount: atomic === MAX ? `Entire supplied ${metadata(asset)?.symbol ?? "token"} balance` : display(atomic, asset), ...quantity(atomic),
            description: "Burn your aTokens and receive the underlying asset. The transaction requires sufficient pool liquidity and a valid collateral position.",
            parties: [addressField("Asset", asset), addressField("Recipient", recipient), field("Position owner", sender)],
            advancedDetails: advanced(decoded.functionName, [field("Amount (atomic units)", atomic), ...(atomic === MAX ? [field("Amount semantics", "Entire aToken balance at execution")] : [])]),
          };
        }
        case "borrow": {
          const [asset, atomic, mode, referral, borrower] = decoded.args;
          if (mode !== 2n) return null;
          return { ...withAsset(asset), title: "Borrow from Aave", amountLabel: "You receive", amount: display(atomic, asset), ...quantity(atomic),
            description: "Borrow at a variable rate. The debt owner owes the borrowed amount plus accruing interest, and their collateral can be liquidated.",
            parties: [addressField("Asset", asset), field("Recipient", sender), addressField("Debt owner", borrower), field("Interest rate mode", "Variable (2)")],
            advancedDetails: advanced(decoded.functionName, [field("Amount (atomic units)", atomic), field("Referral code", referral)]),
          };
        }
        case "repay": {
          const [asset, atomic, mode, borrower] = decoded.args;
          if (mode !== 2n) return null;
          return { ...withAsset(asset), title: "Repay Aave debt", amountLabel: "Repayment limit", amount: atomic === MAX ? `Entire outstanding ${metadata(asset)?.symbol ?? "token"} debt` : display(atomic, asset), ...quantity(atomic),
            description: atomic === MAX
              ? "Repay the entire variable debt at execution, including accrued interest. The wallet must have sufficient tokens and allowance; full repayment is supported for your own debt."
              : "Spend wallet tokens to reduce the listed borrower's variable debt, up to this amount and the outstanding debt.",
            parties: [addressField("Asset", asset), field("Paid by", sender), addressField("Debt owner", borrower), field("Interest rate mode", "Variable (2)")],
            advancedDetails: advanced(decoded.functionName, [field("Amount (atomic units)", atomic), ...(atomic === MAX ? [field("Amount semantics", "Entire outstanding debt at execution")] : [])]),
          };
        }
        case "repayWithATokens": {
          const [asset, atomic, mode] = decoded.args;
          if (mode !== 2n) return null;
          return { ...withAsset(asset), title: "Repay using Aave supply", amountLabel: "Supplied tokens to use", amount: atomic === MAX ? `Available supplied ${metadata(asset)?.symbol ?? "token"} balance, up to debt` : display(atomic, asset), ...quantity(atomic),
            description: "Burn your supplied aTokens to reduce your variable debt in the same underlying asset. This reduces your supplied balance; any debt beyond the repayment remains.",
            parties: [addressField("Underlying asset", asset), field("Position and debt owner", sender), field("Payment source", "Supplied aToken balance"), field("Interest rate mode", "Variable (2)")],
            advancedDetails: advanced(decoded.functionName, [field("Amount (underlying atomic units)", atomic), ...(atomic === MAX ? [field("Amount semantics", "Available aToken balance at execution, capped by outstanding debt")] : [])]),
          };
        }
        case "setUserUseReserveAsCollateral": {
          const [asset, enabled] = decoded.args;
          return { ...withAsset(asset), title: enabled ? "Enable Aave collateral" : "Disable Aave collateral", amountLabel: "Collateral", amount: metadata(asset)?.symbol ?? null,
            description: enabled ? "Allow this supplied asset to back your borrowing. Collateral can be liquidated if the debt position becomes unhealthy." : "Stop using this supplied asset to back borrowing. Aave checks that the remaining collateral supports your outstanding debt.",
            parties: [addressField("Asset", asset), field("Position owner", sender), field("Use as collateral", enabled ? "Enabled" : "Disabled")],
            advancedDetails: advanced(decoded.functionName),
          };
        }
        case "setUserEMode": {
          const [category] = decoded.args;
          return { ...base, title: category === 0 ? "Disable Aave efficiency mode" : "Change Aave efficiency mode", amountLabel: "Efficiency mode", amount: category === 0 ? "Disabled" : `Category ${category}`,
            description: "Change the risk category for your account. Borrowing eligibility and collateral parameters follow the selected onchain category; this call contains no health-factor estimate.",
            parties: [field("Position owner", sender), field("Category ID", category)], advancedDetails: advanced(decoded.functionName),
          };
        }
      }
    }
    const decoded = decodeFunctionData({ abi: REWARDS, data: tx.data as Hex });
    if (encodeFunctionData({ abi: REWARDS, ...decoded }).toLowerCase() !== tx.data.toLowerCase()) return null;
    const claimAssets = decoded.args[0];
    const eligibility = claimAssets.map((address, index) => addressField(`Incentivized token ${index + 1}`, address));
    if (decoded.functionName === "claimRewards" || decoded.functionName === "claimRewardsToSelf") {
      const atomic = decoded.args[1];
      const recipient = decoded.functionName === "claimRewards" ? decoded.args[2] : sender;
      const reward = decoded.functionName === "claimRewards" ? decoded.args[3] : decoded.args[2];
      return { ...withAsset(reward), title: "Claim Aave rewards", amountLabel: "Reward limit", amount: atomic === MAX ? `All accrued ${metadata(reward)?.symbol ?? "token"} rewards` : display(atomic, reward), ...quantity(atomic),
        description: "Claim this reward token accrued on the listed aToken or debt-token positions. The actual payout is determined at execution.",
        parties: [addressField("Reward token", reward), addressField("Recipient", recipient), field("Position owner", sender)],
        advancedDetails: advanced(decoded.functionName, [field("Amount (atomic units)", atomic), ...eligibility]),
      };
    }
    const recipient = decoded.functionName === "claimAllRewards" ? decoded.args[1] : sender;
    return { ...base, title: "Claim all Aave rewards", amountLabel: "Rewards", amount: "All accrued rewards for selected positions",
      description: "Claim every reward token accrued on the listed aToken or debt-token positions. Reward token addresses and amounts are determined at execution.",
      parties: [addressField("Recipient", recipient), field("Position owner", sender)], advancedDetails: advanced(decoded.functionName, eligibility),
    };
  } catch { return null; }
}
