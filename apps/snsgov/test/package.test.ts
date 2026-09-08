import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { generateAppMethodSchemaArtifact } from "neutron-scripts/src/method_schema.js";
import { type NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const backendUrl = new URL("../backend/main.mo", import.meta.url);

async function readManifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

test("the manifest validates against the shared schema", async () => {
  const result = validate_neutron_conf(await readManifest());
  expect(result.valid).toBe(true);
});

test("the app identity is stable and installable", async () => {
  const manifest = (await readManifest()) as unknown as Record<string, unknown>;
  // App ids must be 4-30 chars; "sns" would be rejected by the installer.
  expect(manifest.id).toBe("snsgov");
  expect(String(manifest.id).length).toBeGreaterThanOrEqual(4);
  expect(manifest.format).toBe(3);
  expect(manifest.name).toBe("SNS Governance");
});

test("it declares a tile and a resident background", async () => {
  const manifest = (await readManifest()) as unknown as {
    tiles: { id: string; path: string }[];
    background: { path: string };
  };
  expect(manifest.tiles).toHaveLength(1);
  expect(manifest.tiles[0]?.id).toBe("main");
  // Agent tools are registered by the background so an agent can reach them
  // with no tile open. Losing this declaration silently breaks that.
  expect(manifest.background?.path).toBe("service.html");
});

test("every preapproved self call resolves to a real authorized method", async () => {
  const manifest = (await readManifest()) as unknown as {
    capabilities?: { preapproved_self_calls?: { methods: string[] } };
    func: Record<string, { type: string }>;
  };
  const declared = manifest.capabilities?.preapproved_self_calls?.methods ?? [];
  expect(declared.length).toBeGreaterThan(0);
  for (const method of declared) {
    const entry = manifest.func[method];
    if (entry === undefined) throw new Error(`preapproved method ${method} is not declared in func`);
    // Internal methods cannot be preapproved self calls.
    expect(["query", "update"]).toContain(entry?.type);
  }
});

test("the relay-facing helpers stay internal", async () => {
  const manifest = (await readManifest()) as unknown as { func: Record<string, { type: string }> };
  // These authorize and record signed writes. Exposing them as app methods
  // would let the frontend forge audit rows or bypass the allowlist.
  expect(manifest.func.snsgov_allowed?.type).toBe("internal");
  expect(manifest.func.snsgov_audit_append?.type).toBe("internal");
});

test("the backend models no SNS domain types", async () => {
  const backend = await readFile(backendUrl, "utf8");
  // The backend is a state store and (later) a byte relay. Modelling SNS Candid
  // in Motoko would create a second, drifting source of truth and would trap on
  // an unknown variant tag after an SNS upgrade.
  for (const forbidden of ["ManageNeuron", "ProposalData", "NervousSystemParameters", "RegisterVote"]) {
    expect(backend).not.toContain(forbidden);
  }
});

test("draft validation mirrors the SNS canister's own limits", async () => {
  const backend = await readFile(backendUrl, "utf8");
  // title and summary are BYTES, url is CHARACTERS. Conflating them is the
  // easy mistake, so the constants are pinned here.
  expect(backend).toContain("MAX_TITLE_BYTES : Nat = 256");
  expect(backend).toContain("MAX_SUMMARY_BYTES : Nat = 30_000");
  expect(backend).toContain("MAX_URL_CHARS : Nat = 2_048");
});

test("generated method schemas are usable by tooling", async () => {
  const artifact = generateAppMethodSchemaArtifact(
    await readManifest(),
    await readFile(backendUrl, "utf8"),
  );
  expect(artifact.app.id).toBe("snsgov");
  expect(Object.keys(artifact.methods).length).toBeGreaterThan(0);
  // Internal methods are not part of the public method surface.
  expect(artifact.methods.snsgov_allowed).toBeUndefined();
  expect(artifact.methods.snsgov_config).toBeDefined();
});

test("candid bindings are checked in and pinned to a source revision", async () => {
  const governance = await readFile(
    new URL("../src/candid/sns_governance.did.js", import.meta.url),
    "utf8",
  );
  expect(governance).toContain("GENERATED FILE");
  expect(governance).toContain("dfinity/ic");
  // One candid codec in the bundle; two produce non-interoperable IDL instances.
  expect(governance).toContain('from \'@dfinity/candid\'');
  expect(governance).not.toContain("@icp-sdk/core");
});

test("the agent tool surface cannot submit proposals or grant permissions", async () => {
  const service = await readFile(new URL("../src/service.ts", import.meta.url), "utf8");
  const registered = [...service.matchAll(/exposeTool\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);

  expect(registered.length).toBeGreaterThan(10);
  expect(registered).toContain("sns_list");
  expect(registered).toContain("sns_vote");
  expect(registered).toContain("sns_draft_proposal");

  // The safety property is structural: a tool that is never registered cannot
  // be invoked by any prompt, any injected instruction inside a proposal
  // summary, or any delegated child invocation. Submission and permission
  // granting happen only from the tile.
  for (const forbidden of [
    "sns_submit_proposal",
    "sns_submit",
    "sns_add_permissions",
    "sns_grant",
    "sns_manage_neuron",
  ]) {
    expect(registered).not.toContain(forbidden);
  }
});

test("every tool name is namespaced and discoverable", async () => {
  const service = await readFile(new URL("../src/service.ts", import.meta.url), "utf8");
  const registered = [...service.matchAll(/exposeTool\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]!);
  expect(new Set(registered).size).toBe(registered.length); // no duplicates
  for (const name of registered) {
    expect(name.startsWith("sns_")).toBe(true);
  }
});

test("the relay never takes its target from the caller", async () => {
  const backend = await readFile(backendUrl, "utf8");
  // The method is fixed and the canister comes from the allowlist lookup, so a
  // compromised frontend cannot redirect a signed call at an arbitrary target.
  expect(backend).toContain('let MANAGE_NEURON : Text = "manage_neuron"');
  expect(backend).toContain("method = MANAGE_NEURON");
  expect(backend).toContain("snsgov_allowed(request.sns, forAgent)");
  // RelayRequest must not carry a caller-chosen canister or method.
  const relayType = backend.slice(
    backend.indexOf("public type RelayRequest"),
    backend.indexOf("public type RelayResult"),
  );
  expect(relayType).not.toContain("canister :");
  expect(relayType).not.toContain("method :");
});
