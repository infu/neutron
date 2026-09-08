These are immutable memory-lineage fixtures extracted from the SNS Governance
0.1.10 archive imported with the old app. They establish compatibility with
that predecessor package; they are not independent evidence of what is
installed on a production canister.

The original `snsgov.v0.1.10.neutron` archive was 1,048,302 bytes, with SHA-256
`a92113edfc69e369119ce8975aa2277e8dd8aadd36b35825e57ef21a192bfba2`.
The fixtures retain its exact manifest, memory lock, and complete schema
closure: the v1 root and all of its Map dependencies, totaling 15 modules.
No application backend or frontend is needed to verify this memory contract.

Do not regenerate these fixtures from the current app. Schema dependency bytes
are part of the preserved contract, even when the root schema file itself has
not changed.
