import { describe, expect, test } from "bun:test";
import type { VetKeysLifecycleResult } from "neutron-tools/app";
import {
  MailCryptoTileFault,
  activatePrivateMail,
  mailCryptoReadinessErrorMessage,
  mailCryptoTileReadinessError,
  parseSession,
  recoverMailCryptoSessionForBinding,
  retireMailPreviousGeneration,
  startMailKeyRotation,
} from "../src/mail_crypto_client.ts";
import type { MailBackendCryptoProgress } from "../src/backend.ts";

const HOLDER = "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe";

describe("Mail tile crypto boundary", () => {
  test("activation reserves the exact mailbox slot before backend setup", async () => {
    const order: string[] = [];
    const result = await activatePrivateMail({
      async reserve() {
        order.push("reserve");
        return lifecycle("enabled");
      },
      async setup() {
        order.push("mail_crypto_setup");
        return progress();
      },
      async status() {
        order.push("mail_crypto_status");
        return progress();
      },
    });
    expect(order).toEqual(["reserve", "mail_crypto_setup"]);
    expect(result.currentEpoch).toBe("1");
  });

  test("activation refuses disabled or mismatched lifecycle responses", async () => {
    await expect(activatePrivateMail({
      reserve: async () => lifecycle("disabled"),
      setup: async () => progress(),
      status: async () => progress(),
    })).rejects.toThrow("disabled in Neutron Settings");
    await expect(activatePrivateMail({
      reserve: async () => ({ slot: null, retired: true }),
      setup: async () => progress(),
      status: async () => progress(),
    })).rejects.toThrow("did not provide");
  });

  test("an authorized reader reuses an enabled slot managed by another principal", async () => {
    let reserveCalls = 0;
    const existing = lifecycle("enabled").slot!;
    const configured = {
      ...progress(),
      keyHolder: existing.keyHolder,
      currentEpoch: existing.currentGeneration,
    };
    await expect(activatePrivateMail({
      list: async () => ({
        slots: [{
          ...existing,
          keyHolder: "l7put-ak4xb-iq2fx-7zgzw-n57my-5meck-krbld-etgzd-5lnha-zkuff-3ae",
        }],
      }),
      reserve: async () => {
        reserveCalls += 1;
        return lifecycle("enabled");
      },
      setup: async () => configured,
      status: async () => configured,
    })).resolves.toEqual(configured);
    expect(reserveCalls).toBe(0);
  });

  test("activation reconciles only an exactly committed setup", async () => {
    const order: string[] = [];
    const result = await activatePrivateMail({
      async reserve() {
        order.push("reserve");
        return lifecycle("enabled");
      },
      async setup() {
        order.push("mail_crypto_setup");
        throw new Error("setup response lost");
      },
      async status() {
        order.push("mail_crypto_status");
        return progress();
      },
    });
    expect(result).toEqual(progress());
    expect(order).toEqual(["reserve", "mail_crypto_setup", "mail_crypto_status"]);

    await expect(activatePrivateMail({
      reserve: async () => lifecycle("enabled"),
      setup: async () => {
        throw new Error("setup response lost");
      },
      status: async () => ({ ...progress(), currentEpoch: "2" }),
    })).rejects.toThrow("setup response lost");

    const transferred = {
      ...progress(),
      keyHolder: "l7put-ak4xb-iq2fx-7zgzw-n57my-5meck-krbld-etgzd-5lnha-zkuff-3ae",
    };
    await expect(activatePrivateMail({
      reserve: async () => lifecycle("enabled"),
      setup: async () => {
        throw new Error("setup response lost after manager transfer");
      },
      status: async () => transferred,
    })).resolves.toEqual(transferred);
  });

  test("strictly decodes the resident readiness projection", () => {
    expect(parseSession({
      version: 1,
      lockState: "unlocked",
      currentEpoch: "1",
      previousEpoch: null,
      currentUnlocked: true,
      previousUnlocked: false,
      inactivityExpiresAt: "1785000000000",
    })).toMatchObject({ lockState: "unlocked", currentEpoch: "1" });
    expect(parseSession({
      version: 1,
      lockState: "locked",
      currentEpoch: "2",
      previousEpoch: "1",
      currentUnlocked: false,
      previousUnlocked: true,
      // A previous generation can remain unlocked while the rotated current
      // generation still requires its own explicit challenge.
      inactivityExpiresAt: "1785000000000",
    })).toMatchObject({ lockState: "locked", previousEpoch: "1" });
    expect(mailCryptoReadinessErrorMessage("owner_required")).toBe(
      "Sign in with a principal authorized for this Neutron.",
    );
    expect(mailCryptoTileReadinessError(new Error("capability_changed")).message).toBe(
      "Mail key access changed. Review it in Neutron Settings, then retry.",
    );
    expect(mailCryptoTileReadinessError(new Error("raw provider detail")).message).toBe(
      "Private Mail is temporarily unavailable. Try again.",
    );

    expect(mailCryptoTileReadinessError(new Error("rate_limited:119"))).toMatchObject({
      code: "unavailable",
    });
  });

  test("retries one invalidated lifecycle read and accepts only the exact binding", async () => {
    const expected = { currentEpoch: "2", previousEpoch: null };
    const exact = parseSession({
      version: 1,
      lockState: "unlocked",
      currentEpoch: "2",
      previousEpoch: null,
      currentUnlocked: true,
      previousUnlocked: false,
      inactivityExpiresAt: "1785000000000",
    });
    let calls = 0;
    await expect(recoverMailCryptoSessionForBinding(expected, {
      async status() {
        calls += 1;
        if (calls === 1) throw new Error("capability_changed");
        return exact;
      },
    })).resolves.toEqual(exact);
    expect(calls).toBe(2);

    const stale = { ...exact, previousEpoch: "1", previousUnlocked: true };
    calls = 0;
    await expect(recoverMailCryptoSessionForBinding(expected, {
      async status() {
        calls += 1;
        return stale;
      },
    })).rejects.toThrow("Mail key access changed");
    expect(calls).toBe(2);

    calls = 0;
    await expect(recoverMailCryptoSessionForBinding(expected, {
      async status() {
        calls += 1;
        throw new Error("service unavailable");
      },
    })).rejects.toThrow("service unavailable");
    expect(calls).toBe(1);
  });

  test("rejects key-bearing, ambiguous, and inconsistent projections", () => {
    expect(() => parseSession({
      version: 1,
      lockState: "locked",
      currentEpoch: "1",
      previousEpoch: null,
      currentUnlocked: false,
      previousUnlocked: false,
      inactivityExpiresAt: "1785000000000",
    })).toThrow("Invalid Mail crypto session");
  });

  test("rotation starts its trusted request immediately and recovers a committed lifecycle", async () => {
    const before = progress();
    const order: string[] = [];
    const rotated = { ...progress(), revision: "2", currentEpoch: "2", previousEpoch: "1" };
    const operation = startMailKeyRotation(before, {
      request() {
        order.push("request");
        return Promise.reject(new Error("response lost"));
      },
      async reconcile() {
        order.push("reconcile");
        return rotated;
      },
    });
    expect(order).toEqual(["request"]);
    await expect(operation).resolves.toEqual(rotated);
    expect(order).toEqual(["request", "reconcile"]);
  });

  test("retirement refuses references and reconciles an already retired previous generation", async () => {
    const before: MailBackendCryptoProgress = {
      ...progress(),
      revision: "8",
      currentEpoch: "2",
      previousEpoch: "1",
      readyToRetire: true,
    };
    const retained = {
      ...before,
      readyToRetire: false,
      previousReferences: { settings: "0", inbox: "1", outbox: "0", total: "1" },
    };
    await expect(retireMailPreviousGeneration(retained, {
      request: async () => lifecycle("enabled"),
      reconcile: async () => before,
    })).rejects.toThrow("still has records");

    const retired = { ...progress(), revision: "9", currentEpoch: "2" };
    const actions: string[] = [];
    const operation = retireMailPreviousGeneration(before, {
      request(input) {
        actions.push(`${input.action}:${"generation" in input ? input.generation : ""}`);
        return Promise.reject(new Error("response lost"));
      },
      async reconcile() {
        actions.push("reconcile");
        return retired;
      },
    });
    expect(actions).toEqual(["retireGeneration:1"]);
    await expect(operation).resolves.toEqual(retired);
    expect(actions).toEqual(["retireGeneration:1", "reconcile"]);
  });
});

function lifecycle(
  status: "enabled" | "disabled" | "manifest_suspended",
): VetKeysLifecycleResult {
  return {
    retired: false,
    slot: {
      slot: "mailbox",
      purpose: "Encrypt and decrypt private Mail",
      keyHolder: HOLDER,
      status,
      environment: "local",
      currentGeneration: "1",
      previousGeneration: null,
      generations: [{
        generation: "1",
        status: "current",
        keyName: "test_key_1",
        publicFingerprint: null,
      }],
      createdAt: "1",
      updatedAt: "1",
      lastUsedAt: null,
      totalDerivations: "0",
      approximateCycleSpend: "0",
    },
  };
}

function progress(): MailBackendCryptoProgress {
  return {
    revision: "1",
    keyHolder: HOLDER,
    currentEpoch: "1",
    previousEpoch: null,
    previousReferences: { settings: "0", inbox: "0", outbox: "0", total: "0" },
    readyToRetire: false,
  };
}
