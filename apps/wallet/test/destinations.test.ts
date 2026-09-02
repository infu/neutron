import { expect, test } from "bun:test";
import {
  decodeIcrcAccount,
  encodeIcrcAccount,
} from "neutron-tools/src/icrc_account.js";
import {
  parseWalletContactDestinations,
  walletDestinationVariant,
  walletDestinationText,
} from "../src/destinations.ts";

const icpLedger = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const principalOnlyAccount = "togwv-zqaaa-aaaal-qr7aa-cai";
const subaccount = Uint8Array.from([...new Array(31).fill(0), 255]);
const accountWithSubaccount = encodeIcrcAccount({
  owner: decodeIcrcAccount(icpLedger).owner,
  subaccount,
});

test("parses typed IC and native Contact destinations", () => {
  const page = parseWalletContactDestinations({
    ledger: "mxzaz-hqaaa-aaaar-qaada-cai",
    book_revision: "8",
    total: "2",
    destinations: [
      {
        contact_id: "1",
        contact_revision: "3",
        contact_kind: { person: null },
        contact_name: "Ada",
        route: { icrc: null },
        address: {
          id: "4",
          address_label: "Main",
          preferred: true,
          destination: {
            internet_computer: { owner: icpLedger },
          },
        },
      },
      {
        contact_id: "1",
        contact_revision: "3",
        contact_kind: { person: null },
        contact_name: "Ada",
        route: { native: null },
        address: {
          id: "5",
          preferred: false,
          destination: { bitcoin_mainnet: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT" },
        },
      },
    ],
  });

  expect(page.revision).toBe("8");
  expect(page.destinations.map((item) => item.route)).toEqual(["icrc", "native"]);
  expect(walletDestinationText(page.destinations[0]!.destination)).toBe(
    "ryjl3-tyaaa-aaaaa-aaaba-cai",
  );
  expect(walletDestinationText(page.destinations[1]!.destination)).toBe(
    "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
  );
});

test("preserves an ICRC subaccount in canonical textual form", () => {
  const page = parseWalletContactDestinations({
    ledger: icpLedger,
    book_revision: "1",
    total: "1",
    destinations: [
      {
        contact_id: "1",
        contact_revision: "1",
        contact_kind: { self: null },
        contact_name: "Mine",
        route: { icrc: null },
        address: {
          id: "1",
          preferred: false,
          destination: {
            internet_computer: { owner: icpLedger, subaccount },
          },
        },
      },
    ],
  });
  expect(page.destinations[0]?.destination).toEqual({
    network: "internet_computer",
    account: accountWithSubaccount,
  });
  expect(walletDestinationVariant(page.destinations[0]!.destination)).toEqual({
    internet_computer: accountWithSubaccount,
  });
});

test("accepts omitted and null Candid subaccounts as the default account", () => {
  const page = parseWalletContactDestinations({
    ledger: icpLedger,
    book_revision: "1",
    total: "2",
    destinations: [
      {
        contact_id: "1",
        contact_revision: "1",
        contact_kind: { person: null },
        contact_name: "Neutrinite",
        route: { icrc: null },
        address: {
          id: "1",
          preferred: true,
          destination: {
            internet_computer: { owner: principalOnlyAccount },
          },
        },
      },
      {
        contact_id: "2",
        contact_revision: "1",
        contact_kind: { person: null },
        contact_name: "Neutrinite legacy",
        route: { icrc: null },
        address: {
          id: "2",
          preferred: false,
          destination: {
            internet_computer: {
              owner: principalOnlyAccount,
              subaccount: null,
            },
          },
        },
      },
    ],
  });

  expect(page.destinations[0]?.destination).toEqual({
    network: "internet_computer",
    account: principalOnlyAccount,
  });
  expect(page.destinations[1]?.destination).toEqual({
    network: "internet_computer",
    account: principalOnlyAccount,
  });
  expect(walletDestinationVariant(page.destinations[0]!.destination)).toEqual({
    internet_computer: principalOnlyAccount,
  });
});

test("rejects string-shaped, inherited, accessor, and malformed projections", () => {
  const page = (destination: unknown) => ({
    ledger: icpLedger,
    book_revision: "1",
    total: "1",
    destinations: [
      {
        contact_id: "1",
        contact_revision: "1",
        contact_kind: { self: null },
        contact_name: "Mine",
        route: { icrc: null },
        address: {
          id: "1",
          preferred: false,
          destination: { internet_computer: destination },
        },
      },
    ],
  });

  expect(() => parseWalletContactDestinations(page(icpLedger))).toThrow(
    "Invalid IC account",
  );
  expect(() =>
    parseWalletContactDestinations(page({
      owner: icpLedger,
      subaccount: new Array(32).fill(0),
    }))
  ).toThrow("Invalid IC account");
  expect(() =>
    parseWalletContactDestinations(page({
      owner: icpLedger,
      subaccount: new Uint8Array(31),
    }))
  ).toThrow("Invalid IC account");
  expect(() =>
    parseWalletContactDestinations(page({
      owner: principalOnlyAccount,
      subaccount: undefined,
    }))
  ).toThrow("Invalid IC account");
  expect(() =>
    parseWalletContactDestinations(
      page(Object.create({ owner: principalOnlyAccount })),
    )
  ).toThrow("Invalid IC account");
  const accessor = {} as Record<string, unknown>;
  Object.defineProperty(accessor, "owner", {
    enumerable: true,
    get: () => principalOnlyAccount,
  });
  expect(() => parseWalletContactDestinations(page(accessor))).toThrow(
    "Invalid IC account",
  );
  expect(() =>
    parseWalletContactDestinations(page({
      owner: principalOnlyAccount,
      extra: null,
    }))
  ).toThrow("Invalid IC account");
  expect(() =>
    parseWalletContactDestinations(page(` ${principalOnlyAccount} `))
  ).toThrow("Invalid IC account");
});
