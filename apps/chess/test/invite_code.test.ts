import { expect, test } from "bun:test";
import {
  createGameId,
  decodeInvite,
  encodeInvite,
} from "../src/invite_code.ts";

const HOST = "un4fu-tqaaa-aaaab-qadjq-cai";
const GAME_SEED = "00112233445566778899aabbccddeeff";
const GAME_ID = `${GAME_SEED}_17`;

test("Chess invite codes round-trip the host principal and game id", () => {
  const code = encodeInvite({
    version: 1,
    hostPrincipal: HOST,
    gameId: GAME_ID,
  });

  expect(code.startsWith("NC1-")).toBe(true);
  expect(code).not.toContain(HOST);
  expect(decodeInvite(`  ${code}\n`)).toEqual({
    version: 1,
    hostPrincipal: HOST,
    gameId: GAME_ID,
  });
});

test("Chess invite codes retain legacy raw ids but validate generated ids exactly", () => {
  expect(
    decodeInvite(
      encodeInvite({ version: 1, hostPrincipal: HOST, gameId: GAME_SEED }),
    ).gameId,
  ).toBe(GAME_SEED);
  for (const gameId of [
    `${GAME_SEED}_0`,
    `${GAME_SEED}_01`,
    `${GAME_SEED}_1_extra`,
    `${GAME_SEED}_${"9".repeat(96)}`,
  ]) {
    expect(() =>
      encodeInvite({ version: 1, hostPrincipal: HOST, gameId }),
    ).toThrow("invalid game id");
  }
});

test("Chess invite codes reject malformed, unsupported, and unsafe payloads", () => {
  expect(() => decodeInvite("hello")).toThrow("not a Neutron Chess invite");
  expect(() => decodeInvite("NC1-%%%")).toThrow("damaged or incomplete");
  expect(() => decodeInvite(`NC1-${"a".repeat(600)}`)).toThrow("too long");

  const unsupported = `NC1-${base64Url(JSON.stringify({ v: 2, h: HOST, g: GAME_ID }))}`;
  expect(() => decodeInvite(unsupported)).toThrow("version is not supported");

  const badPrincipal = `NC1-${base64Url(JSON.stringify({ v: 1, h: "not a principal!", g: GAME_ID }))}`;
  expect(() => decodeInvite(badPrincipal)).toThrow("invalid Neutron principal");

  const shortGame = `NC1-${base64Url(JSON.stringify({ v: 1, h: HOST, g: "abcd" }))}`;
  expect(() => decodeInvite(shortGame)).toThrow("invalid game id");
});

test("Chess game ids use 128 bits supplied by browser crypto", () => {
  const random = {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      if (array instanceof Uint8Array) {
        array.forEach((_, index) => {
          array[index] = index;
        });
      }
      return array;
    },
  } as Crypto;

  expect(createGameId(random)).toBe("000102030405060708090a0b0c0d0e0f");
});

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
