import { describe, expect, test } from "bun:test";
import {
  encodeDestination,
  parseDestination,
} from "../src/contacts.ts";

const OWNER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const ACCOUNT = `${OWNER}-t5ic6yq.ff`;
const SUBACCOUNT = Uint8Array.from([...new Array(31).fill(0), 255]);

describe("Contacts canonical API-1 account boundary", () => {
  test("encodes an ICRC account as a principal record with a copied Blob", () => {
    const encoded = encodeDestination({
      network: "internet_computer",
      account: ACCOUNT,
    });
    const account = encoded.internet_computer;
    expect(account).toEqual({
      owner: OWNER,
      subaccount: SUBACCOUNT,
    });
    expect(
      (account as { subaccount: Uint8Array }).subaccount,
    ).not.toBe(SUBACCOUNT);

    expect(
      encodeDestination({
        network: "internet_computer",
        account: OWNER,
      }),
    ).toEqual({
      internet_computer: {
        owner: OWNER,
        subaccount: null,
      },
    });
  });

  test("parses canonical account records into detached validated account text", () => {
    const incoming = SUBACCOUNT.slice();
    const parsed = parseDestination({
      internet_computer: {
        owner: OWNER,
        subaccount: incoming,
      },
    });
    expect(parsed).toEqual({
      network: "internet_computer",
      account: ACCOUNT,
    });

    incoming.fill(0);
    expect(encodeDestination(parsed)).toEqual({
      internet_computer: {
        owner: OWNER,
        subaccount: SUBACCOUNT,
      },
    });

    expect(
      parseDestination({
        internet_computer: {
          owner: OWNER,
          subaccount: null,
        },
      }),
    ).toEqual({
      network: "internet_computer",
      account: OWNER,
    });
  });

  test("rejects legacy strings and noncanonical account record shapes", () => {
    for (const account of [
      ACCOUNT,
      { owner: OWNER },
      { owner: OWNER, subaccount: new ArrayBuffer(32) },
      { owner: OWNER, subaccount: new Uint8Array(31) },
      { owner: "2vxsx-fae", subaccount: null },
      { owner: OWNER, subaccount: null, extra: null },
    ]) {
      expect(() =>
        parseDestination({ internet_computer: account }),
      ).toThrow();
    }
  });

  test("leaves every non-IC destination variant unchanged", () => {
    expect(parseDestination({ neutron: OWNER })).toEqual({
      network: "neutron",
      principal: OWNER,
    });
    expect(
      parseDestination({
        ethereum_mainnet: "0x52908400098527886E0F7030069857D2E4169EE7",
      }),
    ).toEqual({
      network: "ethereum_mainnet",
      address: "0x52908400098527886E0F7030069857D2E4169EE7",
    });
    expect(
      encodeDestination({
        network: "solana_mainnet",
        address: "11111111111111111111111111111111",
      }),
    ).toEqual({
      solana_mainnet: "11111111111111111111111111111111",
    });
  });
});
