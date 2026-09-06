# EVM RPC adapter

`Client.Client(backend_calls).request(chainId, method, params)` returns
`async* { #ok : Text; #err : Text }`. `params` is a JSON array. Success is
normalized JSON for the result value, without a JSON-RPC envelope. Hex strings
stay quoted JSON, a pending receipt is `null`, and included receipts and
transactions remain Ethereum JSON objects with hexadecimal quantities.

The canister is `7hfb6-caaaa-aaaar-qadga-cai`. Wire types are pinned to
[`evm_rpc-v2.8.0/candid/evm_rpc.did`](https://raw.githubusercontent.com/dfinity/evm-rpc-canister/evm_rpc-v2.8.0/candid/evm_rpc.did).
That release is also pinned by Neutron's existing local chain fixtures.

## Released wire contract

The released `multi_request` implementation returns an **unquoted Text** for
string results: the official `multi_request_should_succeed` test asserts
`Ok("0x00112233")`. Its `RawJson` type is a transparent Rust `String`, so
structured objects and null results fail deserialization. It cannot serve as
this wallet's generic JSON adapter. See the released
[integration tests](https://github.com/dfinity/evm-rpc-canister/blob/evm_rpc-v2.8.0/tests/tests.rs)
and [`RawJson` definition](https://github.com/dfinity/evm-rpc-canister/blob/evm_rpc-v2.8.0/src/rpc_client/json/responses.rs).

The adapter therefore uses `request` for reads and performs provider consensus
itself. Although that method is deprecated upstream, its released contract
supports complete JSON results. It returns the **full JSON-RPC envelope**, as
asserted by `should_not_modify_json_rpc_request_from_request_endpoint`. Its
upstream transform canonicalizes JSON and removes headers for IC replica
consensus. See [`http.rs`](https://github.com/dfinity/evm-rpc-canister/blob/evm_rpc-v2.8.0/src/http.rs).

Each read contacts Alchemy, BlockPi, and PublicNode on Ethereum (1), Sepolia
(11155111), Arbitrum One (42161), Base (8453), or Optimism (10). Two independent
batches execute in sequence:

1. Obtain `requestCost` for each exact provider, payload, and response size.
2. After every quote succeeds, call `request` for each provider with its exact
   quoted cycle amount and unchanged Candid arguments.

The adapter validates JSON-RPC version `2.0`, response ID `1`, and exactly one
of `result` or `error`. It recursively sorts result object keys while preserving
array order, then requires all three provider results to agree. Any provider
error, malformed envelope, or disagreement returns an explicit error; there
is no fallback to a preferred provider. Agreement is provider agreement, not
an Ethereum light-client proof. Fresh `latest`/`pending` state can legitimately
differ between providers and is not silently made authoritative.

The exact backend-call reservations are `requestCost`, `request`,
`eth_sendRawTransactionCyclesCost`, and `eth_sendRawTransaction`. The Kernel
applies the installed owner's cycle settings. This adapter adds no independent
spending quota or invented cycle multiplier.

## Broadcast and larger replies

Broadcast continues to use typed `eth_sendRawTransaction`, whose upstream
transform normalizes hash and already-known replies from replicated sends
before comparing providers. A typed `Ok(null)` means accepted without a
returned hash; the wallet already computed and saved its hash. Nonce errors,
provider disagreement, malformed replies, and transport failures require
reconciliation against that saved hash. They do not establish definitive
rejection or successful mining and do not authorize signing a new transaction
with another nonce. The adapter never repeats broadcasts automatically.

Initial read response-size estimates follow the upstream typed methods:
block 24 KiB plus 2048 header bytes, receipt 700 plus 2048, fee history 512 plus
2048, logs 1024 plus 2048, and other methods 256 plus 2048. These are starting
estimates, not acceptance limits. The raw `request` endpoint does not retry
internally. On the documented `SysFatal` error containing `body exceeds size
limit`, known read methods increase the estimate and re-quote all providers.
The existing IC HTTPS maximum is 2,000,000 bytes. All other errors, including
`TooFewCycles`, remain errors; they do not imply an oversized response.
The specific size error is verified by upstream's
`should_retry_when_response_too_large` integration test.

## JSON and validation

`Json.mo` wraps pinned `json@1.4.0` to correct demonstrated library behavior:
UTF-16 surrogate escapes must be combined, duplicate object fields must not
give consumers different values, and serialized object keys need escaping.
The wrapper preserves arbitrary integer precision and rejects non-finite JSON
numbers. Quantity helpers keep Ethereum `QUANTITY` separate from padded `DATA`.

Run `bun test/actor_run.ts test/rpc_test.mo` from the app directory, or
`bun test test/rpc.test.ts`. Actual compiled Motoko runs in a fresh pinned
PocketIC 14 application instance. Tests cover complete released request
response envelopes, scalar/object/null results, nested key-order differences,
array-order disagreement, quote and paid batch matching, no paid calls after a
quote failure, provider errors, invalid versions/IDs/result-error shapes,
response-size growth, typed broadcast uncertainty, and exact JSON handling.
The instance is removed afterward; the tests send no production transactions.

The backend's separate released-canister integration probe tests this adapter
against the actual pinned EVM RPC Wasm with mocked HTTPS provider responses.
That probe is necessary because locally invented Candid success fixtures alone
cannot establish the released service's JSON interpretation.
