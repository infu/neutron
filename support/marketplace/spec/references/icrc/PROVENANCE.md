# Pinned ICRC references

Exact, unmodified source files copied from [dfinity/ICRC-1](https://github.com/dfinity/ICRC-1) commit `5d670e54d9a58fbf472bf0a25f33743d60cfd0e6` (2026-05-11), retrieved 2026-09-10. `provenance.json` records source URLs, byte lengths and SHA-256 values.

These third-party files retain the upstream Apache License 2.0 in `LICENSE`, including its DFINITY Foundation copyright notice. They are reference material, not relicensed as Neutron app source. No upstream NOTICE file was present. Files under `standards/` are unmodified; this provenance document and manifest are local additions.

Included: accepted ICRC-1/2/3 specifications and Candid interfaces; ICRC-1 account text encoding; non-normative ICRC-1/2 advisories; ICRC-3 representation-independent hashing and test vectors. The ICRC-3 README itself defines the `1xfer`, `2xfer`, `2approve`, `1mint`, and `1burn` transaction schemas and legacy `tx.op` fallback. No separate transaction schema download is needed. A decoder must give `btype` precedence over legacy `tx.op` and preserve raw generic Value data needed for hashes.

The two ADVISORY files explicitly describe error atomicity and transaction deduplication expectations; they do not amend normative standards. Verify the selected production ledgers' actual interface and behavior rather than assuming all optional capabilities or stronger guarantees.
