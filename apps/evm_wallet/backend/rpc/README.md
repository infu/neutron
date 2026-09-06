# EVM observation JSON

Public EVM reads and transaction broadcast use the wallet's browser transport
in `src/browser_rpc.ts`. `src/browser_reads.ts` and `src/read_adapters.ts`
construct the wallet observations. The backend has no EVM RPC canister client
or duplicate fee estimator.

`Json.mo` parses browser observations used by `BrowserObservations.mo` and
`token/Evidence.mo`. It wraps pinned `json@1.4.0` to correct demonstrated library
behavior: UTF-16 surrogate escapes must be combined, duplicate object fields
must not give consumers different values, and serialized object keys need
escaping. It preserves arbitrary integer precision and rejects non-finite JSON
numbers. Quantity helpers distinguish Ethereum `QUANTITY` from padded `DATA`.

Run `bun test test/rpc.test.ts` from the app directory. The compiled Motoko tests
use fresh local PocketIC instances and cover exact quantities, absent versus
null fields, Unicode, duplicate fields, escaped keys, nested object and array
shapes, and complete large bytecode strings. They make no network RPC requests
or financial transactions.
