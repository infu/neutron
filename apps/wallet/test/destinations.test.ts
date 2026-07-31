import { expect, test } from "bun:test";
import { Principal } from "@icp-sdk/core/principal";
import { encodeIcrcAccount } from "neutron-tools/src/icrc_account.js";
import {
  parseWalletContactDestinations,
  walletDestinationText,
} from "../src/destinations.ts";

const icpLedger = "ryjl3-tyaaa-aaaaa-aaaba-cai";

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
            internet_computer: {
              owner: icpLedger,
              subaccount: null,
            },
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
  const account = encodeIcrcAccount({
    owner: Principal.fromText(icpLedger),
    subaccount: Uint8Array.from([...new Array(31).fill(0), 255]),
  });
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
            internet_computer: {
              owner: icpLedger,
              subaccount: Uint8Array.from([
                ...new Array(31).fill(0),
                255,
              ]),
            },
          },
        },
      },
    ],
  });
  expect(page.destinations[0]?.destination).toEqual({
    network: "internet_computer",
    account,
  });
});

test("rejects legacy and malformed ICRC destination byte projections", () => {
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
  ).toThrow("Invalid IC account subaccount");
  expect(() =>
    parseWalletContactDestinations(page({
      owner: icpLedger,
      subaccount: new Uint8Array(31),
    }))
  ).toThrow("Invalid IC account subaccount");
});
