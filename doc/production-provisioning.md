# Production provisioning

[Back to the documentation index](./index.md).

This is the production IC operator guide. Start with
[Provisioning System](./provisioning-system.md) for the shared local/production
architecture and command matrix, use
[Local Development And Deployment](./bootstrap-local-development-and-deployment.md)
for the PocketIC workflow, and use the
[provisioner package reference](../packages/neutron-provision/README.md) for the
complete CLI, config, session, and recovery contract.

This runbook covers operator-owned Neutrons created by
`packages/neutron-provision`. It is distinct from the public, self-service
[SushiOS dispenser](./dispenser-and-provisioning.md), whose backend accepts an
ICP deposit, creates a canister, installs the configured starter, and hands
authorization to the browser through a one-time activation code.

Neutron production creation, live-verified adoption, and whole-canister
reinstall are implemented only by `packages/neutron-provision`. They use the
same target-neutral package archives and shared seeding/verifying machinery as
local PocketIC, with an IC adapter for identity, payment, subnet placement,
snapshots, and crash recovery.

The checked-in [`config.ndeploy.json`](../config.ndeploy.json) is a current
format-3 IC config with complete inline package pins. An IC config may instead
select a closed external artifact set. For example:

```json
{
  "format": 3,
  "target": {
    "kind": "ic",
    "host": "https://icp-api.io",
    "identity_id": 0,
    "subnet": "<subnet-principal>",
    "payment_icp": "5",
    "controllers": [],
    "deployment_evidence": {
      "source": "ic_registry_certified_v1",
      "registry_canister": "rwlgt-iiaaa-aaaaa-aaaaa-cai",
      "root_key_sha256": "737ba355e855bd4b61279056603e05501db5e5bad147c6eba7be8c2a13f4b6b3",
      "pricing_profile": "application_13_node"
    }
  },
  "artifacts": {
    "kind": "file",
    "path": ".neutron/deploy/production.artifacts.json"
  }
}
```

The referenced file is a closed format-1 artifact set with one kernel pin and
an ordered package-pin list. Each pin contains an exact archive `path`,
`sha256`, `bytes`, `id`, and `version`; the same record may instead be written
inline under `artifacts`. Paths resolve relative to the deployment config.
Every archive is re-read and checked against all five declarations before
planning or execution.

Unknown fields, target overrides, deployment configs other than format 3,
workspace or build instructions, environment-labelled archives, duplicate
identities, archive drift, and symlink escapes are rejected. Provisioning never
runs npm, Bun, TypeScript, shell hooks, Mogen, or app-owned scripts. A separate
trusted package/release workflow produces the target-neutral archives and
updates their pins. The configured `controllers` are merged with the deployer
identity for creation, and Neutron adds its own canister ID afterward.

The four `deployment_evidence` values are closed protocol pins, not operator
labels. The stock provisioner performs anonymous replicated calls to the
pinned NNS Registry canister, verifies each request-status certificate under
the compiled IC mainnet root key, reads the subnet record at one exact Registry
version, and derives the subnet type, 13-node membership, and explicit SEV
flag. A Dashboard response, an ordinary query response, a fetched replacement
root key, or a config assertion is not accepted as evidence. The checked-in
pricing profile is `application_13_node`. It covers a thirteen-member
application-family subnet or a seven-member application-family subnet with
Registry-certified SEV enabled. The provisioner records the exact observed
topology and accepts only those shapes.

The journal binds the effective SHA-256 of the exact config source plus the
exact external artifact-set source when present. Once an IC execution has
created that journal, changing even whitespace or an archive pin
causes `create`, `adopt`, `status`, and any active-operation resume to reject
the mismatch. There is one narrow desired-state transition: when no IC
operation is active, a fresh `reinstall` plan may validate a changed effective
config/artifact-set hash against the immutable source receipt and live
canister. Planning remains read-only. Only executing that exact immutable
reinstall transaction atomically rebinds the journal to the new hash. It may
not change pins during resume, rewrite the permanent origin/adoption evidence,
or let `status` bless an undeployed config.

## Create

The default is a read-only plan:

```bash
npm run provision -- config.ndeploy.json create
```

Execute interactively or noninteractively:

```bash
npm run provision -- config.ndeploy.json create --execute
npm run provision -- config.ndeploy.json create --execute --yes
```

For a new deployment, planning verifies every pinned archive, compiles the
complete production actor, checks Wasm limits, loads the numbered icblast
identity, and performs current ledger/CMC/subnet preflight. It sends no update,
creates no session, and spends no ICP. If creation is already complete and has
not been superseded by reinstall, `create` instead verifies the live certified
subnet, controllers, and module against that receipt; it never creates a
second canister for the same session.

Execution derives the identity's default ICP account and rechecks its balance
and the live ledger fee. Interactive mode prints the canonical ICP account
identifier plus principal and, when the account is underfunded, waits for
funding before a new execution persists or sends anything. The tool then
journals the exact transfer timestamp and fee, sends the CMC creation transfer
with the `CREA` memo, notifies the CMC for the exact
configured subnet, adds Neutron as its own controller, installs the actor,
binds the IC runtime configuration, seeds certified assets, and performs strict
postflight verification.

`--yes` means “execute without funding or destructive confirmation prompts.”
It is accepted only with `--execute`; it does not bypass balance, subnet,
controller, module, or postflight checks.

For a journal-only view that performs no live IC query:

```bash
npm run provision -- config.ndeploy.json status
```

## Adopt an existing canister

An existing production Neutron can become the source of a schema-3 session
through its live-verified adoption receipt, without paying ICP or creating another
canister:

```bash
# Live verification only; does not create a journal
npm run provision -- config.ndeploy.json adopt <canister-id>

# Repeat the proof and record the adoption
npm run provision -- config.ndeploy.json adopt <canister-id> --execute

# Explicit automation
npm run provision -- config.ndeploy.json adopt <canister-id> --execute --yes
```

`adopt` is IC-only and works only when the config has no session. Planning
loads the configured identity and compares the certified and management
canister views. The subnet and installed module must agree, and the controller
set must be exactly the configured deployer, `target.controllers`, and the
canister itself. The live Kernel must additionally prove its runtime and
installed-package identity, identify itself as the requested canister, expose
the same controllers through its access snapshot, and authorize the deployer
as a controller.

The default plan writes nothing. Execution repeats every live check under the
config and deployer-wide mainnet locks, then atomically writes a private
mode-`0600` adoption receipt. It sends no ICP, invokes no CMC creation, performs
no install, and makes no provisioning mutation to the canister. The receipt
records the proven canister, subnet, controllers, module/settings
fingerprints, runtime identity, and package identities. Its journal
intentionally has `adoption` but no fabricated `origin` or `current`.

Adoption is the one explicit way to establish a schema-3 source receipt for an
existing canister. It does not add an ID argument to ordinary reinstall.
`--yes` is accepted only with `--execute`.

## Whole-canister reinstall

The target canister comes only from the permanent paid-creation `origin` or
live-verified `adoption` receipt. Ordinary reinstall has no canister-ID
override:

```bash
# Read-only plan
npm run provision -- config.ndeploy.json reinstall

# Destructive execution
npm run provision -- config.ndeploy.json reinstall --execute

# Explicit automation
npm run provision -- config.ndeploy.json reinstall --execute --yes
```

Reinstall preserves the canister ID, source receipt, subnet, controllers,
settings, the existing cycle balance apart from ordinary execution costs, and
the original running/stopped state. A canister created by the provisioner also
retains its permanent origin payment evidence. The exact cycle balance is not
frozen in the reinstall plan. Reinstall permanently erases all application
data, Kernel state, browser authorizations, certified assets, and snapshots.

The provisioner compiles a uniquely stamped complete actor, stages chunks while
the old canister is available, binds the confirmation to exact live module and
settings fingerprints, stops and drains the canister, removes every snapshot,
installs in management `reinstall` mode, restarts, binds runtime config, restores
each certified file with its own `kernel_static` operation, authorizes only the
deployer, verifies module/runtime/Candid/schema/registry/provenance/access, and
performs a final snapshot sweep. An originally stopped canister is stopped
again after verification.

## Authorize the browser principal later

Creation and reinstall authorize the configured icblast deployment identity,
not the Internet Identity principal that the browser receives at the new
Neutron origin. Open the verified production URL, sign in, and copy the
principal shown on the blocking authorization screen. Then use the config's
same `identity_id` to add it:

```bash
npx icblast call <neutron-canister-id> kernel_authorized_add \
  '["<browser-principal>"]' --id 0
```

Replace `0` when the config selects a different `identity_id`. Optionally
confirm the resulting access set:

```bash
npx icblast call <neutron-canister-id> kernel_access_snapshot '[null]' --id 0
```

The provisioner's `authorize` command is PocketIC-only; it cannot perform this
production step. `kernel_authorized_add` grants full kernel authority, so check
the copied principal and target canister carefully before sending the update.
A whole-canister reinstall erases this authorization and requires it again.

## Journal and recovery

The only persistent state associated with the config is:

```text
config.ndeploy.session.json
```

New sessions use a mode-`0600` schema-3 journal, atomically rewritten under a
config lock.
Executing IC commands also take a deployer-wide mainnet lock, preventing the
same identity from running simultaneous paid/destructive operations through
different config files. The journal contains:

- `configSha256` and target runtime;
- exactly one permanent source: `origin` creation/payment evidence or a
  live-verified `adoption` receipt;
- one latest verified `current` deployment receipt after an install completes;
- at most one `active` create or reinstall transaction. It is normally
  unfinished, but may be marked complete while payload cleanup is pending after
  an interruption.

A freshly adopted journal has no `origin` and no `current`; its adoption
receipt is sufficient to bind the first reinstall plan to the proven live
canister. After that reinstall verifies, the journal gains `current` while
retaining `adoption`.

Before the first irreversible call, exact recovery bytes are fsynced into a
private content-addressed binary payload under `.neutron/provision/` and its
digest is placed in `active`. A resume verifies that payload and reconciles
each ambiguous response against ledger, CMC, canister, chunk, module, snapshot,
and runtime state. It never rebuilds mutable source after payment. Completion
is deliberately recoverable rather than one multi-file atomic action: the
journal first records the verified `current` receipt and marks `active`
complete, then deletes the payload, then rewrites the journal without `active`.
A crash between those steps is cleaned up by rerunning the same executing
command.

There is no separate reinstall journal, nonce-named session, JSON artifact
bundle, or unbounded operation history. Do not delete a production session or
an active transaction payload; rerun the same command to reconcile it.

## Package and runtime boundary

The `.neutron` packages used here are the same bytes used by PocketIC. Target
selection happens only while compiling the final combined actor. Once the
canister ID exists, provisioning injects the certified
`/system/runtime-config.json` with mainnet gateway, II, root-key, canister, and
deployment policy, the canister-specific isolated-frame origin template, and an
explicit `null` update-source-origin override. On IC, `null` deliberately means
that Kernel derives each source's standard certified
`https://<source-canister>.icp0.io` origin from the package manifest principal;
it does not disable manifest `update_source` values. Production postflight
fetches and compares that exact runtime file, and Kernel refuses to initialize
clients or UI before its certification and origin binding pass. The current
SushiOS packages name source `233tv-xiaaa-aaaay-aacta-cai`; see
[App Package Updates](./package-updates.md).

The current assembler gives the actor a compiler-owned immutable
`installation.network_id`. Production derives it only from the
compiler-pinned IC mainnet root-key SPKI DER; neither the config nor a fetched
root key may substitute for it. Planning and postflight require exact runtime
identity `neutron_actor_v25`; other assembler IDs fail closed.

The full CLI/config/session details are maintained in the
[provisioner package reference](../packages/neutron-provision/README.md).
