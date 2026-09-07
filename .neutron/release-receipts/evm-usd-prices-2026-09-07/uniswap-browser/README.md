# Focused Uniswap USD browser qualification

Run `node /tmp/neutron-uniswap-usd-browser/check.mjs` from repository root. The temporary harness bundles current actual Uniswap UI, price watcher, shared SDK validation, quote and liquidity implementations. Only Kernel transport boundaries and browser position index responses are mocked. No real API/RPC traffic is allowed, and no signing or sending action is invoked.

`report.json` contains 11 successful checks, exact fixtures and call traces. Screenshots cover 375px and 700px viewports with swap amounts, balance values, token picker, minimum/fees, positions, liquidity preview, stale and missing prices, plus incomplete position totals. No horizontal overflow or browser errors occurred.

Fixture market prices are ETH/WETH $2000 and other tokens $1; these are deterministic visual test data, not actual market prices. Timers/activity/provider fetching are qualified by the separate shared price watcher/provider tests; this harness validates display semantics and end-to-end parser integration.
