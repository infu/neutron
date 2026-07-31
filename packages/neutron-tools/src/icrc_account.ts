import {
  decodeIcrcAccount as decodeOfficialIcrcAccount,
  encodeIcrcAccount as encodeOfficialIcrcAccount,
  type IcrcAccount,
} from "@icp-sdk/canisters/ledger/icrc";

export type { IcrcAccount };

// Keep Neutron's account boundary on the DFINITY-maintained ICRC codec. The
// Candid Account type requires a 32-byte subaccount when one is present.
export function encodeIcrcAccount(account: IcrcAccount): string {
  if (account.subaccount !== undefined && account.subaccount.length !== 32) {
    throw new Error("An ICRC subaccount must contain exactly 32 bytes");
  }
  return encodeOfficialIcrcAccount(account);
}

export function decodeIcrcAccount(value: string): IcrcAccount {
  const account = decodeOfficialIcrcAccount(value.trim());
  if (account.subaccount !== undefined && account.subaccount.length !== 32) {
    throw new Error("An ICRC subaccount must contain exactly 32 bytes");
  }
  return account;
}
