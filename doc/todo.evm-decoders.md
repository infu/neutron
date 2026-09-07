# Extensible EVM transaction presentation

Request: make protocol decoders easier to extend and maintain, and make Wallet
Activity readable for transactions from existing and future protocol apps.

## Plan and qualification

- [x] Inspect Wallet execution, provider approval, Activity, memory contracts and
  the Uniswap, Curve and Aave adapters.
- [x] Research MetaMask transaction insights, ERC-7730 clear signing and ABI
  verification. Record the choices and limitations in the
  [decoder guide](../apps/evm_wallet/src/decoders/README.md).
- [x] Isolate existing protocol adapters behind one pure registry; keep signing
  and execution independent of presentation.
- [x] Implement versioned local JSON packs, exact deployment/calldata matching,
  explicit import provenance and ambiguity fallback.
- [x] Add owner Settings import/preview, replacement, enable/disable and removal.
- [x] Preserve the released Wallet and evidence roots; initialize a separate
  `evm_decoders@1` root for exact pack documents and their state.
- [x] Share presentation and optional token metadata across Activity and owner
  review; preserve complete amounts, signature previews and original bytes.
- [x] Connect Agent review through the same registry and saved token metadata.
- [x] Complete decoder, provider, browser, memory and package regression tests.
- [x] Qualify and package release 116, preserving historical archives and sources.
- [x] Publish through the production update source and verify the exact-byte
  second publication is a receipt-v2 no-op.

The registry supports new ordinary ABI protocols through data imports. Complex
nested command streams can still require a reviewed code adapter and a Wallet
release. Imported labels do not establish contract safety. No Kernel changes or
new policy restrictions are part of this work.

Qualification passed: 228 full-suite tests plus 10 decoder-store tests, both
Motoko memory programs and 27 browser checks. Final package tests passed against
the completed archive. Release 116 was published in batch 65; the repeated
receipt-v2 publication returned `batch_id: null`, with all 20 packages and 20
offered sources unchanged and matching local bytes. Evidence is retained in
`.neutron/release-receipts/evm-decoders-2026-09-07/`.
