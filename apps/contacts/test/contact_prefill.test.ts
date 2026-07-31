import { describe, expect, test } from "bun:test";
import {
  ContactPrefillBroker,
  parseContactPrefill,
  type ContactPrefill,
} from "../src/contact_prefill.ts";

const NEUTRON = "ecbfe-lt777-77774-aaabq-cai";

describe("Contacts prefilled draft boundary", () => {
  test("normalizes an untrusted suggested name and canister principal", () => {
    expect(
      parseContactPrefill({
        suggestedName: "  Unverified Mallory  ",
        neutronPrincipal: `  ${NEUTRON}  `,
      }),
    ).toEqual({
      name: "Unverified Mallory",
      principal: NEUTRON,
    });
  });

  test("rejects unsafe names and principals that are not canisters", () => {
    expect(() =>
      parseContactPrefill({
        suggestedName: "Unsafe\u202ename",
        neutronPrincipal: NEUTRON,
      }),
    ).toThrow("unsupported control");
    expect(() =>
      parseContactPrefill({
        suggestedName: "Person",
        neutronPrincipal:
          "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe",
      }),
    ).toThrow("canister principal");
  });

  test("queues one startup prefill and never overwrites a busy editor", async () => {
    const broker = new ContactPrefillBroker();
    const first: ContactPrefill = { name: "First", principal: NEUTRON };
    const second: ContactPrefill = { name: "Second", principal: NEUTRON };
    const delivered: ContactPrefill[] = [];

    expect(broker.deliver(first)).toBe("ready");
    expect(broker.deliver(second)).toBe("busy");
    const unsubscribe = broker.subscribe((prefill) => {
      delivered.push(prefill);
      return "busy";
    });
    await Promise.resolve();
    expect(delivered).toEqual([first]);
    expect(broker.deliver(second)).toBe("busy");
    unsubscribe();
  });
});
