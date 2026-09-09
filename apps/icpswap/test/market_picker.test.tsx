import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { InfoToken } from "../src/api.ts";
import { MarketKpis, MarketTable, type MergedRow } from "../src/market.tsx";
import { candidatesFromBackend, rankCandidates, TokenPicker } from "../src/picker.tsx";

const address = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const row: MergedRow["row"] = {
  address, symbol: "ICP", name: "Internet Computer", standard: "ICRC1", decimals: 8,
  priceUsd: 0, priceIcp: 0, quote: null, poolCount: 0, pinned: false,
  note: "", addedAt: 0, verified: true, sampleCount: 0, sparkline: [],
};
const token: InfoToken = {
  ledgerId: address, name: row.name, symbol: row.symbol, price: 2.9, priceChange24H: 0,
  tvlUSD: 100, tvlUSDChange24H: 0, txCount24H: 0, volumeUSD24H: 0, volumeUSD7D: 0,
  totalVolumeUSD: 0, priceLow24H: 0, priceHigh24H: 0, priceLow7D: 0, priceHigh7D: 0,
  priceLow30D: 0, priceHigh30D: 0,
};
const entry = (live?: InfoToken): MergedRow => ({ row, live, rank: undefined });
const table = (value = entry()) => renderToStaticMarkup(<MarketTable entries={[value]} sortKey="price" ascending={false} onSort={() => {}} onOpen={() => {}} onTogglePin={() => {}} onRemove={() => {}} busyAddress={null} compact />);
const summary = (entries: MergedRow[]) => renderToStaticMarkup(<MarketKpis entries={entries} icpPriceUsd={0} universeSize={1} />);

describe("market availability", () => {
  test("unknown prices never become a zero-dollar valuation in either layout", () => {
    for (const value of [entry(), entry({ ...token, price: 0 })]) {
      const html = table(value);
      expect(html).toContain('title="Price unavailable"');
      expect(html).not.toContain("$0.00");
    }
  });

  test("a saved price remains usable but is identified as a saved observation", () => {
    const html = table({ ...entry(), row: { ...row, priceUsd: 2.8 } });
    expect(html).toContain("$2.8");
    expect(html).toContain("Last saved price; current price unavailable");
  });

  test("missing changes do not become an observed flat market", () => {
    const unavailable = summary([entry()]);
    expect(unavailable).toContain("Price changes unavailable");
    expect(unavailable).not.toContain("0 ↑");
    const flat = summary([entry(token)]);
    expect(flat).toContain("0 ↑");
    expect(flat).toContain("0 ↓");
    expect(flat).toContain("Price changes available for 1 of 1 watched tokens");
  });

  test("partial coverage counts actual observations and preserves real zero volume", () => {
    const html = summary([entry(), entry({ ...token, priceChange24H: 2 }), entry({ ...token, priceChange24H: -1 })]);
    expect(html).toContain("1 ↑");
    expect(html).toContain("1 ↓");
    expect(html).toContain("2 of 3 watched tokens");
    expect(table(entry(token))).toContain("$0</td>");
  });
});

describe("token recognition", () => {
  const candidates = candidatesFromBackend([{ address, symbol: "ICP", name: row.name, standard: "ICRC1", decimals: 8, poolCount: 3, verified: true, watched: false }]);

  test("fallback listings disclose missing market prices while retaining full token identity", () => {
    const html = renderToStaticMarkup(<TokenPicker candidates={candidates} source="on-chain" loading={false} error={null} busyAddress={null} onAdd={() => {}} onClose={() => {}} />);
    expect(html).toContain("Market prices unavailable");
    expect(html).toContain(`title="Token address: ${address}"`);
    expect(html).toContain("3 pools");
    expect(html).not.toContain("$0");
    expect(html).not.toContain("On-chain price index");
  });

  test("full token addresses still identify an exact match among duplicate symbols", () => {
    const duplicate = { ...candidates[0]!, address: "xevnm-gaaaa-aaaar-qafnq-cai", volumeUsd7d: 50 };
    const matches = rankCandidates([duplicate, candidates[0]!], address);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.address).toBe(address);
  });
});
