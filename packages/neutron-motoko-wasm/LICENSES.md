# License index

This package is a composite distribution. No single license replaces the
licenses of all incorporated components.

## Neutron wrapper and Motoko compiler

The Neutron wrapper and the modified Motoko compiler identified by
`compiler/manifest.json` are distributed under Apache License 2.0 with the
LLVM exception (`Apache-2.0 WITH LLVM-exception`). The exact license and
exception are in `LICENSE`.

The pinned Motoko source is:

- repository: `https://github.com/infu/neutron_motoko`
- revision: `d7ed0a92b6219d784b7143e0851ed64b55dfc25a`

## js_of_ocaml and wasm_of_ocaml runtime

The generated JavaScript/WebAssembly compiler artifacts contain runtime code
from js_of_ocaml/wasm_of_ocaml 6.4.0. That runtime is distributed under the GNU
Lesser General Public License 2.1 or later with the project's OCaml linking
exception (`LGPL-2.1-or-later WITH OCaml-LGPL-linking-exception`). The exact
upstream license and exception from revision
`e4d950bc1cbcb0f8fc61cce06b0c6a2c55f94581` are in
`LICENSE.js_of_ocaml`.

The linking exception permits a qualifying executable containing portions of
the publicly distributed Library to be distributed under terms of choice. It
does not erase the remaining attribution, notice, source, or modified-library
conditions that apply to the incorporated component.

## Source and dependency boundary

The preferred compiler source, build scripts, and dependency declarations are
maintained in the compiler's own repository at the exact immutable revision:

- https://github.com/infu/neutron_motoko/tree/d7ed0a92b6219d784b7143e0851ed64b55dfc25a

The corresponding js_of_ocaml/wasm_of_ocaml runtime source is available at:

- https://github.com/ocsigen/js_of_ocaml/tree/e4d950bc1cbcb0f8fc61cce06b0c6a2c55f94581

This package intentionally references those separately maintained source
repositories instead of duplicating their complete histories and build
closures. `compiler/manifest.json` and `compiler/SHA256SUMS` bind the exact
source revision, build command, and generated assets distributed here. The
license texts and exceptions applicable to those distributed components are
included in this package. Build-time dependencies that are not incorporated
into the distributed assets remain governed and documented by the pinned
compiler repository.

Changing the pinned source revision or any generated-asset checksum requires a
new review of this index and the accompanying license materials.
