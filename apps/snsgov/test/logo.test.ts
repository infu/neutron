/**
 * A DAO chooses its own logo string, so it is untrusted input that the tile
 * renders. Only an inline image is accepted: a remote URL would make the tile
 * fetch from a host the DAO picked, telling that host which SNS the owner is
 * looking at and when.
 */

import { expect, test } from "bun:test";
import { safeLogo } from "../src/data/governance";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

test("an inline image is kept verbatim", () => {
  expect(safeLogo(PNG)).toBe(PNG);
  expect(safeLogo("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeDefined();
  expect(safeLogo("data:image/webp;base64,UklGRg==")).toBeDefined();
});

// Each of these renders fine in an <img> but reaches the network, or is not an
// image at all.
test("anything that is not an inline image is dropped", () => {
  for (const value of [
    "https://example.org/logo.png",
    "http://example.org/logo.png",
    "//example.org/logo.png",
    "javascript:alert(1)",
    "data:text/html;base64,PGgxPmhpPC9oMT4=",
    "data:image/png,notbase64",
    "data:image/png;base64,has spaces!",
    "",
  ]) {
    expect(safeLogo(value)).toBeUndefined();
  }
  expect(safeLogo(undefined)).toBeUndefined();
});

// Half a base64 image is not an image, so an oversized one is dropped whole
// rather than truncated. Real logos measured 12KB–79KB.
test("an oversized logo is dropped rather than truncated", () => {
  const huge = `data:image/png;base64,${"A".repeat(600_000)}`;
  expect(safeLogo(huge)).toBeUndefined();
  const large = `data:image/png;base64,${"A".repeat(100_000)}`;
  expect(safeLogo(large)).toBe(large);
});
