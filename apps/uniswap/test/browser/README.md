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
limit error; pagination must adapt without weakening the transport or dropping
retained records.

Checks cover:

- Missing and incompatible provider errors, followed by successful reconnection.
- Account discovery and balances through the real SDK response validators.
- Four QuoterV2 fee tiers and selection of the greatest output.
- Separate numeric approval/swap fee observations and their total, including a
  refreshed observation with changed prices.
- An unavailable swap estimate before allowance without replacing it with
  Quoter gas or hiding the provider reason.
- Arbitrum posting costs included once in the observed RPC gas estimate.
- Refreshing fees for a saved, approved swap using its frozen transaction and
  request IDs, without repeating the approval or requesting a signature.
- Expired quote presentation and disabled submission, using a controlled clock.
- Open settings and quote review at 1440, 375, and 320 pixels without overflow.
- Quote invalidation after editing and while amount/recipient reads are pending.
- Approval decline, receipt-gated swap submission, and intent persistence.
- A lost swap reply followed by reload and status reconciliation using the same
  request ID, with no duplicate submission.
- Native-input swaps without approval fields, using the packaged backend schema.
- Pending replacements: authenticated Wallet linkage, independent matching
  transaction/receipt evidence, both explorer links, output-token accounting,
  and reload recovery without submitting the saved request again.
- History exceeding the 64 KiB self-query metadata budget: real complete saved
  intents, byte-triggered page-size backoff, every older record accessible, and a
  new prepared request saved/reloaded/resumed with its original ID and calldata.
- Clearing Ethereum balances when selecting Arbitrum and requesting scoped data.

Artifacts default to `/tmp/neutron-uniswap-browser`; override using
`UNISWAP_BROWSER_ARTIFACTS`. `CHROMIUM_PATH` overrides the default Nix Chromium
path. `report.json` records successful checks, calls, and final saved records.
Screenshots are saved for each viewport. Failure artifacts retain the failing UI
and call trace.

This is a deterministic integration fixture. It does not replace Motoko journal
release tests, deployed-contract tests, Kernel authorization tests, or live RPC
validation. It neither signs nor broadcasts funded transactions.
