# Third-Party Notices

The first-party update-source scripts and configuration are Apache-2.0; see
`LICENSE`. Published `.neutron` packages remain separately licensed payloads
and retain the license, source, and notices supplied with each package.

## DFINITY SDK certified-assets canister

- Component: `assetstorage.wasm.gz`
- Release: DFINITY SDK 0.32.0
- Source: https://github.com/dfinity/sdk/tree/0.32.0
- Binary: https://github.com/dfinity/sdk/releases/download/0.32.0/assetstorage.wasm.gz
- SHA-256: `04e565b3425fe7510ee16b02adcfe3f01abc9a2725c82a21cb08969241debd62`
- License: Apache-2.0

## DFINITY certified-assets sync plugin

- Component: `sync_plugin.wasm`
- Release: `migration-v2.2.1-6b48585`
- Source: https://github.com/dfinity/certified-assets/tree/migration-v2.2.1-6b48585
- Binary: https://github.com/dfinity/certified-assets/releases/download/migration-v2.2.1-6b48585/sync_plugin.wasm
- SHA-256: `ca7cb5666c30d2875f8d5e10535f8a53f97a86c79c263f7d5bdac2fdd1bbf83c`
- License: Apache-2.0

Both upstream projects use the Apache License, Version 2.0. The complete text
is the `LICENSE` file in this directory. Neither pinned upstream source tree
contains a NOTICE file at the identified revision.

## Publisher dependencies

The publisher scripts use the exact JavaScript dependency graph in the root
`package-lock.json`. Dependencies retain their own licenses and notices; they
are not relicensed by the update-source package. A bundled release, if one is
created, must include a byte-specific third-party notice inventory.
