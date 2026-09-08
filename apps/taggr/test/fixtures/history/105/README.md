These are immutable memory-lineage fixtures extracted from the Taggr 0.1.5
archive imported with the old app. They establish compatibility with that
predecessor package; they are not independent evidence of what is installed on
a production canister.

The original `taggr.v0.1.5.neutron` archive was 700,801 bytes, with SHA-256
`86a4c894461054525151ded5f4391bb73ebc6a6e6098328041b56c0680800aa2`.
The fixtures retain its exact manifest, memory lock, and complete schema
closure: the one-module identity v1 root, with no dependencies or migrations.
No application backend, frontend, or account data is included.

Do not regenerate these fixtures from the current app. The identity schema is
the durable contract for preserving the owner's Taggr account key and settings.
