# Ethereum USDC checkout research

Reviewed 2026-09-10. The supported route is Ethereum mainnet USDC through the official subaccount deposit helper into a marketplace-owned ckUSDC invoice account. It needs no marketplace Ethereum custody key. This research did not send approvals, deposits, or other financial transactions.

## Runtime configuration

Anonymous public queries at `2026-09-10T16:32:44.830Z` returned:

| Item | Observed value |
| --- | --- |
| Official minter canister | `sv3dd-oaaaa-aaaar-qacoa-cai` |
| Subaccount deposit helper | `0x18901044688D3756C35Ed2b36D93e6a5B8e00E68` |
| Minter Ethereum account | `0xb25eA1D493B49a1DeD42aC5B1208cC618f9A9B80` |
| Ethereum USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| ckUSDC ledger | `xevnm-gaaaa-aaaar-qafnq-cai` |
| ckUSDC decimals | `6` |
| Ledger transfer fee | `10000` atoms, or `0.01 ckUSDC` |

These are dated observations, not promises that the helper or fee never changes. Discover the subaccount helper and minter account from the canonical minter's `get_minter_info`, verify the canonical token-to-ledger mapping, and save the chosen route with the invoice. Read the ledger fee for the quote. Do not switch an already submitted invoice to a newly discovered helper. The public canister registry and official Candid interface document the supported discovery surface. [Canister registry](https://docs.internetcomputer.org/references/chain-key-canister-ids/), [minter interface](https://github.com/dfinity/ic/blob/b75c0e59d0d6c1f8cd652f188eaf4f59dd41e83e/rs/ethereum/cketh/minter/cketh_minter.did).

## Destination and exact payment evidence

Call `depositErc20(address erc20Address, uint256 amount, bytes32 principal, bytes32 subaccount)` after any required bounded USDC approval. The principal word contains its raw byte length in byte zero, raw IC principal bytes next, and trailing zeros to 32 bytes. Use the marketplace principal and the invoice's exact 32-byte subaccount. The Ethereum payer may differ from the IC recipient; no EOA-only or same-owner requirement is imposed.

The helper transfers tokens from its caller to the minter, then emits `ReceivedEthOrErc20(address,address,uint256,bytes32,bytes32)`. Its indexed fields are token, payer, and principal; its data fields are amount and subaccount. Match the successful receipt's exact helper log against the saved invoice and retain the transaction hash and log index. For smart contract wallets, the helper's indexed payer can differ from the outer transaction sender. [Official helper contract](https://github.com/dfinity/ic/blob/b75c0e59d0d6c1f8cd652f188eaf4f59dd41e83e/rs/ethereum/cketh/minter/DepositHelperWithSubaccount.sol).

Independently verified mined payment and completed conversion are separate states. A submitted hash or approval is not a successful payment receipt. Early app delivery uses a verified successful mined transaction; it must not make unsettled developer, affiliate, or burn funds withdrawable. Mined receipts are not Ethereum finality. Reserve the exact event identity durably before granting ownership, and make entitlement finalization idempotent so the same payment cannot grant multiple purchases.

## Amounts, source checks, and conversion

The reviewed helper-deposit path has no USDC minimum. Its minting code transfers the event's full amount to the encoded beneficiary, without subtracting a mint fee. This supports a $1 listing; calculate USDC atoms using the retained ckUSDC pricing quote and add the current internal collection fee separately. The buyer also pays Ethereum approval/deposit gas.

The minter checks source addresses against its blocklist and can reject a deposit despite a successful helper transaction. Query `is_address_blocked` before submission and before relying on the source for early delivery; unavailable policy data is not an affirmative result. Minting runs asynchronously and retries failures. A mined helper receipt does not guarantee a mint has happened. [Minter deposit processing](https://github.com/dfinity/ic/blob/b75c0e59d0d6c1f8cd652f188eaf4f59dd41e83e/rs/ethereum/cketh/minter/src/deposit.rs).

The distinct `deposit_erc20` canister API registers addresses for exchange-style deposits. Its scan thresholds, registration fees, and sweep costs do not apply to the helper contract route above. Do not impose that route's approximately $10 collection threshold on marketplace purchases. [Official registration and sweep upgrade](https://github.com/dfinity/ic/blob/b75c0e59d0d6c1f8cd652f188eaf4f59dd41e83e/rs/ethereum/cketh/mainnet/minter_upgrade_2026_09_04.md).

## Settlement without ledger history

Observe `icrc1_balance_of({owner=marketplace; subaccount=invoice})`, then collect the quoted sale proceeds with a saved ICRC-1 transfer from that invoice to the treasury. The invoice pays that transfer's ledger fee. Preserve the existing guaranteed-response call and result-commit discipline; the exact successful sweep result triggers revenue allocation once. A zero balance is distinct from an unavailable balance response. [ICRC-1 balance and transfer contract](https://github.com/dfinity/ICRC-1/blob/main/standards/ICRC-1/README.md).

Balance alone shows funding of the unique invoice account, not Ethereum provenance. It is enough to proceed with settlement after the invoice's required amount arrives; early delivery separately uses authoritative Ethereum receipt evidence. Keep delayed or excess deposits associated with their original invoice. Do not create a second Ethereum deposit automatically to recover a pending conversion.

Neither ICRC-3 nor an index/history scan is required. The minter's global `get_events` endpoint is explicitly a debugging interface without backward compatibility guarantees, so it is not the settlement dependency. [Official interface comments](https://github.com/dfinity/ic/blob/b75c0e59d0d6c1f8cd652f188eaf4f59dd41e83e/rs/ethereum/cketh/minter/cketh_minter.did).

## Existing local implementation references

- `apps/wallet/src/ethereum.ts`: helper ABI, allowance handling, chain checks, helper verification, transaction preparation.
- `apps/wallet/backend/bridge/Journal.mo`: principal-word encoding and matching helper deposit fields. Its historical mint lookup is not needed by this marketplace flow.
- `apps/wallet/src/deposit_tools.ts`: the existing wrap tool deliberately targets the current Neutron's Wallet. It cannot be reused unchanged for a marketplace-owned recipient.
- `support/marketplace/mo/EvmMinter.mo`: typed minter queries, mapping/source validation, principal encoding, and exact invoice balance reads.
- `support/marketplace/mo/EvmEvidence.mo`: independent Ethereum receipt-to-invoice matching.
- `support/marketplace/mo/Ledger.mo`: guaranteed-response ICRC transfer adapter.

## Deployed EVM RPC verification

Anonymous `candid:service` metadata from `7hfb6-caaaa-aaaar-qadga-cai`
confirmed the typed receipt and block-number methods and their cycle-cost
queries. Its deployed interface does not include the newer upstream `batch`
endpoint. Use the inspected deployed interface, not a speculative API upgrade.

Receipt-by-hash and a canonical block-number lookup require no personal provider
credentials or historical account-state calls. The chosen built-in providers
are Ankr, PublicNode and Llama with equality consensus. Provider disagreement
leaves payment unverified. This relies on provider agreement rather than an
Ethereum light-client proof. [EVM RPC integration](https://docs.internetcomputer.org/concepts/chain-fusion/ethereum/).

Read-only cost queries on 2026-09-10 returned these estimates for the explicit
three-provider configuration:

| Response estimate | Quoted cycles |
| --- | ---: |
| Receipt, 8 KiB | 2,214,447,200 |
| Block, 16 KiB | 2,880,629,600 |
| Block, 128 KiB | 12,237,837,600 |
| Block, 256 KiB | 22,933,312,800 |

The block response includes transaction hashes, which can exceed 16 KiB in an
ordinary busy block. The implementation uses a fixed 50-billion-cycle allowance
split between a 5-billion receipt call and a 45-billion block call, with 256 KiB
estimated for the latter. These figures are estimates, not measured outcall
receipts, and do not cause automatic tariff changes. The adapter checks the
current required cost before dispatching within the saved budget. [Cycle costs](https://docs.internetcomputer.org/references/cycle-costs/).
