# Playwright

[Back to the documentation index](./index.md)

Use this workflow for repository browser tests. The authorities are
[playwright.config.ts](../playwright.config.ts), the selected
[test/e2e spec](../test/e2e/), and the scripts in [package.json](../package.json).
Inspect their setup and skip conditions before running a scenario.

## Prepare A Local Deployment

Root aliases select [local.ndeploy.json](../local.ndeploy.json):

```sh
# Terminal 1
npm run local:start

# Terminal 2
npm run local:deploy
npm run local:status
```

`local:start` starts or attaches to the supervised PocketIC server.
`local:deploy` destructively reinstalls the configured package set.
`local:status` reports the recorded deployment and browser URL. Use this setup
only for disposable local state. For preserved-state testing and production
upgrades, follow [Provisioning System](./provisioning-system.md) and
[Package Updates](./package-updates.md); reinstall is not an upgrade mechanism.

For another config, invoke the provisioner with that config explicitly:

```sh
# Terminal 1
npm run provision -- wagyu-local.ndeploy.json serve

# Terminal 2: disposable local fixture only
npm run provision -- wagyu-local.ndeploy.json reinstall
npm run provision -- wagyu-local.ndeploy.json status
```

The config must have the required packages available. Check its artifact
references and package the relevant workspaces before deployment.

## Select A Config And Node

[resolveLocalNeutronRuntime](../packages/neutron-provision/src/local_session.ts)
reads `local.ndeploy.json` by default. Select another config and an optional
zero-based fleet node index with:

```sh
export NEUTRON_NDEPLOY_CONFIG=wagyu-local.ndeploy.json
export NEUTRON_LOCAL_NODE_INDEX=0
```

The resolver validates the selected config against its private deployment
session and returns gateway URLs, canister IDs, node labels, and the configured
developer identity. Consume those values instead of copying principals,
ports, node order, or session contents into tests. Fleet-aware tests should
use its `nodeLabels` and `canisterIds` arrays. These environment variables
select test resolution; root `local:*` aliases still explicitly select
`local.ndeploy.json`.

## Authenticate Locally

When authentication is not the scenario under test, use the Kernel's
[local Playwright hook](../apps/kernel/src/playwright_auth.ts) with the
configured developer seed:

```ts
import { resolveLocalNeutronRuntime } from "neutron-provision/src/local_session.ts";

const runtime = resolveLocalNeutronRuntime();
const principal = await page.evaluate(async (seed) => {
  const login = window.__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
  if (!login) throw new Error("Local Playwright login hook is unavailable");
  return login(seed);
}, runtime.developerIdentitySeed);
```

The hook is exposed only for a PocketIC runtime on an admitted local hostname.
It derives an identity from the supplied seed and requires that principal to
be authorized on the deployed Kernel; it does not read the deployment config
itself. Production deployments do not expose this hook.

Use the real Internet Identity fixtures when testing authentication. Specs
with `NEUTRON_E2E_WITH_II` gates skip that path unless explicitly enabled.

## Run And Inspect Tests

On Linux, use the locked Nix environment to select Chromium and launch options:

```sh
nix develop
npm run test:e2e
```

For a focused run, select the actual spec and scenario:

```sh
npx playwright test test/e2e/local-kernel.spec.ts --grep 'local bootstrap'
```

`PLAYWRIGHT_CHROMIUM_EXECUTABLE` and `PLAYWRIGHT_CHROMIUM_ARGS` override browser
launch settings in the root config. Outside the Linux flake environment,
provide a compatible browser explicitly. Use `--headed` when observing a
scenario. The config retains traces on failure; inspect the failed test's trace
and console/network evidence before modifying timeouts or retries.

Read the root `test:e2e:*` aliases for purpose-specific runs. Aliases ending in
`:fresh` first perform a destructive local reinstall; non-fresh aliases consume
the selected deployment session. Check the output for skipped tests: a zero
exit status is not evidence that an environment-gated scenario ran.

The standalone `npm run test:browser-media` uses temporary loopback origins
and needs no deployed Neutron. It is separate from the root Playwright suite.
See [Testing And Verification](./testing-and-verification.md) for its evidence
scope and other standalone release gates. App-owned browser suites may also
use separate configs and prerequisites; read their local instructions.
