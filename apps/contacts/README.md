# Contacts

Contacts V2 stores the owner's people and multi-network destinations in managed
Neutron backend memory. Its resident process exposes bounded message-bus tools,
and selected installed backend apps can use the read-only
`contacts_discover_v1` function through a declared dependency.

`Neutron address` is a dedicated destination containing the principal of
another person's Neutron canister. A contact may have at most one, and the same
principal may belong to only one contact. The backend maintains an exact index;
Mail binds recipient selection to the contact id, contact revision, book
revision, and principal. An exact Contacts match provides the local name shown
for an authenticated sender, but it is still owner-authored metadata rather
than proof that the remote canister runs official Neutron code.

The V1 payment discovery contract remains unchanged for Wallet. Mail and other
V2 consumers use the synchronous `contacts_neutron_lookup_v2`,
`contacts_neutron_search_v2`, and `contacts_neutron_revision_v2` dependency
functions, so they never need a second address book.

Contact names, labels, notes, and addresses are owner-authored data. A stored
address is not proof of identity or control. Apps that execute transactions
must validate the address for their own route and re-resolve contact and
address revisions immediately before execution.

The Contacts tile exposes the kernel-governed `prefill_new_contact` UI tool for
cross-app handoffs such as Mail's unknown-sender action. It validates the
suggested name and canonical Neutron canister principal, opens an unsaved
person draft, and never writes until the owner clicks Save. A current unsaved
edit is never replaced. Cross-app callers use the normal exact-tool kernel
approval; there is no app-specific permission bypass.

Build and package:

```sh
npm --workspace neutron-contacts test
```
