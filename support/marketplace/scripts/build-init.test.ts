// All rights reserved. See ../LICENSE.
import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { encodeMarketplaceInit, MarketplaceInit } from "./build-init.ts";
import template from "../config/init.example.json";

function fixture() {
  return {
    ...structuredClone(template),
    admins: [Principal.fromUint8Array(new Uint8Array([0, 1])).toText()],
    tokens: template.tokens.map((token) => ({
      ...token,
      fee: "10000",
      burnAccount: {
        owner: Principal.selfAuthenticating(new Uint8Array([2])).toText(),
        subaccountHex: "ab".repeat(32),
      },
    })),
    fees: {
      version: "1", updateBase: "9007199254740993", updateByte: "1",
      storageByteYear: "2", purchase: "3", withdraw: "4", grant: "5", xrc: "6",
    },
  };
}

test("encodes one init record without losing large fees or forwarding subaccounts", () => {
  const input = fixture();
  const bytes = encodeMarketplaceInit(input);
  const [result] = IDL.decode([MarketplaceInit], bytes) as [{
    admins: Principal[];
    fees: { updateBase: bigint };
    tokens: [{ fee: bigint; burnAccount: [{ owner: Principal; subaccount: [Uint8Array] }] }];
    referralTerms: { discountBps: bigint; affiliateBps: bigint; developerBps: bigint };
  }];
  expect(result.admins[0]?.toText()).toBe(input.admins[0]);
  expect(result.fees.updateBase).toBe(9007199254740993n);
  expect(result.tokens[0].fee).toBe(10000n);
  expect(Array.from(result.tokens[0].burnAccount[0].subaccount[0])).toEqual(Array(32).fill(0xab));
  expect(result.referralTerms).toMatchObject({ discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n });
});

test("preserves an unset forwarding account without inventing a recipient", () => {
  const input = fixture();
  const bytes = encodeMarketplaceInit({ ...input, tokens: input.tokens.map((token) => ({ ...token, burnAccount: null })) });
  const [result] = IDL.decode([MarketplaceInit], bytes) as [{ tokens: { burnAccount: [] }[] }];
  expect(result.tokens.every((token) => token.burnAccount.length === 0)).toBe(true);
});

test("rejects template defaults, imprecise JSON numbers, incomplete fees and malformed subaccounts", () => {
  expect(() => encodeMarketplaceInit(template)).toThrow("replace the example placeholder");
  const input = fixture();
  expect(() => encodeMarketplaceInit({ ...input, fees: { ...input.fees, updateBase: 9007199254740993 } })).toThrow("unsigned decimal string");
  expect(() => encodeMarketplaceInit({ ...input, fees: { ...input.fees, updateBase: null } })).toThrow("unsigned decimal string");
  expect(() => encodeMarketplaceInit({ ...input, admins: [] })).toThrow("authenticated admin principal");
  expect(() => encodeMarketplaceInit({ ...input, tokens: [{ ...input.tokens[0], burnAccount: { owner: input.admins[0], subaccountHex: "ab" } }] })).toThrow("exactly 32 bytes");
});


test("accepts authenticated CLI administrators and retains canister administrators", () => {
  const input = fixture();
  const cli = Principal.selfAuthenticating(new Uint8Array([1]));
  for (const admins of [[cli.toText()], [...input.admins, cli.toText()]]) {
    const [encoded] = IDL.decode([MarketplaceInit], encodeMarketplaceInit({ ...input, admins })) as [{ admins: Principal[] }];
    expect(encoded.admins.map(value => value.toText())).toEqual(admins);
  }
});

test("rejects anonymous and unreachable management administrators", () => {
  const input = fixture();
  for (const admin of [Principal.anonymous(), Principal.fromText("aaaaa-aa")]) {
    expect(() => encodeMarketplaceInit({ ...input, admins: [admin.toText()] })).toThrow("authenticated admin principal");
    expect(() => encodeMarketplaceInit({ ...input, admins: [...input.admins, admin.toText()] })).toThrow("authenticated admin principal");
  }
});

test("initial owner reservations encode atomically while omitted inventories remain compatible", () => {
  const input = fixture();
  const reservations = [{ appId: "existing_app", publisher: input.admins[0], title: "Existing app" }];
  const [withInventory] = IDL.decode([MarketplaceInit], encodeMarketplaceInit({ ...input, reservations })) as [{ reservations: [{ appId: string; publisher: Principal; title: string }[]] }];
  expect(withInventory.reservations[0].map((row) => ({ ...row, publisher: row.publisher.toText() }))).toEqual(reservations);
  const { reservations: _omitted, ...oldInput } = input;
  const [without] = IDL.decode([MarketplaceInit], encodeMarketplaceInit(oldInput)) as [{ reservations: [] }];
  expect(without.reservations).toEqual([]);
  const conflicting = { ...reservations[0], publisher: Principal.fromUint8Array(Uint8Array.of(1, 1)).toText() };
  expect(() => encodeMarketplaceInit({ ...input, reservations: [...reservations, conflicting] })).toThrow("conflicting publishers");
  expect(() => encodeMarketplaceInit({ ...input, reservations: [{ ...reservations[0], publisher: Principal.selfAuthenticating(Uint8Array.of(1)).toText() }] })).toThrow("Neutron canister principal");
  expect(() => encodeMarketplaceInit({ ...input, reservations: [{ ...reservations[0], appId: "Bad-ID" }] })).toThrow("Neutron app ID format");
});
