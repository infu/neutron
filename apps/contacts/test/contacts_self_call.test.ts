import { describe, expect, test } from "bun:test";
import { encodeSelfCallValues } from "neutron-tools/app";
import { decodeIcrcAccount } from "neutron-tools/src/icrc_account.js";
import {
  encodeDestination,
  parseDestination,
} from "../src/contacts.ts";

const OWNER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const CANISTER_OWNER = "togwv-zqaaa-aaaal-qr7aa-cai";
const ACCOUNT = `${OWNER}-t5ic6yq.ff`;
const SUBACCOUNT = Uint8Array.from([...new Array(31).fill(0), 255]);

describe("Contacts canonical API-1 account boundary", () => {
  test("encodes ICRC accounts structurally for the binary-safe self-call", () => {
    expect(
      encodeDestination({
        network: "internet_computer",
        account: CANISTER_OWNER,
      }),
    ).toEqual({
      internet_computer: {
        owner: CANISTER_OWNER,
        subaccount: null,
      },
    });
    const encoded = encodeDestination({
      network: "internet_computer",
      account: ACCOUNT,
    });
    expect(encoded).toEqual({
      internet_computer: {
        owner: OWNER,
        subaccount: SUBACCOUNT,
      },
    });

    const wire = encodeSelfCallValues([
      {
        addresses: [{ destination: encoded }],
      },
    ]);
    expect(wire.value).toEqual([
      {
        addresses: [
          {
            destination: {
              internet_computer: {
                owner: OWNER,
                subaccount: null,
              },
            },
          },
        ],
      },
    ]);
    expect(wire.blobs).toHaveLength(1);
    expect(wire.blobs[0]).toMatchObject({
      path: [
        0,
        "addresses",
        0,
        "destination",
        "internet_computer",
        "subaccount",
      ],
      byteLength: 32,
    });
    expect(new Uint8Array(wire.blobs[0]!.data)).toEqual(SUBACCOUNT);
  });

  test("parses absent and explicit-null output subaccounts identically", () => {
    expect(
      parseDestination({
        internet_computer: { owner: CANISTER_OWNER },
      }),
    ).toEqual({
      network: "internet_computer",
      account: CANISTER_OWNER,
    });
    expect(
      parseDestination({
        internet_computer: {
          owner: CANISTER_OWNER,
          subaccount: null,
        },
      }),
    ).toEqual({
      network: "internet_computer",
      account: CANISTER_OWNER,
    });
  });

  test("round-trips one exact 32-byte ICRC subaccount as canonical text", () => {
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
    if (parsed.network !== "internet_computer") {
      throw new Error("Expected an Internet Computer destination");
    }
    expect(decodeIcrcAccount(parsed.account)).toMatchObject({
      subaccount: SUBACCOUNT,
    });
    incoming.fill(0);
    expect(encodeDestination(parsed)).toEqual({
      internet_computer: {
        owner: OWNER,
        subaccount: SUBACCOUNT,
      },
    });
  });

  test("rejects scalar replies and noncanonical output account records", () => {
    for (const account of [
      CANISTER_OWNER,
      "2vxsx-fae",
      `${OWNER}-bad.ff`,
      { owner: OWNER, subaccount: undefined },
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

  test("rejects inherited and accessor output fields without invoking them", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "subaccount",
    );
    Object.defineProperty(Object.prototype, "subaccount", {
      configurable: true,
      enumerable: true,
      value: null,
    });
    try {
      expect(() =>
        parseDestination({
          internet_computer: { owner: CANISTER_OWNER },
        }),
      ).toThrow();
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(Object.prototype, "subaccount");
      } else {
        Object.defineProperty(Object.prototype, "subaccount", previous);
      }
    }

    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "owner", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return CANISTER_OWNER;
      },
    });
    expect(() =>
      parseDestination({ internet_computer: accessor }),
    ).toThrow();
    expect(getterCalls).toBe(0);

    expect(() =>
      parseDestination({
        internet_computer: Object.assign(
          Object.create(null),
          { owner: CANISTER_OWNER, [Symbol("extra")]: null },
        ),
      }),
    ).toThrow();
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
