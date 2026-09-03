import { useEffect, useRef, useState, type ReactNode } from "react";
import { copyToClipboard } from "neutron-tools/app";

type CodeLanguage = "JSON" | "Motoko" | "TypeScript" | "TSX" | "SCSS";

type PageGuideContent = {
  benefit: string;
  flow: readonly [string, string, string];
  security: {
    enforced: string;
    authority: string;
    visibility: string;
  };
  example: {
    title: string;
    source: string;
    language: CodeLanguage;
    code: string;
  };
};

export const KITCHEN_GUIDE_IDS = [
  "overview",
  "public_ingress",
  "backend_calls",
  "https_outcalls",
  "randomness",
  "scheduled_tasks",
  "stable_store",
  "self_calls",
  "chain_key_signing",
  "vetkeys",
  "ethereum",
  "connections",
  "agent_entrypoints",
  "background_requests",
  "storage",
  "certified_reads",
  "certified_assets",
  "composition",
  "memory",
  "bus",
  "wallet_funding",
  "tray",
  "schemas",
  "data",
  "design",
] as const;

export type KitchenGuideId = (typeof KITCHEN_GUIDE_IDS)[number];

const GUIDES = {
  overview: {
    benefit:
      "Kitchen Sink is a map of Neutron's app-facing surface. Each demo uses the same scoped API an ordinary installed app receives, so it doubles as runnable documentation.",
    flow: [
      "The package manifest declares each capability and its hard limits.",
      "The compiler validates the declaration and injects only the selected backend leaves and function resources.",
      "At runtime, the kernel source-binds calls, applies live permissions, and dispatches to the real app implementation.",
    ],
    security: {
      enforced:
        "Declaration, compiler selection, installation identity, runtime toggles, and each broker's own limits are separate checks.",
      authority:
        "Kitchen Sink does not receive raw management-canister access or one universal authority handle; every backend leaf is explicit.",
      visibility:
        "This page is an index. Each capability page states whether its data is public, browser-local, replicated plaintext, or browser-decrypted.",
    },
    example: {
      title: "Select only the backend leaves the app uses",
      source: "backend/main.mo",
      language: "Motoko",
      code: `let randomness = env.capabilities.randomness;
let stableStore = env.capabilities.stable_store;
let certifiedAssets = env.capabilities.certified_assets;`,
    },
  },
  public_ingress: {
    benefit:
      "An app can receive a small, named public Candid protocol without publishing an ambient raw actor API. This is incoming authority, not permission to call another canister.",
    flow: [
      "The manifest maps one protocol and route id to an ordinary app handler with explicit mode and byte limits.",
      "The compiler emits a collision-proof physical endpoint on Neutron and preserves the real IC caller while validating the outer envelope.",
      "Only the declared logical handler runs; its Candid reply is bounded and returned in a closed success/error envelope.",
    ],
    security: {
      enforced:
        "App installation, protocol, route, query/update mode, caller class, request/reply bytes, and live route toggle.",
      authority:
        "The app cannot invent a route at runtime or impersonate the original caller. Kitchensink exposes only demo_v1:status.",
      visibility:
        "The route is public to its declared caller class: any, any non-anonymous principal, or canisters only. Neutron owner authorization is unrelated.",
    },
    example: {
      title: "Bind one logical route to one handler",
      source: "neutron.json",
      language: "JSON",
      code: `"routes": [{
  "protocol": "demo_v1",
  "id": "status",
  "handler": "public_status",
  "mode": "query",
  "caller": "any",
  "max_response_bytes": 4096
}]`,
    },
  },
  backend_calls: {
    benefit:
      "A backend can call one owner-reserved canister method and transfer a manifest-bounded cycle amount without receiving actor construction, arbitrary raw calls, or raw cycle primitives.",
    flow: [
      "The tile asks the kernel to reserve the exact target principal plus icrc1_fee method for this installation.",
      "The injected Motoko handle checks a matching reservation and the per-call/day cycle ceilings, then the kernel performs the inter-canister call as the Neutron canister.",
      "Kitchen Sink decodes the bounded reply as the expected Candid type and reports malformed replies as errors.",
    ],
    security: {
      enforced:
        "Exact reservation, source installation, target and method, argument/reply limits, concurrency, gross cycles per call, charged plus unresolved cycles per UTC day, low-balance reserve, runtime toggle, and post-await revocation.",
      authority:
        "The app cannot call Neutron itself, the management canister, anonymous targets, or a method outside an approved matching reservation.",
      visibility:
        "Arguments and replies are replicated canister data. A successful transport does not make the remote reply semantically trustworthy.",
    },
    example: {
      title: "Call through the exact reserved method",
      source: "backend/main.mo",
      language: "Motoko",
      code: `await* backendCalls.call({
  canister = target;
  method = "icrc1_fee";
  args = to_candid ();
  cycles = 1_000_000;
})`,
    },
  },
  https_outcalls: {
    benefit:
      "A backend can read one tightly bounded public HTTPS service without receiving arbitrary URL, transform, management-canister, or cycle-spending authority.",
    flow: [
      "App code selects the declared example endpoint and a canonical relative path.",
      "The kernel constructs the final HTTPS URL, validates method and headers, quotes cycles, and dispatches a replicated HTTPS outcall.",
      "A fixed transform strips response headers so replicas can agree, then the kernel bounds and releases the response.",
    ],
    security: {
      enforced:
        "URL prefix, methods, request headers, request/response bytes, calls, cycles, concurrency, transform, and revocation.",
      authority:
        "Kitchen Sink cannot redirect the request to another host, attach credentials or cycles freely, or choose its own transform.",
      visibility:
        "There is no confidentiality: subnet replicas can observe requests and responses, and the remote server may receive one request per replica.",
    },
    example: {
      title: "Use the compiler-injected endpoint handle",
      source: "backend/main.mo",
      language: "Motoko",
      code: `await* httpsOutcalls.request({
  endpoint = "example";
  method = #get;
  path = "";
  headers = [{ name = "accept"; value = "text/html" }];
  body = Text.encodeUtf8("");
  idempotency_key = null;
})`,
    },
  },
  randomness: {
    benefit:
      "The backend receives 32 fresh bytes from the IC random tape instead of deriving predictable values from time or counters.",
    flow: [
      "An update method asks its scoped randomness handle for one seed.",
      "The kernel admits and accounts for the request, then calls the IC management service; the value is resolved from a later round's random tape.",
      "The result is released only if the same app authority is still active. This demo renders it once as hexadecimal evidence.",
    ],
    security: {
      enforced:
        "Twelve accepted requests per anchored hour, one in flight, exact app scope, runtime toggle, and post-await revocation.",
      authority:
        "The app gets fresh bytes, not the management actor. For publicly auditable fairness, product logic still needs a commit-reveal design.",
      visibility:
        "The seed is unpredictable before generation but is not secret after the app receives, returns, logs, or stores it.",
    },
    example: {
      title: "Request one consensus seed",
      source: "backend/main.mo",
      language: "Motoko",
      code: `switch (await* randomness.fresh_bytes()) {
  case (#ok(bytes)) "0x" # hex(bytes);
  case (#err(error)) randomnessErrorText(error);
}`,
    },
  },
  scheduled_tasks: {
    benefit:
      "The kernel can run bounded recurring app work without an external cron service or an always-open tile.",
    flow: [
      "The manifest binds daily_tick to one internal callback and requests an initial run plus a one-day interval.",
      "After deployment commit, the kernel scheduler obtains a lease and invokes the exact callback with temporary task resources.",
      "The lease closes after completion; the next run is scheduled without overlapping the previous invocation.",
    ],
    security: {
      enforced:
        "Exact task id and handler, committed deployment, runtime toggle, lease, non-overlap, and task-specific backend-call allowance.",
      authority:
        "The callback cannot retain invocation-scoped resources after it returns, and V1 exposes no arbitrary run-now endpoint.",
      visibility:
        "The timer is approximate background execution, not real-time cron. Durable state records outcomes; the open page merely polls that marker.",
    },
    example: {
      title: "Implement the compiler-bound callback",
      source: "backend/main.mo",
      language: "Motoko",
      code: `public func /*internal*/scheduled_tick(
  (), taskCapabilities : TaskCapabilities,
) : async* () {
  ignore taskCapabilities.backend_calls.canister_principal;
  mem.scheduledRuns += 1;
};`,
    },
  },
  stable_store: {
    benefit:
      "Apps get bounded dynamic records, pagination, quotas, and compare-and-swap updates without handling stable-memory pointers or building a storage allocator.",
    flow: [
      "The compiler injects a leaf fixed to Kitchen Sink's notes store and current installation.",
      "The kernel validates the key, value, schema, quota, and expected revision before changing its ordered app namespace.",
      "A newer revision causes a conflict instead of silently losing another writer's update; prefix scans return bounded logical cursors.",
    ],
    security: {
      enforced:
        "App/install/store namespace, schema version, key/value sizes, entry and byte quotas, revisions, cursor binding, and uninstall cleanup.",
      authority:
        "The app receives CRUD/CAS operations, not maps, Regions, offsets, raw stable memory, or another app's namespace.",
      visibility:
        "Keys and values are plaintext to subnet replicas. Stable Store provides isolation and accounting, not encryption or HTTP certification.",
    },
    example: {
      title: "Replace only the revision that was read",
      source: "backend/main.mo",
      language: "Motoko",
      code: `stableStore.put({
  store = "notes";
  key = Text.encodeUtf8(key);
  value = Text.encodeUtf8(value);
  condition = #if_revision(revision);
})`,
    },
  },
  self_calls: {
    benefit:
      "Frequently used same-app methods can be approved with the package once, while sensitive or unusual methods continue to open a kernel review dialog.",
    flow: [
      "The installed manifest lists exact logical methods eligible for prompt-free calls from this same app.",
      "querySelf/updateSelf send a source-bound request; the kernel checks the current app, method, mode, and live Candid schema.",
      "A normal client.callDialog call follows the ordinary per-call review path instead, as the echo example demonstrates.",
    ],
    security: {
      enforced:
        "Exact source installation, logical method, query/update mode, installed preapproval, and current method schema.",
      authority:
        "Preapproval changes frontend consent only. It does not bypass backend caller checks or authorize other apps, canisters, or undeclared methods.",
      visibility:
        "Arguments still enter the replicated backend. Prompt-free is a UX property, not a confidentiality property.",
    },
    example: {
      title: "Choose the fast or reviewed route",
      source: "src/capability_lab.tsx",
      language: "TypeScript",
      code: `await querySelf("read_counter", [null], 20);

await client.callDialog(
  "echo",
  [message],
  60,
);`,
    },
  },
  chain_key_signing: {
    benefit:
      "An external system can verify that one exact Neutron app installation signed a statement without the app, browser, canister, or any single node holding a conventional private key.",
    flow: [
      "Kitchen Sink submits a fixed zero-value receipt to its declared receipt_assertions slot.",
      "The kernel derives an app/install/slot namespace, constructs a domain-separated digest, attaches cycles, and asks the IC threshold-signing service.",
      "The page validates the returned shape and authority binding, then displays the public key, digest, and 64-byte signature; it does not perform the external cryptographic verification itself.",
    ],
    security: {
      enforced:
        "Algorithm and key, derivation namespace, assertion size/rate, cycle budget, concurrency, runtime toggle, and post-await revocation.",
      authority:
        "V1 exposes no raw digest, transaction, child path, master-key name, cycle amount, or automatic retry. A signature proves provenance, not truth or human approval.",
      visibility:
        "Assertion bytes are visible to subnet replicas before hashing. Threshold custody protects the signing key, not assertion confidentiality.",
    },
    example: {
      title: "Sign one domain-separated app assertion",
      source: "backend/main.mo",
      language: "Motoko",
      code: `await* chainKeySigning.sign_assertion({
  slot = "receipt_assertions";
  assertion = Text.encodeUtf8(RECEIPT_ASSERTION);
})`,
    },
  },
  vetkeys: {
    benefit:
      "Public material can encrypt data for an app slot, while an authorized browser later recovers the exact derived key without storing a raw private key in the canister.",
    flow: [
      "The browser fetches the enabled slot generation's public binding and encrypts the short message locally.",
      "For recovery it creates a one-use transport key and completes a source-bound kernel challenge as a currently authorized Neutron principal.",
      "The subnet returns the derived VetKey encrypted to that transport key; the browser verifies it and decrypts locally.",
    ],
    security: {
      enforced:
        "Canister, kernel epoch, app installation, slot nonce, generation, authorized principal, live source, and one-use challenge are all bound.",
      authority:
        "Apps with the same slot name cannot collide. Rotation retains one explicit previous generation; retirement cannot erase a key already copied by a client.",
      visibility:
        "The backend stores no raw decryption key, but a compromised browser, controller-replaced frontend, or malicious owning app can capture future plaintext or recovered keys.",
    },
    example: {
      title: "Encrypt publicly, recover privately in the browser",
      source: "src/capability_lab.tsx",
      language: "TypeScript",
      code: `const info = await getVetKeyPublicKey({
  slot: slot.slot,
  generation: slot.currentGeneration,
});
const envelope = createVetKeyDemoEnvelope(info, message);
return recoverVetKeyDemoEnvelope(envelope);`,
    },
  },
  ethereum: {
    benefit:
      "A sandboxed tile can use an injected EIP-1193 wallet through a narrow proxy without receiving the browser extension object itself.",
    flow: [
      "A focused user gesture asks the kernel to connect an available wallet for this exact tile session.",
      "Kitchen Sink reads eth_chainId through the proxy and requires Ethereum mainnet before asking for accounts once.",
      "Every provider request is checked against the installed chain and method declaration; the wallet owns its own approval UI.",
    ],
    security: {
      enforced:
        "Transient activation, source endpoint, app installation/version, session lifetime, chain ids, method allowlist, and request schema.",
      authority:
        "Kitchen Sink declares no signing or transaction method. Connecting does not silently grant eth_sendTransaction or personal_sign.",
      visibility:
        "Requested account addresses become visible to this tile. The external wallet remains a separate trust boundary.",
    },
    example: {
      title: "Use only the declared provider subset",
      source: "src/capability_lab.tsx",
      language: "TypeScript",
      code: `const wallet = await connectEthereumProvider();
const chainId = await wallet.provider.request({
  method: "eth_chainId",
});`,
    },
  },
  connections: {
    benefit:
      "Apps can reuse a kernel-owned provider flow instead of implementing arbitrary authorization URLs, callbacks, token exchange, and durable connection records.",
    flow: [
      "The resident requests the exact declared OpenRouter connection; the kernel owns setup and consent.",
      "Only the declaring installation's background may acquire the credential after all scope and lifecycle checks pass.",
      "Kitchen Sink proves delivery with a boolean, returns only redacted metadata, and drops its reference immediately.",
    ],
    security: {
      enforced:
        "Exact app/install/background, provider, scopes, connection lifecycle, and post-await scope checks.",
      authority:
        "The tile and tool result never receive the credential. The authorized resident can use or disclose it, and discarding an immutable JavaScript string is not provable memory zeroization.",
      visibility:
        "Current provider credentials are replicated canister state, not end-to-end encrypted; subnet replicas, controllers, kernel code, and the provider are in the trust boundary.",
    },
    example: {
      title: "Acquire only inside the declared resident",
      source: "src/service.ts",
      language: "TypeScript",
      code: `const connection = await requestConnection({
  provider: "openrouter",
});
const sensitive = await acquireConnectionCredential(connection.provider);
try { delivered = sensitive.credential.length > 0; }
finally { sensitive.credential = ""; }`,
    },
  },
  agent_entrypoints: {
    benefit:
      "A user can temporarily delegate one exact resident tool entrypoint for bounded multi-step work without broadening the app's backend capabilities.",
    flow: [
      "Enable Agent Mode grants this app version and entrypoint temporary delegated invocation authority.",
      "The kernel creates an attenuated turn context containing cancellation, progress, the source endpoint, and bounded nested-call access.",
      "This deterministic demo makes exactly one source-bound tile_snapshot call; it does not contact a model.",
    ],
    security: {
      enforced:
        "Owner, app installation uid, version, exact entrypoint, live source, invocation lifetime, cancellation, and nested-call budget.",
      authority:
        "Delegation does not add backend calls, wallet methods, connections, or tools. Nested operations still pass their normal checks.",
      visibility:
        "The demo returns a bounded tile snapshot. A real model-backed agent would have an additional external-provider data boundary that must be disclosed separately.",
    },
    example: {
      title: "Use the attenuated invocation context",
      source: "src/service.ts",
      language: "TypeScript",
      code: `const tile = await context.kernel.callTool({
  target: requireOwnTile(context),
  name: "tile_snapshot",
  arguments: {},
}, 20);`,
    },
  },
  background_requests: {
    benefit:
      "A long-lived resident may ask the user for a normal UI-mediated operation even when no app tile initiated the workflow.",
    flow: [
      "The manifest declares which dialog categories the background is allowed to request.",
      "Kitchen Sink discovers a foreign read-only tool, then its resident asks the kernel to call that exact endpoint and tool.",
      "The kernel opens the ordinary owner review and applies the target tool's schema, source, cancellation, and permission rules.",
    ],
    security: {
      enforced:
        "Exact requesting background, declared category, target endpoint, tool schema/effects, cancellation, and ordinary nested consent.",
      authority:
        "This capability is permission to ask, never permission to self-approve. Same-app routes remain prompt-free by design.",
      visibility:
        "Data disclosed by an approved nested operation reaches the requesting resident and any further destination that operation explicitly uses.",
    },
    example: {
      title: "Ask the kernel to route one foreign tool",
      source: "src/service.ts",
      language: "TypeScript",
      code: `const result = await context.kernel.callTool({
  target,
  name: tool,
  arguments: {},
}, 60);`,
    },
  },
  storage: {
    benefit:
      "A resident can keep device-local browser data across tile closure and reloads on a stable origin that belongs only to this app installation.",
    flow: [
      "The kernel serves only the declared background on a nonce-prefixed, installation-specific same-origin host.",
      "The resident uses normal localStorage and exposes bounded source-checked read/write tools to its own tile.",
      "Compatible upgrades retain the origin; uninstall/reinstall creates a fresh nonce and therefore an empty, isolated browser store.",
    ],
    security: {
      enforced:
        "Current installation nonce, background surface, live capability toggle, source-bound tools, and opaque origins for tiles and tray pages.",
      authority:
        "Another app or a reinstalled copy cannot address this origin. Existing-document revocation, explicit quota, and orphan cleanup remain incomplete.",
      visibility:
        "localStorage is plaintext on this browser profile, not canister backup, encryption, or cross-device sync. Do not store secrets in this demo.",
    },
    example: {
      title: "Use ordinary storage only in the resident",
      source: "src/service.ts",
      language: "TypeScript",
      code: `const storage = requireBrowserStorage();
storage.setItem(STORAGE_KEY, value);
const saved = storage.getItem(STORAGE_KEY);`,
    },
  },
  certified_reads: {
    benefit:
      "Apps can expose install-reviewed certified collections without authoring a second HTTP route policy or controlling Neutron's global HTTP entrypoint.",
    flow: [
      "A publication collection synthesizes Host-bound GET/HEAD beneath its mount and a kernel-allocated opaque path.",
      "Immutable and mutable blob collections synthesize portable GET beneath their declared prefix or exact path.",
      "Each kind fixes its locator, methods, authority, cache/CORS/security headers, certified absence, and response geometry.",
    ],
    security: {
      enforced:
        "App installation, collection kind, mount, path shape, collection generation, synthesized response policy, and lifecycle state.",
      authority:
        "The app cannot select Hosts, methods, headers, statuses, certificate expressions, callbacks, or another scope. API-1 HTTP routes remain a separate POST-handler capability.",
      visibility:
        "Every served body is public plaintext. Certification proves its response came from the expected Neutron state; it does not prove the content is true.",
    },
    example: {
      title: "Select a closed collection kind",
      source: "neutron.json",
      language: "JSON",
      code: `{
  "id": "immutable_blob_demo",
  "mount": "blob_demo",
  "kind": "immutable_blob",
  "path_prefix": "/v1/immutable/"
}`,
    },
  },
  certified_assets: {
    benefit:
      "One scoped engine supports opaque publications, content-addressed immutable blobs, and revision-CAS mutable blobs without exposing raw certified-data authority.",
    flow: [
      "The publication fixture begins an ordered stage; the kernel allocates its opaque target, accepts the chunk, and commits it create-if-absent.",
      "The immutable fixture derives a SHA-256 target from an ordered stage, while the mutable fixture submits a Candid body inline with absent or exact revision/tag CAS.",
      "Each successful batch updates storage, quota, response ownership, idempotency receipt, and the shared certified root atomically.",
    ],
    security: {
      enforced:
        "Captured app/install scope, collection kind and generations, typed locator, staged or inline body, batch shape, CAS, quota, and idempotency nonce.",
      authority:
        "The app cannot call setCertifiedData, name another scope, invent a publication path, submit a raw URL, choose response policy, or clear one collection outside the scope lifecycle.",
      visibility:
        "Committed bytes, filenames, protocol keys, and Candid bodies are public plaintext. Stages and mutations consume bounded canister storage/cycles even when no browser fetch follows.",
    },
    example: {
      title: "Commit a kernel-allocated publication stage",
      source: "backend/main.mo",
      language: "Motoko",
      code: `certifiedAssets.commit_batch({
  nonce = commitNonce;
  operations = [#put({
    target = allocatedTarget;
    condition = #absent;
    body = #stage(stageId);
  })];
  requires_present_after = [];
})`,
    },
  },
  composition: {
    benefit:
      "Apps can depend on exact typed exports from another installed app while each backend function receives only the ordered resources it declares.",
    flow: [
      "The manifest requires Contacts 0.1.1 and one exact internal export; installation fails if that contract is missing.",
      "The compiler creates a narrow app_calls.contacts leaf and injects caller, canister principal, and Kitchen Sink memory in reviewed order.",
      "App code calls the typed function directly and cannot widen the target, export name, caller identity, or memory namespace.",
    ],
    security: {
      enforced:
        "Dependency app/version/export, generated Candid type, installation identity, function resource kind, and resource order fingerprint.",
      authority:
        "Kitchen Sink receives one Contacts function—not Contacts' actor—and only its own managed memory reference.",
      visibility:
        "These calls and resources execute inside the assembled Neutron actor. Their data has the same replicated-canister visibility as ordinary backend state.",
    },
    example: {
      title: "Call the one compiler-provided dependency leaf",
      source: "backend/main.mo",
      language: "Motoko",
      code: `let revision =
  appCalls.contacts.contacts_neutron_revision_v2(());

let ownCounter = kitchensinkMemory.counter;`,
    },
  },
  memory: {
    benefit:
      "Managed memory gives Motoko code typed durable app state with compiler-reviewed schemas and upgrade wiring, ideal for a small fixed data model.",
    flow: [
      "The manifest declares the kitchensink root and schema v1; the compiler creates and injects that exact Mem value.",
      "A reviewed frontend update calls save_profile, which validates bounds before changing typed fields.",
      "On compatible package upgrades the schema is retained or explicitly migrated; uninstall can clear the app root through the kernel lifecycle.",
    ],
    security: {
      enforced:
        "App-owned root, reviewed schema source/hash, declared migration graph, backend method authorization, and input bounds.",
      authority:
        "The app receives its Mem record, not another app's memory or a dynamic allocator. A tile cannot perform actor lifecycle operations itself.",
      visibility:
        "Values are replicated canister plaintext. Kernel call approval controls who invokes a method; it does not hide state from subnet execution.",
    },
    example: {
      title: "Write the compiler-injected typed record",
      source: "backend/main.mo",
      language: "Motoko",
      code: `public func save_profile(name : Text, email : Text) : Text {
  if (name.size() > 80) return "Name must be 80 characters or fewer";
  if (email.size() > 160) return "Email must be 160 characters or fewer";
  mem.profileName := name;
  mem.profileEmail := email;
  "Saved";
};`,
    },
  },
  bus: {
    benefit:
      "Live tiles, trays, residents, and agents can discover and invoke typed frontend tools without sharing window references or inventing a second RPC protocol.",
    flow: [
      "A surface exposes a named tool with bounded JSON input/output schemas and effect annotations.",
      "The caller discovers a live endpoint, then asks the kernel bus to route one exact tool invocation.",
      "The kernel validates source, target, schema, permission, timeout, cancellation, and result before resolving the call.",
    ],
    security: {
      enforced:
        "Unforgeable live endpoint registration, source context, tool schema, declared effects, permission policy, cancellation, and disconnect cleanup.",
      authority:
        "Same-app calls are prompt-free; cross-app calls use kernel consent. Tool availability does not automatically grant permission to invoke it.",
      visibility:
        "Arguments and results reach both participating frontend surfaces and the trusted kernel router, but do not enter backend state unless a tool sends them there.",
    },
    example: {
      title: "Expose and call one typed frontend tool",
      source: "src/index.tsx + platform_pages.tsx",
      language: "TypeScript",
      code: `exposeTool("tile_snapshot", descriptor, readSnapshot);

await bus.callTool({
  target: companion.endpoint,
  name: "tile_snapshot",
  arguments: {},
}, 30);`,
    },
  },
  wallet_funding: {
    benefit:
      "A swap or commerce app can ask the user's trusted Wallet for live token fee and balance information, then fund one exact action without reserving the ledger or asking for a second funding approval.",
    flow: [
      "The separate wallet_token_info_v1 demo asks Wallet for live ICP metadata, fee, and its fixed default-account balance without granting Kitchen Sink ledger access or joining the funding click. Kitchen Sink's resident separately prepares or reuses one persisted fixed ICP intent per rail before enabling that control; only an explicit warned discard/reset replaces unresolved or unreadable state. The user's click sends that exact saved intent to wallet_fund_v1.",
      "For funding, the Kernel authenticates and routes the request and opens or focuses Wallet without displaying a token approval dialog. The separate token-information read uses ordinary cross-app consent and does not open Wallet.",
      "Wallet reads authoritative ledger metadata and fees, shows its own token-aware modal, then transfers directly or creates an allowance that expires five minutes after the intent was prepared.",
    ],
    security: {
      enforced:
        "The Kernel source-binds Kitchen Sink and Wallet and validates both tool schemas. For funding it opens the exact Wallet tile; it routes but does not interpret or display ICP amounts, decimals, or fees.",
      authority:
        "Wallet owns the read and mutation reservations and execution. Token info is limited to a selected ledger and Wallet's default account. Kitchen Sink fixes the funding ledger, amount, and governance account and cannot spend Neutrinite governance's allowance or fall back to a ledger call.",
      visibility:
        "The intent and receipt traverse the trusted Kernel router, while the token-aware review is rendered inside Wallet. Ledger transfers and approvals are public replicated ledger state.",
    },
    example: {
      title: "Ask Wallet to prepare and execute one exact funding intent",
      source: "src/wallet_funding_demo.ts",
      language: "TypeScript",
      code: `await bus.callTool({
  target: "app:wallet:background",
  name: "wallet_fund_v1",
  arguments: {
    requestId,
    ledger: "ryjl3-tyaaa-aaaaa-aaaba-cai",
    amountAtoms: "1000000",
    validUntilNs,
    route: {
      kind: "allowance",
      spender: "eqsml-lyaaa-aaaaq-aacdq-cai",
      expiresAtNs,
    },
  },
}, 180);`,
    },
  },
  tray: {
    benefit:
      "A resident app can offer a lightweight, transient popout and optional live badge without keeping the full tile open.",
    flow: [
      "The resident owns a bounded eight-item snapshot and exposes same-app tools for reading and changing it.",
      "After a mutation it asks the kernel to update the badge and publishes an invalidation revision.",
      "Opening the tray mounts a fresh sandboxed popout, which fetches the current resident snapshot and rejects older in-flight revisions.",
    ],
    security: {
      enforced:
        "Only the exact owning background may set its badge; only the live tray may dismiss itself; same-app tool schemas bound every mutation.",
      authority:
        "Declaring a tray grants UI presence, not backend, notification, or cross-app authority. The popout is transient and credentialless.",
      visibility:
        "Demo items live only in resident JavaScript memory and reset when that resident restarts; they are not durable mail or notification records.",
    },
    example: {
      title: "Synchronize the kernel badge after a commit",
      source: "src/service.ts",
      language: "TypeScript",
      code: `await setTrayState({
  badge: unread > 0 ? unread : null,
});
await publishAppStateChange(TRAY_DEMO_TOPIC, revision);`,
    },
  },
  schemas: {
    benefit:
      "Apps and agents can inspect the installed Candid-derived shape of a method before encoding arguments or presenting a review UI.",
    flow: [
      "The page requests metadata for one logical installed method through the kernel message bus.",
      "The kernel looks up the active app method and returns its bounded schema derived during package assembly.",
      "The viewer renders that JSON; call dialogs and tools use the same contract when validating values.",
    ],
    security: {
      enforced:
        "Installed app/method lookup, bounded schema depth, closed transport shape, and normal source-bound bus routing.",
      authority:
        "A schema describes how to encode data. Reading it neither invokes the method nor grants permission to call it.",
      visibility:
        "Schemas are public package metadata, not secrets and not proof of business semantics. The implementation must still validate domain rules.",
    },
    example: {
      title: "Load the active method contract on demand",
      source: "src/index.tsx",
      language: "TypeScript",
      code: `const schema = await client.methodSchema(
  "save_profile",
  6,
);`,
    },
  },
  data: {
    benefit:
      "This visual stress fixture proves that long principals, hashes, copy controls, and nested JSON remain readable without stretching or breaking the app layout.",
    flow: [
      "The component builds hard-coded representative values; it does not query a capability or authority source.",
      "React renders the nested object as escaped text inside a contained preformatted block.",
      "Copy controls use an explicit user action and report clipboard success without changing the displayed value.",
    ],
    security: {
      enforced:
        "React text escaping, no innerHTML, bounded layout, wrapping/overflow containment, and user-initiated clipboard access.",
      authority:
        "The fixture principal, module hash, and backend_calls string are inert examples. They prove layout behavior, not identity, installation, or permission.",
      visibility:
        "Everything on this page is intentionally visible in the tile and clipboard when copied; no backend call occurs.",
    },
    example: {
      title: "Render dense values as escaped, contained text",
      source: "src/platform_pages.tsx",
      language: "TSX",
      code: `<CopyValue label="Fixture principal" value={principal} />
<pre className="nt-json">
  {JSON.stringify(nested, null, 2)}
</pre>`,
    },
  },
  design: {
    benefit:
      "The component gallery shows the shared Neutron visual language, keyboard patterns, and semantic action hierarchy an app can reuse without reimplementing controls.",
    flow: [
      "Kitchen Sink imports the versioned design-system stylesheet during its own build—no remote script or style is loaded.",
      "Components combine semantic nt-* classes with native HTML labels, buttons, fields, tabs, and disclosure state.",
      "The four panels are local visual fixtures; their sample actions do not call the kernel or mutate backend state.",
    ],
    security: {
      enforced:
        "Native semantics, visible focus, keyboard tab movement, escaped text, disabled states, and consistent danger/critical styling.",
      authority:
        "A red or critical button communicates intent but grants nothing. Real privileged actions must still enter trusted kernel review.",
      visibility:
        "Inputs and settings rows on this page are examples only and stay in component-local browser state.",
    },
    example: {
      title: "Reuse tokens and semantic component classes",
      source: "src/style.scss + platform_pages.tsx",
      language: "TSX",
      code: `<button className="nt-button">Primary</button>
<button className="nt-button nt-button--danger">
  Danger
</button>
<input className="nt-input" aria-invalid={hasError} />`,
    },
  },
} as const satisfies Record<KitchenGuideId, PageGuideContent>;

export function PageGuide({ id }: { id: KitchenGuideId }) {
  const guide = GUIDES[id];
  const headingId = `kitchen-guide-${id}`;
  return (
    <section
      aria-labelledby={headingId}
      className="ks-page-guide"
      data-tid={`kitchen-guide-${id}`}
    >
      <header className="ks-page-guide-header">
        <div>
          <p className="nt-eyebrow">Implementation guide</p>
          <h2 id={headingId}>Why use it</h2>
        </div>
        <span className="nt-tag">real app code</span>
      </header>
      <p className="ks-page-guide-benefit">{guide.benefit}</p>
      <div className="ks-page-guide-grid">
        <section className="ks-guide-flow" aria-labelledby={`${headingId}-flow`}>
          <h3 id={`${headingId}-flow`}>What really happens</h3>
          <ol>
            {guide.flow.map((step) => <li key={step}>{step}</li>)}
          </ol>
        </section>
        <CodeExample {...guide.example} />
      </div>
      <section className="ks-guide-security" aria-labelledby={`${headingId}-security`}>
        <h3 id={`${headingId}-security`}>Security boundary</h3>
        <dl>
          <div><dt>Kernel enforces</dt><dd>{guide.security.enforced}</dd></div>
          <div><dt>Authority limit</dt><dd>{guide.security.authority}</dd></div>
          <div><dt>Who can see it</dt><dd>{guide.security.visibility}</dd></div>
        </dl>
      </section>
    </section>
  );
}

function CodeExample({
  title,
  source,
  language,
  code,
}: PageGuideContent["example"]) {
  const [copyLabel, setCopyLabel] = useState("Copy");
  const resetTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const copy = () => {
    void copyToClipboard(code)
      .then(() => setCopyLabel("Copied"))
      .catch(() => setCopyLabel("Unavailable"))
      .finally(() => {
        if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
        resetTimer.current = window.setTimeout(() => {
          setCopyLabel("Copy");
          resetTimer.current = null;
        }, 1_800);
      });
  };

  return (
    <figure className="ks-code-example">
      <figcaption>
        <span><strong>{title}</strong><small>{source}</small></span>
        <span><code>{language}</code><button onClick={copy} type="button">{copyLabel}</button></span>
      </figcaption>
      <pre><code>{highlight(code)}</code></pre>
      <span aria-live="polite" className="nt-sr-only">
        {copyLabel === "Copy" ? "" : `Code example: ${copyLabel}`}
      </span>
    </figure>
  );
}

const KEYWORDS = new Set([
  "as", "assert", "async", "await", "await*", "case", "class", "const",
  "else", "export", "false", "func", "function", "if", "ignore", "import",
  "let", "new", "null", "public", "return", "switch", "true", "type", "var",
]);

const TOKEN_PATTERN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d(?:[\d_]*\d)?n?\b|\b[A-Za-z_][A-Za-z0-9_]*\b|\s+|[^\s])/gu;

function highlight(code: string): ReactNode[] {
  return Array.from(code.matchAll(TOKEN_PATTERN), (match, index) => {
    const token = match[0];
    const start = match.index ?? 0;
    const remainder = code.slice(start + token.length);
    const className = tokenClass(token, remainder);
    return className
      ? <span className={className} key={`${index}:${start}`}>{token}</span>
      : token;
  });
}

function tokenClass(token: string, remainder: string): string | null {
  if (/^\/\//u.test(token) || /^\/\*/u.test(token)) return "ks-code-comment";
  if (/^["'`]/u.test(token)) {
    return /^\s*:/u.test(remainder) ? "ks-code-property" : "ks-code-string";
  }
  if (/^\d/u.test(token)) return "ks-code-number";
  if (KEYWORDS.has(token)) return "ks-code-keyword";
  if (/^[A-Z][A-Za-z0-9_]*$/u.test(token)) return "ks-code-type";
  if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(token) && /^\s*\(/u.test(remainder)) {
    return "ks-code-function";
  }
  if (/^[#{}[\]();,.=:<>+\-*/?]+$/u.test(token)) return "ks-code-punctuation";
  return null;
}
