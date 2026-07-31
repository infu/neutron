import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BROWSER_LIBRARY_VECTOR_FILE,
  assertPinnedBrowserLibraryEvidence,
  encodeBrowserLibraryVector,
  parseBrowserLibraryVector,
  verifyBrowserLibraryVector,
  type BrowserLibraryVector,
} from "../scripts/browser-library-vectors";

const fixtureRoot = resolve(import.meta.dir, "..");
const vectorPath = resolve(fixtureRoot, BROWSER_LIBRARY_VECTOR_FILE);

async function loadVector(): Promise<{
  text: string;
  vector: BrowserLibraryVector;
}> {
  const text = await readFile(vectorPath, "utf8");
  return { text, vector: parseBrowserLibraryVector(text) };
}

function clone(vector: BrowserLibraryVector): BrowserLibraryVector {
  return JSON.parse(JSON.stringify(vector)) as BrowserLibraryVector;
}

function flipFirstBit(hex: string): string {
  const first = Number.parseInt(hex.slice(0, 2), 16) ^ 0x01;
  return first.toString(16).padStart(2, "0") + hex.slice(2);
}

describe("pinned official vetKeys browser-library vectors", () => {
  test("decrypts and verifies the real current and previous responses offline", async () => {
    const { text, vector } = await loadVector();
    await assertPinnedBrowserLibraryEvidence(fixtureRoot, text);
    expect(() => verifyBrowserLibraryVector(vector)).not.toThrow();
    expect(vector.generations.current.generation).toBe("2");
    expect(vector.generations.previous.generation).toBe("1");
  });

  test("rejects every cryptographic input mutation for both generations", async () => {
    const { vector } = await loadVector();
    for (const status of ["current", "previous"] as const) {
      for (const field of [
        "encryptedVetKeyHex",
        "publicKeyHex",
        "derivationInputHex",
        "decryptedVetKeyHex",
      ] as const) {
        const mutated = clone(vector);
        mutated.generations[status][field] = flipFirstBit(
          mutated.generations[status][field],
        );
        expect(
          () => verifyBrowserLibraryVector(mutated),
          `${status} ${field} mutation must fail closed`,
        ).toThrow();
      }
    }
  });

  test("rejects transport mutation and cross-generation response substitution", async () => {
    const { vector } = await loadVector();
    for (const field of ["secretKeyHex", "publicKeyHex"] as const) {
      const mutated = clone(vector);
      mutated.transport[field] = flipFirstBit(mutated.transport[field]);
      expect(
        () => verifyBrowserLibraryVector(mutated),
        `transport ${field} mutation must fail closed`,
      ).toThrow();
    }

    for (const [target, source] of [
      ["current", "previous"],
      ["previous", "current"],
    ] as const) {
      const substituted = clone(vector);
      substituted.generations[target].encryptedVetKeyHex =
        substituted.generations[source].encryptedVetKeyHex;
      expect(
        () => verifyBrowserLibraryVector(substituted),
        `${source} ciphertext must not verify as ${target}`,
      ).toThrow();
    }
  });

  test("rejects noncanonical, expanded, or profile-mutated vector documents", async () => {
    const { text, vector } = await loadVector();
    expect(encodeBrowserLibraryVector(vector)).toBe(text);
    expect(() => parseBrowserLibraryVector(` ${text}`)).toThrow(/canonical/u);

    const expanded = JSON.parse(text) as Record<string, unknown>;
    expanded.unreviewed = true;
    expect(() => parseBrowserLibraryVector(JSON.stringify(expanded))).toThrow(
      /fields/u,
    );

    const profileMutation = clone(vector);
    profileMutation.capture.slotUid = "3" as "2";
    expect(() => verifyBrowserLibraryVector(profileMutation)).toThrow(/slotUid/u);
  });
});
