# IC Wallet Ethereum withdrawal browser review

The fixture bundles the actual `WalletEthereumWithdrawal` component, withdrawal controller, quote parser, amount formatting, shared EVM Wallet client and Wallet stylesheet. Only Kernel self-calls and the message-bus transport are mocked; no network transaction, canister install, app packaging or publication occurs. The full `index.tsx` integration was inspected separately and was not mounted by this component fixture.

`node /tmp/neutron-ckwithdraw-ui-browser/qualify.mjs` passes 14 recorded checks at 1440×900 and 375×900 with no browser errors or remaining fixture failures.

Verified at both sizes and for both EVM Wallet and direct Ethereum destinations:

- EVM Wallet address is loaded by the real SDK and displayed by default.
- Direct address mode needs no Contacts record; malformed addresses keep submission disabled.
- Available balance, approval fee, Ethereum gas budget and valid amount enable Withdraw.
- Advanced details are collapsed initially.
- No prepare/resume call happens before clicking Withdraw.
- Clicking Withdraw prepares exactly the selected ledger/address/amount, and resumes the identical request ID once.
- Submitted progress is visible and the amount remains frozen.
- Supplying a confirmed journal row changes the form to Withdrawal complete with Done and the exact Etherscan transaction link, without another prepare/resume.
- Removing the acknowledged terminal row retains the visible completion.
- Document/form widths fit both viewports, and amount inputs remain usable.

Additional mobile checks verify direct address mode remains usable when the EVM account tool fails and that insufficient ckETH gas is clearly reported with Withdraw disabled.

The initial read found an amount-null quote mismatch between this form and the controller. The controller owner fixed this before the fixture bundled: route-only quotes are accepted while explicit quoted amounts must still match. The current fixture passes with the fix.

`index.tsx` integration observation resolved after review: Ethereum destination mode now lives in the parent, and the Contacts loader skips direct/EVM modes and ignores stale Contacts failures after switching views. The actual loader is covered by `ethereum_withdrawal_poll.test.ts`; the direct form does not depend on Contacts results or busy state.

Evidence: `report.json` and the associated screenshots in this directory.
