# Marketplace protocol project

This directory contains the standalone Motoko marketplace and package-source
canister, operator tools, deployment configuration, and local acceptance tests.
The client is [apps/marketplace](../../apps/marketplace/README.md). The same change
adds generic authenticated repository acquisition to the Kernel so purchases
remain installable and updatable without depending on the marketplace client.

The protocol is deployed on mainnet at `sj2r4-haaaa-aaaay-aadgq-cai`. Its installed
Wasm, roles, 27 initial app-ID reservations and first XRC rate refresh have been
verified. The first marketplace publication has verified receipts for all 27
releases, and public catalog queries confirm their approved free listings. Its
exact-byte repeat returned the required no-op. The old-source transition is in
place, and both its first publication and exact-byte no-op repeat are verified. The
[production release record](spec/production-release.md) separates deployment from
publication and installation. Remaining work is tracked in
[todo.marketplace.md](../../todo.marketplace.md).

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
- The configured first-party publisher, production Blast ID 0, owns the initial
  listings. Its releases are cycle-free and automatically approved after the
  publishing scripts inspect the exact package/source artifacts. Compatible
  release sets publish atomically. Other publishers retain normal fees and
  assigned-auditor review.
- Current approved and pending-review package/source content is retained;
  superseded bytes are removed without deleting purchases, receipts or audits.
- Domain modules isolate catalog, audit, access, assets, ranking, ledger, payment,
  and accounting behavior. `main.mo` wires these to authenticated actor methods,
  certified responses, and scheduled maintenance.

The marketplace app supports browsing, checkout, My Apps, publisher submissions,
ratings, referrals, earnings, and agent tools. Public and signed private reads
are browser-direct. Ordinary user and publisher updates use Neutron with native
cycles. Assigned auditors and administrators use their dedicated exempt CLI
endpoints directly; the app has no admin or auditor interface. The
app's approved call budgets are 1 trillion cycles per call and 10 trillion per
day. These budgets are separate from the protocol's configured fee coefficients.
Install and Upgrade reviews show the applicable access cost.

The admin exemption covers exactly `admin_auditor_set`, `admin_reserve_app`,
`admin_set_burn_account`, and `rates_refresh`. They authenticate the actual
configured admin principal, accept no attached cycles, and retain `feeVersion`
only for Candid compatibility. Existing canister admin principals remain valid.
Admin or auditor status does not exempt purchases, uploads, or other ordinary
writes. The separately configured first-party principal may publish and withdraw
its own earnings directly without cycle charges; ledger withdrawal fees still
apply. See [operator commands](OPERATIONS.md) for direct CLI usage.

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
  They do not establish migration between different released marketplace schemas.
  The initial mainnet deployment is recorded separately from these local tests.
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

The initial mainnet deployment has its roles, existing app-ID reservations and
fixed charge configuration. ICP/USD, BTC/USD and USDC/USD rates were refreshed
successfully. The three burn-service destinations remain unset until the owner
supplies them; no external burn is implied by the deployment.

The old production source is a separate Rust asset canister and remains in
place. Marketplace batch 1 published 27 apps, and its exact-byte repeat verified
all packages and offered sources unchanged with `batch_id: null`. The atomic
publication of 26 higher transition releases to the old source is verified as
batch 97; its exact-byte repeat also returned `batch_id: null` with all packages
and offered sources unchanged.
Transition packages preserve app memory and name the marketplace as their new
source. Ordinary Kernel install/update review commits each source change;
there is no marketplace-specific Kernel update resolver.

Existing users choose **Settings → Upgrade all**,
then install [Marketplace version 107](https://sj2r4-haaaa-aaaay-aadgq-cai.icp0.io/repo/v1/packages/03ef7d67e3c7314474049da7ee9ede6678b5a8e291b3ed85e55fc5feddb7f785.neutron)
separately. Publication does not install
apps into an existing Neutron. This release does not change the Dispenser starter
or push Git commits.

## Specifications and license

- [Architecture, domains and browser authentication](spec/architecture.md)
- [Query-first access and caller-funded updates](spec/cycles-and-queries.md)
- [Purchase, withdrawal and ledger recovery](spec/ledger-flows.md)
- [Ethereum USDC invoices, early access and conversion](spec/ethereum-usdc.md)
- [Prices, acquisition records and rankings](spec/catalog-rankings.md)
- [Admin-assigned auditors and review stamps](spec/audits.md)
- [Certified HTTP package delivery](spec/certified-http.md)
- [Build, installation and upgrades with icp](spec/deployment.md)
- [Production deployment and publication status](spec/production-release.md)
- [Ash/PocketIC acceptance tests](spec/testing.md)
- [Upstream ledger references](spec/references/README.md)

The protocol's original material is [all rights reserved](LICENSE). The Neutron
app uses the shared [standard NSAL 1.1](../../LICENSE.APP) packaging workflow, as
selected for this app. Third-party references retain their accompanying
licenses. These documents describe public protocol behavior; research scratch
work remains outside the repository.
