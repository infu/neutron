import { describe, expect, test } from "bun:test";
import {
  builtinLogo,
  extractLogo,
  isSafeImageSource,
  peekLogo,
  resolveLogo,
  snsLogoUrl,
} from "../src/logos.ts";

/** A one-pixel PNG, standing in for the real base64 payload. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("isSafeImageSource", () => {
  test("accepts the inline images ledgers actually publish", () => {
    // ckBTC, ckETH, ckUSDC and ckUSDT all publish base64 SVG.
    expect(isSafeImageSource("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe(true);
    expect(isSafeImageSource(PNG)).toBe(true);
  });

  test("accepts an SNS aggregator logo", () => {
    expect(isSafeImageSource(snsLogoUrl("3e3x2-xyaaa-aaaaq-aaalq-cai"))).toBe(true);
  });

  test("refuses an arbitrary remote image named by a token author", () => {
    expect(isSafeImageSource("https://example.invalid/logo.png")).toBe(false);
    expect(isSafeImageSource("http://example.invalid/logo.png")).toBe(false);
    expect(isSafeImageSource("//example.invalid/logo.png")).toBe(false);
  });

  test("refuses anything that is not a base64 image payload", () => {
    expect(isSafeImageSource("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isSafeImageSource("javascript:alert(1)")).toBe(false);
    expect(isSafeImageSource("data:image/svg+xml,<svg onload=alert(1)/>")).toBe(false);
    expect(isSafeImageSource("data:image/png;base64,not base64!")).toBe(false);
    expect(isSafeImageSource("")).toBe(false);
  });
});

describe("extractLogo", () => {
  test("reads the ICRC-1 metadata key the ck-tokens use", () => {
    expect(
      extractLogo([
        ["icrc1:decimals", { Nat: 8n }],
        ["icrc1:logo", { Text: PNG }],
      ]),
    ).toBe(PNG);
  });

  test("accepts a bare logo key", () => {
    expect(extractLogo([["logo", { Text: PNG }]])).toBe(PNG);
  });

  test("trims surrounding whitespace", () => {
    expect(extractLogo([["icrc1:logo", { Text: `  ${PNG}  ` }]])).toBe(PNG);
  });

  test("reports nothing for a ledger that publishes no logo", () => {
    // ICP and OpenChat both look like this.
    expect(
      extractLogo([
        ["icrc1:name", { Text: "Internet Computer" }],
        ["icrc1:symbol", { Text: "ICP" }],
      ]),
    ).toBeNull();
  });

  test("ignores a logo that is not usable", () => {
    expect(extractLogo([["icrc1:logo", { Text: "https://example.invalid/x.png" }]])).toBeNull();
    expect(extractLogo([["icrc1:logo", { Blob: [1, 2, 3] }]])).toBeNull();
    expect(extractLogo([["icrc1:logo", null]])).toBeNull();
  });

  test("does not confuse a similarly named key for the logo", () => {
    expect(extractLogo([["icrc1:logotype", { Text: PNG }]])).toBeNull();
  });
});

describe("snsLogoUrl", () => {
  test("builds the aggregator path for a root canister", () => {
    expect(snsLogoUrl("3e3x2-xyaaa-aaaaq-aaalq-cai")).toBe(
      "https://3r4gx-wqaaa-aaaaq-aaaia-cai.icp0.io/v1/sns/root/3e3x2-xyaaa-aaaaq-aaalq-cai/logo.png",
    );
  });
});

describe("built-in icons", () => {
  const ICP = "ryjl3-tyaaa-aaaaa-aaaba-cai";

  test("ships a mark for ICP, which publishes none and is no SNS", () => {
    const logo = builtinLogo(ICP);
    expect(logo).not.toBeNull();
    expect(isSafeImageSource(logo!)).toBe(true);
  });

  test("resolves without a lookup", async () => {
    // No agent is available in this environment, so a network path would throw.
    expect(peekLogo(ICP)).toBe(builtinLogo(ICP));
    await expect(resolveLogo(ICP)).resolves.toBe(builtinLogo(ICP));
  });

  test("ships nothing for a ledger that can answer for itself", () => {
    expect(builtinLogo("mxzaz-hqaaa-aaaar-qaada-cai")).toBeNull();
  });
});
