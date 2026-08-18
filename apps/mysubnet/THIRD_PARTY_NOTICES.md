# Third-party notices

## Natural Earth

The bundled 1:110m land topology is derived from Natural Earth via the
`world-atlas` package. Natural Earth data is in the public domain. See
https://www.naturalearthdata.com/about/terms-of-use/ and
https://github.com/topojson/world-atlas.

## Three.js

The globe uses Three.js, distributed under the MIT License. See
https://github.com/mrdoob/three.js/blob/dev/LICENSE.

## DFINITY IC Registry protocol definitions

`src/registry.ts` is a local minimal implementation of the public Registry wire
interface. It does not vendor DFINITY's `.proto` or Rust implementation files.
Its field numbers, message layout, and Registry key prefixes were reviewed on
15 August 2026 against this immutable DFINITY `ic` revision:

`eb55873567bcda6cdcf3c0a573d4db13daaa2c8e`

The exact referenced sources and their SHA-256 values are:

| Upstream path                                                             | SHA-256                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `rs/registry/transport/proto/ic_registry_transport/pb/v1/transport.proto` | `55b704a970c28bc2dc4f64912947312dd4901f31aaef4e2346fe777cb6e52354` |
| `rs/registry/keys/src/lib.rs`                                             | `19ae7f90d146093755337e03f658d1ed2273b8d150960249c23c810f1ff3f403` |
| `rs/protobuf/def/registry/node/v1/node.proto`                             | `873b8da09c14ca447fe0c84e3170cbe53f3bf73a0b4f27e3943028f388928da6` |
| `rs/protobuf/def/registry/node_operator/v1/node_operator.proto`           | `1ce1158af8b21835664230eddfbc5b03c4db7dfd1e64b33d844ca7ced3ba7464` |
| `rs/protobuf/def/registry/dc/v1/dc.proto`                                 | `9178358b22d54c0d84b3d05c7efe303832f6f213ebb4a6809e9123c536c89057` |

The first two files inherit the Internet Computer Community Source License,
Version 1.0 through upstream `rs/registry/LICENSE`, which resolves to
`licenses/IC-1.0.txt`. Its exact text is retained in
`LICENSE.DFINITY-IC-1.0` (SHA-256
`3ba11e25f86c79b944d0ee682d978b66230e12032eae32fd9d4ce2f327683162`).
That license includes an Internet Computer platform limitation.

The three record protobuf definitions have no closer license file and inherit
the DFINITY repository-root Apache-2.0 license. Its exact text and DFINITY
copyright notice are retained in `LICENSE.DFINITY-IC-Apache-2.0` (SHA-256
`663dab5e2a11fed35cd86d277d83f52cbeac29eb2b08581d10aaacbaa3ced4ef`).

No `NOTICE` file exists at the repository root or along the relevant upstream
paths at this revision. The available DFINITY copyright and license notices
are preserved in the two local license copies. Future changes that copy
upstream implementation or schema text, rather than independently consuming
the documented interface, require a fresh compatibility and redistribution
review before release.
