# Marketplace protocol project

This directory contains the standalone Motoko marketplace and package-source
canister, operator tools, deployment configuration, and local acceptance tests.
The client is [apps/marketplace](../../apps/marketplace/README.md). The same change
adds generic authenticated repository acquisition to the Kernel so purchases
remain installable and updatable without depending on the marketplace client.

The implementation is being validated locally. No production marketplace has
been deployed, existing apps have not been imported, and no production source
transition or marketplace payment has been performed. Release work and remaining
configuration are tracked in [todo.marketplace.md](../../todo.marketplace.md).

## Implemented behavior

- The catalog combines reviewed app listings, immutable package/source artifacts,
  screenshots, publisher ownership, ratings, and Top free/Top paid charts for
  rolling 7 days, 30 days, and all time. Rankings count distinct Neutron
  acquisitions, not downloads or retries.
- A purchase belongs to the Neutron canister principal. Free claims and paid
  purchases grant enduring access to approved updates. Paid bytes use
  authenticated certified HTTP; browser read credentials do not authorize writes.
- ICP, ckBTC, and ckUSDC payments share durable collection and withdrawal
  journals. Repeating the same request resumes its retained outcome. Quotes show
  ledger fees, the developer and affiliate shares, and the allocation forwarded
  toward burning NTN. A forwarding receipt does not prove the external burn.
- Ethereum USDC checkout works with the Neutron EVM Wallet and browser wallets.
  A verified successful mined payment grants app access before wrapping. The
  official minter converts the deposit into ckUSDC in a separate invoice
  subaccount; collection then releases earnings. Saved invoices preserve payment
  and conversion progress independently of browser state.
- Listing prices are free or USD $1–$50 inclusive, before discounts. Daily rate
  refresh retains the last successful rate when the XRC request fails and exposes
  freshness diagnostics. Fixed cycle charges and first-year storage coverage are
  separate from token fees; the operator funds storage after that year.
- Publishers submit exact artifacts for an assigned auditor to approve, reject,
  or revoke. An audit binds the candidate ID and inspected package/source hashes.
  Pending releases do not replace an approved version, and revocation preserves
  ownership while blocking ordinary downloads of revoked bytes.
- Domain modules isolate catalog, audit, access, assets, ranking, ledger, payment,
  and accounting behavior. `main.mo` wires these to authenticated actor methods,
  certified responses, and scheduled maintenance.

The marketplace app supports browsing, checkout, My Apps, publisher submissions,
ratings, referrals, earnings, and agent tools. Public and signed private reads
are browser-direct. Non-auditor updates use the Neutron with native cycles; the
app's approved call budgets are 1 trillion cycles per call and 10 trillion per
day. These budgets do not set the protocol's initial fee coefficients, which
remain an operator configuration decision.

## Local build and validation

From the repository root, with the reviewed build inputs prepared:

```sh
npm --workspace neutron-marketplace-protocol run build
npm --workspace neutron-marketplace-protocol run test
npm --workspace neutron-marketplace run test
npm --workspace neutron-marketplace run test:browser
npm --workspace neutron-marketplace run package
```

The test harness uses the pinned Motoko compiler, Ash, and PocketIC. Tests cover
pure/domain behavior, inter-canister ledger recovery, the public protocol actor,
certified HTTP, and actual same-canister upgrades. The ledger and upgrade
fixtures have distinct limits:

- Scripted ledger canisters exercise lost replies, duplicates, concurrent
  continuation, and interrupted local finalization.
- Official generic ICRC ledger Wasm exercises six- and eight-decimal payment
  flows; a separately pinned native ICP ledger tests order-specific spender
  subaccounts, full-length memos, duplicates, withdrawals and upgrade recovery.
  Coverage applies to those pinned releases. No ledger-history or archive adapter
  is used by the protocol.
- HTTP fixtures use the response verifier against actual canister certificates,
  including private delivery and streaming. This is local verification, not a
  production gateway test.
- Same-build upgrades exercise retained state at the same canister principal.
  They do not establish migration from a previously released marketplace schema;
  no production marketplace version exists yet.
- Ethereum fixtures exercise the deployed RPC and minter interfaces, exact
  helper-event verification, early certified downloads with zero minted balance,
  deferred earnings, concurrent recovery, and upgrades during conversion. They
  do not submit a mainnet Ethereum transaction or establish provider availability.
- Client and Kernel tests cover their local integrations. Browser fixtures are
  separate from live mainnet installation, wallet, or financial testing.

See [acceptance tests](spec/testing.md) for the executable suites and remaining
coverage requirements. Passing local tests does not authorize deployment,
publication, or financial smoke tests.

## Deployment and source transition

The project builds for `icp` CLI. Use explicit installation only for a new empty
canister, and a state-preserving upgrade for an existing deployment; the
[deployment guide](spec/deployment.md) gives commands and prerequisites.

Before production use, supply the new canister principal, initial roles,
existing app-ID ownership reservations, fixed charge coefficients, and the three
burn-service receiving accounts. The old production source is a separate Rust
asset canister and must be retained. Inventory/planning tools and an explicitly
scoped source-transition publisher are present, but actual imports, approvals,
publication, and installed-client migration remain release work. Transition
packages must have higher versions, preserve app memory, and name the new source
in their manifests. Ordinary Kernel install/update review commits each source
change; there is no marketplace-specific Kernel update resolver.

## Specifications and license

- [Architecture, domains and browser authentication](spec/architecture.md)
- [Query-first access and caller-funded updates](spec/cycles-and-queries.md)
- [Purchase, withdrawal and ledger recovery](spec/ledger-flows.md)
- [Ethereum USDC invoices, early access and conversion](spec/ethereum-usdc.md)
- [Prices, acquisition records and rankings](spec/catalog-rankings.md)
- [Admin-assigned auditors and review stamps](spec/audits.md)
- [Certified HTTP package delivery](spec/certified-http.md)
- [Build, installation and upgrades with icp](spec/deployment.md)
- [Ash/PocketIC acceptance tests](spec/testing.md)
- [Upstream ledger references](spec/references/README.md)

The protocol's original material is [all rights reserved](LICENSE). The Neutron
app uses the shared [standard NSAL 1.1](../../LICENSE.APP) packaging workflow, as
selected for this app. Third-party references retain their accompanying
licenses. These documents describe public protocol behavior; research scratch
work remains outside the repository.
