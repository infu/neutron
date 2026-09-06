import { expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  kitchenSinkPersonalMessage,
  kitchenSinkPersonalMessageHex,
  kitchenSinkTypedData,
  verifyKitchenSinkPersonal,
  verifyKitchenSinkTyped,
} from "../src/evm_wallet_signatures.ts";

// Public test fixture only: this account must never hold real funds.
const account = privateKeyToAccount(
  "0x0000000000000000000000000000000000000000000000000000000000000001",
);
const otherAccount = privateKeyToAccount(
  "0x0000000000000000000000000000000000000000000000000000000000000002",
);
const personalSignature =
  "0xf272abd173de22784a8fce2b71d3498724a462886da995cdf952104b25eaa3ed0d566877366c64aa072bc6d83cc02ea3c4a6a8bc28a8492ecd32b34fa9a6674d1b";
const typedSignature =
  "0x26d409441936ab52fdd3205811e2dc4366ee757e1736c06f24bc2e324df01cca5dd6764163135401abc0611c8e98dae03c2d8e137caae6d2a5ef0b60ba98812a1c";

test("the personal demo verifies the exact visible UTF-8 message", async () => {
  expect(account.address).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  expect(await account.signMessage({ message: kitchenSinkPersonalMessage })).toBe(
    personalSignature,
  );
  expect(await account.signMessage({
    message: { raw: kitchenSinkPersonalMessageHex() },
  })).toBe(personalSignature);
  await expect(verifyKitchenSinkPersonal(account.address, personalSignature)).resolves
    .toBe(true);
  await expect(verifyKitchenSinkPersonal(
    account.address.toLowerCase(),
    personalSignature,
  )).resolves.toBe(true);
});

test("personal verification rejects another account or another signed message", async () => {
  await expect(verifyKitchenSinkPersonal(otherAccount.address, personalSignature))
    .resolves.toBe(false);
  const changedMessage = await account.signMessage({
    message: `${kitchenSinkPersonalMessage} Changed.`,
  });
  await expect(verifyKitchenSinkPersonal(account.address, changedMessage)).resolves
    .toBe(false);
  const hexAsText = await account.signMessage({ message: kitchenSinkPersonalMessageHex() });
  await expect(verifyKitchenSinkPersonal(account.address, hexAsText)).resolves.toBe(false);
});

test("typed demo data contains only the chain-bound demonstration message", async () => {
  const data = kitchenSinkTypedData(1);
  expect(data).toEqual({
    domain: { name: "Neutron Kitchen Sink", version: "1", chainId: 1 },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
      KitchenSinkMessage: [{ name: "message", type: "string" }],
    },
    primaryType: "KitchenSinkMessage",
    message: { message: kitchenSinkPersonalMessage },
  });
  expect(await account.signTypedData(data)).toBe(typedSignature);
  await expect(verifyKitchenSinkTyped(1, account.address, typedSignature)).resolves
    .toBe(true);
  const arbitrumSignature = await account.signTypedData(kitchenSinkTypedData(42161));
  await expect(verifyKitchenSinkTyped(42161, account.address, arbitrumSignature))
    .resolves.toBe(true);
});

test("typed verification binds the account, network, domain and message", async () => {
  await expect(verifyKitchenSinkTyped(1, otherAccount.address, typedSignature))
    .resolves.toBe(false);
  await expect(verifyKitchenSinkTyped(42161, account.address, typedSignature))
    .resolves.toBe(false);
  const data = kitchenSinkTypedData(1);
  const changedMessage = await account.signTypedData({
    ...data,
    message: { message: "Changed demo message" },
  });
  const changedDomain = await account.signTypedData({
    ...data,
    domain: { ...data.domain, name: "Different application" },
  });
  await expect(verifyKitchenSinkTyped(1, account.address, changedMessage)).resolves
    .toBe(false);
  await expect(verifyKitchenSinkTyped(1, account.address, changedDomain)).resolves
    .toBe(false);
});

test("signature helpers reject malformed chain IDs, addresses and hex", async () => {
  for (const chainId of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => kitchenSinkTypedData(chainId)).toThrow("chain ID");
    await expect(verifyKitchenSinkTyped(chainId, account.address, typedSignature))
      .rejects.toThrow("chain ID");
  }
  for (const address of [
    "0x1234",
    account.address.replace("7E5F", "7e5F"),
    `${account.address} `,
    account.address.replace("0x", ""),
  ]) {
    await expect(verifyKitchenSinkPersonal(address, personalSignature)).rejects
      .toThrow("account address");
    await expect(verifyKitchenSinkTyped(1, address, typedSignature)).rejects
      .toThrow("account address");
  }
  for (const signature of [
    "0x",
    personalSignature.slice(0, -2),
    `${personalSignature}00`,
    personalSignature.replace("0x", ""),
    `0xgg${personalSignature.slice(4)}`,
  ]) {
    await expect(verifyKitchenSinkPersonal(account.address, signature)).rejects
      .toThrow("signature");
    await expect(verifyKitchenSinkTyped(1, account.address, signature)).rejects
      .toThrow("signature");
  }
});

test("valid hex containing an invalid curve signature cannot verify", async () => {
  const invalidSignature = `0x${"00".repeat(65)}`;
  await expect(verifyKitchenSinkPersonal(account.address, invalidSignature)).resolves
    .toBe(false);
  await expect(verifyKitchenSinkTyped(1, account.address, invalidSignature)).resolves
    .toBe(false);
});
