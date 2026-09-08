# Browser integration fixture

Run from the repository root:

```sh
node apps/uniswap/test/browser/check.mjs
```

An existing app build must provide `dist/schema.json`. The harness bundles the
frontend in memory; it does not write or rebuild package archives.

The harness bundles the actual Uniswap React UI, Sass, controller, and shared
`neutron-tools/evm_wallet` SDK. Only `neutron-tools/app` transport is replaced. A
Node-owned mock journal and mock EVM Wallet retain records and operations across
browser reloads. Contract reads decode independent QuoterV2/Factory/Pool/ERC20
ABIs and return ABI-encoded results. Fee-tool responses are deterministic
observations that pass the shared SDK parsers; they are not live gas quotations. Every effect verifies that its immutable
intent and requested phase were already saved. Every backend request and response
is validated against the packaged `dist/schema.json` using the same icblast
schema validator as the release tooling. Mock optional record fields are omitted
on the wire, and successful Candid results are unwrapped like Kernel self calls.
The fixture rejects self-query JSON exceeding 65,536 bytes with the real metadata
limit error. The current browser scenarios remain below that boundary; adaptive
history pagination and oversized-record handling are covered separately by
`test/history.test.ts` and `test/memory_release.test.mo`.

Checks cover:

- Automatic recovery from a temporary Wallet startup failure on focus, without
  a separate connection permission request.
- Account discovery, balances and USD estimates through the real SDK validators.
- Debounced Auto quoting across four V3 and four V4 pools, with token artwork
  present and advanced details collapsed.
- One Swap action saving its intent before dispatch, then checking approval and
  final swap receipts before completing and refreshing balances.
- A lost final reply followed by reload and Continue, reconciling the original
  request without another send.
- Focus refreshing account, balance and both current and legacy history reads.
- Agent-owned activity remaining visible without the human tile loading or
  resuming that Agent's intent.
- Explicit V4 selection completing exact token approval, Permit2 authorization
  and the router transaction from one Swap click.
- Swap forms, token pickers and liquidity position cards fitting at 375 and
  320 pixels; liquidity editors are also checked at 320 pixels.
- Browser V4 position discovery followed by onchain ownership and pool checks,
  plus manual import retaining a durable position reference.
- Previews for minting a full-range position, increasing liquidity, percentage
  removal and fee collection, with advanced details collapsed.
- Collection submitting the position-manager transaction and refreshing the
  portfolio and saved activity.
- A released legacy approved swap surviving reload, retaining its old request
  and refreshing into a newly reviewed swap that reuses existing allowance.
- A mismatched Wallet balance address remaining unavailable until account and
  balance observations agree.
- An Ethereum custom-token read completing after a network switch without
  adding the contract to the Arbitrum token menu.

Artifacts default to `/tmp/neutron-uniswap-browser`; override using
`UNISWAP_BROWSER_ARTIFACTS`. `CHROMIUM_PATH` overrides the default Nix Chromium
path. `report.json` records successful checks, calls, and final saved records.
Screenshots are saved for each viewport. Failure artifacts retain the failing UI
and call trace.

This is a deterministic integration fixture. It does not replace Motoko journal
release tests, deployed-contract tests, Kernel authorization tests, or live RPC
validation. It neither signs nor broadcasts funded transactions.
