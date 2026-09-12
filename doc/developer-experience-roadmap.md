# Developer Tooling Boundaries

[Back to the documentation index](./index.md)

Use this reference when changing the authoring, packaging, compiler, or
provisioning workflow. The historical filename is retained for links; active
plans and TODO files belong in gitignored `tmp/`, not in this document.

## Responsibilities

| Owner | Contract |
| --- | --- |
| App workspace `package.json` | Complete app build, package, and release-test commands |
| `packages/neutron-scripts` | Shared annotation generation, validation, module packaging, legal/source records, and archives |
| `packages/neutron-compiler` | Package preparation, supported assembler selection, checked installation, and combined actor compilation |
| `packages/neutron-cli` | Filesystem adapter for production-context compilation |
| `packages/neutron-provision` | Deployment config/journal, trusted local context, IC operations, and supervised PocketIC fleet |
| Root `package.json` | Selected workspace fan-out, repository generation, local aliases, and production publisher entrypoint |

Packages are target-neutral. Deployment identity and trusted network context
belong to compilation/provisioning, not to an app-specific local archive.
The provisioner consumes declared archives; it does not discover app workspaces
or run their package commands.

The local config owns its session journal. Browser tests and local tools should
resolve the gateway and fleet from that state rather than duplicate canister
IDs, ports, or another deployment journal. Production declarations use exact
pinned artifacts; local path declarations support rebuilding before a new
disposable deployment.

## Discover Commands From Their Owners

Read the root and selected workspace manifests before choosing a command:

```sh
node -p 'JSON.stringify(require("./package.json").scripts, null, 2)'
node -p 'JSON.stringify(require("./apps/<app>/package.json").scripts, null, 2)'
```

The root ordered build pipeline builds workspaces, packages apps, then generates
repository artifacts. Repository generation consumes archives. A frontend
watcher or a workspace build alone is not a package release.

Some test commands build packages, start replica fixtures, or reinstall a local
fleet. Inspect their script bodies and configuration before running them.
The `local:deploy` alias is destructive whole-canister provisioning; production
app upgrades use the reviewed, state-preserving product transaction.

Read environment requirements from `flake.nix`, tool manifests, and the root
lockfile. Use `nix develop` for the repository's declared shell. Do not mirror
dependency versions, current Chromium paths, or compiler generation numbers in
this guide.

## Change Guidance

- Keep package generation deterministic and make ownership of generated files
  explicit. Fix the owning generator rather than adding app-specific repair
  scripts.
- Diagnose compile caching using the package/compiler identity and journal
  already carried by the operation. Avoid inventing a parallel state format.
- Preserve the split between building an archive, compiling an actor,
  provisioning a disposable environment, and reviewing an installed app
  upgrade. These operations have different state and authorization effects.
- Use the shared app contract for new examples. Do not add app-ID branches to
  generic compiler or provisioning code to support an ordinary app.
- Test interrupted operations and realistic retained state when changing
  install/provisioning orchestration. Compilation and happy-path smoke tests
  do not prove recovery.
- Keep documentation as source navigation and stable contracts. Record active
  task plans, test logs, release receipts, and live deployment observations in
  their designated scratch/evidence locations.

See [App Development Workflow](./app-development-workflow.md),
[Local Development And Deployment](./bootstrap-local-development-and-deployment.md),
[Provisioning System](./provisioning-system.md), and
[Testing And Verification](./testing-and-verification.md).
