import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("dispenser provisions through a persistent one-time activation handoff", async () => {
  const [
    backend,
    managementBinding,
    neutronBinding,
    frontend,
    provisioning,
    build,
    packageText,
  ] = await Promise.all([
    readFile(new URL("../mo/main.mo", import.meta.url), "utf8"),
    readFile(new URL("../mo/lib/IC.mo", import.meta.url), "utf8"),
    readFile(new URL("../mo/lib/neutron.mo", import.meta.url), "utf8"),
    readFile(new URL("../src/index.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/provisioning.ts", import.meta.url), "utf8"),
    readFile(new URL("../build.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  expect(backend).not.toMatch(/repo\s*:/i);
  expect(backend).not.toMatch(/manifest\s*:/i);
  expect(frontend).toContain("dispenser.provision(hash)");
  expect(frontend).toContain('rel="noopener noreferrer"');
  expect(frontend).toContain("consumeSetupHandoff");
  expect(frontend).toContain("Open and activate SushiOS");
  expect(frontend).toContain('window.addEventListener("hashchange"');
  expect(frontend).toContain("if (event.button === 1)");
  expect(frontend).toContain("DISPENSER_CANISTER_ID");
  expect(frontend).not.toContain("InternetIdentity");
  expect(packageText).not.toMatch(/auth-client|icblast/i);
  expect(frontend).toContain("window.localStorage");
  expect(frontend).toContain("account_balance");
  expect(frontend).toContain("automaticProvisionStarted.current = true");
  expect(provisioning).toContain("appendInternalHandoffFragment(base, setup)");
  expect(provisioning).toContain("Ed25519KeyIdentity.generate");
  expect(provisioning).toContain("activationToken");
  expect(build).toContain("process.env.LOCAL");
  expect(build).toContain("process.env.ICP_LOCAL_HOST");
  expect(frontend).toContain("fetchRootKey");
  expect(provisioning).toContain("runtimeNeutronUrl");
  expect(build).toContain("./.icp/data/mappings/ic.ids.json");
  expect(build).not.toContain("MAINNET_DISPENSER_BACKEND_CANISTER_ID");

  const activeBackend = backend.slice(
    backend.indexOf("persistent actor class"),
  );
  for (const source of [
    activeBackend,
    neutronBinding,
    frontend,
    provisioning,
  ]) {
    expect(source).not.toMatch(
      /bootstrap.?claim|prepare_claim|claim_issued|consumed_claim/i,
    );
  }
  expect(activeBackend).toContain("MINIMUM_DEPOSIT_E8S : Nat64 = 200_000_000");
  expect(activeBackend).toContain("kernel_activation");
  expect(activeBackend).toContain(
    "runtime_config_template : RuntimeConfigTemplate",
  );
  expect(activeBackend).toContain('key = "/system/runtime-config.json"');
  expect(activeBackend).toContain(
    "await neutron.kernel_publication_entropy_initialize(null)",
  );
  expect(activeBackend).toContain("#activated");
  expect(activeBackend).toContain("assertDispenserController(caller)");
  expect(activeBackend).toContain("await ic.canister_info");
  expect(managementBinding).toContain("canister_info");
  expect(neutronBinding).toContain("kernel_activation");
  expect(neutronBinding).toContain(
    "kernel_publication_entropy_initialize : shared Null ->",
  );
  expect(neutronBinding).not.toContain("kernel_install_code");
  expect(activeBackend.indexOf("let ?candidate = current_starter")).toBeLessThan(
    activeBackend.indexOf("await ledger.account_balance"),
  );
  expect(activeBackend).toContain(
    "No committed Neutron starter is configured",
  );
  expect(frontend).not.toMatch(/reinstall/i);
  expect(provisioning).not.toMatch(/reinstall|upgrade/i);
  expect(activeBackend).not.toContain("#reinstall");
  expect(activeBackend).not.toContain("#upgrade");
  expect(activeBackend).not.toContain(
    "provisional_create_canister_with_cycles",
  );
  expect(activeBackend).not.toContain("create_local");
  expect(activeBackend).not.toMatch(/func (?:reinstall|upgrade)\b/i);
  expect(backend).not.toContain("with migration");
  expect(backend).toContain("mode = #install");
  expect(backend).toContain("Map.empty<Principal, Registration>()");
  expect(backend).toContain("var current_starter : ?CommittedStarter = null");
  expect(backend).toContain("created_at_time");
  expect(backend).toContain("#TxDuplicate");
  const newRegistration = backend.slice(
    backend.indexOf("case null {", backend.indexOf("private func advance")),
    backend.indexOf("case (?existing)", backend.indexOf("private func advance")),
  );
  expect(newRegistration).not.toContain("Map.add");
  const paidBoundary = backend.slice(
    backend.indexOf("await ledger.account_balance"),
    backend.indexOf("case (#transferring(transfer))"),
  );
  expect(paidBoundary).toContain("starter = ?committedStarter");
  expect(paidBoundary).toContain(
    "starter_revision = ?committedStarter.info.revision",
  );
  const awaitingPhase = backend.slice(
    backend.indexOf("case (#awaiting_payment)"),
    backend.indexOf("case (#transferring(transfer))"),
  );
  expect(awaitingPhase).toContain("boundStarter(registration)");
  expect(awaitingPhase.indexOf("case (?bound) bound")).toBeLessThan(
    awaitingPhase.indexOf("let ?candidate = current_starter"),
  );
  expect(awaitingPhase.indexOf("let ?candidate = current_starter")).toBeLessThan(
    awaitingPhase.indexOf("await ledger.account_balance"),
  );
  expect(paidBoundary.indexOf("starter = ?committedStarter")).toBeLessThan(
    paidBoundary.indexOf("#transferring(transfer)"),
  );
  const effectfulTail = backend.slice(
    backend.indexOf("case (#transferring(transfer))"),
    backend.indexOf("private func setPhase"),
  );
  expect(effectfulTail).not.toContain("current_starter");
  const createdPhase = backend.slice(
    backend.indexOf("case (#created(canisterId))"),
    backend.indexOf("case (#installed(canisterId))"),
  );
  expect(createdPhase).toContain(
    "starter.info.backend_call_target_principals",
  );
  expect(createdPhase).toContain(
    "Starter backend-call reservation targets the created Neutron canister",
  );
  expect(createdPhase.indexOf("backend_call_target_principals")).toBeLessThan(
    createdPhase.indexOf("await ic.canister_status"),
  );
  expect(createdPhase.indexOf("backend_call_target_principals")).toBeLessThan(
    createdPhase.indexOf("await ic.install_code"),
  );
  expect(createdPhase).toContain("wasm_module = starter.wasm");
  expect(createdPhase).toContain(
    "moduleHash != starter.info.wasm_sha256",
  );
  const controlledPhase = backend.slice(
    backend.indexOf("case (#controlled(canisterId))"),
    backend.indexOf("case (#assets_seeded(canisterId))"),
  );
  expect(controlledPhase).toContain("starter.files.vals()");
  expect(controlledPhase).toContain("starter.file_chunks.vals()");
  expect(controlledPhase).toContain("starter.runtime_config_template");
  const finalHandoffStart = backend.indexOf("case (#activated(canisterId))");
  expect(
    backend.indexOf("kernel_publication_entropy_initialize"),
  ).toBeLessThan(backend.indexOf("case (#assets_seeded(canisterId))"));
  const finalHandoff = backend.slice(
    finalHandoffStart,
    backend.indexOf("case (#complete(canisterId))", finalHandoffStart),
  );
  expect(finalHandoff.indexOf("await ic.canister_info")).toBeLessThan(
    finalHandoff.indexOf("await updateControllers"),
  );
  expect(finalHandoff).toContain(
    "controllersEqual(current.controllers, [canisterId])",
  );
  expect(finalHandoff).toContain(
    "completeRegistration(caller, registration, canisterId)",
  );
  const completion = backend.slice(
    backend.indexOf("private func completeRegistration"),
    backend.indexOf("private func releaseStarterAtAssetsSeeded"),
  );
  expect(completion).toContain("phase = #complete(canisterId)");
  const starterRelease = backend.slice(
    backend.indexOf("private func releaseStarterAtAssetsSeeded"),
    backend.indexOf("private func boundStarter"),
  );
  expect(starterRelease).toContain("starter = null");
  expect(starterRelease).toContain("phase = #assets_seeded(canisterId)");

  const consumeSetup = frontend.slice(
    frontend.indexOf("const consumeSetupHandoff"),
    frontend.indexOf("const refreshState"),
  );
  expect(consumeSetup).toContain("setSetup(null)");
  expect(consumeSetup).toContain("consumePendingSetup()");
  expect(consumeSetup).toContain("window.setTimeout");
  expect(consumeSetup).toContain("stripFragmentBestEffort()");

  const storageDenied = provisioning.slice(
    provisioning.indexOf('result.status === "storage_error"'),
    provisioning.indexOf('result.status === "invalid"'),
  );
  expect(storageDenied).toContain("setup: result.reference");
  expect(storageDenied).not.toContain("stripFragment()");
});
