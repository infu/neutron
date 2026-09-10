# Marketplace

A Neutron app for discovering, acquiring, installing and publishing apps. The
standalone [marketplace protocol](../../support/marketplace/README.md) holds the
catalog, audited releases, purchases and earnings. Purchases belong to the
current Neutron principal and survive uninstalling this app or an acquired app.

## Setup

Install the package through Neutron's normal installer. New and previously
unconfigured installations select the production marketplace
`sj2r4-haaaa-aaaay-aadgq-cai` at `https://icp-api.io` automatically. Read access
is prepared automatically, without a Connect button. The manifest declares the
production protocol's exact update routes, so the ordinary install or upgrade
review grants them together with the app's cycle budget. Opening the installed
app or reinstalling it does not require another route permission. Restoring
explicitly revoked access uses the normal runtime permission review.
The production canister and gateway are defined in code, with no connection
settings in the app. Existing configuration, browser signing seeds and saved
requests remain intact on upgrade.

Use IC Wallet for ICP, ckBTC or ckUSDC purchases. Ethereum USDC checkout
uses EVM Wallet or a connected MetaMask/browser wallet. Review the app's requested
permissions, including Wallet access and the protocol's fixed cycle charges.

Public and authenticated private queries run directly from the browser.
Package downloads use authorized certified HTTP. Protocol mutations go through
Neutron with native cycles attached; the browser read identity does not grant
direct update authority.

Version 109 uses the existing app-ID custody key facility for a permanent read
principal. Reinstalling Marketplace in the same Neutron restores that principal;
it does not create another account or change purchases. The existing browser
seed signs locally under a delegation restricted to the selected protocol.
One-time setup authorizes this new permanent principal for older installations,
without deleting their old read delegate. A browser caches only the public
signed delegation and validates it against the live Neutron key before reuse.
Fresh browsers or reinstalls can issue another delegation automatically. There
is no recurring login timer; explicit protocol revocation remains effective.
Uninstall still removes app-local journals and browser signing data.

## Using the app

- **Explore:** browse Top paid followed by Top free over rolling 7 days,
  30 days or all time. Kernel and Marketplace packages remain available to the
  installer and updater but are omitted from these storefront lists. Inspect
  descriptions, screenshots and the release's audit under **Audited by AI**,
  including its actual auditor and analysis. Cards and app details show lifetime
  paid-purchase or free-acquisition counts; reinstalls and retries do not add to
  them. Listing icons and screenshots are served from the marketplace. Checkout
  shows the token price, ledger fees, referral discount, developer/affiliate
  shares and allocation toward burning NTN before purchase.
- **My Apps:** select one or several acquired apps and choose **Install**.
  The control shows selection preparation and private download access costs
  together. After preparing the saved selection, the app opens Neutron's single
  package review with the selected apps, dependencies and manifest permissions.
  Approving that review installs the selection. Packages download directly from
  the source; the access credential is passed privately to the installer.
  Closing or reloading the review keeps the original preparation and access in
  Marketplace, so reopening the same selection does not charge them again.
  Install handoffs do not create a persistent status card; the existing Install
  control reopens the saved selection. **Refresh cost** retains the original request. **Prepare latest selection**
  explicitly reviews a new request if the old release is unavailable or newer
  releases are wanted. Installed apps update through Neutron Settings.
- **Publish:** create or edit a listing, attach a `.neutron` package and matching
  offered source, and add an icon or screenshots. List prices are free or
  $1–$50 before discounts. Review upload costs before submitting; uploads prepay
  the first year of storage, and the operator funds storage afterward without
  annual renewal. Rejected submissions display the auditor's reason.
- **Earnings:** obtain a referral code, inspect available/reserved earnings and
  review withdrawals. The ledger fee comes out of the chosen withdrawal debit.
  Self-referrals are not allowed.

Free and paid acquisitions include future approved updates. Either kind of
owner can leave one editable rating. Upload review retains the selected files
and quote while the app remains open, including when switching tabs; use
**Continue this upload** after an interrupted reply.

## Agent tools and recovery

Tools are exposed on `app:marketplace:background`. Inspect their current schemas
before calling them; atomic amounts are decimal strings.

| Tools | Purpose |
|---|---|
| `marketplace_catalog_v1`, `marketplace_app_v1` | Discover and inspect apps |
| `marketplace_library_v1`, `marketplace_earnings_v1` | Read owned apps and earnings |
| `marketplace_connect_v1` | Restore automatic browser read access through this Neutron |
| `marketplace_quote_v1`, `marketplace_purchase_v1` | Review costs and acquire apps |
| `marketplace_ethereum_quote_v1`, `marketplace_ethereum_purchase_v1` | Review and pay Ethereum USDC through EVM Wallet |
| `marketplace_ethereum_continue_v1`, `marketplace_ethereum_verify_v1`, `marketplace_ethereum_settle_v1`, `marketplace_ethereum_cancel_v1` | Resume or verify the original Ethereum invoice, collect converted credit, or cancel before entitlement |
| `marketplace_operation_v1`, `marketplace_history_v1` | Read original outcomes and recover their IDs |
| `marketplace_withdraw_v1` | Review and withdraw earnings |
| `marketplace_install_quote_v1`, `marketplace_install_v1` | Quote exact preparation cycles and offer installation with scoped owner/Root review |
| `marketplace_rate_v1` | Rate acquired apps |

Installation history retains the original selection and prepared installer URL.
Its private draft also retains the exact source-access request for interrupted
reply recovery. Public tools and history never return that access credential.
Resume the original request instead of preparing the same selection under another
ID. An installer handoff only means package review was presented; it remains
reopenable until installation is checked separately in My Apps or Neutron.

Normal agents open an exact owner review for purchases and withdrawals. Root
agents use the existing root permission judge. For a paid root purchase:

1. Keep one 32-character lowercase hexadecimal `operationId` and the original
   purchase inputs.
2. Call `marketplace_purchase_v1`. If it returns `fundingInstructions`, execute
   the exact returned `wallet_fund_root_v1` instruction from the root agent at
   root depth; do not call that root Wallet tool through a nested app.
3. Pass the raw Wallet response as `fundingResult` to
   `marketplace_purchase_v1` with the **same operation ID and inputs**.
4. Read the original operation's outcome. Wallet approval alone does not mean
   the apps were purchased.

Ethereum purchases disclose the app payment, one ckUSDC collection fee,
Ethereum gas and separate invoice/receipt-verification cycle costs. The invoice
retains the payer, current official subaccount helper and marketplace subaccount.
EVM Wallet handles agent signing through its existing Normal/Root authorization;
browser wallets require an owner click in the Marketplace tile and are not an
agent signing route. Approval is never payment. Once the protocol independently
verifies the successful mined Ethereum deposit, the apps can be installed while
conversion and revenue settlement finish in the background. Use **Saved request → Original Ethereum payment hash** or
`marketplace_ethereum_verify_v1` if the wallet sent the deposit but its response
was lost; this verifies the existing payment and never sends it again. A canceled checkout
can still receive an already-sent deposit as recoverable ckUSDC credit.

Pending or unknown outcomes retain their original IDs and reviewed terms. Read
status/history before continuing; do not create a replacement payment to recover
an interrupted reply. Keep the protocol's returned status and ledger reference
with the original operation. Installation keeps the generic Kernel review and
does not purchase missing entitlements.

## Development

From the repository root:

```sh
npm --workspace neutron-marketplace run typecheck
npm --workspace neutron-marketplace run test
npm --workspace neutron-marketplace run test:browser
npm --workspace neutron-marketplace run test:protocol
npm --workspace neutron-marketplace run package
```

Browser tests use local client fixtures and block external requests. They need
Chromium; `CHROMIUM_PATH` can select its executable. Protocol integration uses
the [Ash/PocketIC test setup](../../support/marketplace/spec/testing.md) with local
canisters, not production payments. Packaging does not publish or install a
release; follow the repository's [release workflow](../../doc/package-updates.md).

## License

This app uses the shared [Neutron Sovereign Application License 1.1](../../LICENSE.APP)
(`LicenseRef-Neutron-Sovereign-Application-License-1.1`), as stated in [NOTICE](NOTICE).
Use the repository's shared license and offered-source packaging workflow.
The separate marketplace protocol is [all rights reserved](../../support/marketplace/LICENSE).
