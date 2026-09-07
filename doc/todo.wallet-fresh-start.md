# Wallet fresh start and stable app identity

The owner is on Kernel 0.3.44 and explicitly chose to discard their old Wallet
account and start with a new address. Complete Wallet uninstall while still on
0.3.44, upgrade Kernel to 0.3.46, then install Wallet 0.1.19. Uninstall clears
Wallet data; it does not move assets or permissions from the old address.

This release always derives custody keys from the Neutron canister, app ID,
slot, algorithm and threshold key name. Later removal and reinstallation of the
same app and slot on that canister recovers the new address after permission is
granted again. It does not restore Wallet history, settings or decoder choices.

Kernel 0.3.46 keeps the installed 0.3.44 schema 4 and activation schema 1
directly, with the same memory declaration and lock. Its existing 3-to-4 upgrade
path remains available. Kernel and other apps keep their state. Wallet keeps
its three version-1 memory roots with no migrations or automatic clearing on
upgrade; the owner completes its ordinary uninstall before the cutover.

- [x] Confirm the installed Kernel version and intentional new-account choice.
- [x] Derive custody keys from the stable app ID and account slot.
- [x] Verify exact digest signing, assertion isolation, permissions, stale-cache
  invalidation and stable v2 identity across installation changes.
- [x] Keep the installed schema and lock; use package versions 346 and 119 with
  the production update source.
- [x] Finish lifecycle UI and documentation, including stale legacy accounts.
- [x] Test actual checked uninstall on 344, upgrade, fresh Wallet initialization,
  signing and repeated reinstall with exact candidate archives.
- [x] Test clean initialization and direct restoration of installed schema 4.
- [x] Pass complete package commands, release suites and Kernel qualification.
- [x] Review exact package bytes and matching offered source artifacts.
- [x] Publish both successors in one catalog transaction and verify the same-byte
  receipt-v2 no-op publication.
- [x] Update the existing pull request with the final design and release evidence.

Release evidence is retained under
`.neutron/release-receipts/custody-fresh-start-2026-09-07/`.

Published Kernel 346 and Wallet 119 atomically in catalog batch 68. The required
repeat publication returned `batch_id: null`; all 20 packages and offered sources
were unchanged and matched their local bytes. Both checked-actor scenarios
passed (241 assertions), alongside 761 Kernel tests, 33 current Motoko programs,
259 Wallet tests, both Wallet memory programs and 43 browser checks.

[Implementation PR](https://github.com/infu/neutron/pull/29).
