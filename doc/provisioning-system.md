# Unified Provisioning System

For `create` and `reinstall`, `neutron-provision` deploys one ordered package
set through one compiler and fresh-Kernel initialization pipeline. PocketIC
and the IC are target adapters, not separate app orchestration systems.

```text
format-3 create/reinstall desired state
    -> bounded package acquisition
    -> one input-bound compile
    -> target-specific canister operation
    -> generic Kernel initialization and asset seeding
    -> authorization
    -> runtime/access/certified-entrypoint verification
    -> schema-3 receipt
```

The provisioner does not branch on ordinary app IDs or call app-private
initializers.

## Commands

```text
neutron-provision CONFIG.ndeploy.json adopt CANISTER_ID [--execute]
neutron-provision CONFIG.ndeploy.json authorize PRINCIPAL
neutron-provision CONFIG.ndeploy.json create [--execute] [--yes]
neutron-provision CONFIG.ndeploy.json reinstall [--execute] [--yes]
neutron-provision CONFIG.ndeploy.json serve
neutron-provision CONFIG.ndeploy.json status
```

| Command | Target | Effect |
| --- | --- | --- |
| `serve` | PocketIC | Starts or attaches to the supervised long-lived PocketIC server and gateway |
| `reinstall` | PocketIC | Destructively creates/reinstalls every configured node with the current package set |
| `authorize` | PocketIC | Grants one principal owner access on every deployed node |
| `status` | PocketIC | Verifies the session, live supervisor, and gateway, then validates and prints the recorded fleet |
| `status` | IC | Validates the local schema-3 journal and prints recorded deployment state |
| `create` | IC | Plans or executes a paid canister creation |
| `adopt` | IC | Live-verifies an existing Neutron and records it as the deployment source |
| `reinstall` | IC | Plans or executes a whole-canister destructive reinstall |

PocketIC mutation executes directly. IC `create` and `reinstall` require
`--execute` for remote mutation; `--yes` is their explicit noninteractive
confirmation path. `adopt --execute` writes the verified local receipt but does
not mutate the canister.

## Deployment Config

The only accepted config format is 3:

```json
{
  "format": 3,
  "target": {},
  "artifacts": {}
}
```

The config is closed: unknown or missing fields fail before package loading,
compilation, payment, or mutation.

### PocketIC Target

```json
{
  "format": 3,
  "target": {
    "kind": "pocketic",
    "profile": "minimal",
    "gateway_port": 8000,
    "developer_identity_seed": 2,
    "authorized_principals": [],
    "nodes": ["alpha", "bravo", "charlie"]
  },
  "artifacts": {
    "kind": "inline",
    "kernel": { "path": "apps/kernel/kernel.v0.3.11.neutron" },
    "packages": [
      { "path": "apps/hello/hello.v0.2.4.neutron" }
    ]
  }
}
```

PocketIC inline archives are intentionally path-only developer inputs. Their
exact package identity is derived when `reinstall` starts, so rebuilding a
local package does not require hand-editing its digest and byte count.

Rules include:

- gateway port is 8000;
- up to 16 unique lowercase node labels;
- up to 255 ordinary packages;
- canonical non-anonymous authorized principals;
- archive paths stay within the config directory and resolve to regular files;
  and
- every node receives the same ordered target package set.

### IC Target

```json
{
  "format": 3,
  "target": {
    "kind": "ic",
    "host": "https://icp-api.io",
    "identity_id": 0,
    "subnet": "<canonical subnet principal>",
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
    "kind": "inline",
    "kernel": {
      "path": "apps/kernel/kernel.v0.3.11.neutron",
      "sha256": "<64 lowercase hex>",
      "bytes": "<archive byte length>",
      "id": "kernel",
      "version": 306
    },
    "packages": []
  }
}
```

IC inline archives are exactly pinned by:

- contained path;
- SHA-256;
- byte length;
- app ID; and
- packed app version.

An external release artifact set may be selected with:

```json
{
  "artifacts": {
    "kind": "file",
    "path": ".neutron/deploy/release.artifacts.json"
  }
}
```

That file uses artifact-set format 1 and contains the same complete pins.
Production package bytes are inspected against every independent declaration
before compilation.

An external artifact set is fully pinned for either target and is loaded with
its archives during config inspection, including `serve`, `status`, and
`authorize`. Deferred archive loading applies only to PocketIC inline
path-only records.

IC target rules also bound the HTTPS host, identity number, payment decimal,
controller count, subnet principal, and exact deployment-evidence policy.

## Effective Config Identity

The provisioner hashes the exact config source and, when present, the external
artifact-set source under the current config domain. This fingerprint binds the
session to the selected desired state.

Changing whitespace changes config identity. That is deliberate: the session
authenticates the exact reviewed file, not a loosely equivalent object.

Package identity, compiler fingerprint, deployment ID, Wasm hashes, Candid,
stable signature, chunk hashes, and evidence fingerprints are separately bound
in the plan and receipt.

## One Session Per Config

`CONFIG.ndeploy.json` owns:

```text
CONFIG.ndeploy.session.json
```

The only provision journal schema is 3. It records:

- config identity and timestamps;
- IC or PocketIC runtime;
- verified creation or adoption origin;
- current completed deployment;
- local fleet membership;
- one active create, reinstall, or local-reinstall transaction; and
- immutable plan and evidence fingerprints.

Session files:

- are regular non-symlink files;
- are privately owned and mode-restricted;
- have a 1 MiB bound;
- use atomic temporary-write, fsync, and rename;
- are validated as a closed schema on every read; and
- are protected by per-session operation locks.

Mainnet execution also uses a deployer-principal-wide lock so two configs cannot
spend or mutate concurrently through the same identity.

An interrupted exact transaction is resumed from its journal. A different
config, package set, compiler, target, controller set, or live state is not
silently merged into it.

## PocketIC Server Lifecycle

`serve` owns one supervised PocketIC instance and HTTP gateway under
`.neutron/`. Its owner session is the authoritative runtime descriptor.
Additional config sessions may attach to that live supervisor only when the
profile, root key, topology, gateway, state directory, and process identity
match.

The supervisor:

- resolves the pinned PocketIC binary;
- preserves the PocketIC state directory;
- publishes and verifies its root key and topology;
- owns the gateway on port 8000;
- records one owner-session pointer under a process lock; and
- stops cleanly without letting an attached config tear down the shared server.

`status` checks the live process and gateway rather than trusting the JSON
descriptor alone.

## Local Environment Profiles

Profiles are app-neutral infrastructure choices.

### `minimal`

Starts or verifies:

- PocketIC and its gateway;
- the lean NNS trust-root subnet required for Internet Identity query-signature
  verification, without optional NNS canister fixtures;
- local Internet Identity fixture;
- local update-source fixture; and
- infrastructure needed to create, authorize, install, and verify Neutrons.

It does not start optional Bitcoin/Ethereum services or the full ledger,
index, minter, and funding fleet.

Deployment and authorization derive the deterministic developer identity when
they need it; it is not a separate service started by `serve`.

### `full_protocol_fixtures`

Adds the shared protocol-development environment:

- persistent local Bitcoin and Ethereum services;
- PocketIC and managed ledger/index pairs;
- native-chain minter fixtures;
- deterministic test funding; and
- the same local authentication and update-source infrastructure.

The profile is never inferred from package IDs or capability declarations.
Native-chain fixture funding is applied only to the fleet's primary node.

## Local Reinstall

After `serve`, `reinstall`:

1. attaches the config session to the verified supervisor;
2. resolves every path-only archive and validates the target inventory;
3. compiles the actor once and caches the exact compiled result;
4. allocates or reuses each labeled canister from the local fleet;
5. installs the transport Wasm;
6. binds canister-specific runtime config before seeding each node;
7. initializes generic publication entropy;
8. seeds package assets, registry, Candid, stable signature, and provenance;
9. authorizes configured principals;
10. applies optional profile fixtures;
11. verifies module, runtime, owner access, packages, and certified browser
    entrypoint; and
12. atomically records the completed local deployment.

Per-node phases make exact reruns resumable:

```text
pending -> allocated -> installing -> installed
        -> seeded -> authorized -> verified
                              \-> funded -> verified
```

The `funded` branch is used only when the selected profile supplies fixtures
that require funding.

Node labels and canister IDs live in the session's local fleet. No external
helper script repairs app state or adds app-specific grants.

`authorize PRINCIPAL` mutates the current live local fleet. Add that principal
to `target.authorized_principals` when it must be restored by the next
destructive reinstall.

## Generic Fresh-Kernel Initialization

Fresh installs perform only platform initialization:

- call `kernel_publication_entropy_initialize`;
- clear the fresh static namespace;
- upload exact prepared files;
- write generated Candid, app registry, stable signature, and provenance;
- verify the final Kernel.

The compiled actor construction has already initialized the committed
app-instance inventory and compiler-authored backend-call reservation defaults;
the seeding step does not reconstruct either one.

The entropy initializer obtains management randomness, stores the first
32-byte winner idempotently, and returns its fingerprint. Publication writes
remain `#not_ready` until it succeeds.

Provision, local deploy, and whole-canister reinstall all use
`seedFreshKernel`. The Dispenser has its own resumable handoff and calls the
same initializer after seeding static assets and before arming activation.

## IC Creation

`create` first constructs a read-only plan:

- verify config, packages, identity, and target subnet;
- collect certified Registry placement/node/pricing observation;
- compile the exact target;
- build immutable transaction payloads and fingerprints;
- calculate payment and ledger transfer metadata; and
- print the planned controllers and evidence.

Execution:

1. obtains explicit confirmation;
2. transfers the exact ICP amount through the CMC path;
3. records block/creation identity for retry;
4. creates the canister on the selected subnet;
5. verifies controllers and settings;
6. installs the exact compiled Wasm through the chunked-Wasm management API;
7. initializes and seeds the fresh Kernel;
8. verifies owner access, runtime, module, and certified frontend;
9. collects an independent final Registry observation; and
10. writes a self-authenticating creation receipt.

A lost reply or process crash resumes from the journal without repeating a
confirmed paid or destructive step.

IC controllers and Kernel authorization are separate. Creation builds the
management-plane controller set from the deployer identity, up to eight
configured backup controllers, and the canister itself, for at most ten final
controllers. Thus `controllers: []` still produces the deployer and self
controllers. The deployer is separately the sole principal authorized inside a
fresh Kernel.

## Adoption

`adopt CANISTER_ID` does not change an arbitrary canister into a Neutron by
assertion. It verifies:

- canonical canister ID and selected IC host;
- running operational state;
- module hash and Kernel runtime identity;
- the exact current `neutron_actor_v25` assembler and a bounded package
  inventory snapshot;
- controller and settings snapshot;
- authorized-principal snapshot including the deployer;
- target subnet and Registry-backed deployment evidence; and
- equality of before/after observations.

Execution writes an adoption receipt. That receipt becomes the authenticated
source for a later whole-canister reinstall.

## Whole-Canister Reinstall

An IC reinstall requires a verified creation or adoption source. Its plan
binds:

- canister and deployer;
- subnet and controller set;
- original run state;
- prior module/settings fingerprints;
- exact target packages and compiler output;
- deployment nonce and chunk hashes; and
- source and fresh execution-time deployment evidence.

Execution stops the canister when required, removes snapshots that could restore
the old actor outside the recorded transaction, installs the exact target Wasm,
starts/restores the intended run state, initializes and seeds the Kernel,
verifies the final state, and records a new deployment receipt.

The operation refuses changed controllers, settings, module, subnet evidence,
source receipt, or active-transaction identity.

## Compiler And Cache Boundary

The local compiled cache is keyed by:

- the compiler-source fingerprint;
- exact ordered package archive hashes; and
- the installation network ID.

Cache entries are closed, hash-checked, size-bounded, and revalidated before
use. They contain the compiled Wasm, generated Candid, and stable signature.
Package and runtime assets are prepared separately for each deployment.

The browser, Node, and Bun Motoko compiler hosts require the artifact's explicit
`NeutronMotokoReady` Promise, apply the same bounded initialization timeout, and
do not poll for a global compiler API. Compilation uses isolated compiler
services; the provisioner does not accept an unverified external Wasm as
equivalent to the selected packages.

## Verification Boundary

A deployment is complete only when the provisioner verifies:

- module hash and run status;
- exact assembler, compiler, and deployment IDs;
- app-instance and managed-memory inventories;
- package IDs, versions, and plan fingerprints;
- controller and authorized-principal state;
- expected browser-entrypoint and runtime-config HTTP bodies;
- publication entropy readiness through successful initialization; and
- production Registry placement/node/pricing evidence where applicable.

The fresh-Kernel HTTP checks compare the returned entrypoint/runtime bodies;
they do not independently verify an IC HTTP certificate witness.
`runDeployedKernelObservation()` is a separate optional read-only release
check that pins the mainnet root, refreshes Registry evidence, verifies
module/controllers/subnet through `read_state`, and requires management
`canister_status` to report the same running module and controllers.

Generic Certified Assets implementation qualification is a Kernel CI/release
concern. The provisioner verifies the exact selected Kernel and deployed
runtime; it does not run an app-specific storage qualification mode.

## Unsupported Inputs

The current provisioner rejects:

- deployment configs other than format 3;
- provision journals other than schema 3;
- incomplete IC archive pins;
- pinned inline records in a PocketIC config;
- app-specific deployment modes or hooks;
- unknown target/profile/artifact fields;
- package inventories over 255 ordinary apps;
- local fleets over 16 nodes;
- unsafe or externalized inline paths;
- mutation without the required execution/confirmation mode; and
- live state that differs from the authenticated journal.

Recreate unsupported development state with a current config and destructive
local reinstall.

## Primary Sources

- `packages/neutron-provision/src/config.ts`
- `packages/neutron-provision/src/session.ts`
- `packages/neutron-provision/src/cli.ts`
- `packages/neutron-provision/src/local_environment.ts`
- `packages/neutron-provision/src/local_server.ts`
- `packages/neutron-provision/src/local_deploy.ts`
- `packages/neutron-provision/src/provision.ts`
- `packages/neutron-provision/src/adopt.ts`
- `packages/neutron-provision/src/reinstall.ts`
- `packages/neutron-provision/src/deployment_evidence.ts`
- `packages/neutron-provision/src/ic_registry_evidence.ts`
