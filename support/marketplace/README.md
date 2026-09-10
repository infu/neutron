# Marketplace protocol project

This folder currently contains specifications and reference material. The
canister implementation and deployment configuration have not been created.
Implementation work is tracked in [todo.marketplace.md](../../todo.marketplace.md).

The planned standalone Motoko canister combines marketplace and package-source
responsibilities with one internal database. Deployment uses `icp` CLI and
protocol tests use Ash with PocketIC. Its Neutron UI will be a separate app in
`apps/marketplace/`.

The protocol's original material is [all rights reserved](LICENSE). The Neutron
app will use the shared [standard NSAL 1.1](../../LICENSE.APP) packaging workflow.
Third-party references retain their accompanying licenses. Private database
configuration is excluded from Git; these specs describe protocol behavior.

## Specifications

- [Architecture, domains and browser authentication](spec/architecture.md)
- [Query-first access and caller-funded updates](spec/cycles-and-queries.md)
- [Purchase, withdrawal and ledger recovery](spec/ledger-flows.md)
- [Prices, acquisition records and rankings](spec/catalog-rankings.md)
- [Admin-assigned auditors and review stamps](spec/audits.md)
- [Certified HTTP package delivery](spec/certified-http.md)
- [Build, installation and upgrades with icp](spec/deployment.md)
- [Ash/PocketIC acceptance tests](spec/testing.md)
- [Upstream ledger references](spec/references/README.md)

These are implementation specifications, not claims of tested production
behavior. Business rules include fixed estimated cycle charges, one year of
developer-prepaid storage followed by operator-funded storage, enduring update
rights and no self-referrals. Remaining setup is the initial cost coefficients,
admin/auditor principals and burn-service accounts. Research scratch work remains
outside the repository.
