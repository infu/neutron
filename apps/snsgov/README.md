# SNS Governance

Explore, vote, and propose across every Service Nervous System on the Internet
Computer, from inside your own Neutron.

## What it does

- **Explore** every SNS with live stats, and drill into one for the full
  picture: parameters, treasuries, canister health, proposals, neurons.
- **Vote** with all of your eligible neurons at once, across many SNSes.
- **Propose**, including the DAO-registered custom proposal types that most
  real SNS governance actually runs on.
- **Expose agent tools** from a resident background, so an agent can research
  governance and draft proposals without a tile open.

## How it reaches the network

Every read is an **anonymous IC query made from the browser** — free, requiring
no capability, no reservation, and no approval. Only signed writes go through
the app backend, which is a thin relay that signs as this Neutron's canister
principal.

That canister principal is the "hotkey" you register on your SNS neurons, using
the NNS dapp or another tool. This app uses `Vote` and `SubmitProposal`; review
the authority and proposal costs in the selected SNS before enabling writes.
Agents vote only for SNSes enabled by the existing app policy. Proposal
submission and permission changes remain in the user interface.

## Development

Release 0.1.13 switches future updates to the Marketplace source
`sj2r4-haaaa-aaaay-aadgq-cai`. Upgrade using the state-preserving
[package update workflow](../../doc/package-updates.md); an older copy marked
**Manual** first needs this package installed over it. Existing configuration,
drafts and audit history are retained.

```sh
npm --workspace neutron-snsgov run package
npm --workspace neutron-snsgov test
```

The read half can be developed against real mainnet data from a local Neutron.
Write-path testing uses a separate local SNS; see
[`scripts/local-sns.md`](./scripts/local-sns.md) and `npm run verify:write-path`.
Research and old-repository build notes are kept outside this repository.

The import preserves the released `snsgov` memory schema and its existing
configuration, drafts, and audit history. It requires no Kernel changes.
Audit counters record IC replies received, including replies that contain SNS
command errors; they do not establish how many votes governance accepted.
The vote result decodes and reports each neuron's actual command outcome.

If proposal submission loses its reply, reconcile proposals before submitting
again. A confirmed submission whose local draft cleanup fails returns its
proposal ID and a cleanup warning. The tile hides that submitted draft for the
current session; after reload the retained draft can reappear. This release
does not add a durable submission journal or automatically resend proposals.
