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

The default positive gate pins Kernel 356, Marketplace 109 and the protocol
module used for the release. To qualify another Marketplace archive, pass both
`--version` and `--sha256`. It verifies automatic first setup, real permission
approval, a successful authenticated My Apps response, reload and a new browser
profile. Checked UI uninstall/reinstall must retain the same protocol read
principal despite deleting the old app memory. Its first later update requests
fresh installation permissions without registering another read account.

The unchanged Marketplace 107 archive reproduces the original missing UI
request declaration through the same installed runtime:

```sh
bun test/qualification/marketplace/run.ts --negative-control
```

Receipts and screenshots default to `/tmp/marketplace-connect-<version>`;
`MARKETPLACE_QUALIFICATION_ARTIFACTS` overrides that directory. Local fixture
setup only selects the disposable protocol; it never inserts a read delegate
or bypasses the browser's backend permission request.
