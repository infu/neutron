import { expect, test } from "bun:test";
import { decodeFunctionData, encodePacked, padHex, parseAbi, stringToHex } from "viem";
import { CCTP, depositCalldata, depositFees, forwardHook, parseFundingInput, usdcAtoms, withdrawalAction, withdrawalTypedData } from "../src/funding_protocol.ts";

const owner = "0x1111111111111111111111111111111111111111";
const input = { environment: "mainnet", direction: "deposit", chainId: "1", amount: "10" } as const;
test("Circle hook has its exact 56-byte header/recipient/default-perps layout", () => {
  const expected = encodePacked(["bytes24", "uint32", "uint32", "address", "uint32"], [padHex(stringToHex("cctp-forward"), { size: 24, dir: "right" }), 0, 24, owner, 0]);
  expect(forwardHook(owner)).toBe(expected);
  expect(forwardHook(owner).length).toBe(114);
});
test("Ethereum burn binds both destination authorities to Circle's forwarder", () => {
  const independent = parseAbi(["function depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)"]);
  const decoded = decodeFunctionData({ abi: independent, data: depositCalldata(input, owner, "210000") });
  const args = decoded.args!;
  expect(args[0]).toBe(10_000_000n); expect(args[1]).toBe(19);
  expect(args[2]).toBe(padHex(CCTP.forwarder, { size: 32 })); expect(args[4]).toBe(args[2]);
  expect(args[3].toLowerCase()).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  expect(args[5]).toBe(210_000n); expect(args[6]).toBe(1000); expect(args[7]).toBe(forwardHook(owner));
  const arb = decodeFunctionData({ abi: independent, data: depositCalldata({ ...input, chainId: "42161", speed: "standard" }, owner, "200000") });
  expect(arb.args![3].toLowerCase()).toBe("0xaf88d065e77c8cc2239327c5edb3a432268e5831"); expect(arb.args![6]).toBe(2000);
});
test("fee math rounds fractional bps up in USDC atoms and rejects malformed tiers", () => {
  const row = { finalityThreshold: 1000, minimumFee: 1.4, forwardFee: { low: 200000, med: 210000, high: 220000 } };
  expect(depositFees([row], 1_000_001n, "fast")).toMatchObject({ protocolFeeAtoms: "141", estimatedFeeAtoms: "210141", maxFeeAtoms: "220141" });
  expect(depositFees([{ ...row, forwardFee: { low: 200000, medium: 210000, high: 220000 } }], 1_000_001n, "fast")).toEqual(depositFees([row], 1_000_001n, "fast"));
  expect(() => depositFees([{ ...row, forwardFee: { low: 300000, med: 200000, high: 100000 } }], 1_000_001n, "fast")).toThrow("inconsistent");
  expect(() => depositFees([{ ...row, forwardFee: { low: 1, med: 2, high: Number.MAX_SAFE_INTEGER + 1 } }], 1_000_001n, "fast")).toThrow("invalid");
});
test("withdrawal signs domain42161 but destination CCTPdomain0 without unsigned fields", () => {
  const action = withdrawalAction({ environment: "mainnet", direction: "withdraw", chainId: "1", amount: "10.500000" }, owner, "", 1800000000000);
  const typed = JSON.parse(withdrawalTypedData(action));
  expect(action.destinationChainId).toBe(0); expect(action.amount).toBe("10.5"); expect(typed.domain.chainId).toBe(42161);
  expect(typed.message.type).toBeUndefined(); expect(typed.message.signatureChainId).toBeUndefined();
  expect(Object.keys(typed.message).sort()).toEqual(typed.types[typed.primaryType].map((field: { name: string }) => field.name).sort());
  expect(typed.types.EIP712Domain).toHaveLength(4);
  expect(withdrawalAction({ ...input, direction: "withdraw", chainId: "42161" }, owner, "spot", 1800000000001).destinationChainId).toBe(3);
});
test("funding accepts only exact native-USDC precision and the intended perps routes", () => {
  expect(parseFundingInput({ ...input, amount: "10.000000" }).amount).toBe("10");
  for (const amount of ["0", "-1", "01", "1e3", "1.0000001", "NaN"]) expect(() => usdcAtoms(amount)).toThrow();
  expect(() => parseFundingInput({ ...input, environment: "testnet" })).toThrow("mainnet");
  expect(() => parseFundingInput({ ...input, recipient: owner })).toThrow("Unknown");
  expect(() => parseFundingInput({ ...input, sourceBalance: "perps" })).toThrow("withdrawals");
  expect(() => depositCalldata(input, owner, "10000000")).toThrow("exceed");
});
