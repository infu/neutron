import { expect, test } from "bun:test";
import {
  readManagedMemoryRetirements,
  validateCommittedManagedMemoryRetirements,
  writeManagedMemoryRetirements,
} from "../src/memory_retirements.ts";
import type { PackagedNeutronManifest } from "neutron-tools/src/schema.js";

const retirement = {
  memoryId: "mail_state",
  owner: "mail",
  version: 2,
  schemaEntry: "a".repeat(64),
};

test("stable signatures carry one canonical bounded retirement marker", () => {
  const stable = writeManagedMemoryRetirements(
    "// Version: 1.0.0\nactor {};\n",
    [retirement],
  );

  expect(readManagedMemoryRetirements(stable)).toEqual([retirement]);
  expect(stable.match(/@neutron-managed-memory-retirements-v2/g)).toHaveLength(
    1,
  );
  expect(
    readManagedMemoryRetirements(
      writeManagedMemoryRetirements("actor {};", []),
    ),
  ).toEqual([]);
});

test("non-null V2 stable signatures require exactly one canonical marker", () => {
  expect(() => readManagedMemoryRetirements("")).toThrow(
    /exactly one managed-memory retirement marker/,
  );
  expect(() => readManagedMemoryRetirements("actor {};\n")).toThrow(
    /exactly one managed-memory retirement marker/,
  );
  const stable = writeManagedMemoryRetirements("actor {};", []);
  expect(() => readManagedMemoryRetirements(`${stable}${stable}`)).toThrow(
    /exactly one managed-memory retirement marker/,
  );
  expect(() =>
    readManagedMemoryRetirements(
      "actor {};\n// @neutron-managed-memory-retirements-v2 [{\"owner\":\"mail\",\"memory_id\":\"mail_state\",\"version\":2,\"schema_entry\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}]\n",
    ),
  ).toThrow(/non-canonical managed-memory metadata/);
});

test("retirement identity is the exact owner and local memory id", () => {
  const sameLocalId = {
    ...retirement,
    owner: "alpha",
  };
  const stable = writeManagedMemoryRetirements("actor {};", [
    retirement,
    sameLocalId,
  ]);

  expect(readManagedMemoryRetirements(stable)).toEqual([
    sameLocalId,
    retirement,
  ]);
  expect(() =>
    writeManagedMemoryRetirements("actor {};", [retirement, retirement]),
  ).toThrow(/Duplicate target managed-memory retirement mail\.mail_state/);
});

test("the flat V1 retirement marker is not a compatibility input", () => {
  expect(() =>
    readManagedMemoryRetirements(
      "actor {};\n// @neutron-managed-memory-retirements-v1 []\n",
    ),
  ).toThrow(/exactly one managed-memory retirement marker/);
});

test("retirement ownership validation ignores another app's equal local id", () => {
  const appWithState = (id: string): PackagedNeutronManifest => ({
    format: 3,
    id,
    name: id,
    version: 100,
    entry: "b".repeat(64),
    memory: {
      mail_state: {
        version: 2,
        schemas: {
          "2": { entry: retirement.schemaEntry, hash: retirement.schemaEntry },
        },
        migrations: [],
      },
    },
  });

  expect(() =>
    validateCommittedManagedMemoryRetirements([retirement], {
      alpha: appWithState("alpha"),
    }),
  ).not.toThrow();
  expect(() =>
    validateCommittedManagedMemoryRetirements([retirement], {
      mail: appWithState("mail"),
    }),
  ).toThrow(/mail\.mail_state conflicts/);
});
