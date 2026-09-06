import { expect, test } from "bun:test";
import {
  CHAIN_KEY_SIGNING_MAX_SLOTS_PER_APP,
  buildCapabilityPlan,
  diffCapabilityPlans,
  fingerprintCapabilityPlanWireV1,
  parseCapabilityPlanWireV1,
  projectCapabilityInstallDisclosures,
  projectRuntimeCapabilityRegistrationsV1,
  serializeCapabilityPlanWireV1,
  toCapabilityPlanWireV1,
} from "../src/capabilities/index.ts";
import {
  normalizeManifestCapabilities,
  type NeutronManifest,
} from "../src/schema.ts";
import { validate_neutron_conf } from "../src/validate_schema.ts";

function manifest(): NeutronManifest {
  return {
    format: 3,
    id: "custody_wallet",
    name: "Custody Wallet",
    version: 100,
    backend: { capabilities: { wallet_custody_signing: { api: 1 } } },
    capabilities: {
      wallet_custody_signing: {
        api: 1,
        slots: [
          { id: "z_account", algorithm: "ecdsa_secp256k1", purpose: "Sign transactions" },
          { id: "a_account", algorithm: "ecdsa_secp256k1", purpose: "Sign messages" },
        ],
      },
    },
  };
}

function runtime(candidate: NeutronManifest) {
  return projectRuntimeCapabilityRegistrationsV1(buildCapabilityPlan(candidate));
}

function wire(candidate: NeutronManifest) {
  return toCapabilityPlanWireV1(buildCapabilityPlan(candidate));
}

test("wallet custody declaration is closed and separate from assertion signing", () => {
  const candidate = manifest();
  expect(validate_neutron_conf(candidate).errors).toEqual([]);
  const normalized = normalizeManifestCapabilities(candidate);
  expect(normalized.wallet_custody_signing!.slots.map(({ id }) => id)).toEqual([
    "a_account", "z_account",
  ]);
  expect(normalized.chain_key_signing).toBeUndefined();

  const rejected = (patch: Record<string, unknown>, slot = false) => {
    const value = manifest() as any;
    const declaration = value.capabilities.wallet_custody_signing;
    Object.assign(slot ? declaration.slots[0] : declaration, patch);
    expect(validate_neutron_conf(value).valid).toBe(false);
    expect(() => normalizeManifestCapabilities(value)).toThrow(/wallet_custody_signing/);
  };
  rejected({ api: 2 });
  rejected({ namespace: "another_wallet" });
  rejected({ raw_signing: true });
  rejected({ slots: [] });
  for (const algorithm of ["schnorr_ed25519", "schnorr_bip340secp256k1", "secp256k1"]) {
    rejected({ algorithm }, true);
  }
  for (const id of ["", "Uppercase", "a".repeat(41)]) rejected({ id }, true);
  rejected({ purpose: "" }, true);
  rejected({ purpose: "x".repeat(161) }, true);
  rejected({ max_assertion_bytes: 32 }, true);
  rejected({ derivation_path: [] }, true);
  rejected({ key_name: "key_1" }, true);
  const duplicate = manifest();
  duplicate.capabilities!.wallet_custody_signing!.slots[1] = {
    ...duplicate.capabilities!.wallet_custody_signing!.slots[0]!,
  };
  expect(() => normalizeManifestCapabilities(duplicate)).toThrow(/wallet_custody_signing slot/);
  const missingDeclaration = manifest();
  delete missingDeclaration.capabilities;
  expect(() => buildCapabilityPlan(missingDeclaration)).toThrow(/requires capabilities.wallet_custody_signing/);
});

test("assertion and custody authority share the existing slot inventory", () => {
  const candidate = manifest();
  candidate.capabilities!.chain_key_signing = {
    api: 1,
    slots: Array.from({ length: CHAIN_KEY_SIGNING_MAX_SLOTS_PER_APP - 2 }, (_, index) => ({
      id: `assertion_${index}`,
      algorithm: "ecdsa_secp256k1",
      purpose: "Sign assertions",
      max_assertion_bytes: 1024,
    })),
  };
  expect(runtime(candidate)).toHaveLength(CHAIN_KEY_SIGNING_MAX_SLOTS_PER_APP);
  const validWire = wire(candidate);
  candidate.capabilities!.wallet_custody_signing!.slots.push({
    id: "extra", algorithm: "ecdsa_secp256k1", purpose: "Extra wallet",
  });
  expect(() => buildCapabilityPlan(candidate)).toThrow(/Combined.*slot limit/);
  const entry = validWire.entries.find(({ id }) => id === "wallet_custody_signing")!;
  if (entry.id !== "wallet_custody_signing") throw new Error("fixture");
  entry.config.slots.push({ id: "extra", algorithm: "ecdsa_secp256k1", purpose: "Extra wallet" });
  expect(() => parseCapabilityPlanWireV1(validWire)).toThrow(/Combined.*slot limit/);
});

test("custody wire roundtrips and runtime fingerprints retain independent owner controls", () => {
  const candidate = manifest();
  candidate.capabilities!.chain_key_signing = {
    api: 1,
    slots: [{ id: "a_account", algorithm: "ecdsa_secp256k1", purpose: "Assertion identity", max_assertion_bytes: 32 }],
  };
  const registrations = runtime(candidate);
  const custody = registrations.find(({ kind, resource_id }) =>
    kind === "wallet_custody_signing" && resource_id === "a_account")!;
  expect(custody).toMatchObject({
    format: 1, api: 1, grant: "declaration", toggleable: true,
  });
  expect(custody.declaration_fingerprint).not.toBe(registrations.find(({ kind }) => kind === "chain_key_signing")!.declaration_fingerprint);
  const reordered = structuredClone(candidate);
  reordered.capabilities!.wallet_custody_signing!.slots.reverse();
  expect(serializeCapabilityPlanWireV1(wire(reordered))).toBe(serializeCapabilityPlanWireV1(wire(candidate)));
  expect(parseCapabilityPlanWireV1(wire(candidate))).toEqual(wire(candidate));

  const presentation = structuredClone(candidate);
  presentation.capabilities!.wallet_custody_signing!.slots[1]!.purpose = "Reviewed message signatures";
  expect(runtime(presentation)).toEqual(registrations);
  expect(fingerprintCapabilityPlanWireV1(wire(presentation))).not.toBe(fingerprintCapabilityPlanWireV1(wire(candidate)));

  const renamed = structuredClone(candidate);
  renamed.capabilities!.wallet_custody_signing!.slots[1]!.id = "replacement";
  expect(runtime(renamed).find(({ resource_id }) => resource_id === "replacement")!.declaration_fingerprint).not.toBe(custody.declaration_fingerprint);
  expect(diffCapabilityPlans(wire(candidate), wire(renamed)).entries.map(({ id }) => id)).toEqual(["wallet_custody_signing"]);
});

test("install disclosure distinguishes wallet custody from autonomous assertions", () => {
  const declarations = projectCapabilityInstallDisclosures(wire(manifest())).entries;
  const custody = declarations.find(({ id }) => id === "wallet_custody_signing")!;
  expect(custody.title).toBe("Wallet custody signing");
  expect(custody.summary).toContain("exact transaction or message digests");
  expect(custody.summary).toContain("Trust this app");
  expect(custody.entry).toMatchObject({
    id: "wallet_custody_signing", provenance: "declared", api: 1,
    config: { slots: [{ id: "a_account" }, { id: "z_account" }] },
  });
});
