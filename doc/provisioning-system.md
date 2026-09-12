# Unified provisioning system

Use this document when changing provisioning orchestration or diagnosing a
deployment. Use [production provisioning](./production-provisioning.md) for IC
operations and [local development](./bootstrap-local-development-and-deployment.md)
for PocketIC. The implementation contract is in
[`packages/neutron-provision`](../packages/neutron-provision/src/).

Production app upgrades use the checked, state-preserving in-product install
transaction. `neutron-provision reinstall` is a destructive whole-canister
reset, not an upgrade or a workaround for migration failures. Preserve installed
state according to [memory migrations](./memory-migrations-and-uninstall.md)
and follow [package updates](./package-updates.md) for releases.

## Architecture

IC creation and PocketIC/IC reinstall share an ordered package acquisition,
compilation, fresh-Kernel seeding, and verification pipeline. Targets supply
identity, canister operations, runtime configuration, and infrastructure. The
provisioner must not infer infrastructure from ordinary app IDs or add
app-private initialization hooks.

```text
desired archive set
    -> validate archives and bind compilation inputs
    -> compile the combined actor
    -> target-specific canister operation
    -> bind runtime config and seed fresh Kernel assets
    -> verify runtime, packages, access, and HTTP assets
    -> record completion in the journal
```

Read [`cli.ts`](../packages/neutron-provision/src/cli.ts) for accepted commands
and flags. The target distinction matters:

| Operation | PocketIC | IC |
| --- | --- | --- |
| `serve` | Own or attach to the supervised server and gateway | Unsupported |
| `create` | Use local reinstall to allocate the fleet | Plan by default; `--execute` performs paid creation |
| `adopt` | Unsupported | Live-verify a canister; `--execute` records the local receipt |
| `reinstall` | Immediately and destructively deploy the configured fleet | Plan by default; execution destructively resets the recorded canister |
| `authorize` | Grant owner access across the deployed fleet | Use the Kernel authorization API explicitly |
| `status` | Check the live supervisor and gateway; report the recorded fleet | Validate and report the local journal; no live IC state check |

IC `create` and `reinstall` support `--yes` with `--execute` to suppress
interactive confirmation. Adoption has no confirmation prompt and rejects
`--yes`. Local mutation commands do not use the IC execution flags.

## Deployment inputs

[`config.ts`](../packages/neutron-provision/src/config.ts) defines the closed
format-3 config, format-1 external artifact set, accepted target profiles,
field types, and resource bounds. Read it and the selected `*.ndeploy.json`
before editing deployment inputs; do not copy a package inventory or release
pin from prose.

- IC archives require independent `path`, `sha256`, `bytes`, `id`, and `version`
  declarations. The archive must match every declaration.
- PocketIC inline inputs are path-only so local package rebuilds do not require
  new integrity declarations. Archives are resolved at reinstall.
- External artifact sets remain fully pinned on both targets and are inspected
  when loading the config, including for commands that do not compile.
- Artifact paths are relative to the config directory and must remain contained
  there after resolution. Unknown fields, duplicates, unsafe paths, and invalid
  pins fail before deployment.

The effective config fingerprint includes the exact config source and any
external artifact-set source. Whitespace changes its identity. Package hashes,
compiler identity, deployment identity, and compiled output have separate
bindings; do not substitute one kind of evidence for another.

Archives are the provisioner's inputs. Packaging and release preparation happen
before provisioning; the provisioner does not execute app-owned build scripts.
[`artifact.ts`](../packages/neutron-provision/src/artifact.ts) owns acquisition
and compilation, and
[`compiled_cache.ts`](../packages/neutron-provision/src/compiled_cache.ts) binds
cached output to compiler sources, the exact ordered archives, and network ID.

## Sessions and recovery

Each `CONFIG.ndeploy.json` owns `CONFIG.ndeploy.session.json`. The schema-3
journal binds config identity, runtime, permanent IC creation/adoption evidence,
completed deployment, local fleet, and any active transaction. Read
[`session.ts`](../packages/neutron-provision/src/session.ts) for the accepted
schema and locking contract.

Journal reads validate ownership, private file permissions, regular-file
status, schema, and fingerprints. Writes use atomic durable replacement.
Session locks serialize operations; IC execution also locks the deployer
principal across configs.

Resume an interrupted transaction with the same config, archives, and executing
command. Its persisted payload and evidence are authoritative; rebuilding a
different actor or replacing a journal is not recovery. A newly planned IC
reinstall can select changed desired archives only when no operation is active;
execution binds the new config hash atomically with that transaction while
retaining the permanent source receipt. See
[production recovery](./production-provisioning.md#journal-and-recovery).

## PocketIC lifecycle

[`local_server.ts`](../packages/neutron-provision/src/local_server.ts) and
[`pocketic_supervisor.ts`](../packages/neutron-provision/src/pocketic_supervisor.ts)
own one long-lived server, state directory, and gateway under `.neutron/`.
An attached config must match the live runtime descriptor, process, profile,
root key, topology, and gateway. Its session is not permission to tear down
another config's supervisor.

Profiles select infrastructure explicitly. `minimal` provides authentication,
the required trust-root infrastructure, a local update source, and ordinary
Neutron deployment. `full_protocol_fixtures` additionally supplies shared chain,
ledger, minter, and funding fixtures. Consult
[`local_environment.ts`](../packages/neutron-provision/src/local_environment.ts)
and the supervisor's fixture setup for the current services; do not branch on
the apps selected by a config.

[`local_deploy.ts`](../packages/neutron-provision/src/local_deploy.ts) resolves
archives, compiles once, and tracks each node through allocation, installation,
seeding, authorization, optional fixture funding, and verification. The same
ordered package set goes to every node. Node labels and canister IDs belong in
the session, not a second deployment registry. Completed local deployments may
have changed modules through browser installs; a new local reinstall verifies
supervisor ownership and canister identity and ensures the self-controller
without requiring the previous module hash. An interrupted transaction still
resumes its recorded phases. A principal added with `authorize` must also be
placed in `target.authorized_principals` if it should survive the next destructive local
reinstall.

## Fresh-Kernel initialization

[`seedFreshKernel`](../packages/neutron-provision/src/provision.ts) validates
the complete package-derived asset set, initializes publication entropy, and
uploads package assets, generated Candid, app registry, stable signature,
canister identity, and install provenance. It seeds authorized browser origins
when the selected assembler supports them. The
compiled actor already owns the committed app-instance inventory and
compiler-authored backend-call defaults; seeding must not reconstruct them.

Publication entropy initialization is idempotent and must succeed before
publication writes are ready. The Dispenser has its own resumable handoff but
uses the same Kernel initializer before activation; see
[dispenser provisioning](./dispenser-and-provisioning.md).

[`runtime_config.ts`](../packages/neutron-provision/src/runtime_config.ts)
binds target-neutral Kernel assets only after the canister ID is known. Keep
gateway, identity provider, trust policy, isolated-frame origins, and update
source configuration together at this boundary.

## Verification boundary

Successful installation alone is not completion. Production orchestration
checks certified module/controller/subnet state, Registry-backed placement
evidence, initial Kernel access, and the selected runtime/package identities.
Fresh-Kernel verification also checks registry/provenance consistency,
generated Candid and stable signature, expected runtime configuration, and a
nonempty browser entrypoint.

The fresh-Kernel HTTP fetches do not independently verify an IC HTTP certificate
witness. Do not describe them as client-side certification proof or claim they
compare the entire HTML entrypoint to the selected package.
[`deployed_kernel_observation.ts`](../packages/neutron-provision/src/deployed_kernel_observation.ts)
provides a separate read-only observation that verifies mainnet certificates,
refreshes Registry evidence, and cross-checks management status against the
expected running module, controllers, and subnet. Neither check replaces Kernel
Certified Assets qualification or app migration tests.

For changes here, select relevant tests under
[`packages/neutron-provision/test`](../packages/neutron-provision/test/).
Exercise interruption/resume and rejected drift as well as successful fresh
deployment. Test local reset behavior only on disposable development state.
