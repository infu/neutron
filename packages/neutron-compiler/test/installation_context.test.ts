import { describe, expect, test } from "bun:test";
import { IC_ROOT_KEY } from "@dfinity/agent";
import {
  assertTrustedInstallationContext,
  mainnetTrustedInstallationContext,
  trustedInstallationContextFromRootKey,
  trustedInstallationNetworkIdHex,
} from "../src/installation_context.ts";

const MAINNET_NETWORK_ID =
  "6c777193cb352fcf161afad69a6def789c4c6ebdd1fd1a9eb98d54c9a8a01c44";

describe("trusted installation context", () => {
  test("derives the frozen Neutron network ID from exact mainnet SPKI DER bytes", () => {
    const exactDer = Uint8Array.from(
      { length: IC_ROOT_KEY.length / 2 },
      (_, index) =>
        Number.parseInt(IC_ROOT_KEY.slice(index * 2, index * 2 + 2), 16),
    );
    const context = trustedInstallationContextFromRootKey(exactDer);

    expect(trustedInstallationNetworkIdHex(context)).toBe(MAINNET_NETWORK_ID);
    expect(trustedInstallationNetworkIdHex(mainnetTrustedInstallationContext()))
      .toBe(MAINNET_NETWORK_ID);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.networkId)).toBe(true);
  });

  test("rejects unvalidated, malformed, zero, and unbounded input", () => {
    expect(() =>
      assertTrustedInstallationContext({
        networkId: Object.freeze(new Array(32).fill(1)),
      }),
    ).toThrow("not validated");
    expect(() =>
      trustedInstallationContextFromRootKey(new Uint8Array(0)),
    ).toThrow("SPKI DER");
    expect(() =>
      trustedInstallationContextFromRootKey(new Uint8Array(4_097)),
    ).toThrow("SPKI DER");
  });
});
