import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const [adapterSource, requestTypesSource, managementTypesSource] = await Promise.all([
  readFile(new URL("../backend/vetkeys/Adapter.mo", import.meta.url), "utf8"),
  readFile(new URL("../backend/vetkeys/Types.mo", import.meta.url), "utf8"),
  readFile(new URL("../backend/aaa_interface.mo", import.meta.url), "utf8"),
]);

describe("vetKD management adapter target boundary", () => {
  test("always requests the local calling canister public key", () => {
    // vetkd_public_key is the only vetKD operation with a canister selector.
    // Keeping exactly one fixed-null occurrence makes a remote target an
    // explicit test failure instead of an app-controlled adapter option.
    expect(adapterSource.match(/\bcanister_id\b/gu)).toHaveLength(1);
    expect(adapterSource).toMatch(
      /vetkd_public_key\s*\(\s*\{[\s\S]*?canister_id\s*=\s*null\s*;/u,
    );
  });

  test("does not expose a remote canister selector to adapter callers", () => {
    const publicRequest = requestTypesSource.match(
      /public type AdapterPublicKeyRequest\s*=\s*\{([\s\S]*?)\n\s*\};/u,
    )?.[1];
    const deriveRequest = requestTypesSource.match(
      /public type AdapterDeriveRequest\s*=\s*\{([\s\S]*?)\n\s*\};/u,
    )?.[1];
    expect(publicRequest).toBeDefined();
    expect(deriveRequest).toBeDefined();
    expect(`${publicRequest}\n${deriveRequest}`).not.toMatch(
      /canister[_A-Z]|target|remote/iu,
    );

    // The focused management interface itself has no derive-time canister
    // selector. If ICP adds one and Neutron adopts it, this test requires an
    // explicit decision rather than silently enabling remote key selection.
    const managementDeriveRequest = managementTypesSource.match(
      /public type vetkd_derive_key_args\s*=\s*\{([\s\S]*?)\n\s*\};/u,
    )?.[1];
    expect(managementDeriveRequest).toBeDefined();
    expect(managementDeriveRequest).not.toMatch(/canister_id/iu);
  });
});
