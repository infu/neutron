# Local Development And Deployment

[Back to the documentation index](./index.md)

Neutron has one local deployment system:
`packages/neutron-provision`. It consumes target-neutral `.neutron` archives,
compiles one complete actor, and installs the configured package set into a
supervised PocketIC fleet.

See [Provisioning System](./provisioning-system.md) for the full config,
journal, and recovery contract.

## Quick Start

Package the apps whose archives changed, then:

```sh
# Terminal 1
npm run local:start

# Terminal 2
npm run local:deploy
npm run local:status
```

These aliases select [`local.ndeploy.json`](../local.ndeploy.json).
`local:start` owns the long-running PocketIC server. `local:deploy` is a
destructive whole-canister reinstall. `local:status` prints the recorded node,
gateway, and browser URL.

For another config:

```sh
# Terminal 1
npm run provision -- CONFIG.ndeploy.json serve

# Terminal 2
npm run provision -- CONFIG.ndeploy.json reinstall
npm run provision -- CONFIG.ndeploy.json status
```

The tracked three-node Wagyu example is
[`wagyu-local.ndeploy.json`](../wagyu-local.ndeploy.json).

## Current Config

The only deployment config format is 3. A PocketIC config declares:

- `target.kind: "pocketic"`;
- one infrastructure profile;
- gateway port `8000`;
- a deterministic developer identity seed;
- desired authorized principals;
- one through sixteen ordered node labels; and
- either one path-only inline kernel declaration plus up to 255 ordinary app
  declarations, or one closed external artifact set with complete pins.

Example:

```json
{
  "format": 3,
  "target": {
    "kind": "pocketic",
    "profile": "minimal",
    "gateway_port": 8000,
    "developer_identity_seed": 2,
    "authorized_principals": [],
    "nodes": ["local"]
  },
  "artifacts": {
    "kind": "inline",
    "kernel": { "path": "apps/kernel/kernel.v0.3.12.neutron" },
    "packages": [
      { "path": "apps/hello/hello.v0.2.4.neutron" }
    ]
  }
}
```

PocketIC inline declarations are intentionally path-only. Reinstall reads each
archive and derives its digest, byte count, ID, and version. Rebuilding an
archive at the declared path therefore needs no digest edit. An external
artifact set is fully pinned and inspected while the config is loaded, including
for `serve`, `status`, and `authorize`.

The config contains no workspace, build command, script hook, app-specific
mode, or package initializer. Packaging is a separate trusted step.

## Config And Session

Every config owns one derived journal:

```text
CONFIG.ndeploy.json
CONFIG.ndeploy.session.json
```

The only journal schema is 3. It records the verified PocketIC runtime, ordered
`localFleet`, one active reinstall when present, and the latest completed
deployment receipt. Tests and developer tools read this journal instead of
guessing canister IDs.

The session is private generated state. Do not commit, copy, or edit it.
Changing the config changes its identity and requires an explicit reinstall
before session consumers accept the new desired state.

## App Development Loop

1. Edit and test the app.
2. Run its trusted package workflow to produce a `.neutron` archive.
3. Add its archive path to the config only when package membership or the path
   changes.
4. Run `reinstall`.
5. Open a labeled URL from `status`.

The provisioner never runs app build scripts. The browser installer remains
the correct path when the behavior under test is the reviewed end-user
install, upgrade, or uninstall flow.

`packages/neutron-cli` is compile-only and uses production installation
context:

```sh
bun packages/neutron-cli/src/index.ts compile \
  --package apps/kernel/kernel.v0.3.12.neutron \
  --package apps/hello/hello.v0.2.4.neutron \
  --wasm-out /tmp/neutron.wasm \
  --candid-out /tmp/neutron.did
```

Local compilation belongs to the attached provisioner because it binds the
exact PocketIC root key into the current `neutron_actor_v25` installation
identity.

## Reinstall Flow

The provisioner:

1. verifies the supervised PocketIC process and selected config;
2. derives and validates the declared package inventory;
3. compiles the complete actor once;
4. allocates or reuses each labeled fleet canister;
5. installs the same transport Wasm on every node;
6. binds each node's runtime config;
7. performs generic fresh-Kernel initialization and asset seeding;
8. authorizes the deterministic developer and configured principals;
9. applies infrastructure fixtures selected by the profile; and
10. verifies every deployed node before recording completion.

Initialization is platform-only. It does not branch on app IDs or invoke
app-private repair code.

## Profiles

`minimal` starts PocketIC, the gateway, local authentication, the update-source
fixture, and the infrastructure needed to install and verify Neutrons.

`full_protocol_fixtures` additionally starts the shared ledger, index, minter,
Bitcoin, Ethereum, and deterministic funding fixtures used by protocol tests.

Profiles are infrastructure choices, not app detection.

## Authorization

Reinstall restores the deterministic developer identity and every principal in
`target.authorized_principals` on every node. Add a temporary fleet-wide
principal without reinstalling:

```sh
npm run provision -- CONFIG.ndeploy.json authorize PRINCIPAL
```

`authorize` verifies the live session and every target node before mutation.
The next reinstall returns authorization to the config's desired state.

## Browser Tests

The selected config/session supplies the node URLs and deterministic developer
identity:

```sh
npm run test:e2e:local
npm run test:e2e:local:ii
```

Set `NEUTRON_NDEPLOY_CONFIG` and `NEUTRON_LOCAL_NODE_INDEX` for another config
or fleet member. See [Playwright](./playwright.md).

## Safety Rules

- Treat every local reinstall as application-data loss.
- Keep the supervisor running while deploying or browsing.
- Use one supervisor for the shared PocketIC state.
- Obtain node IDs and URLs from `status` or the session resolver.
- Do not add package-by-package deployment scripts or app-specific provisioning
  branches.
- Keep `.neutron` packages target-neutral.

## Primary Sources

- `local.ndeploy.json`
- `wagyu-local.ndeploy.json`
- `packages/neutron-provision/src/config.ts`
- `packages/neutron-provision/src/session.ts`
- `packages/neutron-provision/src/local_server.ts`
- `packages/neutron-provision/src/local_deploy.ts`
- `packages/neutron-provision/src/local_session.ts`
- `packages/neutron-cli/src/index.ts`
