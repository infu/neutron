# OpenChat (Neutron app)

A sovereign Neutron client for the [OpenChat](https://oc.app) network. It lets
the Neutron owner — and the Neutron agent — sign in to OpenChat, read and send
direct messages, groups, and channels, search users, and join public groups and
communities. It is an independent client and is not affiliated with OpenChat
Labs.

This app is maintained in `apps/openchat`. Its existing browser database and
session keys are retained; it has no managed canister memory. Research from the
older repository is not part of this app import.

## How it works

- **Browser-direct, zero backend.** The app holds its own OpenChat delegation
  key in the resident background's IndexedDB and calls OpenChat's mainnet
  canisters directly with `@dfinity/agent` — the `apps/wagyu`/`apps/blast`
  pattern. There are **no Neutron backend calls or kernel per-call dialogs**.
  While signed in, the engine polls chat state in the browser. The
  Motoko backend is an empty, state-free module.
- **One engine, two consumers.** The resident (`src/service.ts`,
  `src/engine/`, `src/oc/`) is the only surface that talks to OpenChat. The tile
  UI (`src/tile/`) and the Neutron agent both drive it through the same
  message-bus tool surface (`src/tools/surface.ts`), so the agent can do
  everything the UI can — list chats, read, send, DM, search, join.
- **Email sign-in.** OpenChat mints accounts only through an allowlisted
  identity provider; in a no-popup sandbox, email is the one that works. A
  single non-extractable session key is delegated first by OpenChat's
  sign-in-with-email canister, then by its identity canister, yielding a
  self-signed OpenChat identity (30-day / 90-day delegation).
- **msgpack wire.** OpenChat's chat canisters are msgpack-only (no Candid); the
  client speaks their exact `rmp_serde(.with_struct_map())` shape via
  `@msgpack/msgpack`. The auth canisters that expose Candid are used through a
  small authored IDL (`src/oc/sie.ts`).

## Layout

```
backend/main.mo         empty, backend-free module
src/oc/                 OpenChat client: transport, msgpack, identity, canister clients, view mappers
src/engine/engine.ts    session + onboarding + bootstrap/poll + read/send/join orchestration
src/tools/surface.ts    the message-bus tool surface (UI + agent)
src/service.ts          resident entry
src/shared/             protocol (JSON view models, tool names) + tile RPC client
src/tile/               compact React UI (sign-in, chats, conversation, browse/join)
test/                   msgpack round-trip + manifest/tool tests
```

## Develop

Release 0.1.24 switches future updates to the Marketplace source
`sj2r4-haaaa-aaaay-aadgq-cai`. Upgrade using the state-preserving
[package update workflow](../../doc/package-updates.md); an older copy marked
**Manual** first needs this package installed over it. The existing browser
account session and storage are retained.

```sh
npm --workspace neutron-openchat run build     # esbuild + mogen
npm --workspace neutron-openchat test          # complete package + tests
npm --workspace neutron-openchat run package   # -> openchat.v<x>.neutron
npm --workspace neutron-openchat run verify:live # anonymous public directory queries
```

Because OpenChat lives on IC mainnet, the client always targets the mainnet
boundary (`https://icp-api.io`). Under local PocketIC the OpenChat canisters do
not exist locally, so live use requires the mainnet boundary (the resident CSP
in `public/service.html` already allows it).

## Build status — verified vs. remaining

Verified in this repo:

- Type-checks in the referenced graph (`tsc -b`), passes the Motoko security
  scan, and packages to a valid installable `.neutron`.
- `@msgpack/msgpack` round-trips the wire conventions the client relies on
  (name-keyed struct maps, externally-tagged enums, `bin` byte fields, exact
  u64 message ids, `Option::None` as nil). See `test/msgpack.test.ts`.
- The manifest is a valid backend-free resident+tiles app; the agent tool set
  mirrors the UI actions. See `test/package.test.ts`.

Remaining live bring-up (needs a browser, a real email inbox, and a running
Neutron — cannot be exercised from a headless build):

- End-to-end email onboarding against OpenChat mainnet and the exact
  field-level shapes of the chat read/write msgpack payloads. The request
  encodings and the delegation flow are implemented from OpenChat's own source,
  but the import tests do not authenticate an account or send mainnet messages.
- Initial registration uses OpenChat's default local user index. After sign-in,
  the app reads the assigned index from the user's initial state; joining a
  group or community discovers the target's local index.

## Import regression checks

The 0.1.22 import fixes session restoration racing sign-out, messages addressed
to the first fuzzy username match, stale chat drafts crossing recipients, and
protocol errors being presented as empty data. Storage writes now wait for
transaction commit, and fallback keys, sessions, and deletions move together
when IndexedDB becomes available. The existing database name, version, store,
and record keys remain unchanged.

`npm test` runs package validation, wire/engine/storage/tool tests, and Chromium
UI workflows at narrow and wide tile sizes. `verify:live` only queries the public
group and community directories. Tests use controlled replies for account
login and messages; they do not send emails or messages to production.

## License

Apache-2.0 (a deliberate permissive exception, like `apps/gemma`). This app
interoperates with the AGPL-3.0 OpenChat project and reuses interface facts
from it, but contains no copied OpenChat source. The import retains this explicit
existing exception; see the app-local `LICENSE` and `NOTICE`.
