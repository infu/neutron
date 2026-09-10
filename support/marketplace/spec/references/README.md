# Ledger specification references

The [icrc](icrc/) directory contains unchanged selected files from
[DFINITY's ICRC repository](https://github.com/dfinity/ICRC-1/tree/5d670e54d9a58fbf472bf0a25f33743d60cfd0e6),
commit `5d670e54d9a58fbf472bf0a25f33743d60cfd0e6`, fetched 2026-09-10.
These third-party reference documents retain their [Apache-2.0 license](icrc/LICENSE).
They do not set the original protocol's [all-rights-reserved terms](../../LICENSE)
or the separate Neutron app's [standard NSAL license](../../../../LICENSE.APP).

| Reference | Used for |
|---|---|
| [ICRC-1](icrc/standards/ICRC-1/README.md) and [Candid](icrc/standards/ICRC-1/ICRC-1.did) | Accounts, token transfers, explicit fees and timestamped deduplication |
| [ICRC-2](icrc/standards/ICRC-2/README.md) and [Candid](icrc/standards/ICRC-2/ICRC-2.did) | Wallet allowance and marketplace collection using transferFrom |
| [ICRC-1 advisory](icrc/standards/ICRC-1/ADVISORY.md) and [ICRC-2 advisory](icrc/standards/ICRC-2/ADVISORY.md) | Non-normative atomicity, error and deduplication implementation guidance |
| [Account text encoding](icrc/standards/ICRC-1/TextualEncoding.md) | Correct account/subaccount representation |

[provenance.json](icrc/provenance.json) records upstream paths, exact bytes,
SHA-256 hashes and immutable source URLs. Keep these snapshots unchanged;
refreshing them is an explicit dependency/reference update. Some relative links
inside the upstream documents point to files outside this selected snapshot;
resolve those through the pinned upstream repository rather than rewriting it.

The protocol uses guaranteed-response ICRC-1/2 write calls and their returned
block numbers. It does not use ICRC-3, ledger/index searches or archive callbacks.
Test the configured ICP, ckBTC and ckUSDC ledgers' typed error and deduplication
semantics; caller-supplied transaction matches are not accepted as payment proof.
