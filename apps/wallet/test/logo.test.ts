import { describe, expect, test } from "bun:test";
import { safeTokenLogo, tokenInitials } from "../src/logo.ts";

describe("safeTokenLogo", () => {
  test("accepts supported base64 image metadata", () => {
    expect(safeTokenLogo("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="))
      .toBe("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=");
    expect(safeTokenLogo("data:image/png;base64,iVBORw=="))
      .toBe("data:image/png;base64,iVBORw==");
  });

  test("rejects active, remote, malformed, and oversized sources", () => {
    expect(safeTokenLogo("https://example.com/token.svg")).toBeNull();
    expect(safeTokenLogo("data:text/html;base64,PGgxPk5vPC9oMT4=")).toBeNull();
    expect(safeTokenLogo("data:image/svg+xml,<svg></svg>")).toBeNull();
    expect(safeTokenLogo("data:image/png;base64,not_base64")).toBeNull();
    expect(safeTokenLogo(`data:image/png;base64,${"A".repeat(32_768)}`)).toBeNull();
  });
});

test("tokenInitials normalizes symbols and has a fallback", () => {
  expect(tokenInitials(" ckbtc ")).toBe("CK");
  expect(tokenInitials(null)).toBe("?");
});
