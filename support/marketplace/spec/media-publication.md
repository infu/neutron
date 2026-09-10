# First-party listing media

Icons and screenshots belong to marketplace listings. Updating them does not
change package bytes, release versions, approved candidates, prices, or ownership.
The existing trusted Blast identity 0 can upload these images and save the
listing without attaching cycles, using the same endpoints as other publishers.

Create a local selection file:

```json
{
  "format": 1,
  "apps": [
    {
      "appId": "wallet",
      "icon": "media/wallet/icon.svg",
      "screenshots": ["media/wallet/overview.png", "media/wallet/compact.png"]
    }
  ]
}
```

Image paths resolve relative to that file. Omitting `icon` or `screenshots`
preserves existing media. An explicit empty screenshots array removes those
screenshots. No title, price, owner, release, or other listing metadata can be
supplied through this manifest. Headless apps without a tile need no fabricated
UI screenshot.

From the repository root, review and then publish the same files:

```sh
bun support/marketplace/scripts/publish-media.ts --manifest /path/to/media.json
bun support/marketplace/scripts/publish-media.ts --manifest /path/to/media.json --execute
bun support/marketplace/scripts/publish-media.ts --manifest /path/to/media.json --execute
```

The first command makes queries only and saves a local journal. The second uses
`upload_begin`, `upload_chunk`, `upload_finish`, and `listing_save`. Every image's
SHA-256, upload request, and exact response are retained before the next step.
The last command must return `publication_verified`, `updateCalls: 0`, and
`unchanged` for every selected app. Public images are read back with certified
HTTP verification and their exact media type, byte count, and digest checked.

Defaults use the production marketplace and a deterministic private journal
under `.neutron/marketplace-media/`. `--journal` and `--request` may select an
explicit recovery file and stable identity. After interruption, keep the same
selection, bytes, request ID, and journal. Do not change image bytes to recover
a lost response. A concurrent listing or release change stops publication instead
of overwriting it; review a new request against that new listing state.

Use `publish-catalog.ts` for package releases. Its `--listings` option applies to
changed releases and is not the media-only workflow described here.
