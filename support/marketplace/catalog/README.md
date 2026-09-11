# First-party listing media

`first-party-media.json` selects the existing app icons and screenshots published
to the marketplace. Paths are relative to that manifest. Images are stored by
the protocol and served through its certified HTTP media routes; app package
versions do not change when listing images change.

The screenshots render the current app UIs with local demo content. Balances,
messages, contacts and conversations are examples, not a user's private data or
evidence of a live transaction. Capture harnesses used local fixtures and did
not make financial calls. Icons are copied from each app's existing public
assets.

The manifest covers the 24 storefront apps with a UI. Kernel and Marketplace
are excluded from the storefront. Blast is a tools-only app with no tile or
existing icon, so it has no fabricated UI screenshot.

Review the media selection before publishing:

```sh
bun support/marketplace/scripts/publish-media.ts --manifest support/marketplace/catalog/first-party-media.json
```

Add `--execute` to publish the reviewed bytes using the assigned first-party
identity. Repeat the same command and unchanged image files to verify the
result, or to resume after an interrupted reply. The script preserves listing
text, price, ownership, visibility and approved release; it changes only the
selected icon and screenshots.
