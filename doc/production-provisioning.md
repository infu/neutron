# Production provisioning

Use this document for agent-operated IC creation, adoption, and recovery with
[`packages/neutron-provision`](../packages/neutron-provision/src/). Read
[provisioning architecture](./provisioning-system.md) for shared invariants and
the [package reference](../packages/neutron-provision/README.md) alongside the
implementation when changing CLI behavior. Public self-service creation uses
the separate [Dispenser](./dispenser-and-provisioning.md).

Existing production canisters contain durable user data. Routine upgrades use
the checked in-product install transaction and
[package update workflow](./package-updates.md). Whole-canister reinstall erases
state; it must not be used as an application upgrade or migration repair.

## Review the deployment inputs

Inspect the selected `*.ndeploy.json`, the exact archives it names, and any
existing session before running a command. The repository's
[`config.ndeploy.json`](../config.ndeploy.json) is a deployment input, not proof
that its selected release is the newest or suitable for a different canister.

[`config.ts`](../packages/neutron-provision/src/config.ts) accepts format-3
deployment configs. IC archives are pinned inline or through a format-1
external artifact set. Each archive has a contained `path`, SHA-256, byte count,
app ID, and packed version, all verified against its contents. Read the code
for field types, bounds, and allowed values rather than maintaining duplicate
JSON examples or release inventories here.

The configured host, numbered icblast identity, subnet, payment, backup
controllers, and deployment-evidence policy are reviewed inputs. Creation's
management controller set includes the deployer, configured backups, and the
new canister itself. This is separate from Kernel authorization: the deployer
is the sole initially authorized Kernel principal.

The stock evidence provider uses the pinned NNS Registry
`rwlgt-iiaaa-aaaaa-aaaaa-cai` and the compiler-pinned IC mainnet root key.
`ic_registry_certified_v1` observations bind a Registry version, subnet type,
membership, and SEV flag to verified replicated-call certificates. The
`application_13_node` pricing-policy identifier is not an assertion of the
observed member count; read
[`deployment_evidence.ts`](../packages/neutron-provision/src/deployment_evidence.ts)
for supported topologies and
[`ic_registry_evidence.ts`](../packages/neutron-provision/src/ic_registry_evidence.ts)
for verification. A Dashboard response, ordinary query result, replacement root
key fetched from a host, or config label does not satisfy this policy.

## Create

Plan without paying or creating a deployment journal:

```bash
npm run provision -- CONFIG.ndeploy.json create
```

The plan validates archive pins, compiles the actor, checks installation limits,
loads the selected identity, and performs ledger, CMC, and certified subnet
preflight. Review the printed identity, payment, controllers, and evidence.
Planning reads the network and compiles local artifacts; it does not perform a
paid creation or install. The production path does not use the rebuildable
PocketIC complete-actor cache.

Execute the reviewed operation interactively:

```bash
npm run provision -- CONFIG.ndeploy.json create --execute
```

For already authorized noninteractive execution, add `--yes`. It is valid only
with `--execute` and suppresses confirmation/funding prompts, not balance,
placement, controller, or verification checks. Interactive execution prints the
identity's ICP account and can wait for funding before starting the transaction.

Execution journals the exact ledger transfer parameters, creates through the
CMC on the selected subnet, verifies controllers, installs the compiled Wasm,
binds runtime configuration, seeds the Kernel, and verifies the result. A lost
reply resumes from the transaction instead of creating a second canister.
Once creation is complete and has not been superseded by reinstall, repeating
`create` checks the receipt against live state rather than creating again.

## Adopt an existing canister

Adoption establishes a verified source receipt without paying for or mutating
the canister. It requires a config with no existing session:

```bash
npm run provision -- CONFIG.ndeploy.json adopt CANISTER_ID
npm run provision -- CONFIG.ndeploy.json adopt CANISTER_ID --execute
```

The first command verifies without writing a journal. The second repeats the
proof under config/deployer locks and records the adoption. **Adoption rejects
`--yes`**; `--execute` already requests its local receipt write.

The running canister must match the certified subnet, module, management
controllers, selected assembler, Kernel runtime, and access snapshot. Its
controller set must agree with the configured deployer/backups and self
controller, and the deployer must have Kernel access. Adoption is not an
assertion that an arbitrary canister is a Neutron, and it cannot manufacture
missing creation/payment evidence. See
[`adopt.ts`](../packages/neutron-provision/src/adopt.ts).

## Whole-canister reinstall

This command exists for an explicitly intended destructive reset. It erases
application state, keys, Kernel permissions, browser authorizations, certified
assets, and canister snapshots. It preserves canister identity, permanent source
evidence, subnet, controllers, settings, original run state, and remaining cycles
apart from execution costs. It cannot preserve the installed applications' data.

The target comes only from the session's permanent creation or adoption receipt;
there is no canister-ID override. Read-only inspection is:

```bash
npm run provision -- CONFIG.ndeploy.json reinstall
```

Execution uses `--execute`; interactive confirmation names the target canister.
`--execute --yes` is the noninteractive destructive path and is not permission
to reset production data as part of an ordinary release.

[`reinstall.ts`](../packages/neutron-provision/src/reinstall.ts) binds the live
module, settings, controllers, subnet evidence, desired packages, and exact
compiled actor into an immutable plan. It stages Wasm, stops/drains the
canister, removes snapshots, reinstalls, initializes/seeds the fresh Kernel,
verifies it, and restores the intended running/stopped state. Reconciliation
must respect those recorded phases; do not bypass drift failures with a manual
management install.

## Authorize the browser principal later

The configured deployment identity differs from the Internet Identity principal
at the new Neutron origin. Open the verified production URL, sign in, and obtain
the principal from its authorization screen. Use the same numbered deployment
identity to grant access and inspect the result:

```bash
npx icblast call CANISTER_ID kernel_authorized_add '["BROWSER_PRINCIPAL"]' --id IDENTITY_ID
npx icblast call CANISTER_ID kernel_access_snapshot '[null]' --id IDENTITY_ID
```

Replace the placeholders with the selected canister, browser principal, and
`target.identity_id`. `kernel_authorized_add` grants full Kernel authority.
The provisioner's `authorize` command is PocketIC-only. A destructive
whole-canister reinstall removes browser authorization and requires this step
again.

## Journal and recovery

`CONFIG.ndeploy.session.json` is a private schema-3 journal. It holds a permanent
creation `origin` or verified `adoption`, the latest completed install in
`current`, and at most one `active` transaction. A fresh adoption has no invented
`origin` or completed-install `current`.

Execution takes both session and deployer-wide locks. Before irreversible work,
the provisioner durably stores exact transaction payload bytes and Registry
proof bundles referenced by the journal. They belong with the session during
recovery; the JSON file alone is not the complete recovery material. See
[`session.ts`](../packages/neutron-provision/src/session.ts),
[`payload.ts`](../packages/neutron-provision/src/payload.ts), and the deployment
evidence modules.

Keep the config source, external artifact-set source, archives, journal, and
active payload unchanged after an interrupted operation. Resume the same
executing command. Recovery reconciles ambiguous ledger, CMC, chunk, install,
snapshot, and runtime outcomes using persisted evidence; it does not rebuild a
new actor after payment.

Completion is itself recoverable: the journal records the verified deployment
and completed active transaction, then removes the payload and clears `active`.
If interrupted during cleanup, rerun the same command. Do not delete production
journals or active payloads, or bypass another running provisioner's lock.

The effective config hash covers exact source bytes, including whitespace and
external artifact-set source. `create`, `status`, and active-operation resume
reject mismatches. When no operation is active, a fresh destructive reinstall
plan may validate a changed desired config against the permanent receipt and
live canister. Only execution atomically binds that new config hash to its
transaction; planning or `status` cannot bless an undeployed config.

For a journal-only status report:

```bash
npm run provision -- CONFIG.ndeploy.json status
```

IC `status` performs no live canister verification. Config loading still checks
the selected archive pins.

## Runtime and verification

Provisioning binds `/system/runtime-config.json` after the canister ID is known.
It carries IC gateway/authentication trust, canister/deployment identity, and
the isolated-frame origin template. A production `null` update-source-origin
override means Kernel derives each source's certified origin from its manifest
principal; it does not disable updates. Packages distributed through the
SushiOS production source retain `233tv-xiaaa-aaaay-aacta-cai` as required by
[package updates](./package-updates.md).

The compiler derives immutable `installation.network_id` from its pinned mainnet
root key. Config values or a fetched root key cannot replace that identity.
Planning/adoption/postflight enforce the selected compiler's assembler contract;
do not copy a current assembler number into this runbook.

See [verification boundaries](./provisioning-system.md#verification-boundary)
before interpreting success. Fresh HTTP checks compare runtime configuration,
Candid, stable signature, and provenance, and require nonempty entrypoint HTML;
they do not independently validate HTTP certification witnesses or prove app
migration correctness.
