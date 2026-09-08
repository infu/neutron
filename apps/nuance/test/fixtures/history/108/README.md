These are immutable memory-lineage fixtures extracted from the Nuance 0.1.8
archive imported with the old app. They establish compatibility with that
predecessor package; they are not independent evidence of what is installed on
a production canister.

The original `nuance.v0.1.8.neutron` archive was 853,723 bytes, with SHA-256
`eaaa0c2d83c94ef96d134f63247fd123f75432a44282c4d8d706348cc69ddc87`.
The fixtures retain its exact manifest, memory lock, and the complete closures
of both declared schemas and the v1-to-v2 migration. No application backend or
frontend is needed to verify this memory contract.

Do not regenerate these fixtures from the current app. The v1 planner test
projects an installation holding the declared v1 schema from this archive; it
does not claim to reproduce an independently recovered older app release.
