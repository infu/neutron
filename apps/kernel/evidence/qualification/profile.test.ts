import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PHYSICAL_POPULATION_BATCHES,
  physicalPopulationReceiptRollovers,
} from "./physical_population.ts";
import {
  CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE,
  QUALIFICATION_ACTIVE_BOUNDARY_AWAITED_INGRESSES,
  QUALIFICATION_FRESH_SETUP_FIXED_AWAITED_INGRESSES,
  QUALIFICATION_INSTALL_WASM_MAX_CHUNKS_BOUND,
  QUALIFICATION_MAX_ROUNDS_PER_AWAITED_INGRESS,
  QUALIFICATION_RESET_SETUP_FIXED_AWAITED_INGRESSES,
} from "./profile.ts";

describe("Certified Assets qualification clock budgets", () => {
  test("binds setup drift to two maximum-chunk installs and fixed ingresses", () => {
    const compilerInstallSource = readFileSync(
      path.resolve(
        import.meta.dir,
        "../../../../packages/neutron-compiler/src/install.ts",
      ),
      "utf8",
    );
    expect(compilerInstallSource).toContain(
      `const INSTALL_WASM_MAX_CHUNKS = ${QUALIFICATION_INSTALL_WASM_MAX_CHUNKS_BOUND};`,
    );
    expect(QUALIFICATION_FRESH_SETUP_FIXED_AWAITED_INGRESSES).toBe(13);
    expect(QUALIFICATION_RESET_SETUP_FIXED_AWAITED_INGRESSES).toBe(11);
    expect(
      CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE
        .maximum_setup_implicit_round_drift_ns,
    ).toBe(
      (
        2 * QUALIFICATION_INSTALL_WASM_MAX_CHUNKS_BOUND +
        QUALIFICATION_FRESH_SETUP_FIXED_AWAITED_INGRESSES +
        QUALIFICATION_RESET_SETUP_FIXED_AWAITED_INGRESSES
      ) * QUALIFICATION_MAX_ROUNDS_PER_AWAITED_INGRESS,
    );
    expect(
      CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE
        .maximum_setup_implicit_round_drift_ns,
    ).toBe(22_400);
  });

  test("binds active drift to the largest fixed workload gap", () => {
    const rollovers = physicalPopulationReceiptRollovers();
    let maximumAwaitedIngresses = rollovers[0]!.after_batch_count;
    for (let index = 1; index < rollovers.length; index += 1) {
      const preceding = rollovers[index - 1]!;
      const following = rollovers[index]!;
      maximumAwaitedIngresses = Math.max(
        maximumAwaitedIngresses,
        preceding.expected_maintenance_pages +
          following.after_batch_count -
          preceding.after_batch_count,
      );
    }
    const last = rollovers.at(-1)!;
    maximumAwaitedIngresses = Math.max(
      maximumAwaitedIngresses,
      last.expected_maintenance_pages +
        PHYSICAL_POPULATION_BATCHES -
        last.after_batch_count +
        1,
    );

    expect(maximumAwaitedIngresses).toBe(
      QUALIFICATION_ACTIVE_BOUNDARY_AWAITED_INGRESSES,
    );
    expect(maximumAwaitedIngresses).toBe(10);
    expect(
      CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE
        .maximum_implicit_round_drift_ns_per_boundary,
    ).toBe(
      maximumAwaitedIngresses *
        QUALIFICATION_MAX_ROUNDS_PER_AWAITED_INGRESS,
    );
    expect(
      CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE
        .maximum_implicit_round_drift_ns_per_boundary,
    ).toBe(1_000);
  });
});
