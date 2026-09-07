import { expect, test } from "bun:test";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { decodeKnownCall, type Operation } from "../src/data.ts";
import { presentOperation } from "../src/presentation.ts";

const contract = "0x1111111111111111111111111111111111111111";
const owner = "0x2222222222222222222222222222222222222222";
const recipient = "0x3333333333333333333333333333333333333333";
function operation(data: Hex): Operation {
  return { kind: "transaction", chainId: "1", address: owner, intent: { transaction: { to: contract, value: "0", data } } } as Operation;
}

test("generic token interpretation requires the entire canonical ABI encoding", () => {
  for (const functionName of ["approve", "transfer"] as const) {
    const data = encodeFunctionData({ abi: erc20Abi, functionName, args: [recipient, 123n] });
    expect(decodeKnownCall(data)).not.toBeNull();
    expect(decodeKnownCall(`${data}00`)).toBeNull();
    // The first address word has a nonzero high byte, which viem otherwise
    // discards when decoding the rightmost 20 bytes as an address.
    const invalidPadding = `${data.slice(0, 10)}01${data.slice(12)}` as Hex;
    expect(decodeKnownCall(invalidPadding)).toBeNull();
    expect(presentOperation(operation(`${data}00`)).title).toBe("Contract interaction");
  }
  const transferFrom = encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [owner, recipient, 123n] });
  expect(decodeKnownCall(`${transferFrom}00`)).toBeNull();
});

test("unknown approve preserves token ID zero without claiming an allowance revocation", () => {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [recipient, 0n] });
  const unknown = presentOperation(operation(data));
  expect(unknown).toMatchObject({ title: "Approve token permission", amount: "0", amountLabel: "Allowance or token ID", unlimitedApproval: false });
  expect(unknown.description).toContain("ERC-721 token ID");
  expect(unknown.amountAtoms).toBeUndefined();
  expect(unknown.parties).toEqual([{ label: "Spender", value: recipient }]);
  expect(presentOperation(operation(data), [{ chainId: "1", address: contract, decimals: 6, symbol: "USDV" }])).toMatchObject({ title: "Revoke USDV allowance", amount: "0 USDV", amountAtoms: "0" });
});

test("unknown transferFrom preserves the exact ID and identified ERC20 metadata restores monetary units", () => {
  const atomic = 900719925474099312345n;
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [owner, recipient, atomic] });
  const unknown = presentOperation(operation(data));
  expect(unknown).toMatchObject({ title: "Transfer token", amount: atomic.toString(), amountLabel: "Amount or token ID" });
  expect(unknown.amountAtoms).toBeUndefined();
  expect(unknown.parties).toEqual([{ label: "Token owner", value: owner }, { label: "Recipient", value: recipient }]);
  expect(presentOperation(operation(data), [{ chainId: "1", address: contract, decimals: 6, symbol: "USDV" }])).toMatchObject({ title: "Send USDV", amount: "900719925474099.312345 USDV", amountAtoms: atomic.toString() });
});

test("unknown MAX approval retains its conditional unlimited-allowance warning", () => {
  const atomic = 2n ** 256n - 1n;
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [recipient, atomic] });
  const shown = presentOperation(operation(data));
  expect(shown.amount).toBe(atomic.toString());
  expect(shown.unlimitedApproval).toBeFalse();
  expect(shown.decoderWarning).toContain("If this is an ERC-20 token, this grants an unlimited allowance");
});
