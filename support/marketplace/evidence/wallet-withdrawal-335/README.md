# Wallet ckERC20 gas review release

Wallet 0.3.35 fixes withdrawals rejected when the ckETH minter refreshes its
Ethereum gas estimate after Wallet has approved an exact ckETH allowance.
Quotes now distinguish the estimate from a maximum with 20% headroom, rounded
up to wei. The maximum is adjustable in the direct and contact withdrawal
forms. Execution allows price movement within the reviewed maximum, approves
that exact maximum, and never silently increases it. Token approval amounts
and the separate ledger approval fees remain exact.

The confirmed production failure approved 132281730360000 wei while the minter
required 135993271310000 wei. Its log reported `InsufficientAllowance` before
either burn. A separate attempt coincided with the minter's gas-refresh
`AlreadyProcessing` error. An accepted withdrawal was already successful on
Ethereum while the minter still returned `TxSent`.

Protocol research used DFINITY's [minter implementation](https://github.com/dfinity/ic/blob/c7dda50be7d34af1c40c68f3054bd96ea3660533/rs/ethereum/cketh/minter/src/main.rs),
[60-second gas-cache refresh](https://github.com/dfinity/ic/blob/c7dda50be7d34af1c40c68f3054bd96ea3660533/rs/ethereum/cketh/minter/src/tx/mod.rs),
and [ckERC20 withdrawal documentation](https://github.com/dfinity/ic/blob/c7dda50be7d34af1c40c68f3054bd96ea3660533/rs/ethereum/cketh/docs/ckerc20.adoc).
The minter chooses the charge; the client cannot supply gas price or priority
fee to `withdraw_erc20`. The allowance ceiling does not charge unused headroom.
On 2026-09-21, live queries reported a 0.01 ckUSDT approval fee and a 0.000002
ckETH approval fee. The 0.005 ckETH minimum is for `withdraw_eth`, not a USDT
withdrawal minimum or required ckETH gas balance. The reported 10–13 ckUSDT
amounts were above the token ledger's minimum burn amount.

Definitive gas rejections explain the required/available ckETH and charged
approval fees. Rejected requests remain visible until the owner opens their
receipt. A fresh-cost review retains the entered amount and destination, with
a new request created only on the next explicit withdrawal. Ambiguous outcomes
retain their exact original request and are never automatically resubmitted.
The submitted status preserves the minter-specific finalization explanation.
The gas estimate is no longer recorded as an actual debit; the gas ledger's
verified history supplies that amount.

All eight v1 memory roots and their lock lineage are unchanged. Existing saved
authorization and journal bytes retain their original spending limits. No
schema migration, canister reinstall, capability change or dependency change
is required. Clean initialization, representative nonempty restoration, and
released archive lineage through Wallet 0.3.34 passed.

Validation: complete workspace packaging, 344 unit tests, all 20 Motoko
programs, seven browser suites, memory checks and TypeScript compilation.
The focused backend fixtures exercise gas rising before approval and again
before burn, both inside and outside the reviewed ceiling. The real React
form tests adjustable gas, fresh review after rejection and lost-reply
recovery. Financial calls are fixtures; no production funds were spent.

Exact archive/source identities, file digests and checks are recorded in
[release-verification.json](./release-verification.json). The source and
package passed the publisher's [read-only review](./publication-review.json)
before publication. A transient response-verification Wasm error on the first
read-only review cleared on an identical retry; verification was not bypassed.

[Beta publication](./beta-publish.json) committed batch 28 and
[stable promotion](./stable-promote.json) committed batch 4, candidate 91.
The required repeat runs both returned `batch_id: null`, with exact package
and source identities unchanged: [beta](./beta-repeat.json),
[stable](./stable-repeat.json). The published archive is
[Wallet 0.3.35](../../../../apps/wallet/wallet.v0.3.35.neutron).
Existing Neutrons receive it through the state-preserving in-product update;
publication does not install it or change the Dispenser starter.
