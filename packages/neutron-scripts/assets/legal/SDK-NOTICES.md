# Uniswap SDK notice provenance

Audited on 2026-09-06 for sdk-core 7.19.2, v3-sdk 3.31.3 and v4-sdk 2.3.3.
All three SDKs declare MIT. Exact missing-file decisions are in
`audited-npm-license-materials.json`, bound to package version, package.json
SHA-256 and material SHA-256.

`@ethersproject/logger@5.8.0` omits the monorepo license from its npm archive.
Its published gitHead is `fa5f647bb2cde63dd0b9664c42cbfbdc1515e800`; the exact
[upstream MIT license](https://github.com/ethers-io/ethers.js/blob/fa5f647bb2cde63dd0b9664c42cbfbdc1515e800/LICENSE.md)
is preserved as `Ethers-5.8.0.LICENSE`, including Richard Moore's copyright.
The other five decisions preserve complete installed README files containing
their MIT license and copyright text. There is no generic MIT fallback.

The SDK's Solidity artifact dependencies are not distributed by the Uniswap
browser app. The app uses its own thin position ABI encoders and the SDK's
math/action planner, avoiding the default helper import that emitted unused
contract bytecode. `npm_build_evidence.ts` audits exactly these versions and
manifest bytes: swap-router-contracts 1.3.1, v3-periphery 1.4.4 and v3-staker
1.0.0. Their contracts, source, bytecode and compiler dependencies are absent
from both the browser output and the offered source snapshot; npm lock entries
remain reproducible build references.

The real esbuild invocation writes `dist/third-party-build.json`. Packaging
verifies its output sizes and SHA-256 values, its input contribution inventory,
and coverage of executable browser assets. An audited artifact package can be
omitted only when its inputs contribute zero output bytes and any observed
inputs are precompiled artifact JSON. A missing proof, different package version
or changed manifest follows the existing full dependency notice path. Stale
output evidence is an error. This does not license or permit distribution of
the omitted contracts under the app's license.

The fixture package.json/README copies under `test/fixtures` are exact inputs
used to test these decisions. They retain their original license metadata and
complete copyright/license text.
