# Wallet approval replacement and revocation qualification

**PASS** on installed Kernel 342 / EVM Wallet 107, deployment `4646e9e9048f3cbc6034fa079ff263a3`. The recorded full Playwright test passed in 114.216 seconds, starting 2026-09-06T13:51:07.757Z, with no retry. The report records one expected test, zero unexpected tests and zero flaky tests.

The actual Wallet created an approval, signed a same-nonce speed-up, confirmed only the replacement, discovered its approval after reload, then explicitly reviewed and signed a zero-allowance revocation. This completes the previously failing approval → replacement → Known Approvals → revocation path on the local fixture.

## Artifact identities

- Installed evidence SHA-256: `b744288e175ffc012596fbf22c2c3390644359eed9d0628e321b517451e59a0d`; preserved verbatim as `installed-final-candidates.json`.
- EVM Wallet107 archive: `apps/evm_wallet/evm_wallet.v0.1.7.neutron`, 391816 bytes, SHA-256 `ce05d6106fcfd398281411e488759d52d331d73a735cd7cc05f36574c72e4e91`.
- EVM Wallet107 offered-source package: 524845 bytes, SHA-256 `533ef243aed9fbf3d2fbb5b4d453edd9921af63468953a0ef4a264c44ba61574`. This is the application source artifact.
- Exact executed E2E spec, preflight E2E pin and current E2E source: SHA-256 `dedacaf17446cb364448f4bd024ad1fe10452870fde1a9d5bb2e72bec9dd80be`, 24719 bytes. This is the test source, distinct from the offered-source package.
- Kernel342 archive SHA-256: `ed8dbd29b9c13e91786e3c836489ca81505d5c079884e37a573b3719be63dce4`.
- `artifact-index.json` includes fixture input hashes, report, trace, checkpoints, extracted attachments and offline checks.

## Transaction evidence

| Item | Recorded value |
| --- | --- |
| Network | Owned unforked Anvil chain42161, loopback8546 |
| Owner | `0xd646499bA961Ecdfb989d4b716A4A5E3fb7abd56` |
| Token | `0xf56AA3aCedDf88Ab12E494d0B96DA3C09a5d264e` |
| Spender | `0xE931aEA27eB107Afa909152F8Ee854538030d229` |
| Original approval request | `ec66d879f33a6952fc7576c87c65f961` |
| Original approval hash | `0xbb469fed05bcbc91f8e350bd6b494feeebc3a0c8959e8cd629d254e2a3294623` |
| Original signed nonce | 10 |
| Replacement request | `58d8bc9320bed7c3b2b22778832ab7ac` |
| Replacement hash | `0x83bb17c9cfd641b7550d60172ff084daf2030cc1a70e4adbf85ce16a3a2d7917` |
| Replacement signed nonce | 10 |
| Replacement successful canonical block | 40984 |
| Replacement block hash | `0x47616bdca8a564b55a295f32fd72230d81c73d9d1940bc4e065f7f5b14c19f36` |
| Revocation request | `62e3a49c9b1df79133e4fb6e463291d8` |
| Revocation hash | `0xe3de3db7c31f3bcda61d2cacd7efb7516e00071095bf47704e105503a203f068` |
| Revocation signed nonce | 11 |
| Revocation successful canonical block | 41006 |
| Revocation block hash | `0xe77c894fd2a72c13bc5ec4507755f59f5382e660a7a3317e90ac17963363ffe0` |
| Latest / pending nonce before | 10 / 10 |
| Latest / pending nonce after | 12 / 12 |
| Allowance before / after replacement / after revocation | 0 / 7000000000000000000 / 0 atomic units |
| Preserved token balance | 10000000000000000000 atomic units |
| Final Wallet observation block | 41014 |
| Final Wallet observation block hash | `0x9a1e66be84357f0207e9ba4a1165e6035ab0bea41f3c4f26a044c36c0aefae16` |

The original and replacement retain the same signer, chain, nonce, token recipient, zero native value, access list and exact `approve(spender, 7e18)` calldata. The replacement fee fields equal twice the original fields plus one wei, matching the explicit review inputs. Their hashes differ. The replacement's saved pending transaction reconstructs to the same raw bytes as its successful mined transaction. The original remained without a receipt after replacement inclusion; this was checked by the passing test and independently saved in lane-postflight.json before lane release.

`offline-evidence-check.json` independently reconstructs the original signed raw bytes from its saved complete pending RPC fields and checks the original hash. It decodes the replacement and revocation raw bytes, recomputes their hashes, recovers the Wallet signer, checks low-S signatures and compares chain, nonce, value, calldata and receipt identities. Canonical receipt block hashes and transaction membership were verified against the actual node by the passing execution's `chain.evidence()` helper; offline assembly performs no new RPC.

## Wallet behavior and state observations

The passing executed assertions show that both the pending original and pending replacement are absent from Known Approvals. After canonical inclusion, Activity shows the replacement confirmed and original replaced. A page reload reconstructs the token/spender from durable Wallet history, and Known Approvals observes 7e18 at the replacement block. The review displays the token balance, current allowance and decrease to zero, and refreshes token evidence before the explicit revocation approval. Request IDs are saved in checkpoints before approval, followed by their returned hashes.

The revocation executes exact `approve(spender, 0)` at nonce11. The test asserts latest nonce12, allowance0 and unchanged token balance10e18. Its final Wallet observation is checked with `eth_call` at the exact UI-displayed block 41014, yielding zero; it is not assumed to equal the earlier revocation receipt block. The separate lane-postflight.json, recorded at 2026-09-06T13:53:30.600481+00:00 immediately before lane release, directly confirms latest and pending nonce12, original receipt null, and mining mode autominingfalse / interval1. Its saved token allowance, balance and UI block match the completed checkpoints; these fields are not misrepresented as additional fresh RPC reads.

This full fixture test intentionally funds the local Wallet, deploys and mints its dedicated token, temporarily pauses both mining modes and explicitly mines the replacement. It then verifies restoration of the original autominingfalse / interval1 mode before revocation, with no later mining-control mutation. The unforked Anvil fixture does not qualify Nitro sequencing, parent posting costs or L1 finality.

## Preservation and scope

Earlier EVM106 replacement failures and explicit cleanup runs remain preserved in their separate folders. This passing EVM107 run qualifies the complete replacement flow; it does not relabel those failures. Original preflight, executed source, report, trace and checkpoints were not modified. PNG attachments and JSON chain evidence were extracted verbatim. The artifact index excludes itself.

All validation/index preparation was offline. No browser, RPC, signing, transaction submission, funding, deployment, mining, routing, runtime or product/source changes occurred while assembling this evidence. These are saved-run observations, not claims about later chain state.
