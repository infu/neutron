import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { transferIdBytes } from "./transfers.ts";

export const CYCLES_DEPOSIT_LEDGER = "um5iw-rqaaa-aaaaq-qaaba-cai";
const accountIdl = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });
const depositArgsIdl = IDL.Record({ to: accountIdl, memo: IDL.Opt(IDL.Vec(IDL.Nat8)) });
const depositResultIdl = IDL.Record({ block_index: IDL.Nat, balance: IDL.Nat });

export function encodeCyclesDeposit(requestId: string, target: string, feeAtoms: string): string {
  const owner = Principal.fromText(target);
  if (owner.isAnonymous() || owner.toText() === "aaaaa-aa") throw new Error("Choose a recipient principal");
  const fee = parseCyclesAtoms(feeAtoms);
  if (fee >= 1n << 128n) throw new Error("The TCYCLES fee cannot fit its saved receipt memo");
  const memo = new Uint8Array(32);
  memo.set(transferIdBytes(requestId));
  for (let i = 0; i < 16; i += 1) memo[31 - i] = Number((fee >> BigInt(i * 8)) & 255n);
  return bytesHex(new Uint8Array(IDL.encode([depositArgsIdl], [{ to: { owner, subaccount: [] }, memo: [memo] }])));
}
export function decodeCyclesDeposit(argsHex: string): { requestId: string; target: string; feeAtoms: string } {
  const value = IDL.decode([depositArgsIdl], hexBytes(argsHex))[0] as unknown as { to: { owner: Principal; subaccount: Uint8Array[] }; memo: Uint8Array[] };
  if (value.to.subaccount.length !== 0 || value.memo.length !== 1 || value.memo[0]!.length !== 32) throw new Error("This is not a supported Wallet TCYCLES deposit");
  const memo = value.memo[0]!;
  let fee = 0n;
  for (const byte of memo.slice(16)) fee = (fee << 8n) | BigInt(byte);
  return { requestId: bytesHex(memo.slice(0, 16)), target: value.to.owner.toText(), feeAtoms: fee.toString() };
}
export function decodeCyclesDepositReceipt(replyHex: string): { blockIndex: string; recipientBalanceAtoms: string } {
  const value = IDL.decode([depositResultIdl], hexBytes(replyHex))[0] as { block_index: bigint; balance: bigint };
  return { blockIndex: value.block_index.toString(), recipientBalanceAtoms: value.balance.toString() };
}
export function parseCyclesAtoms(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Enter cycles as a whole number of atomic units");
  return BigInt(value);
}
export function bytesHex(value: Uint8Array): string { return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function hexBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) throw new Error("Invalid saved Candid bytes");
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}
