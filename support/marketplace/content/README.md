# First-party listing copy

`listings.en.json` contains the curated English excerpts and expanded descriptions
for the 27 first-party app listings. The existing protocol field `summary` is the
excerpt: at most 255 Unicode characters. `description` allows up to 5,000.

Copy is based on the apps' implemented features and agent tools. The five DeFi
protocol excerpts explicitly identify independently developed Neutron
integrations. Kernel and Marketplace retain descriptions for direct details,
but remain excluded from the storefront charts.

These entries contain no prices, release versions or media identifiers. Publish
text changes through `listing_save` using the current listing revision and retain
its title, price, images and approved package. Ordinary package updates preserve
listing text; they do not replace it with the package manifest description.
