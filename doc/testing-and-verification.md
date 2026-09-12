# Testing And Verification

[Back to the documentation index](./index.md)

Use this document to select verification appropriate to the changed boundary.
Read the selected command and test implementation before claiming coverage:
script names do not establish which workspaces, browsers, fixtures, or release
candidates actually ran.

## Fast Checks

The repository gates are independently defined in [package.json](../package.json):

```sh
npm test
npm run typecheck
npm run security:check
npm run license:check
```

`npm test` executes the explicit `test:unit` script chain, not every workspace
or every release gate. Despite the alias, that chain also invokes packaging,
Motoko programs, browser-bundle checks, and selected release verification.
It does not imply the separate type, security, and license gates passed.
Inspect workspace scripts for additional app-specific checks.

For focused development, select the owning workspace and test:

```sh
npm --workspace neutron-kernel test
npm --workspace neutron-compiler test
```

Use an app's complete workspace `package` command before testing its generated
archive or install path. Do not assume root `validate`, `package`, or `test`
automatically includes a newly added workspace; their selected sets are explicit
in the root scripts. A test requiring an archive must produce it or declare its
packaging prerequisite.

Documentation-only changes need source, command, and link validation; they do
not require regenerating packages or release evidence.

## Choose Evidence By Boundary

| Changed boundary | Required distinction and source authority |
| --- | --- |
| Package validation and assembly | Separate manifest/package rejection from installed behavior. Start with [compiler tests](../packages/neutron-compiler/test/) and [tools tests](../packages/neutron-tools/test/); use the browser install path when the claim includes review, upload, activation, or commit. |
| Persistent app state | Test clean initialization and supported released migration paths with representative data. Follow [memory migrations](./memory-migrations-and-uninstall.md); successful compilation does not prove semantic migration correctness. |
| Kernel-app authority | Exercise live endpoint identity, installation scope, replacement, cancellation, and replay boundaries. Use [Kernel tests](../apps/kernel/test/) and [Kernel-App Communication](./kernel-app-communication.md). A fixture proving MessagePort delivery alone does not prove downstream permission routing. |
| Provider consent and financial effects | Keep generic routing fixtures independent of Wallet semantics. Verify one provider-owned decision, denied/cancelled behavior, exact effect arguments, durable retries, and uncertain outcomes. Human, direct-root, and nested-agent audiences require separate assertions. See [consent contract](./app-method-access-and-call-consent.md) and [Wallet tests](../apps/wallet/test/). |
| Browser-origin and media policy | Use a real browser for CSP, document navigation, storage, worker, and media behavior; mocked headers or source assertions are insufficient. Run the standalone browser qualification described below. |
| Certified HTTP | Distinguish declaration validation, runtime mutation semantics, cryptographic verification, gateway behavior, and browser CORS. Use the dedicated candidate qualification below. |
| Provisioning | Bind the config, artifact identity, runtime, and private session together. Follow [Provisioning System](./provisioning-system.md) and [provisioner tests](../packages/neutron-provision/test/). |

For compatibility changes, use released packages and the intended successor,
including skipped-release migration paths. Obtain versions, hashes, fixture
sizes, and compatibility matrices from the tests and manifests rather than
copying them into general documentation. Planned removals are in
[Deprecated Compatibility Paths](./deprecated.md); existing fallback behavior
is not evidence that its security boundary is fully qualified.

Update-transport tests must distinguish a resend of the same signed request
from a newly signed second mutation. A delayed, cancelled, or lost response
after dispatch is an uncertain outcome, not proof that retry is safe. Exercise
that boundary in actual installation or financial workflows when those effects
are the subject of the change.

## Browser And Local Replica Coverage

Follow [Playwright](./playwright.md) to prepare the browser, select a deployment,
and authenticate. [playwright.config.ts](../playwright.config.ts) selects the
root browser suite; [test/e2e](../test/e2e/) owns its assertions and skip gates.
Workspace-owned browser suites can have different setup requirements and are
not automatically part of the root suite.

Inspect the selected spec's environment gates and report skipped cases. For
example, the package-update Settings spec requires explicit Internet Identity
enablement:

```sh
NEUTRON_E2E_WITH_II=1 npm run test:e2e:package-updates
```

That spec checks discovery and refresh UI against its configured source. It is
not an end-to-end publication or upgrade transaction qualification.

The historical-package browser gate is:

```sh
npm run test:e2e:old-packages
```

It pins the fixture archives and exercises the real file chooser, package
review, compilation, installation, and committed state. Archive preparation
alone is not equivalent evidence. Read
[the spec](../test/e2e/old-packages.spec.ts) for the authoritative fixture set
and local-environment gate.

Root `:fresh` browser aliases run a destructive local provisioner `reinstall`
before their tests. Use them only for the selected disposable development
fixture. Never use clean reinstall as a production upgrade path or as evidence
that existing user state migrates correctly.

Reproduce browser-compiler problems using the production lifecycle: each
compile operation creates a fresh worker service, and inspection and final
emission use separate compiler instances. A page-thread mock does not exercise
that isolation.

## Browser Surfaces And Media Qualification

Run the standalone browser qualification from the repository root in the
locked flake environment and retain its browser identity with the result:

```sh
nix develop -c bash -lc '
  set -euo pipefail
  "$PLAYWRIGHT_CHROMIUM_EXECUTABLE" --version
  npm run test:browser-media
'
```

The source-owned [qualification runner](../apps/kernel/test/browser/media-capabilities.qualification.ts)
uses temporary loopback origins and fake media devices; it requires no deployed
Neutron. Its scope includes explicit media delegation and denial, child-policy
narrowing, Kernel framing containment, passive package-response replay, and the
persistent-origin predecessor/cleanup/successor transition.

The worker checks concern the entrypoints and document policies actually
exercised. They do not establish denial of blob-backed SharedWorkers or
synchronous destruction of an already-running predecessor worker. A Chromium
result does not establish other browsers' fallback behavior. An executable
override outside the pinned environment is useful for diagnosis but is not the
same release qualification.

## Certified Assets Qualification

The [qualification implementation](../apps/kernel/evidence/qualification/README.md)
owns candidate inputs, workload, environment isolation, watchdog, and receipt
validation. Do not copy its changing case inventory or fixture constants here.
For a Kernel release candidate, freeze, check, and qualify in order:

```sh
npm --workspace neutron-kernel run certified-assets:candidate-binding:write
npm --workspace neutron-kernel run certified-assets:candidate-binding
npm --workspace neutron-kernel run certified-assets:qualify
```

The write command changes the deterministic candidate binding. The check
command verifies that binding against source; neither is runtime evidence.
The qualification command runs the source-owned workload in an isolated
PocketIC environment and writes a pass-only receipt after successful validation
and cleanup. A stale or absent receipt does not qualify the current candidate.
Packaging and the repository baseline do not run this qualification implicitly.

The receipt binds the implementation, runner, candidate, compiler/assembler,
and assembled Wasm. It is bounded release-regression evidence, not proof of
cycle cost, proof size, allocator behavior, or upgrade safety at the production
state ceiling. Rejecting an oversized declaration proves admission behavior,
not operation at the maximum admitted state.

See [Certified HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md)
for the capability and certification contracts.

## App-Specific Release Gates

Read the changed app's `package.json`, release scripts, tests, and local E2E
instructions. Root test success and packaging success do not replace release
checks excluded from those commands.

Blast's installed qualification requires current Kernel and Agent archives:

```sh
npm --workspace neutron-kernel run package
npm --workspace neutron-agent run package
npm --workspace neutron-blast run verify:release
```

The [runner](../test/qualification/blast/run.ts) creates a private PocketIC,
installs a pinned released Blast predecessor alongside the current Kernel and
Agent, upgrades Blast through the browser, and exercises the installed
boundary. The release command also packages and tests Blast. Root `npm test`
runs Blast's workspace tests but does not invoke its installed qualification.

Files' standalone worker browser gate is:

```sh
npm --workspace neutron-vfs run release:browser
```

It bundles the current worker and exercises startup in a temporary browser
harness, including its credentialless negative control. It reports to stdout
without writing package inputs or evidence artifacts. Neither Files packaging
nor root `build:all` invokes it. The focused test wrapper is
`npm --workspace neutron-vfs run test:browser-release`.

## Evidence Discipline

Record the command, exact tested candidate, environment, result, skipped
coverage, and relevant artifacts in the change's verification record. Keep
run-specific outputs and task notes out of this reference; TODO files belong
in the gitignored repository-root `tmp/` directory.

Keep these claims separate:

- A unit or source fixture proves its bounded assertions.
- A browser test proves the exercised behavior in its recorded setup.
- A PocketIC run proves that local environment and workload.
- A live-network smoke proves only the exercised path.
- A release qualification proves only the validated candidate and measurements
  bound by its evidence contract.

Do not infer certification, maximum-state safety, cycle cost, or upgrade
continuity from source inspection. App-specific fixtures do not establish a
generic Kernel contract unless they exercise that generic boundary directly.
Follow [Package Updates](./package-updates.md) for production build, publication,
and verification; passing tests does not authorize publishing or reinstalling.
