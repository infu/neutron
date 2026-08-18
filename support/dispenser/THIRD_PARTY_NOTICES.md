# Third-Party Notices

This file records incorporated third-party material in the Dispenser source and
built program. The governing Apache-2.0 text is in `LICENSE`. Separately
embedded `.neutron` package payloads keep the licenses and notices carried in
those archives.

## Aviate Labs hash.mo

- Component: adapted `src/CRC32.mo`
- Incorporated file: `mo/lib/CRC32.mo`
- Revision: `8f8bd427428fc26ef8a806fa3f1dacbe5e252c9b`
- License: Apache-2.0
- Copyright notice: Copyright 2021 Quint Daenen
- Source: https://github.com/aviate-labs/hash.mo/tree/8f8bd427428fc26ef8a806fa3f1dacbe5e252c9b

Neutron changed imports, array slicing, and the exposed checksum API. The
incorporated file carries a prominent change notice.

## Aviate Labs encoding.mo

- Component: adapted `src/Binary.mo`
- Incorporated file: `mo/lib/encoding.mo`
- Revision: `2711d18727e954b11afc0d37945608512b5fbce2`
- License: Apache-2.0
- Copyright notice: Copyright 2021 Quint Daenen
- Source: https://github.com/aviate-labs/encoding.mo/tree/2711d18727e954b11afc0d37945608512b5fbce2

Neutron changed imports and narrowed the byte-order API. The incorporated file
carries a prominent change notice.

## flyq/motoko-sha224 and the Go SHA-256 implementation

- Component: adapted `src/SHA224.mo`
- Incorporated file: `mo/lib/sha.mo`
- Revision: `16aa34f4420317e514954b3f89037918a7572b9c`
- License: Apache-2.0
- Source: https://github.com/flyq/motoko-sha224/tree/16aa34f4420317e514954b3f89037918a7572b9c

Neutron changed imports and mutable-array/range APIs. The incorporated file
carries a prominent change notice.

flyq's SHA224 implementation derives from Enzo Haussecker's DFINITY
`SHA256.mo` at revision `90cbfc3b6c131767027fdd910393a5766208142c`:

- Source: https://github.com/enzoh/motoko-sha/tree/90cbfc3b6c131767027fdd910393a5766208142c
- License: Apache-2.0 WITH LLVM-exception
- Source notice: Copyright 2020 DFINITY Stiftung
- Maintainer: Enzo Haussecker
- NOTICE: Copyright 2020 Enzo Haussecker
- Exact license and exception: `LICENSE.Enzoh-Motoko-SHA`

That lineage cites Go's `crypto/sha256/sha256.go`, which is distributed under
this BSD-3-Clause notice:

    Copyright 2009 The Go Authors.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions are
    met:

       * Redistributions of source code must retain the above copyright
         notice, this list of conditions and the following disclaimer.
       * Redistributions in binary form must reproduce the above copyright
         notice, this list of conditions and the following disclaimer in the
         documentation and/or other materials provided with the distribution.
       * Neither the name of Google Inc. nor the names of its contributors may
         be used to endorse or promote products derived from this software
         without specific prior written permission.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
    AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
    IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
    ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
    LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
    CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
    SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
    INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
    CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
    ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
    POSSIBILITY OF SUCH DAMAGE.

## Motoko Core 2.6.0

- Revision: `f8daac747ac6ac8e663a44b79891ee0613796d76`
- License: Apache-2.0 WITH LLVM-exception
- Source: https://github.com/dfinity/motoko-core/tree/f8daac747ac6ac8e663a44b79891ee0613796d76

The complete Apache-2.0 text and LLVM exception are in
`LICENSE.Motoko-Core`.

Copyright 2025 DFINITY Stiftung

This product contains modified software originally developed by MR Research AG,
used with permission:

- https://github.com/research-ag/vector
- https://github.com/research-ag/prng

## MR Research sha2 0.1.6

- Revision: `50b75cc03baaecedf03cc2ba955679247f69e91a`
- License: Apache-2.0
- Source: https://github.com/research-ag/sha2/tree/50b75cc03baaecedf03cc2ba955679247f69e91a

Copyright 2023-2025 MR Research AG

## Motoko Base 0.14.14

- Revision: `bff049d57bc693b6f0098c7e0d848668c4a3bab2`
- License: Apache-2.0 WITH LLVM-exception
- Source: https://github.com/dfinity/motoko-base/tree/bff049d57bc693b6f0098c7e0d848668c4a3bab2

The complete Apache-2.0 text and LLVM exception are in
`LICENSE.Motoko-Base`.

Copyright 2020 DFINITY Stiftung

## sanitize.css 10.0.0

- Incorporated file: `src/style/sanitize.css`
- Revision: `6faee43ecc70ae0a6e18079233558e99c868682a`
- License: CC0-1.0
- Author: Jonathan Neal
- Contributors: Jonathan Neal and Nicolas Gallagher
- Source: https://github.com/csstools/sanitize.css/tree/6faee43ecc70ae0a6e18079233558e99c868682a

The local source was byte-identical to that revision before Neutron added its
provenance comment.

## JavaScript dependencies

The browser build also incorporates packages identified by the repository's
exact `package-lock.json`, including DFINITY/ICP SDK packages, React,
ReactDOM, and their transitive dependencies. Those components retain their own
Apache-2.0, MIT, BSD, ISC, or other permissive terms. A release build must carry
the generated exact dependency notice bundle; this source notice is not a
substitute for that byte-specific release inventory.
