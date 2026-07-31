import { describe, expect, test } from "bun:test";
import {
  BRAIN_CATALOG_SCHEMA_VERSION,
  BrainCatalogError,
  parseBrainCatalog,
  unbiasedCatalogIndex,
} from "../src/brain_catalog.ts";
import { encodeShareCode, parseShareCode } from "../src/share_code.ts";

describe("HullshiftBrain catalog identity", () => {
  test("freezes unbiased SHA-256 selection vectors", () => {
    expect(unbiasedCatalogIndex("0000000000000000", 0, 37)).toBe(1);
    expect(unbiasedCatalogIndex("ffffffffffffffff", 8, 64)).toBe(21);
    expect(unbiasedCatalogIndex("0123456789abcdef", 4, 997)).toBe(96);
    expect(unbiasedCatalogIndex("deadbeefcafebabe", 7, 2)).toBe(1);
  });

  test("rejects noncanonical selection inputs", () => {
    expect(() => unbiasedCatalogIndex("1", 0, 1)).toThrow(RangeError);
    expect(() => unbiasedCatalogIndex("0000000000000000", 9, 1)).toThrow(RangeError);
    expect(() => unbiasedCatalogIndex("0000000000000000", 0, 0)).toThrow(RangeError);
  });

  test("accepts an empty staging catalog but rejects wrong version metadata", () => {
    expect(parseBrainCatalog({
      schemaVersion: BRAIN_CATALOG_SCHEMA_VERSION,
      generatorVersion: "g4",
      brainVersion: "test-brain",
      entries: [],
    }).entries).toEqual([]);
    expect(() => parseBrainCatalog({
      schemaVersion: BRAIN_CATALOG_SCHEMA_VERSION,
      generatorVersion: "g3",
      brainVersion: "test-brain",
      entries: [],
    })).toThrow(BrainCatalogError);
    expect(() => parseBrainCatalog({
      schemaVersion: BRAIN_CATALOG_SCHEMA_VERSION,
      generatorVersion: "g4",
      brainVersion: "test-brain",
      entries: [],
      ignored: true,
    })).toThrow(/unknown field/);
  });

  test("rejects locale-sensitive catalog ids before selection", () => {
    expect(() => parseBrainCatalog({
      schemaVersion: BRAIN_CATALOG_SCHEMA_VERSION,
      generatorVersion: "g4",
      brainVersion: "test-brain",
      entries: [{
        id: "bräin-level",
        difficulty: 0,
        level: {},
        levelHash: "0".repeat(64),
        witness: [],
        milestones: [],
        requiredPrecedence: [],
        topologySignature: "topology",
        semanticSignature: "semantic",
        provenance: {},
        certificate: {},
      }],
    })).toThrow(/invalid id/);
  });
});

describe("Hullshift g4 share identity", () => {
  test("has frozen share-code vectors and round trips", () => {
    const vectors = [
      "HS1-G4-D0-S0000000000000001-C9e629938",
      "HS1-G4-D4-S0000000000000001-C770a94da",
      "HS1-G4-D8-S0000000000000001-C97c384bd",
    ] as const;
    for (const [difficulty, expected] of [[0, vectors[0]], [4, vectors[1]], [8, vectors[2]]] as const) {
      expect(encodeShareCode({ generatorVersion: "g4", seed: 1n, difficulty })).toBe(expected);
      expect(parseShareCode(expected)).toMatchObject({
        generatorVersion: "g4",
        seed: 1n,
        difficulty,
      });
    }
  });
});
