# Initialization arguments

`init.example.json` describes the public actor initialization record. It is a
template, not deployable production configuration. The admin and all unset fees
must be filled deliberately. The encoder rejects placeholders and missing fees.
No private keys belong in this file.

`admins` contains the actual authenticated principals authorized for protocol
administration. An existing direct CLI identity may be listed; existing canister
admin principals remain supported. Anonymous and management-canister principals
are not administrators. Selecting a CLI identity does not derive authority from
a different Neutron's principal. `auditors` similarly names explicitly assigned
reviewer principals. Neither role requires an administration UI.

Exactly four admin endpoints are exempt from caller cycle payments:
`admin_auditor_set`, `admin_reserve_app`, `admin_set_burn_account`, and
`rates_refresh`. They accept direct authenticated calls and retain the Candid
`feeVersion` field without charging or funding validation. Attached cycles are
left unaccepted. Admin status does not exempt ordinary purchases, uploads,
withdrawals, or publisher edits; those still use Neutron with attached cycles.

The three ledger and XRC principals are mainnet addresses. For local tests,
replace them with the corresponding disposable fixture canisters and use test
fee estimates. For production, read current ledger fees and use the reviewed
fixed protocol cycle estimates; this template does not set a production tariff.

`fees.application-subnet.json` provides the initial fixed estimate for a standard
application subnet. Copy it into the filled configuration's `fees` field after
review; it is never applied automatically. The per-byte annual estimate is
4,000 cycles: the published 127,000 cycles/GiB/second rate is about 3,730
cycles/byte for 365 days. Processing uses a 100M base plus 5,000 per encoded
request byte; purchases and withdrawals use a 100M base, and a source grant
uses 250M. These are rough prepaid charges, not measured refunds or dynamic
tariffs. Daily XRC requests attach its documented 1B cycles each.
([Cycle costs](https://docs.internetcomputer.org/references/cycle-costs/),
[XRC request costs](https://github.com/dfinity/exchange-rate-canister#usage))

This estimate is for a standard application subnet, not a larger fiduciary
subnet. The protocol keeps the installed coefficients fixed. The operator pays
ongoing storage after year one and must keep the canister funded; the coverage
timestamp never deletes an upload, package or entitlement. The marketplace app's
approved permission budget is 1T cycles per call and 10T per UTC day, separate
from these protocol charges and the sale token's ledger fees.

All natural numbers except token `decimals` are decimal strings, preserving exact
large values. A known forwarding account uses
`{"owner":"principal-text","subaccountHex":null}`; a non-default subaccount is
exactly 64 hex characters. Leave each `burnAccount` null until its address is
provided. A missing address must not silently select another recipient.

Keep filled configuration and encoded arguments outside Git. From this project:

```sh
npm run config:init -- --input /private/path/init.json --output /private/path/init.bin
icp canister install marketplace -e local --mode install --wasm build/marketplace.wasm --args-file /private/path/init.bin --args-format bin
```

The output is binary Candid, so `--args-format bin` is required. The command does
not create a canister or install anything. Its output file must not already exist.
Use the explicit upgrade workflow for existing canisters rather than replaying a
first installation.
