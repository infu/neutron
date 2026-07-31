# Mail Local Browser Smoke

The active Mail Playwright suite exercises the installed Mail tile on the
primary local Neutron recorded by an archive-only format-3 provision config
and its matching schema-3 session journal. It opens Mail through the
provisioned gateway, uses the provisioned developer identity, completes
private-Mail setup through normal product UI, and verifies that the ready
mailbox survives a page reload.

The suite deliberately has no local provisioning layer of its own. It does
not create or install canisters, select a canister or gateway directly, manage
snapshots, advance PocketIC time, or write a second fixture-state file. The
config-selected provision session is its only runtime authority.

## Run

From the repository root, prepare a separately named archive-only format-3
config whose closed artifact pins include Mail, then start and populate the
shared local runtime through that config:

```sh
npm run provision -- MAIL-E2E.ndeploy.json serve
npm run provision -- MAIL-E2E.ndeploy.json reinstall
```

Then run the Mail checks:

```sh
npm --workspace neutron-mail run test:e2e:typecheck
npm --workspace neutron-mail run test:e2e:list
NEUTRON_NDEPLOY_CONFIG=MAIL-E2E.ndeploy.json \
  npm --workspace neutron-mail run test:e2e
```

The suite's default config is the tracked legacy `local.ndeploy.json`, which
can select an already-existing attachment but cannot prepare a fresh runtime.
Select the writable format-3 provision config, and therefore its one matching
schema-3 session, only through:

```sh
NEUTRON_NDEPLOY_CONFIG=/absolute/path/to/test.ndeploy.json \
  npm --workspace neutron-mail run test:e2e
```

The browser smoke may configure Mail through normal user-facing actions on the
provisioned Neutron. It never writes test fixture state or mutates another
canister, and re-running it is valid when Mail is already configured.

## Historical Evidence

The checksummed archive under `e2e/evidence/` records an earlier, retired
two-Neutron release harness. It remains historical evidence for the exact
package bytes and runner captured there; it is not an active local deployment
path and must not be used as a source of current canister or runtime state.

Cross-canister delivery, quotas, retry, rotation, codec, storage, and privacy
invariants remain covered by Mail's Bun and Motoko suites. Any future installed
cross-canister fixture must be declared and owned by the shared provisioner
instead of being created by Mail test code.
