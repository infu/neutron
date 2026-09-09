import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { candidatesForSelection, candidatesFromBackend, TokenPicker, type PickerCandidate } from "../src/picker.tsx";

const ICP = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const USDC = "xevnm-gaaaa-aaaar-qafnq-cai";
const tokens = [
  { address: ICP, symbol: "ICP", name: "Internet Computer" },
  { address: USDC, symbol: "ckUSDC", name: "Chain-key USDC" },
];
const candidates = candidatesFromBackend(tokens.map((token) => ({ ...token, standard: "ICRC1", decimals: 8, poolCount: 3, verified: true, watched: true })));
const rich: PickerCandidate = { ...candidates[0]!, priceUsd: 2.91, priceChange24H: -1.2, volumeUsd24h: 100_000, volumeUsd7d: 700_000, tvlUsd: 20_000 };

const markup = (mode: "add" | "select") => renderToStaticMarkup(createElement(TokenPicker, mode === "add"
  ? { candidates: [rich], source: "live", loading: false, error: null, busyAddress: null, onAdd: () => {}, onClose: () => {} }
  : { mode, title: "Pay with", selectedAddress: ICP, candidates: [rich], source: "live", loading: false, error: null, busyAddress: null, onSelect: () => {}, onClose: () => {} }));

describe("shared watchlist and swap token picker", () => {
  test("selecting an already watched token remains available, while adding it again remains disabled", () => {
    expect(markup("add")).toContain('disabled=""');
    const select = markup("select");
    expect(select).not.toContain('disabled=""');
    expect(select).toContain('aria-pressed="true"');
    expect(select).toContain("Selected");
    expect(select).toContain("Pay with");
  });

  test("both modes keep token identity and market information", () => {
    for (const mode of ["add", "select"] as const) {
      const html = markup(mode);
      expect(html).toContain("Internet Computer");
      expect(html).toContain(`title="Token address: ${ICP}"`);
      expect(html).toContain("$2.91");
      expect(html).toContain("-1.2%");
      expect(html).toContain("Traded volume over 24 hours");
    }
  });

  test("analytics enriches only selectable tokens, preserving missing watchlist identities", () => {
    const unrelated = { ...rich, address: "unrelated", symbol: "FAKE" };
    const result = candidatesForSelection(tokens, [unrelated, rich]);
    expect(result.map((candidate) => candidate.address)).toEqual([ICP, USDC]);
    expect(result[0]).toEqual(rich);
    expect(result[1]).toMatchObject({ address: USDC, symbol: "ckUSDC", name: "Chain-key USDC", watched: true, priceUsd: 0, priceChange24H: null, volumeUsd24h: null });
  });

  test("missing analytics never becomes a zero-dollar price or drops a selectable token", () => {
    const result = candidatesForSelection(tokens, []);
    const html = renderToStaticMarkup(createElement(TokenPicker, { mode: "select", title: "Receive token", selectedAddress: null, candidates: result, source: "on-chain", loading: false, error: null, busyAddress: null, onSelect: () => {}, onClose: () => {} }));
    expect(result).toHaveLength(2);
    expect(html).toContain("Market prices unavailable");
    expect(html).toContain("Chain-key USDC");
    expect(html).not.toContain("$0");
    expect(html).not.toContain('disabled=""');
  });
});
