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
receipts and beta preferences. Release publication evidence is being collected.

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
