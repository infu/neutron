import { expect, test } from "bun:test";
import {
  buildCapabilityPlan,
  diffCapabilityPlans,
  fingerprintCapabilityPlanWireV1,
  getCapabilityPlanEntry,
  parseCapabilityPlanWireV1,
  projectCapabilityInstallDisclosures,
  projectCapabilitySettingsWireV1,
  projectRuntimeCapabilityRegistrationsV1,
  serializeCapabilityPlanWireV1,
  toCapabilityPlanWireV1,
} from "../src/capabilities/index.ts";
import {
  normalizeManifestCapabilities,
  type NeutronManifest,
} from "../src/schema.ts";
import { assertToolName } from "../src/protocol.ts";
import { validate_neutron_conf } from "../src/validate_schema.ts";

function manifest(): NeutronManifest {
  return {
    format: 3,
    id: "swap_client",
    name: "Swap Client",
    version: 100,
    capabilities: {
      frontend_tools: {
        api: 1,
        targets: [
          {
            app: "evm_wallet",
            tools: ["evm_wallet.sendTransaction", "evm_wallet.accounts"],
          },
          { app: "contacts", tools: ["contacts.search", "contacts.lookup"] },
        ],
      },
    },
  };
}

function wire(candidate = manifest()) {
  return toCapabilityPlanWireV1(buildCapabilityPlan(candidate));
}

test("frontend tool grants normalize exact targets and preserve canonical wire bytes", () => {
  const candidate = manifest();
  expect(validate_neutron_conf(candidate).errors).toEqual([]);
  const expected = {
    api: 1 as const,
    targets: [
      { app: "contacts", tools: ["contacts.lookup", "contacts.search"] },
      {
        app: "evm_wallet",
        tools: ["evm_wallet.accounts", "evm_wallet.sendTransaction"],
      },
    ],
  };
  expect(normalizeManifestCapabilities(candidate).frontend_tools).toEqual(expected);
  expect(getCapabilityPlanEntry(wire(candidate), "frontend_tools")).toEqual({
    id: "frontend_tools",
    api: 1,
    provenance: "declared",
    config: expected,
  });

  const reordered = structuredClone(candidate);
  reordered.capabilities!.frontend_tools!.targets.reverse();
  for (const target of reordered.capabilities!.frontend_tools!.targets) target.tools.reverse();
  expect(serializeCapabilityPlanWireV1(wire(reordered))).toBe(
    serializeCapabilityPlanWireV1(wire(candidate)),
  );
  expect(fingerprintCapabilityPlanWireV1(wire(reordered))).toBe(
    fingerprintCapabilityPlanWireV1(wire(candidate)),
  );
  expect(parseCapabilityPlanWireV1(wire(candidate))).toEqual(wire(candidate));
});

test("frontend tool declarations close fields, versions, targets, and exact name syntax", () => {
  const invalidDeclarations: unknown[] = [
    null,
    { api: 2, targets: [{ app: "evm_wallet", tools: ["evm_wallet.accounts"] }] },
    { api: 1, targets: [] },
    { api: 1, targets: [{ app: "evm_wallet", tools: ["evm_wallet.accounts"] }], roles: ["background"] },
    { api: 1, targets: [{ app: "evm_wallet", tools: [] }] },
    { api: 1, targets: [{ app: "evm_wallet", tools: ["evm_wallet.accounts"], endpoint: "background" }] },
    ...["", "abc", "Uppercase", "_wallet", "wallet_", "evm__wallet", "evm-wallet", "a".repeat(31)].map(
      (app) => ({ api: 1, targets: [{ app, tools: ["evm_wallet.accounts"] }] }),
    ),
    ...["", "*", "evm_wallet.*", "wallet/read", "wallet read", "é", "a".repeat(129)].map(
      (tool) => ({ api: 1, targets: [{ app: "evm_wallet", tools: [tool] }] }),
    ),
  ];
  for (const declaration of invalidDeclarations) {
    const candidate = manifest() as any;
    candidate.capabilities.frontend_tools = declaration;
    expect(validate_neutron_conf(candidate).valid).toBe(false);
    expect(() => normalizeManifestCapabilities(candidate)).toThrow();
    expect(() => buildCapabilityPlan(candidate)).toThrow();
  }

  const boundary = manifest();
  boundary.capabilities!.frontend_tools!.targets = [
    { app: "a".repeat(30), tools: ["A0._-", "a".repeat(128), "0"] },
  ];
  expect(validate_neutron_conf(boundary).errors).toEqual([]);
  expect(() => buildCapabilityPlan(boundary)).not.toThrow();
  for (const tool of boundary.capabilities!.frontend_tools!.targets[0]!.tools) {
    expect(() => assertToolName(tool)).not.toThrow();
  }
  for (const tool of ["evm_wallet.*", "wallet/read", "a".repeat(129)]) {
    expect(() => assertToolName(tool)).toThrow();
  }
});

test("duplicate app authorities and tool names are rejected rather than merged", () => {
  const duplicateApp = manifest();
  duplicateApp.capabilities!.frontend_tools!.targets.push({
    app: "evm_wallet",
    tools: ["evm_wallet.transaction"],
  });
  expect(() => normalizeManifestCapabilities(duplicateApp)).toThrow();
  expect(() => buildCapabilityPlan(duplicateApp)).toThrow();

  const duplicateTool = manifest();
  duplicateTool.capabilities!.frontend_tools!.targets[0]!.tools.push("evm_wallet.accounts");
  expect(validate_neutron_conf(duplicateTool).valid).toBe(false);
  expect(() => normalizeManifestCapabilities(duplicateTool)).toThrow();
  expect(() => buildCapabilityPlan(duplicateTool)).toThrow();
});

test("wire parsing validates frontend tool authority independently of manifest validation", () => {
  for (const mutate of [
    (entry: any) => { entry.api = 2; },
    (entry: any) => { entry.config.api = 2; },
    (entry: any) => { entry.config.targets = []; },
    (entry: any) => { entry.config.allow_all = true; },
    (entry: any) => { entry.config.targets[0].surface = "tile"; },
    (entry: any) => { entry.config.targets[0].app = "bad__app"; },
    (entry: any) => { entry.config.targets[0].tools = ["*"]; },
    (entry: any) => { entry.config.targets[0].tools = ["a".repeat(129)]; },
    (entry: any) => { entry.config.targets[0].tools.push(entry.config.targets[0].tools[0]); },
    (entry: any) => { entry.config.targets.push({ ...entry.config.targets[0], tools: ["different.tool"] }); },
  ]) {
    const candidate = wire() as any;
    mutate(candidate.entries.find((entry: any) => entry.id === "frontend_tools"));
    expect(() => parseCapabilityPlanWireV1(candidate)).toThrow();
  }
});

test("frontend tool declarations do not require a background endpoint or impose list quotas", () => {
  const candidate = manifest();
  candidate.capabilities!.frontend_tools!.targets = Array.from({ length: 40 }, (_, index) => ({
    app: `peer_${index}`,
    tools: Array.from({ length: 65 }, (_, tool) => `tool.${tool}`),
  }));
  expect(candidate.background).toBeUndefined();
  expect(candidate.tiles).toBeUndefined();
  expect(validate_neutron_conf(candidate).errors).toEqual([]);
  const plan = buildCapabilityPlan(candidate);
  expect(plan.entries.map(({ id }) => id)).toEqual(["frontend_tools"]);
  expect(parseCapabilityPlanWireV1(toCapabilityPlanWireV1(plan))).toEqual(toCapabilityPlanWireV1(plan));
  expect(projectRuntimeCapabilityRegistrationsV1(plan)).toEqual([]);
});

test("installation and Settings disclose the exact frontend app and tool authorities", () => {
  const plan = buildCapabilityPlan(manifest());
  const planWire = toCapabilityPlanWireV1(plan);
  const entry = getCapabilityPlanEntry(planWire, "frontend_tools")!;
  const fingerprint = fingerprintCapabilityPlanWireV1(planWire);
  const install = projectCapabilityInstallDisclosures(plan);
  const settings = projectCapabilitySettingsWireV1(planWire);
  expect(install.plan_fingerprint).toBe(fingerprint);
  expect(settings.plan_fingerprint).toBe(fingerprint);
  for (const projection of [install, settings]) {
    const disclosure = projection.entries.find(({ id }) => id === "frontend_tools")!;
    expect(disclosure.entry).toEqual(entry);
    expect(disclosure.title.length).toBeGreaterThan(0);
    expect(disclosure.summary.length).toBeGreaterThan(0);
  }
});

test("changing a declared tool changes installation authority without adding backend registrations", () => {
  const previous = manifest();
  previous.backend = { capabilities: { randomness: { api: 1 } } };
  previous.capabilities!.randomness = { api: 1 };
  const next = structuredClone(previous);
  next.capabilities!.frontend_tools!.targets[0]!.tools.push("evm_wallet.transaction");
  const previousWire = wire(previous);
  const nextWire = wire(next);
  expect(fingerprintCapabilityPlanWireV1(nextWire)).not.toBe(fingerprintCapabilityPlanWireV1(previousWire));
  expect(diffCapabilityPlans(previousWire, nextWire).entries).toMatchObject([
    { change: "changed", id: "frontend_tools" },
  ]);
  const withoutFrontend = structuredClone(previous);
  delete withoutFrontend.capabilities!.frontend_tools;
  const existingRegistrations = projectRuntimeCapabilityRegistrationsV1(buildCapabilityPlan(withoutFrontend));
  expect(existingRegistrations.map(({ kind }) => kind)).toEqual(["randomness"]);
  expect(projectRuntimeCapabilityRegistrationsV1(buildCapabilityPlan(previous))).toEqual(existingRegistrations);
  expect(projectRuntimeCapabilityRegistrationsV1(buildCapabilityPlan(next))).toEqual(existingRegistrations);
});

test("apps without frontend tools retain the previously released capability fingerprint", () => {
  const planWire = wire({
    format: 3,
    id: "plain_app",
    name: "Plain App",
    version: 100,
    tiles: [{ id: "main", title: "Main" }],
  });
  expect(serializeCapabilityPlanWireV1(planWire)).toBe(
    '{"app":{"id":"plain_app","version":100},"entries":[{"api":1,"config":{"endpoints":[{"id":"main","path":"index.html"}]},"id":"tile_endpoints","provenance":"derived"}],"format":1}',
  );
  expect(fingerprintCapabilityPlanWireV1(planWire)).toBe(
    "fadcdb953c2d9054f646b4c46b4b2c772d90e60fc3277faa4505b4c4ad5c3883",
  );
});
