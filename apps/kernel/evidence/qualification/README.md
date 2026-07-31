# Certified Assets qualification

This directory owns the generic runtime qualification for the Kernel's three
closed Certified Assets collection kinds. It must not import or name a real
application.

`certified-assets-candidate-binding.json` is only a deterministic input
binding. It identifies one synthetic Motoko source, the exact ordered set of
five generated neutral manifests, every non-test runner, packaging, and local
provisioning source it executes, generic implementation sources, and the
measurement profile. The set is one 256-entry bounded physical scope, one
full-behavior scope, and three tiny stage probes. It is not a test result and
must validate against current source before a release run. Normal Kernel builds
and provisioning neither consume it nor ship it in the Kernel package.

The implementation fingerprint covers the complete precompile Kernel backend,
manifest, memory lock, generated provider-support asset, and capability source.
It excludes only assembler-generated `backend/_neutron.mo`; compiler and tool
workspaces are bound by the independently recomputed compiler fingerprint.

A qualification evidence file is written only after the source-owned release
runner completes in a fresh isolated PocketIC instance. It owns
`127.0.0.2:8000` and never attaches to or stops the developer environment on
`127.0.0.1:8000`. It accepts no driver, replica, root-key, state-directory, or
evidence-import override.

The public qualification command runs the evidence worker in a private process
group and private temporary directory. It allows 170 seconds of work and has
an absolute 180-second command ceiling. The ordinary timeout terminates the
complete PocketIC process tree and removes that directory. The emergency
180-second watchdog guarantees process-tree termination but may leave its
isolated temporary directory for later operating-system cleanup.

From the repository root, freeze and check the candidate input before running:

```sh
npm --workspace neutron-kernel run certified-assets:candidate-binding:write
npm --workspace neutron-kernel run certified-assets:candidate-binding
npm --workspace neutron-kernel run certified-assets:qualify
```

The release runner first validates the checked binding input and executes the
fixed privileged Motoko and one-over manifest gates. It then packages the
current Kernel and all five generated neutral fixture manifests, compiles their
exact actor without the local compile cache, and binds the raw and gzip
transport Wasm plus compiler and assembler IDs. Inside its private PocketIC
environment the runner:

1. creates private ephemeral state at a bootstrap time exactly 60 seconds
   before `1735689600000000000` ns (2025-01-01T00:00:00Z), keeps automatic
   progress disabled, then explicitly sets and ticks to that fixed start;
2. runs the physical phase first: commits 256 one-byte records in 16 batches,
   advances exactly 24 hours plus 1 ns after the eighth receipt, reclaims those
   eight receipts in one bounded page, and rejects the 257th record without
   state drift;
3. normalizes the replica forward to host wall time, enables automatic
   progress, and only then crosses the raw-query and gateway boundaries;
4. records exact raw/gateway pairs for every fixed physical witness candidate
   and every gateway-enabled operational read;
5. executes all 12 operational cases once, using a fresh canister per case and
   all five scopes for the actor-wide cases, while
   bracketing calls with exact app-usage and allocator diagnostics;
6. verifies portable CORS through Chromium; and
7. proves same-Wasm upgrade persistence and hostile Range fail-closure.

The runner, not a generic byte collector, parses the typed replies and proves
every semantic assertion. The pass-only receipt records the manual clock
advance, wall-clock transition, gateway phase, raw/gateway pairs, exact
candidate, and source-owned gates. No waiver, synthetic pass, opaque nonempty
byte placeholder, or incomplete evidence is valid. The runner emits
`apps/kernel/certified-assets-qualification-receipt.json` only after a pass,
validates it against current source, and publishes it atomically only after
PocketIC and temporary-package cleanup succeeds. An absent or stale receipt is
not qualified.

The five scopes make cross-scope isolation and the actor-wide four-stage
boundary observable. Privileged retirement and corrupt allocator fail-closure
remain owned by the fixed source-bound Motoko gates rather than a nonexistent
public application method.

The bounded receipt is release-regression evidence. It proves the sampled
quota, receipt cleanup, resource counters, proof geometry, and lifecycle
behavior. The independent manifest gate rejects 100,001 entries against the
unchanged 100,000-entry production admission limit. It does not establish
cycle cost, proof size, allocator behavior, or upgrade safety at that
production ceiling.
