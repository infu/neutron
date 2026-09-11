# SNS Governance

Follow proposals across Internet Computer SNS communities, stake governance
tokens, manage neurons and vote from your Neutron. The same operations are
available to agents. This app manages existing SNSes; it does not launch one.

## Using the app

The **Feed** combines proposals across SNSes. Open a proposal to review its
purpose, voting thresholds, tally and outcome. Vote Yes or No with every eligible
neuron, or choose a subset. Shared neurons participate alongside neurons managed
by your Neutron. Eligibility comes from each proposal's actual ballots and your
Neutron's current permissions. A decided proposal can still accept votes until
its voting deadline; decision status and reward voting are shown separately.

Use the feed's filter button to select communities, select all, or hide specific
SNSes. This browser remembers the selection. Only communities with a successful
governance read appear in the picker; confirmed stopped, empty or out-of-cycles
canisters stay out. Refresh checks for recovered communities. Temporary read
failures retain a compact retry control. Proposal cards render Markdown without
embedded HTML, with bounded headings and expandable summaries.

**My neurons** brings staking, lock settings, following, maturity, permissions
and withdrawals together. Common actions use labeled forms and token amounts;
Candid fields, identifiers and less common options are in advanced details.
**Explore** retains each community's parameters, treasury information, custom
functions and canister details. **Activity** keeps original requests and their
outcomes so an interruption does not require starting the action again.

SNS neurons have principal permission lists, rather than a permanent owner
field. A new stake uses a governance-owned ledger account whose subaccount is
derived from the Neutron principal and a retained nonce. Claiming grants that
Neutron the SNS's current claimer permissions. The app displays the actual
capabilities: a shared voting grant does not imply permission to withdraw funds
or transfer control. Transferring control grants access to the recipient before
removing the selected Neutron permissions; it does not move the staking account.

## Protocol and agent tools

The bundled interface and action catalog were checked against
[dfinity/ic 605a5396](https://github.com/dfinity/ic/tree/605a5396f12536e4e7b30479397e196c71b18961/rs/sns).
Installed SNS versions and live governance parameters remain authoritative.

- Discovery and reads cover proposals, complete/paginated neuron inventories,
  permissions, topics, custom functions, parameters and upgrade diagnostics.
- Management covers every valid bundled `manage_neuron` command: configuration,
  voting, proposals, following by function/topic, claim/refresh, split,
  disbursement, maturity and principal permissions.
- Proposal schemas cover all 19 valid native action variants, including custom
  function registration, execution, removal and topic assignment. The generic
  editor accepts lossless decimal integers, principal text, records, variants,
  optionals, vectors and exact blobs. Custom target methods may have zero, one
  or multiple Candid arguments.
- Public governance recovery operations have explicit reviewed, recorded paths.
  Interface support does not imply every SNS can execute an action: extension
  eligibility, framework versions, permissions and governance state still apply.

Use the schema tools to inspect a command, then a preview to read its precise
consequences. Execution tools save an `operationId`; retain it through
`status`/`continue` calls. Normal agents open an exact owner review. Root agents
use the Kernel's existing invocation-bound approval mechanism. They do not need
an additional SNS-specific agent opt-in. The old saved agent-voting preference
remains intact for compatibility with the legacy relay.

IC Wallet supplies token information, ledger registration and direct staking
transfers. Normal mode uses its existing funding review. Root staking starts
with the SNS tool's returned depth-zero preparation instruction, which binds the
actual Root caller. Its continuation returns the exact Wallet instruction; the
Root agent calls it and passes the original output to the SNS continuation. The original Wallet caller,
request ID, destination, amount, memo and deadline remain bound to that stake.
Changing a caller or inventing a new funding ID is not recovery.

## Queries, evidence and recovery

Public query reads run directly from the browser to SNS canisters. Signed
management writes use the Neutron backend to call as its canister principal and
retain replies. No SNS-specific Kernel change is required. A few protocol reads
are actually updates; their tool descriptions distinguish them from queries.

Custom validator preview uses a browser query only. An update-only,
caller-restricted or unavailable validator is reported as unavailable for that
preview. The SNS itself performs authoritative validation during submission.
The target's reply to a custom execution is not interpreted by SNS: an executed
proposal alone does not prove that a target application's business operation
succeeded. Check that application's result when relevant.

Governance can replace large custom payloads, Wasms and upgrade arguments with
summaries in public proposal reads. The app distinguishes original bytes from
summarized or omitted data. A rendered summary is not an executable payload;
use the preserved original draft or a verified source artifact.

The operation journal records exact command bytes before dispatch and preserves
raw replies afterwards. Concurrent continuation calls do not dispatch a saved
step twice. A confirmed reply remains available after reload or upgrade. If a
callback failed after a remote effect, the state remains unresolved; a matching
balance or absence of a neuron is not a generic transaction receipt. Only
commands with observable deterministic postconditions can be reconciled from
current state. Other unknown non-idempotent actions require further evidence.

Staking is a transfer followed by claim/refresh and any requested configuration.
A failed claim does not refund the transfer automatically. Recovery keeps the
same governance account, nonce and Wallet request. Wallet's original funding
deadline cannot simply be extended after an uncertain transfer. A failed SNS
step can be reviewed separately without paying the stake a second time.

Legacy audit counters describe received IC replies, including command errors;
they are not accepted-vote counts. New vote results distinguish accepted votes,
existing same/opposite ballots, failures and unattempted neurons.

## Development and durable state

The Marketplace update source remains `sj2r4-haaaa-aaaay-aadgq-cai`. Use the
[state-preserving package update workflow](../../doc/package-updates.md).
The released `snsgov` v1 schema, its dependency closure, configuration, drafts
and audit history are preserved. The independent `snsgov_operations` v1 root
stores new intents, steps and receipts. Upgrades initialize that new root while
keeping the existing root; no reinstall or fake v1 migration is required.

```sh
npm --workspace neutron-snsgov test
npm --workspace neutron-snsgov run verify:write-path
```

The test command runs the complete package build, unit/contract tests, isolated
browser suites and memory checks. The optional `SNSGOV_MAINNET=1 bun test
test/mainnet.integration.test.ts` command, run from this app's directory, also
qualifies live queries and custom validator queries without submitting actions.

Release tests include schema/codec cases, invocation authority, recovery,
managed-memory lineage, journal PocketIC tests and sandboxed browser fixtures.
The write-path verifier uses genuine SNS canisters in isolated PocketIC; see
[`scripts/local-sns.md`](./scripts/local-sns.md) for its precise coverage.
Local tests do not certify every deployed SNS version or every proposal target.
Research and implementation planning artifacts remain outside the repository.
