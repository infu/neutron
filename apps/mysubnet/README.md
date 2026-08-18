# My Subnet

My Subnet is a live, self-contained Earth globe for Neutron. It discovers the
subnet hosting the current Neutron canister, reads that subnet's node
membership, and resolves every node to the GPS coordinates recorded by the NNS
Registry.

The frontend uses anonymous IC calls only. Subnet membership comes from the
IC's certified state tree through Agent JS. Location metadata follows the
Registry's public record chain:

```text
node -> node operator -> data center -> GPS
```

No app backend state, management-canister access, HTTP data API, API key, or
owner-approved backend-call reservation is required.

Subnet identity and membership are verified from the IC state tree. Registry
location lookups are anonymous signed queries, pinned to one Registry version;
the GPS values are NNS-governed administrative metadata rather than physical
attestations. Markers for nodes in the same data center are spread by a fraction
of a degree so each one remains visually distinct, while the underlying data
retains the recorded coordinates.

Protocol references:

- https://docs.internetcomputer.org/references/ic-interface-spec/
- https://docs.internetcomputer.org/references/system-canisters/
- https://github.com/dfinity/ic/blob/eb55873567bcda6cdcf3c0a573d4db13daaa2c8e/rs/registry/transport/proto/ic_registry_transport/pb/v1/transport.proto
- https://github.com/dfinity/ic/blob/eb55873567bcda6cdcf3c0a573d4db13daaa2c8e/rs/protobuf/def/registry/node/v1/node.proto
- https://github.com/dfinity/ic/blob/eb55873567bcda6cdcf3c0a573d4db13daaa2c8e/rs/protobuf/def/registry/node_operator/v1/node_operator.proto
- https://github.com/dfinity/ic/blob/eb55873567bcda6cdcf3c0a573d4db13daaa2c8e/rs/protobuf/def/registry/dc/v1/dc.proto

## Updating Upstream Material

The app does not download GitHub content at runtime. The following upstream
material is reviewed at development time and then bundled into the Neutron
package.

### Earth coastline

`src/land-110m.json` is the `land-110m.json` topology from the public-domain
Natural Earth dataset, distributed by `world-atlas`:

- project and release history: https://github.com/topojson/world-atlas
- currently pinned artifact: https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json
- upstream dataset and terms: https://www.naturalearthdata.com/about/terms-of-use/

To update it, select and review a specific `world-atlas` release rather than
copying an unpinned development branch, replace `src/land-110m.json`, and verify
that the TopoJSON object remains named `land` with the same topology structure
consumed by `src/world.ts`.

### NNS Registry wire definitions

`src/registry.ts` contains a small protobuf reader based on these authoritative
IC definitions. The reviewed snapshot is DFINITY `ic` revision
`eb55873567bcda6cdcf3c0a573d4db13daaa2c8e`:

- Registry request and response fields:
  https://github.com/dfinity/ic/blob/eb55873567bcda6cdcf3c0a573d4db13daaa2c8e/rs/registry/transport/proto/ic_registry_transport/pb/v1/transport.proto
- Registry key prefixes:
  https://github.com/dfinity/ic/blob/eb55873567bcda6cdcf3c0a573d4db13daaa2c8e/rs/registry/keys/src/lib.rs
- `NodeRecord.node_operator_id`:
  https://github.com/dfinity/ic/blob/eb55873567bcda6cdcf3c0a573d4db13daaa2c8e/rs/protobuf/def/registry/node/v1/node.proto
- `NodeOperatorRecord.node_provider_principal_id` and `dc_id`:
  https://github.com/dfinity/ic/blob/eb55873567bcda6cdcf3c0a573d4db13daaa2c8e/rs/protobuf/def/registry/node_operator/v1/node_operator.proto
- `DataCenterRecord` and nested `Gps`:
  https://github.com/dfinity/ic/blob/eb55873567bcda6cdcf3c0a573d4db13daaa2c8e/rs/protobuf/def/registry/dc/v1/dc.proto

The transport and Registry-key files inherit the Internet Computer Community
Source License 1.0 through `rs/registry/LICENSE`. The three record-definition
files inherit the repository-root Apache-2.0 license. Exact source SHA-256
values and local copies of both upstream licenses are in
`THIRD_PARTY_NOTICES.md`. No upstream implementation or schema file is bundled
in this app; `src/registry.ts` is a local reader of the documented wire fields.

Protobuf changes should normally be additive, but review these definitions when
upgrading Agent JS or when Registry decoding starts returning partial nodes.
Select a new immutable DFINITY revision, confirm the field numbers used by
`src/registry.ts`, refresh the recorded hashes and license inheritance, update
the decoder and fixtures if necessary, and then run:

```sh
npm run typecheck
npm test
```

## Controls

- Drag or swipe: rotate the globe
- Arrow keys: rotate while the globe is focused

Automatic rotation pauses while the user is interacting and resumes shortly
afterward. It stays disabled when the browser requests reduced motion. Live
topology refreshes automatically every five minutes; there is no manual refresh
control.

## Development

From this directory:

```sh
npm run typecheck
npm test
```

The final artifact is `mysubnet.v0.3.4.neutron`.
