import { describe, expect, test } from "bun:test";
import {
  CERTIFIED_ASSETS_MAINTENANCE_RECEIPTS_PER_PAGE,
  CERTIFIED_ASSETS_RECEIPT_RECONCILE_NS,
  PHYSICAL_ABSENCE_TERMINAL_WITNESS_BYTES,
  PHYSICAL_ABSENCE_WITNESS_CANDIDATES,
  PHYSICAL_POPULATION_BATCHES,
  PHYSICAL_POPULATION_BATCH_OPERATIONS,
  PHYSICAL_POPULATION_ENTRIES,
  PHYSICAL_POPULATION_FINAL_USAGE,
  PHYSICAL_POPULATION_INITIAL_USAGE,
  PHYSICAL_POPULATION_MAX_COMMITTED_BYTES,
  PHYSICAL_POPULATION_OVERFLOW_EXPECTATION,
  PHYSICAL_POPULATION_RECEIPT_LIMIT,
  PHYSICAL_POPULATION_ROUTE_PREFIX,
  PHYSICAL_PRESENT_TERMINAL_WITNESS_BYTES,
  PHYSICAL_PRESENT_WITNESS_CANDIDATES,
  assertPhysicalWitnessCandidateDerivation,
  physicalPopulationAbsenceKey,
  physicalPopulationBatches,
  physicalPopulationOverflowInput,
  physicalPopulationPath,
  physicalPopulationPresentKey,
  physicalPopulationReceiptRollovers,
  physicalReceiptReclaimedChargedBytes,
} from "./physical_population.ts";

describe("Certified Assets physical population", () => {
  test("streams the bounded profile in full deterministic batches", () => {
    const keys = new Set<string>();
    const nonces = new Set<string>();
    let batches = 0;
    let entries = 0;
    for (const batch of physicalPopulationBatches(7n)) {
      expect(batch.batch_index).toBe(batches);
      expect(batch.first_entry_index).toBe(entries);
      expect(batch.input.operations).toHaveLength(
        PHYSICAL_POPULATION_BATCH_OPERATIONS,
      );
      expect(batch.input.requires_present_after).toEqual([]);
      nonces.add(Buffer.from(batch.input.nonce).toString("hex"));
      for (const [offset, operation] of
        batch.input.operations.entries()) {
        const entryIndex = entries + offset;
        expect(operation.put.target.collection_generation).toBe(7n);
        expect(operation.put.condition).toEqual({ absent: null });
        expect(operation.put.body.inline).toEqual(
          Uint8Array.of(entryIndex & 0xff),
        );
        keys.add(
          Buffer.from(
            operation.put.target.locator.key32.key,
          ).toString("hex"),
        );
      }
      entries += batch.input.operations.length;
      batches += 1;
    }
    expect(batches).toBe(PHYSICAL_POPULATION_BATCHES);
    expect(entries).toBe(PHYSICAL_POPULATION_ENTRIES);
    expect(keys.size).toBe(PHYSICAL_POPULATION_ENTRIES);
    expect(nonces.size).toBe(PHYSICAL_POPULATION_BATCHES);
    expect(PHYSICAL_POPULATION_MAX_COMMITTED_BYTES).toBe(257);
    expect(PHYSICAL_POPULATION_INITIAL_USAGE).toEqual({
      live_entries: 0n,
      occupied_entry_slots: 0n,
      committed_body_bytes: 0n,
      reserved_committed_body_bytes: 0n,
      accepted_staged_bytes: 0n,
      reserved_staged_bytes: 0n,
      detached_charged_bytes: 0n,
      active_stages: 0n,
      reserved_entry_slots: 0n,
      receipt_lanes: 0n,
      general_receipt_lanes: 0n,
      reserved_general_receipt_lanes: 0n,
      reserved_revocation_lanes: 0n,
      filled_revocation_lanes: 0n,
      receipt_nonce_indexes: 0n,
      receipt_expiry_indexes: 0n,
      cleanup_jobs: 0n,
    });
  });

  test("places deterministic odd absence keys in every neighbor gap and both boundaries", () => {
    expect(hex(physicalPopulationPresentKey(0))).toEndWith("0000000000000002");
    expect(
      hex(physicalPopulationPresentKey(PHYSICAL_POPULATION_ENTRIES - 1)),
    ).toEndWith("0000000000000200");
    expect(hex(physicalPopulationAbsenceKey(0))).toEndWith(
      "0000000000000001",
    );
    expect(
      hex(physicalPopulationAbsenceKey(PHYSICAL_POPULATION_ENTRIES)),
    ).toEndWith("0000000000000201");
    expect(
      physicalPopulationPath(physicalPopulationPresentKey(0)),
    ).toBe(`${PHYSICAL_POPULATION_ROUTE_PREFIX}${"0".repeat(63)}2`);
    const overflow = physicalPopulationOverflowInput(7n);
    expect(overflow.operations).toHaveLength(1);
    expect(
      hex(overflow.operations[0]!.put.target.locator.key32.key),
    ).toBe(
      hex(
        physicalPopulationAbsenceKey(
          PHYSICAL_POPULATION_ENTRIES,
        ),
      ),
    );
    expect(PHYSICAL_POPULATION_OVERFLOW_EXPECTATION).toEqual({
      attempted_entries: 257n,
      maximum_entries: 256n,
      attempted_committed_body_bytes: 257n,
      maximum_committed_body_bytes: 257n,
      isolated_resource: "entries",
      expected_error: "quota",
    });
    expect(
      PHYSICAL_POPULATION_OVERFLOW_EXPECTATION.attempted_entries,
    ).toBeGreaterThan(
      PHYSICAL_POPULATION_OVERFLOW_EXPECTATION.maximum_entries,
    );
    expect(
      PHYSICAL_POPULATION_OVERFLOW_EXPECTATION
        .attempted_committed_body_bytes,
    ).toBeLessThanOrEqual(
      PHYSICAL_POPULATION_OVERFLOW_EXPECTATION
        .maximum_committed_body_bytes,
    );
  });

  test("rolls receipts only at exact admission boundaries", () => {
    const rollovers = physicalPopulationReceiptRollovers();
    expect(PHYSICAL_POPULATION_RECEIPT_LIMIT).toBe(8);
    expect(
      physicalReceiptReclaimedChargedBytes(
        PHYSICAL_POPULATION_RECEIPT_LIMIT,
      ),
    ).toBe(8_192n);
    expect(rollovers).toEqual([
      {
        after_batch_count: 8,
        advance_time_ns:
          CERTIFIED_ASSETS_RECEIPT_RECONCILE_NS + 1n,
        expected_receipts_reclaimed: 8,
        expected_maintenance_pages: 1,
        usage_before: {
          live_entries: 128n,
          occupied_entry_slots: 128n,
          committed_body_bytes: 128n,
          reserved_committed_body_bytes: 0n,
          accepted_staged_bytes: 0n,
          reserved_staged_bytes: 0n,
          detached_charged_bytes: 0n,
          active_stages: 0n,
          reserved_entry_slots: 0n,
          receipt_lanes: 136n,
          general_receipt_lanes: 8n,
          reserved_general_receipt_lanes: 0n,
          reserved_revocation_lanes: 128n,
          filled_revocation_lanes: 0n,
          receipt_nonce_indexes: 8n,
          receipt_expiry_indexes: 8n,
          cleanup_jobs: 0n,
        },
        usage_after: {
          live_entries: 128n,
          occupied_entry_slots: 128n,
          committed_body_bytes: 128n,
          reserved_committed_body_bytes: 0n,
          accepted_staged_bytes: 0n,
          reserved_staged_bytes: 0n,
          detached_charged_bytes: 0n,
          active_stages: 0n,
          reserved_entry_slots: 0n,
          receipt_lanes: 128n,
          general_receipt_lanes: 0n,
          reserved_general_receipt_lanes: 0n,
          reserved_revocation_lanes: 128n,
          filled_revocation_lanes: 0n,
          receipt_nonce_indexes: 0n,
          receipt_expiry_indexes: 0n,
          cleanup_jobs: 0n,
        },
      },
    ]);
    expect(rollovers).toHaveLength(
      Math.floor(
        (PHYSICAL_POPULATION_BATCHES - 1) /
          PHYSICAL_POPULATION_RECEIPT_LIMIT,
      ),
    );
    for (const [index, rollover] of rollovers.entries()) {
      expect(rollover.after_batch_count).toBe(
        (index + 1) * PHYSICAL_POPULATION_RECEIPT_LIMIT,
      );
      expect(rollover.advance_time_ns).toBe(
        CERTIFIED_ASSETS_RECEIPT_RECONCILE_NS + 1n,
      );
      expect(rollover.expected_maintenance_pages).toBe(
        Math.ceil(
          PHYSICAL_POPULATION_RECEIPT_LIMIT /
            CERTIFIED_ASSETS_MAINTENANCE_RECEIPTS_PER_PAGE,
        ),
      );
      expect(rollover.expected_receipts_reclaimed).toBe(
        PHYSICAL_POPULATION_RECEIPT_LIMIT,
      );
    }
    expect(PHYSICAL_POPULATION_FINAL_USAGE).toEqual({
      live_entries: 256n,
      occupied_entry_slots: 256n,
      committed_body_bytes: 256n,
      reserved_committed_body_bytes: 0n,
      accepted_staged_bytes: 0n,
      reserved_staged_bytes: 0n,
      detached_charged_bytes: 0n,
      active_stages: 0n,
      reserved_entry_slots: 0n,
      receipt_lanes: 264n,
      general_receipt_lanes: 8n,
      reserved_general_receipt_lanes: 0n,
      reserved_revocation_lanes: 256n,
      filled_revocation_lanes: 0n,
      receipt_nonce_indexes: 8n,
      receipt_expiry_indexes: 8n,
      cleanup_jobs: 0n,
    });
  });

  test("pins the exhaustive LLRB terminal-map witness maxima", () => {
    const geometry = assertPhysicalWitnessCandidateDerivation();
    expect(geometry.present.bytes).toBe(
      PHYSICAL_PRESENT_TERMINAL_WITNESS_BYTES,
    );
    expect(geometry.present.key_values).toEqual(
      PHYSICAL_PRESENT_WITNESS_CANDIDATES.map(
        ({ key_value }) => Number(key_value),
      ),
    );
    expect(geometry.absence.bytes).toBe(
      PHYSICAL_ABSENCE_TERMINAL_WITNESS_BYTES,
    );
    expect(geometry.absence.key_values).toEqual(
      PHYSICAL_ABSENCE_WITNESS_CANDIDATES.map(
        ({ key_value }) => Number(key_value),
      ),
    );
    expect(
      PHYSICAL_PRESENT_WITNESS_CANDIDATES.every(
        ({ path }) => path.startsWith(PHYSICAL_POPULATION_ROUTE_PREFIX),
      ),
    ).toBe(true);
    expect(
      PHYSICAL_ABSENCE_WITNESS_CANDIDATES.every(
        ({ path }) => path.startsWith(PHYSICAL_POPULATION_ROUTE_PREFIX),
      ),
    ).toBe(true);
  });
});

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}
