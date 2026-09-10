# Installed Marketplace initialization regression

This gate installs unchanged, hash-pinned release archives in disposable
PocketIC canisters. It uses the normal Marketplace tile, background process,
Kernel permission dialog and private protocol queries. All browser traffic is
restricted to the test's local gateway; no production calls or payments occur.

Run from the repository root with the qualification gateway at `127.0.0.2:8000`
available:

```sh
bun test test/qualification/marketplace/wire.test.ts
bun test/qualification/marketplace/run.ts
```

The positive gate verifies automatic first setup, a successful authenticated
My Apps response, reload and a new browser profile. Checked UI
uninstall/reinstall must retain the same protocol read principal despite
deleting the old app memory. For Marketplace 110 onward, the fixture protocol
uses the manifest's principal inside disposable PocketIC. The test reads the
Kernel's reservation snapshot before first open, checks every exact grant in
the installation review, and proves that opening the app and its first later
update require no additional permission prompt.

Marketplace 111 onward also copies the resulting affiliate code from the real
app frame through the generic Kernel clipboard broker. Browser clipboard
permissions are granted only to the top-level Kernel origin, and the test
verifies the actual copied text.

The same gate publishes two free fixture packages inside disposable PocketIC,
acquires them through the real Marketplace checkout, selects both in My Apps,
and clicks Install selected. It must reach the final Kernel review directly,
with both packages selected and no preliminary offer or permission dialog.
Canceling must leave the installed deployment unchanged. Reopening reuses the
saved preparation and exact download grant without another charged update;
one approval then installs both packages. Fake-ledger counters must remain
zero throughout.

PocketIC 14's HTTP gateway overwrites `Access-Control-Expose-Headers`, hiding
the canister's certificate headers from a cross-origin browser. The test-only
`source_gateway.ts` adapter restores the canister's exact declared expose list.
It obtains that list from an actual canister HTTP query and verifies both its
proof and the gateway-delivered certificate with the official response
verifier and the disposable subnet's root key. Gateway status, bytes, proof,
cache and authorization behavior are retained; missing proof or altered
certified headers fail the test. No certificate headers are manufactured.
The receipt records every such adaptation.

Playwright supplies browser preflight responses when request routing is
enabled, so this gate does not prove the gateway's OPTIONS behavior. A separate
probe verifies the actual canister's certified OPTIONS response permits
Authorization, and records the unmodified gateway response in
`source-preflight.json`. PocketIC's gateway currently replaces that response
and omits Authorization from its allow list. Production preflight checks must
therefore be recorded separately; they cannot be inferred from this gate.

The current default archive pins are Kernel 359 and Marketplace 111. For new
release candidates, provide `--version`, `--sha256`, `--kernel-version` and
`--kernel-sha256`; archives remain unchanged. Add `--custom-target` to exercise
the separately selected protocol case, where a real runtime permission request
is still required for the new target. Marketplace 109 also retains its prior
runtime-grant expectation, so the old behavior can be compared explicitly.

The unchanged Marketplace 107 archive reproduces the original missing UI
request declaration through the same installed runtime:

```sh
bun test/qualification/marketplace/run.ts --negative-control
```

Receipts and screenshots default to `/tmp/marketplace-connect-<version>`;
`MARKETPLACE_QUALIFICATION_ARTIFACTS` overrides that directory. Local fixture
setup only selects the disposable protocol; it never inserts a read delegate
or creates grants outside the regular installation/permission flow.
