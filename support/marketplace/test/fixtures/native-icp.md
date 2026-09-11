# Native ICP ledger fixture

The native ICP tests install DFINITY's actual ledger Wasm at
`ryjl3-tyaaa-aaaaa-aaaba-cai` on a local NNS subnet. They do not substitute the
generic ICRC ledger used for the ckUSDC/ckBTC fixtures.

The fixture uses the official
[ledger-suite-icp-2025-08-29 release](https://github.com/dfinity/ic/releases/tag/ledger-suite-icp-2025-08-29),
source commit `69b755062f5ef0a7d6efc9a127172b46121420c8`:

- `ledger-canister_notify-method.wasm.gz` archive SHA-256:
  `51f4be010f23064137defacd627ffbec024c5133210c68ca3b80ab8f257101d6`.
- Uncompressed module SHA-256:
  `fca0a9713133c67edf4ba0375c64afb81561123a4fe2b53b4bac740e7e1048f5`.
- The release's `ledger.did` SHA-256:
  `dbbb2c3020186e56bbdd88685dad191af6fe40f89e01ff5c60eb11a972eb86f3`.

Both Wasm hashes are checked before every installation. Downloads are cached
under the repository's ignored `.neutron/cache/fixtures` directory. A missing or
invalid fixture fails the required test; no fallback or skipped test is used.
The ledger source inherits the upstream
[Apache-2.0 license](https://github.com/dfinity/ic/blob/69b755062f5ef0a7d6efc9a127172b46121420c8/LICENSE).
Its Wasm is test infrastructure and is not included in the marketplace protocol
or app package.

Run from the repository root:

```sh
bun support/marketplace/scripts/test-integration.ts 'Native ICP ledger'
```

The two cases check:

- Eight decimals and the 10,000-atom transfer fee; 32-byte ICRC memos; exact
  order-specific ICRC-2 spender subaccounts; rejection of another spender
  subaccount; exact approval, collection and withdrawal `Duplicate` responses;
  concurrent withdrawals cannot overdraw; resulting account balances and fees.
- The production purchase and withdrawal engines running against the native
  ledger, with local finalization interrupted after a successful ledger reply.
  Real protocol upgrades retain that reply, grant ownership once, allocate
  earnings once and resume the original withdrawal without an extra payout.

These tests use only ordinary ICRC-1/2 calls. They do not install or query an
index, transaction-history service or archive, and do not use ICRC-3. They verify
the pinned release locally, not the current module or state of a live canister.
