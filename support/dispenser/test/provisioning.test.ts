import { expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import {
  activationHash,
  captureProviderSetupHandoff,
  decodeActivationToken,
  depositAccountIdentifier,
  depositIcrcAccountText,
  loadOrCreateProvisioningSecrets,
  neutronUrl,
  neutronHandoffUrl,
  principalText,
  unwrapOpt,
  unwrapResult,
} from "../src/provisioning.ts";
import { decodeIcrcAccount } from "neutron-tools/src/icrc_account.js";
import {
  readPendingRepositorySetup,
  serializeProviderSetupFragment,
} from "neutron-tools/repository";

const dispenserId = "2o4cy-waaaa-aaaay-aacqq-cai";
const userPrincipal = Principal.fromText("2vxsx-fae");

test("principal helpers normalize Candid principal values", () => {
  expect(principalText(dispenserId)).toBe(dispenserId);
  expect(principalText(Principal.fromText(dispenserId))).toBe(dispenserId);
  expect(unwrapOpt<Principal>([])).toBeNull();
  expect(unwrapOpt([Principal.fromText(dispenserId)])?.toText()).toBe(
    dispenserId,
  );
});

test("Candid helpers accept only the current decoded result and opt shapes", () => {
  expect(unwrapResult({ ok: "done" })).toBe("done");
  expect(() => unwrapResult({ err: "no" })).toThrow("no");
  expect(() =>
    unwrapResult({ Ok: "done" } as unknown as { ok: string }),
  ).toThrow("Invalid Candid result response");
  expect(() =>
    unwrapResult({ Err: "no" } as unknown as { err: string }),
  ).toThrow("Invalid Candid result response");
  expect(() =>
    unwrapResult("done" as unknown as { ok: string }),
  ).toThrow("Invalid Candid result response");
  expect(() =>
    unwrapResult({ ok: "done", legacy: true } as unknown as { ok: string }),
  ).toThrow("Invalid Candid result response");
  expect(() =>
    unwrapResult({ err: { message: "no" } } as unknown as { err: string }),
  ).toThrow("Invalid Candid result response");
  expect(() =>
    unwrapOpt(Principal.fromText(dispenserId) as unknown as [Principal]),
  ).toThrow("Invalid Candid opt response");
  expect(() =>
    unwrapOpt(null as unknown as [Principal]),
  ).toThrow("Invalid Candid opt response");
  expect(() =>
    unwrapOpt([
      Principal.fromText(dispenserId),
      Principal.fromText(dispenserId),
    ] as unknown as [Principal]),
  ).toThrow("Invalid Candid opt response");
  expect(unwrapOpt<Principal>([])).toBeNull();
  expect(unwrapOpt([Principal.fromText(dispenserId)])?.toText()).toBe(
    dispenserId,
  );
});

test("Neutron handoff is plain unless repository setup is selected", () => {
  const base = "https://aaaaa-aa.icp0.io/";
  const activationToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
  const setup = {
    repo: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    manifest: "demopack",
    digest: "a".repeat(64),
  };
  expect(neutronHandoffUrl({ base, setup: null, activationToken })).toBe(
    `${base}#activate=${activationToken}`,
  );
  expect(neutronHandoffUrl({ base, setup, activationToken })).toBe(
    `${base}#repo=rrkah-fqaaa-aaaaa-aaaaq-cai&manifest=demopack&digest=${"a".repeat(64)}&activate=${activationToken}`,
  );
});

test("private identity and activation code survive a local-storage reload", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const first = loadOrCreateProvisioningSecrets({
    storage,
    dispenserCanisterId: dispenserId,
  });
  const second = loadOrCreateProvisioningSecrets({
    storage,
    dispenserCanisterId: dispenserId,
  });

  expect(second.identity.getPrincipal().toText()).toBe(
    first.identity.getPrincipal().toText(),
  );
  expect(second.activationToken).toBe(first.activationToken);
  expect(decodeActivationToken(first.activationToken)).toHaveLength(32);
  expect(await activationHash(first.activationToken)).toHaveLength(32);
  const persisted = [...values.values()][0]!;
  expect(persisted).toContain('"identity"');
  expect(persisted).toContain('"activationToken"');
});

test("a corrupt saved private key is preserved instead of silently replaced", () => {
  const values = new Map<string, string>([["key", "not-json"]]);
  const storage = {
    getItem: () => values.get("key") ?? null,
    setItem: (_key: string, value: string) => values.set("key", value),
  };
  expect(() =>
    loadOrCreateProvisioningSecrets({
      storage,
      dispenserCanisterId: dispenserId,
    }),
  ).toThrow(/left untouched/i);
  expect(values.get("key")).toBe("not-json");
});

test("provider capture rejects and erases a handoff that history cannot strip", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  const fragment = serializeProviderSetupFragment({
    repo: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    manifest: "demopack",
    digest: "a".repeat(64),
  });
  const result = captureProviderSetupHandoff({
    location: {
      href: `https://dispenser.invalid/${fragment}`,
      hash: fragment,
    },
    storage,
    history: {
      replaceState() {
        throw new DOMException("denied", "SecurityError");
      },
    },
    now: 1_000,
  });

  expect(result.setup).toBeNull();
  expect(result.expiresAt).toBeNull();
  expect(result.error).toMatch(/could not be removed.*address bar/i);
  expect(readPendingRepositorySetup(storage, 1_000)).toBeNull();
});

test("runtime URL and deposit account helpers are deterministic", () => {
  expect(neutronUrl("aaaaa-aa")).toBe("https://aaaaa-aa.icp0.io/");
  expect(
    neutronUrl("aaaaa-aa", {
      local: true,
      localHost: "http://localhost:8000",
    }),
  ).toBe("http://aaaaa-aa.localhost:8000/");

  const account = depositAccountIdentifier({
    dispenserCanisterId: dispenserId,
    userPrincipal,
  });
  expect(account).toMatch(/^[0-9a-f]{64}$/);
  expect(
    depositAccountIdentifier({
      dispenserCanisterId: dispenserId,
      userPrincipal,
    }),
  ).toBe(account);

  const icrcAccount = depositIcrcAccountText({
    dispenserCanisterId: dispenserId,
    userPrincipal,
  });
  expect(icrcAccount).toContain(".");
  expect(
    depositIcrcAccountText({
      dispenserCanisterId: dispenserId,
      userPrincipal,
    }),
  ).toBe(icrcAccount);
  const decoded = decodeIcrcAccount(icrcAccount);
  expect(decoded.owner.toText()).toBe(dispenserId);
  expect(decoded.subaccount).toHaveLength(32);
});
