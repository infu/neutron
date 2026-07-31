# Playwright

Neutron uses Playwright for repeatable browser tests and, when explicitly
enabled, interactive browser investigation.

## Prepare A Local Deployment

The root aliases use the current format-3
[`local.ndeploy.json`](../local.ndeploy.json):

```sh
# Terminal 1
npm run local:start

# Terminal 2
npm run local:deploy
npm run local:status
```

`local:start` starts or attaches to the supervised PocketIC server.
`local:deploy` destructively reinstalls the configured package set, and
`local:status` prints the recorded node and browser URL.

Use the provisioner directly for another config or a multi-node fleet:

```sh
# Terminal 1
npm run provision -- wagyu-local.ndeploy.json serve

# Terminal 2
npm run provision -- wagyu-local.ndeploy.json reinstall
npm run provision -- wagyu-local.ndeploy.json status
```

Tests resolve the gateway, canister IDs, node labels, and developer identity
from the selected config's schema-3 session. They do not use icp-cli mappings
or hardcoded local principals.

## Select A Config And Node

`resolveLocalNeutronRuntime()` reads `local.ndeploy.json` by default. Select
another config and, for a fleet, a zero-based node index with:

```sh
export NEUTRON_NDEPLOY_CONFIG=wagyu-local.ndeploy.json
export NEUTRON_LOCAL_NODE_INDEX=0
```

The Wagyu node order is `alpha`, `bravo`, `charlie`. Fleet-aware tests should
use the complete `nodeLabels` and `canisterIds` arrays returned by the resolver
instead of opening separate PocketIC instances.

## Authenticate Locally

A local Kernel page exposes a narrow Playwright login hook:

```ts
import { resolveLocalNeutronRuntime } from "neutron-provision/src/local_session.ts";

const runtime = resolveLocalNeutronRuntime();
const principal = await page.evaluate(
  async (seed) => window.__NEUTRON_PLAYWRIGHT_LOGIN_AS__?.(seed),
  runtime.developerIdentitySeed,
);
```

The hook:

- exists only for a PocketIC runtime;
- accepts only loopback and `*.localhost` pages;
- derives the deterministic identity declared by the selected config; and
- succeeds only when that principal is authorized on the deployed Kernel.

It is absent on production deployments. Keep dedicated tests for the real
Internet Identity path; use the hook when authentication is not the subject of
the scenario.

## Run Tests

Run the root suite:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE="$(command -v google-chrome-stable)" \
  npx playwright test
```

Run one spec while iterating:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE="$(command -v google-chrome-stable)" \
  npx playwright test test/e2e/contacts-wallet.spec.ts
```

Useful root commands are:

```sh
npm run test:e2e:local
npm run test:e2e:local:ii
npm run test:e2e:local:fresh
```

The `:fresh` command performs the destructive local reinstall before running
the Internet Identity scenario. Use `--headed` for manual observation.

## Interactive Codex Browser Work

Playwright MCP is opt-in:

```sh
codex -p playwright -C /srv/shared/code/neutron
```

The profile starts the repository's Nix-aware Playwright wrapper. The browser
persists for the Codex session and exposes navigation, accessibility snapshots,
console and network events, screenshots, and viewport controls.

## Primary Sources

- `playwright.config.ts`
- `test/e2e/`
- `packages/neutron-provision/src/local_session.ts`
- `apps/kernel/src/playwright_auth.ts`
- `local.ndeploy.json`
- `wagyu-local.ndeploy.json`
