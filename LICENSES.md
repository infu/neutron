# Neutron repository license map

This repository contains separately licensed works. A workspace's own
`package.json`, `LICENSE`, `LICENSES.md`, application notice, and `NOTICE`
files govern that workspace and its release bytes. The root package is private
workspace metadata; it does not relicense every file in the repository.

## Neutron Public License 1.0

The Neutron-owned Kernel and control-plane components use the Neutron Public
License, Version 1.0 (`LicenseRef-Neutron-Public-License-1.0`) when their own
application notice applies it. The license text is in `LICENSE`.

The control-plane package boundary is:

- `packages/neutron-cli`
- `packages/neutron-compiler`
- `packages/neutron-provision`
- `packages/neutron-security`

## Neutron Application license choices

New ordinary Neutron Applications should deliberately choose one of two
user-sovereign Application licenses:

- `LICENSE.APP` is the Neutron Sovereign Application License, Version 1.1
  (`LicenseRef-Neutron-Sovereign-Application-License-1.1`). It permits
  modification and sharing, but all Production Use must occur in a Qualifying
  Sovereign System.
- `LICENSE.APP.USE` is the Neutron Sovereign Application Use License, Version
  1.0 (`LicenseRef-Neutron-Sovereign-Application-Use-License-1.0`). It provides
  Complete App Source for inspection while reserving modification,
  redistribution, sublicensing, and operation-for-another rights. Its narrow
  installation and use grant also requires a Qualifying Sovereign System.

Previously published ordinary Applications remain under the exact Neutron
Sovereign Application License, Version 1.0
(`LicenseRef-Neutron-Sovereign-Application-License-1.0`) preserved in
`LICENSE.APP.1.0`. Their existing `NOTICE` files continue to apply that version
until a future higher package release deliberately adopts another license. The
current legacy Application workspaces are:

- `apps/agent`
- `apps/chess`
- `apps/contacts`
- `apps/hello`
- `apps/hullshift`
- `apps/jetcreeper`
- `apps/kitchensink`
- `apps/mail`
- `apps/mysubnet`
- `apps/spreadsheet`
- `apps/vetkeys_fixture_test`, including its separately packaged peer
- `apps/vfs`
- `apps/wagyu`
- `apps/wallet`

The Kernel is a control-plane work, not an ordinary Application. Its own
release notice and license materials govern it.

## Apache-2.0 application, shared, and support code

The following Neutron-owned shared or support workspaces use Apache-2.0. Each
has its own `LICENSE` and `NOTICE`:

- `apps/gemma`
- `packages/neutron-design-system`
- `packages/neutron-motoko-capabilities`
- `packages/neutron-scripts`
- `packages/neutron-tools`
- `support/dispenser`
- `support/repository`
- `support/update-source`

Gemma is an intentional permissive Application exception; it is not NSAL.
Apache-2.0 applies only to the Neutron-owned code in these workspaces. Bundled
dependencies and embedded `.neutron` packages retain their own licenses and
notices.

## Motoko compiler distribution

`packages/neutron-motoko-wasm` is a composite distribution. Its exact license
index is `packages/neutron-motoko-wasm/LICENSES.md`; it must not be described
as solely NPL, solely Apache-2.0, or solely LGPL.

## Historical and third-party material

Previously conveyed GPL releases retain their GPL rights. The preserved GPL
text in `LICENSE.GPL-3.0` and immutable historical package fixtures do not make
new, separately licensed source or release bytes GPL-covered.

Every external dependency, copied source file, generated runtime, model,
fixture, icon, and embedded package retains its own copyright and license.
Package-specific third-party notices and release inventories are part of the
applicable license materials; this map does not replace them.
