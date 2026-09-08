# Local SNS write verification

Run from the repository root:

```sh
npm --workspace neutron-snsgov run verify:write-path
```

The script starts the repository's pinned PocketIC binary on an available
control port and creates an isolated instance with the SNS fixtures. It obtains
the genuine governance Wasm from SNS-W, installs a test governance canister with
one neuron and proposal, and submits the app's encoded vote. Assertions require
the ballot and tally to change and a second vote to return the expected
already-voted outcome. The instance and owned server are cleaned up in `finally`.
No production canisters, messages, or funds are involved.

To use an existing local PocketIC control server, set `SNSGOV_POCKETIC` to its
URL. The script still creates and deletes its own instance and leaves that
server running.

This verifies the governance wire encoding and response handling. It does not
install Neutron, test the owner's production neuron permissions, or exercise
the Kernel's approval UI. Those are separate from the app's unit, browser,
managed-memory, and package compilation checks.
