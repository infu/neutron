These are Bun-run TypeScript scripts for Neutron app packaging.

- `src/mogen.ts` extracts annotated Motoko functions into generated type
  aliases and `neutron.json` function metadata.

- `src/mopack.ts` bundles Motoko sources into hash-addressed package modules.

- `src/method_schema.ts` writes `dist/schema.json`, a build-time JSON Schema
  artifact for the app's generated wrapper Candid interface using icblast. This
  is a developer and package contract aid; the kernel still derives trusted
  schemas from the installed canister at runtime.

- `src/pack.ts` creates a binary `.neutron` package from `dist/`.

- `src/validate.ts` validates `neutron.json`.

- `src/compile_motoko.ts` compiles an actor with Neutron's exact vendored
  Motoko WebAssembly compiler and emits its matching Candid sidecar. Pass
  `--emit-stable-types` when the matching stable-types sidecar is also needed.
  It invokes `mops sources` only to resolve package roots and never resolves or
  executes a host `moc`.

Apps should call these through `bun ../../packages/neutron-scripts/src/*.ts`
from their `package.json` scripts.
