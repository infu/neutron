# Installed apps and Marketplace ownership

Marketplace 0.1.23 labels local installations as **Installed**. Only an actual
Marketplace entitlement is shown as **Owned**. An installed paid app retains
the normal reviewed purchase flow, so it can be acquired without uninstalling.
After acquisition, it remains installed and directs updates to Settings.
Installed free apps can optionally use **Get app** to appear in My Apps;
their existing package-download behavior is unchanged.

The source protocol names denied apps in a grouped download request, for
example `Download access denied for Aave (aave), Curve (curve).` Duplicate
package/source references produce one name per app. The existing Kernel error
display carries this message without an interface change. Kernel 0.3.63 uses
unchecked/checked selection icons and an accent highlight for app selection.

[Package audit](package-audit.json) verifies that all 198 Kernel and 50
Marketplace backend modules/lock files match the released predecessors.
Kernel roots remain at versions 4/1/1/1; Marketplace state remains at version 2.
The [protocol audit](protocol-audit.json) records all six unchanged persistent
roots and byte-identical Candid/stable-type declarations.

Checked Marketplace upgrades from [112](upgrade-112.json),
[118](upgrade-118.json), [121](upgrade-121.json) and [122](upgrade-122.json)
preserve identity, journals and the complete saved state, alongside clean
initialization. Kernel qualification covers clean initialization and checked
upgrades from 361 and 362, including saved authorization, activation, cycle
receipts and beta preferences.

The [combined upgrade](paired-upgrade.json) additionally installs the exact
Kernel 363 and Marketplace 123 archives together over released Kernel 362 and
Marketplace 122 in one checked transaction, preserving all five memory roots,
the saved beta preference and a Marketplace purchase journal.

[Release checks](release-checks.json) record the complete package commands,
Marketplace's 173 tests, all nine browser suites and actual client/protocol
integration, Kernel's 980 tests, 35 Motoko tests, owner-cycle integration and
Certified Assets qualification, plus the exact-archive upgrade checks. The
protocol passed 170 unit tests, 131 Motoko cases and 68 canister integration
cases, including the actual deployed predecessor's keep upgrade.

The [protocol deployment](protocol-deployment.json) preserves memory and
settings. Its deployed Wasm matches the qualified successor, and all 57
certified catalog records remained unchanged across deployment.

Kernel **0.3.63** and Marketplace **0.1.23** were [published to beta](beta-publish.json)
together in batch **23** through root `npm run updates:publish`. The exact same
command and bytes produced the [verified receipt-v2 no-op](beta-repeat.json):
`batch_id: null`, with all 28 selected packages and offered sources `unchanged`.
[Publication verification](publication-verification.json) matches each version,
URL, path, byte length and SHA-256 against the frozen local artifacts.
[Certified catalog checks](catalog-verification.json) confirm the two expected
beta successors and unchanged stable heads and other beta heads.

The [browser regression results](browser-results.json) include acquiring an
already installed paid app through the existing checkout, with exactly one
purchase and no installation. Screenshots use local fixtures and the actual
application components; they do not represent a purchase or installation in a
production Neutron.

| View | Screenshot |
|---|---|
| Installed, acquisition available | [Before purchase](installed-unowned.png) |
| Installed and owned after acquisition | [After purchase](installed-owned.png) |
| App selection in Settings | [Selection icons](settings-selection.png) |

Run the fixed pair qualification from the repository root:

```sh
NEUTRON_RUN_INSTALLED_ACQUISITION_UPGRADE=1 \
NEUTRON_POCKETIC_BIN="$PWD/.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic" \
bun test ./support/marketplace/evidence/installed-acquisition/paired-upgrade.test.ts
```
