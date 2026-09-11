# Build and release with icp CLI

The protocol project lives in `support/marketplace/` and uses `icp` CLI for
creation/installation/upgrades. It is a standalone canister, separately deployed
from the Neutron UI package. The initial production canister is
`sj2r4-haaaa-aaaay-aadgq-cai`; its verified deployment and package release progress
are recorded in [production release status](production-release.md). Commands
below describe the operator procedure, not permission to create another canister
or reinstall this one.

## Build inputs and distribution

Research inspected installed `icp 1.0.2` help and the matching official references.
The build uses the repo's pinned Motoko compiler script and the Dispenser's
`icp.yaml` script-build pattern, writing the artifact to `ICP_WASM_OUTPUT_PATH`.
Do not switch to an arbitrary host compiler.

Compile the protocol with matching Candid and compatibility evidence. Pin private
build inputs and dependency identities in the private release record, outside
Git. Keep proprietary schema configuration and internal tooling documentation
out of this repository and public release artifacts. Builds must use the
reviewed inputs without fetching changing dependencies during installation.

The marketplace protocol is proprietary and all rights reserved under its
[protocol license](../LICENSE). The separate Neutron marketplace app uses the
standard [LICENSE.APP](../../../LICENSE.APP) packaging workflow. App packaging
must not include the proprietary protocol or its private build inputs. Preserve
the original license and offered-source obligations of third-party and existing
published app packages.

## Operator command shapes

The following forms were verified against `icp 1.0.2`. The operator identity,
initial cycles and initialization record must be supplied and reviewed. Commands
are examples, not executed deployment steps. Complete the public
[initialization template](../config/README.md) outside Git; its placeholders
intentionally cannot encode a deployable configuration.

Local development, from `support/marketplace`:

```sh
npm run deps:install
npm run test
npm run config:init -- --input /private/path/local-init.json --output /private/path/local-init.bin
icp network start -e local -d
icp project show
npm run build
icp canister create marketplace -e local
icp canister install marketplace -e local --mode install --wasm build/marketplace.wasm --args-file /private/path/local-init.bin --args-format bin
```

Install mode is for an empty newly created local canister. Migration tests use
upgrade mode against retained fixtures, not production resets.
`npm run build` emits `build/marketplace.wasm`, Candid and stable-type evidence.
Alternatively, `icp build marketplace` writes the CLI artifact store; omit the
`--wasm` argument when intentionally installing that CLI-managed build.

Production uses explicit creation and installation of reviewed bytes. Substitute
the agreed creation cycles and verified artifact path in the operator procedure:

```sh
icp canister create marketplace -e ic --identity marketplace-admin --cycles "$MARKETPLACE_INITIAL_CYCLES"
icp canister status marketplace -e ic --identity marketplace-admin --json
icp canister install marketplace -e ic --identity marketplace-admin --mode install --wasm build/marketplace.wasm --args-file /private/path/ic-init.bin --args-format bin
```

Later state-preserving releases install the reviewed successor:

```sh
icp canister install marketplace -e ic --identity marketplace-admin --mode upgrade --wasm-memory-persistence keep --wasm build/marketplace.wasm --args-file /private/path/ic-init.bin --args-format bin
icp canister status marketplace -e ic --identity marketplace-admin --json
```

Do not use reinstall or memory replacement as upgrade shortcuts. Verify the
installed module hash and retained state against the exact reviewed artifact.
The actor class still requires its typed argument on upgrade; retained state,
including configuration changed through protocol methods, remains authoritative.
For larger Wasm, `icp 1.0.2` automatically uploads chunks and calls
`install_chunked_code`; a direct single-message `install_code` test transport
instead needs compressed Wasm. The CLI also defaults EOP upgrades to memory
preservation; the command above makes that choice explicit.
([Verified CLI implementation](https://github.com/dfinity/icp-cli/blob/v1.0.2/crates/icp-cli/src/operations/install.rs))
Keep identities/secrets outside version control. A snapshot is not a way to undo
ledger effects: restoring old internal balances cannot reverse external payments.

## Protocol calls after installation

Ordinary user and publisher protocol updates go through the calling Neutron with native
cycles attached. Use the existing generic backend-call capability; no
marketplace-specific Kernel policy or prepaid browser-write account is needed.
Authorized auditor-only updates are exempt and may use assigned auditor CLI
identities directly. The four admin endpoints `admin_auditor_set`,
`admin_reserve_app`, `admin_set_burn_account`, and `rates_refresh` also accept
direct authenticated CLI calls without cycles. Configure the CLI's actual
principal in `admins`; existing canister admins remain accepted. `feeVersion`
stays in these requests for wire compatibility but is not charged or checked
against attached funding. Admin and auditor roles do not exempt unrelated
marketplace operations. See [cycles and queries](cycles-and-queries.md) for the
exact boundary and [operator commands](../OPERATIONS.md) for `icp`/Blast usage.

Browser reads and certified HTTP downloads remain direct. Ordinary CLI/browser
ingress cannot attach native cycles, and topping up the marketplace canister is
not payment attached to an individual update. Deployment management commands
above are controller operations, separate from the marketplace protocol API.

## Separation from package publication

Canister code deployment and marketplace package uploads are separate operations.
The old source's static asset synchronization can delete objects absent from its
local folder. The new protocol must not use static asset sync to replace retained
publisher content during a code deployment.

The initial deployment created a separate canister and reserved all 27 initial
app IDs for the configured first-party publisher. The existing Rust source
`233tv-xiaaa-aaaay-aacta-cai` remains intact; its historical bytes stay at their
existing immutable URLs. Marketplace batch 1 has published 27 reviewed packages;
its exact-byte repeat verified the receipt-v2 no-op. The compatible 26-app
transition was verified in old-source batch 97; its exact-byte repeat check is
also complete, with `batch_id: null` and all 26 packages and offered sources
unchanged.
Transition manifests name the new source, and matching
offered-source artifacts accompany the packages. The first-party set is free;
this workflow does not expose future paid packages through the old source.

Repeat each publication with the exact same bytes and require the verified
receipt-v2 no-op before calling that source complete. A lost reply must be
reconciled with the retained request and bytes. Package review is not a publish
receipt, and deployment is not app installation. After both publications are
verified, users choose **Settings → Upgrade all**, then install Marketplace
version 107 separately. No Dispenser starter change or Git push is part of this
release.

## Upgrade evidence

Keep the exact build inputs, compiler/dependency identities, Wasm/Candid,
compatibility checks, predecessor module identity and verified installed result
in the private release record. A successful compile does not prove that user
state survives an upgrade.

Follow the [Ash and PocketIC test plan](testing.md) before installation. Test
clean initialization and every supported upgrade path with representative
ownership, money, audit, package, upload and ranking records. Verify byte-for-byte
package retention, durable retry recovery and correct access after restart.
Resume periodic work from retained progress; completed payments and ranking
events must not run twice. Use explicit forward migrations when state changes;
never edit a released predecessor or substitute a clean install.

The local implementation checks below preceded the initial production deployment.
They did not publish packages or execute marketplace financial smoke tests.
Current production status is tracked separately in the
[release record](production-release.md).

## Local CLI release check

On 2026-09-10, `icp 1.0.2` installed the reviewed protocol Wasm on a separate
managed local network, then upgraded that same canister with
`--wasm-memory-persistence keep`. Both commands succeeded. Status queries before
and after reported module SHA-256
`18def141b7ed5cb081e18b4e58cb1bd11ece899985987e62d97a8d3b8799fe0f`, matching
the normal build and public-actor PocketIC test.

The upgrade deliberately supplied different fee initialization values;
`marketplace_info` remained byte-for-byte equal, confirming that retained
configuration was authoritative. This checks the CLI transport and constructor
argument handling, alongside the broader retained-data PocketIC suites. It is
not a production installation or a financial test. The disposable network was
stopped after the check.

A subsequent local check used a later protocol build with public Candid
metadata, SHA-256
`0d9af11fa662a51da3ff9200070fe04db1838cc064c01998400d85b47bc2debc`.
Blast 4.2.0 discovered the interface and called all four exempt admin methods
from an assigned identity that was not a controller. Auditor assignment/removal,
unauthorized-call rejection and ordinary publisher identity checks passed.
Configuration and roles remained intact after a same-canister keep upgrade.
This disposable network was also stopped. The deployment controller identity
and the configured Blast admin/auditor identities are separate roles and need
not be the same principal.

References:

- [icp 1.0.2 command reference](https://github.com/dfinity/icp-cli/blob/v1.0.2/docs/reference/cli.md)
- [icp 1.0.2 configuration](https://github.com/dfinity/icp-cli/blob/v1.0.2/docs/reference/configuration.md)
- [Current Dispenser build configuration](../../dispenser/icp.yaml)
- [Pinned Motoko build script](../../../packages/neutron-scripts/src/compile_motoko.ts)
- [Production source lifecycle cautions](../../update-source/README.md)
- [Canister lifecycle](https://docs.internetcomputer.org/guides/canister-management/lifecycle/)
