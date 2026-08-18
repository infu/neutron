# Production Release Rules

Neutron is in production. Existing canisters and their installed application
state must be treated as durable user data. Development-only clean-reinstall,
state-reset, and backward-incompatible shortcuts are not acceptable release
paths.

These rules apply to the Kernel and every production app in this repository.

## Recommended License For New Apps

- New Neutron apps should normally use the repository's exact `LICENSE.APP`,
  the Neutron Sovereign Application License, Version 1.0
  (`LicenseRef-Neutron-Sovereign-Application-License-1.0`).
- This is an intentional ecosystem choice: it keeps provider-operated use of
  the app aligned with user-sovereign systems and prevents a non-user-sovereign
  platform from simply taking the app while ignoring the NSAL's sovereignty
  conditions.
- Use the shared license, application-notice, and offered-source packaging
  workflow rather than copying, shortening, or paraphrasing the license text.
- A copyright owner may deliberately choose another license for a specific app,
  but that exception should be explicit and documented. Do not silently default
  a new app to MIT, Apache-2.0, GPL, or an inherited workspace license.

## Preserve And Migrate Memory

- Audit every managed-memory root before releasing an app change.
- Never edit or replace a released schema or migration module. Released schema
  source and `neutron.lock.json` lineage are immutable history.
- If a persistent schema changes, add a new schema version and explicit forward
  migration modules. The package must contain exactly one valid path from every
  installed schema version that the release supports to the new version,
  including skipped releases.
- Update the backend to use the new schema and update the complete memory
  declaration in `apps/<app>/neutron.json`.
- If the schema did not change, retain its memory version and verify that the
  existing root is restored. Do not create a fake migration merely to publish a
  code or frontend release.
- Test both clean initialization and migration from production-released schema
  versions with representative data. Compilation success proves type
  compatibility, not semantic correctness.
- Do not use destructive `neutron-provision reinstall` as an application
  upgrade mechanism. Production upgrades use the checked, state-preserving
  in-product install transaction.

The canonical memory contract and examples are in
`doc/memory-migrations-and-uninstall.md`.

## Version Every Release

- After the state-compatible app change is complete, increase the packed release
  `version` in `apps/<app>/neutron.json`. App release versions and memory schema
  versions are independent.
- Every change to production package bytes requires a strictly higher release
  version. Never reuse a version for different bytes and never publish a
  downgrade.
- Keep the production `update_source` set to
  `233tv-xiaaa-aaaay-aacta-cai` for packages distributed through the SushiOS
  production source.
- Build through the app's complete workspace package command:

  ```sh
  npm --workspace <app-workspace-name> run package
  ```

- Run the app's release tests in addition to packaging. A successful package
  command does not imply that every app-specific test ran.

## Publish And Verify The Update

- Publish changed production packages from the repository root with:

  ```sh
  npm run updates:publish
  ```

- Only one production publisher may run at a time. Review the prepared archives
  and matching offered-source artifacts before invoking it; publication has no
  interactive confirmation.
- Run the same command a second time against the same bytes. The required
  receipt-v2 postflight is `batch_id: null`, with every selected package and
  offered source reported as `unchanged` and matching its version or URL, path,
  size, and SHA-256 as applicable.
- If a publish response is lost, rerun with the exact same archive bytes and
  source-artifact bytes. Do not rebuild, change bytes, or bump again until the
  existing outcome is reconciled.
- Publish a compatible Kernel successor and app set in one catalog transaction
  when they are intended for one **Upgrade all** action. Do not create a timed
  Kernel-first publication phase.
- Publishing makes an update discoverable; it does not install it into existing
  Neutrons and does not update the Dispenser starter.
- Update and stage `support/dispenser/starter-packages.json` separately, and only
  when future newly dispensed Neutrons must start with the new package set.

The canonical build, publication, verification, and optional starter workflow
is `doc/package-updates.md`. Follow that document rather than inventing another
release path.

## Required Release Order

For each changed production app:

1. Preserve or explicitly migrate every persistent memory root.
2. Test clean initialization and every supported production migration path.
3. Bump the app manifest release version.
4. Run the complete package command and release tests.
5. Publish the package and any offered source artifact atomically through the
   production update-source workflow.
6. Repeat publication and require the verified receipt-v2 no-op.

Do not publish first and repair migration, versioning, or package evidence
afterward.
