# Local SNS protocol verification

Run from the repository root:

```sh
npm --workspace neutron-snsgov run verify:write-path
```

This focused integration gate starts the repository's pinned PocketIC binary on
an available control port and creates an isolated instance with the SNS feature.
It obtains genuine Governance and Ledger Wasms from that instance's SNS-W,
checks their SHA-256 against the requested SNS-W versions, and installs a local
SNS fixture. No production canisters, messages, or funds are involved.

Two small forwarding canisters own the fixture neurons. Commands therefore
reach Governance with an actual canister principal as caller, just as Neutron
would, rather than an anonymous user identity. The app's production staking
subaccount helper, proposal-action builder and ManageNeuron encoders construct
the requests. The fixture uses the generated upstream Governance and Ledger
Candid definitions; it does not replace their execution with mocks.

## Executed coverage

The gate checks resulting governance state and, for staking, splitting,
disbursement and maturity payouts, the genuine ledger balances:

- Transfer stake to the account derived from the Neutron principal and nonce;
  claim it and refresh the same claim without funding again.
- Increase dissolve delay, start and stop dissolving, set the absolute dissolve
  timestamp, and enable automatic maturity staking.
- Add and remove shared voting/proposal permissions; hand all permissions to the
  second canister and verify the former controller can no longer configure it.
- Set legacy function-based and topic-based following.
- Split stake into the derived child neuron, then fully disburse the child and
  partially disburse the parent after the local clock advances past dissolution.
- Stake maturity and queue a maturity withdrawal. Advance the local clock by
  eight days, allow Governance's timer to finalize it, and verify the actual
  ledger mint and payout balance.
- Submit, adopt and execute Motion, metadata, governance-parameter, custom
  function registration, custom function execution, custom topic assignment,
  and custom function removal proposals.
- Exercise a real custom validator and target: accept and render an exact Candid
  payload, execute it, reject an invalid payload, and reject later use of the
  removed function.
- Verify duplicate-vote handling, an uncast vote accepted after adoption but
  before the voting deadline, the stricter critical-proposal threshold, and an
  uncast vote rejected after the deadline.

The script prints each successful check and a JSON evidence summary containing
Wasm versions and hashes. The proposal-action unit tests separately cover wire
round trips for every supported native action; those tests do not establish
execution of every action against a full SNS deployment.

## Reproducibility and scope

The successful local run on 2026-09-11 used:

| Artifact | SHA-256 |
| --- | --- |
| PocketIC 14.0.0 | `f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4` |
| SNS-W Governance Wasm, 1,695,732 bytes | `d41e8cd08a2161e56cc6f4eb99733c9a46a38b98d3f40ce80e444dc33c5580ad` |
| SNS-W Ledger Wasm, 682,971 bytes | `354dd6ecfdc72b5409805b31dea22c9db11df6e14095a5a68924eb63535e6d8a` |

SNS-W fixture versions may change with a future PocketIC release. Each run
verifies and reports its actual Wasm hashes; the historical hashes above are
coverage evidence, not a substitute for checking new releases.

Initial stake and maturity are seeded deliberately. Maturity payout execution
is tested, while earning rewards through a real deployed SNS is not. The
fixture does not install SNS Root, Swap, Index or Archive canisters. Root-managed
upgrades, dapp settings, treasury actions, token mint proposals, native
extensions, archive traversal and cross-canister failure recovery are outside
this gate's execution coverage.

This does not install the full Neutron Kernel, exercise its approval UI, or test
application-journal persistence. Those remain separate app/browser,
managed-memory and journal checks. The temporary fixture canisters and the
owned server are cleaned up in `finally`, including after a failed assertion.

To use an existing local PocketIC control server, set `SNSGOV_POCKETIC` to its
URL. The script still creates and deletes only its own instance and leaves that
server running.
