# Neutron provisioner

`neutron-provision` installs complete Neutron actors on the IC or in the
repository's supervised PocketIC runtime. It consumes `.neutron` archives; it
does not discover workspaces, build apps, run package scripts, or repair app
state from source.

Run it through the repository wrapper:

```sh
npm run provision -- CONFIG.ndeploy.json COMMAND
```

The command surface is:

```text
CONFIG.ndeploy.json authorize PRINCIPAL
CONFIG.ndeploy.json adopt CANISTER_ID [--execute]
CONFIG.ndeploy.json create [--execute] [--yes]
CONFIG.ndeploy.json reinstall [--execute] [--yes]
CONFIG.ndeploy.json serve
CONFIG.ndeploy.json status
```

`serve`, local `reinstall`, local `authorize`, and local `status` are PocketIC
operations. `adopt` and `create` are IC-only. IC `reinstall` is a read-only plan
unless `--execute` is supplied.

## Configuration

Format 3 is the only accepted deployment-config format.

### Local development

PocketIC inline archives are path-only developer inputs:

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
    "kernel": {
      "path": "apps/kernel/kernel.v0.3.12.neutron"
    },
    "packages": [
      {
        "path": "apps/hello/hello.v0.2.4.neutron"
      }
    ]
  }
}
```

The profile is explicit and app-neutral:

- `minimal` creates Application, NNS trust-root, Internet Identity, and
  TestThresholdKeys subnets. It installs Internet Identity and the local update
  source; optional NNS canister fixtures remain disabled.
- `full_protocol_fixtures` adds the SNS, fiduciary, and Bitcoin subnets, local
  Bitcoin and Ethereum services, protocol ledgers/minters, and fixture funding
  for the fleet's primary node.

Profiles describe the local network, never an app. The provisioner does not
infer a profile from package IDs or manifests. One persistent PocketIC runtime
has one profile; attaching a config with another profile fails and requires
recreating local state.

Local archive paths are resolved only by `reinstall`. The bounded archives are
then read and their SHA-256, byte length, manifest ID, version, and kernel/app
role are derived before compilation and deployment fingerprinting. `serve`,
`status`, and `authorize` do not need the archive files.

Inline local records accept exactly `path`. Pins in local inline records are
rejected so normal development does not require hand-maintaining generated
digests.

### IC releases

IC deployment inputs remain immutable and fully pinned:

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
    "kind": "inline",
    "kernel": {
      "path": "apps/kernel/kernel.v0.3.12.neutron",
      "sha256": "<64 lowercase hex characters>",
      "bytes": "<archive byte length>",
      "id": "kernel",
      "version": 312
    },
    "packages": []
  }
}
```

A release system may instead provide a pinned external artifact set:

```json
{
  "artifacts": {
    "kind": "file",
    "path": ".neutron/deploy/release.artifacts.json"
  }
}
```

That JSON file has format 1 and contains the same fully pinned `kernel` and
ordered `packages` records. An external set stays pinned for either target and
is loaded with its archives during config inspection, including `serve`,
`status`, and `authorize`. Deferred archive loading applies only to PocketIC
inline path-only records.

Archive paths are relative to the deployment config and must resolve to regular
files inside its directory; symlink escapes are rejected. The kernel is first
and unique. Package IDs and paths are unique. One archive is limited to 128
MiB, the ordered set to 256 MiB, and the set contains at most 256 archives
(one kernel and up to 255 apps).

Unknown fields, partial pin records, old formats, and missing artifacts fail
closed. The provisioner does not guess filenames, create placeholder digests,
or fall back to source builds.

## Local lifecycle

`serve` starts or attaches to the one checksum-pinned, repository-owned
PocketIC supervisor and the fixed `http://localhost:8000` gateway. Compatible
configs share that runtime while keeping separate session journals.

Local `reinstall` verifies the recorded runtime and binds compilation to the
exact PocketIC root key. The ordered package set is compiled once and the same
actor is installed on each named node. Per-canister runtime assets are bound
after installation.

A fresh node is initialized in this order:

1. install the compiled actor;
2. initialize the Kernel's generic publication entropy;
3. seed the package, runtime, and provenance assets;
4. grant the deterministic developer principal and configured principals;
5. fund protocol fixtures when the selected profile provides them; and
6. verify module, package, authorization, runtime, and asset state.

The certified provenance journal contains one `provisioned` entry per installed
package, bound to the SHA-256 digest of the exact outer `.neutron` archive.
This gives same-version update checks an installed-byte baseline without
mislabeling a trusted bootstrap as a manual user install.

There is no app-specific bootstrap hook. Apps own their own initialization and
upgrade behavior.

The same commands work for one node or an arbitrary named fleet:

```sh
npm run provision -- local.ndeploy.json serve
npm run provision -- local.ndeploy.json reinstall
npm run provision -- local.ndeploy.json status
npm run provision -- local.ndeploy.json authorize PRINCIPAL
```

`authorize` changes the live fleet only. Add the principal to
`target.authorized_principals` if it must be restored by a later reinstall.

## Journals and interruption recovery

Each config owns one private, atomically written schema-3 journal:

```text
CONFIG.ndeploy.session.json
```

PocketIC fleet membership has one canonical `localFleet` record. A local
reinstall persists each node through:

```text
pending -> allocated -> installing -> installed
        -> seeded -> authorized -> verified
                              \-> funded -> verified
```

The `funded` branch is used only by profiles with funding fixtures.

Rerunning with the same config and exact resolved package/compiler inputs
reconciles the active operation and resumes unfinished phases. Changing
ordered labels or shrinking a recorded fleet with orphaned canisters fails
instead of guessing.

Only schema 3 is readable. Development deployments can be destructively
recreated.

IC create and reinstall keep immutable transaction payloads, certified Registry
evidence, payment records, and crash-reconciliation state. Do not delete an
active IC journal or payload after an ambiguous remote response; rerun the same
executing command.

Completed IC creation, adoption, and reinstall receipts always include the
generic deployment evidence and fingerprint required to prove their source.
Receipts without that evidence are rejected.

## Production boundary

Production preparation:

- requires exact archive pins;
- uses the compiler-pinned mainnet installation context;
- verifies certified Registry placement and pricing facts;
- validates controller and initial-access intent;
- installs the complete actor through the current chunked-Wasm management API;
  and
- verifies the final module, runtime, packages, authorization, and certified
  HTTP state before recording completion.

The provisioner contains no app qualification mode, app-specific evidence
schema, post-install reservation repair, or old install/commit probe.

`runDeployedKernelObservation()` is the optional read-only release check. It
refreshes the same certified Registry evidence recorded by provisioning, reads
the installed module hash, controllers, and subnet through a mainnet-root-pinned
`read_state`, then requires management `canister_status` to report the same
running module and controllers. It has no app input or app policy.

`adopt` writes a receipt only when explicitly executed. `create` pays and
creates only when explicitly executed. `reinstall` preserves the canister ID,
controllers, settings, subnet, and remaining cycles, but intentionally erases
Kernel and installed-app state.

For the broader model and operational runbooks, see:

- [Unified Provisioning System](../../doc/provisioning-system.md)
- [Local Development And Deployment](../../doc/bootstrap-local-development-and-deployment.md)
- [Production Provisioning](../../doc/production-provisioning.md)
