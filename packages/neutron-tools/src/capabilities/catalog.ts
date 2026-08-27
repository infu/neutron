import type { Schema } from "jsonschema";
import { Principal } from "@dfinity/principal";
import { compareCanonicalText } from "../canonical.ts";
import { CANISTER_METHOD_MAX_LENGTH } from "../physical_names.ts";
import {
  isValidTileId,
  TILE_ID_MAX_LENGTH,
  TILE_ID_SCHEMA_PATTERN,
} from "../tile_ids.ts";

export const CAPABILITY_API_VERSION = 1 as const;

export const BROWSER_PERMISSION_FEATURES = [
  "camera",
  "microphone",
] as const;
export const BROWSER_PERMISSIONS_MAX_TILES = 16;

export const ETHEREUM_PROVIDER_METHODS = [
  "eth_requestAccounts",
  "eth_accounts",
  "eth_chainId",
  "wallet_switchEthereumChain",
  "eth_call",
  "eth_getCode",
  "eth_sendTransaction",
  "eth_getTransactionReceipt",
] as const;

export const VETKEYS_MAX_SLOTS_PER_APP = 4;
/** Must match vetkeys/Memory.MAX_SLOTS_TOTAL. */
export const VETKEYS_MAX_SLOTS_GLOBAL = 128;
export const VETKEYS_SLOT_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const CHAIN_KEY_SIGNING_MAX_SLOTS_PER_APP = 4;
export const CHAIN_KEY_SIGNING_MAX_SLOTS_GLOBAL = 2_048;
export const CHAIN_KEY_SIGNING_SLOT_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const CHAIN_KEY_SIGNING_MAX_ASSERTION_BYTES = 4_096;
export const STABLE_STORE_MAX_STORES_PER_APP = 8;
export const STABLE_STORE_MAX_STORES_GLOBAL = 2_048;
export const STABLE_STORE_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const STABLE_STORE_MAX_SCHEMA_VERSION = 65_535;
export const STABLE_STORE_MAX_ENTRIES_PER_STORE = 4_096;
export const STABLE_STORE_MAX_ENTRIES_PER_APP = 8_192;
export const STABLE_STORE_MAX_ENTRIES_GLOBAL = 65_536;
export const STABLE_STORE_MAX_BYTES_PER_STORE = 16_777_216;
export const STABLE_STORE_MAX_BYTES_PER_APP = 33_554_432;
export const STABLE_STORE_MAX_BYTES_GLOBAL = 268_435_456;
export const STABLE_STORE_MAX_KEY_BYTES = 256;
export const STABLE_STORE_MAX_VALUE_BYTES = 262_144;
export const CONNECTIONS_MAX_PROVIDERS_PER_APP = 8;
export const CONNECTIONS_MAX_RESIDENT_BACKGROUNDS = 32;
export const CONNECTIONS_MAX_PROVIDERS_GLOBAL =
  CONNECTIONS_MAX_RESIDENT_BACKGROUNDS * CONNECTIONS_MAX_PROVIDERS_PER_APP;
export const CONNECTION_PROVIDER_SUPPORT_SCHEMA =
  "neutron.connection-provider-support.v1" as const;
export const HTTPS_OUTCALLS_MAX_ENDPOINTS_PER_APP = 8;
export const HTTPS_OUTCALLS_MAX_ENDPOINTS_GLOBAL = 2_048;
export const HTTPS_OUTCALL_MAX_URL_BYTES = 4_096;
export const HTTPS_OUTCALL_MAX_REQUEST_HEADERS = 16;
export const HTTPS_OUTCALL_MAX_REQUEST_BYTES = 65_536;
export const HTTPS_OUTCALL_MAX_RESPONSE_BYTES = 524_288;
export const HTTP_ROUTES_MAX_MOUNTS = 16;
export const HTTP_ROUTE_MAX_RESPONSE_BYTES = 1_048_576;
export const HTTP_POST_UPDATE_HANDLER_MAX_REQUEST_BYTES = 65_536;
export const HTTP_POST_UPDATE_HANDLER_MAX_RESPONSE_BYTES = 65_536;
export const HTTP_POST_UPDATE_HANDLER_MAX_CALLS_PER_HOUR = 240;
export const HTTP_POST_UPDATE_HANDLER_MAX_FORWARD_HEADERS = 8;
export const HTTP_POST_UPDATE_HANDLERS_MAX_CALLS_PER_HOUR = 240;
export const HTTP_POST_UPDATE_HANDLERS_MAX_REPLAY_BYTES_PER_HOUR = 8_388_608;
export const HTTP_POST_UPDATE_HANDLERS_GLOBAL_MAX_CALLS_PER_HOUR = 1_024;
export const HTTP_POST_UPDATE_HANDLERS_GLOBAL_MAX_REPLAY_BYTES_PER_HOUR = 67_108_864;
export const CERTIFIED_ASSETS_MAX_COLLECTIONS = 16;
export const CERTIFIED_ASSETS_MAX_ENTRIES = 100_000;
export const CERTIFIED_ASSETS_MAX_COMMITTED_BYTES = 1_073_741_824;
export const CERTIFIED_ASSETS_MAX_OBJECT_BYTES = 67_108_864;
/** Must match CertV2.PORTABLE_BLOB_BODY_BYTES_MAX_V2. */
export const CERTIFIED_ASSETS_PORTABLE_BLOB_BODY_BYTES_MAX = 1_048_576;
export const CERTIFIED_ASSETS_MAX_PENDING_STAGES = 1;
export const CERTIFIED_ASSETS_MAX_STAGED_BYTES = 67_108_864;
export const CERTIFIED_ASSETS_MAX_BATCH_OPERATIONS = 16;
export const CERTIFIED_ASSETS_MAX_BATCH_BYTES = 67_108_864;
export const CERTIFIED_ASSETS_MIN_IDEMPOTENCY_RECEIPTS = 2;
export const CERTIFIED_ASSETS_MAX_IDEMPOTENCY_RECEIPTS = 4_096;
// Mirrors certified_http_v2.CERTIFIED_HTTP_PATH_SEGMENTS_MAX_V2. Every
// certified-assets path is served below /app/<app>/_route/<mount>.
export const CERTIFIED_HTTP_PATH_SEGMENTS_MAX_V2 = 14;
/** Must match CertV2.CERTIFIED_HTTP_PATH_SEGMENT_BYTES_MAX_V2. */
export const CERTIFIED_HTTP_PATH_SEGMENT_BYTES_MAX_V2 = 1_024;
export const CERTIFIED_ASSETS_GLOBAL_ACTIVE_STAGES_MAX = 4;
export const CERTIFIED_ASSETS_PHYSICAL_RESERVATION_POLICY_V1 = Object.freeze({
  id: "neutron.certified-assets.physical-reservation.v1",
  stageBlockBytes: 1_889_984n,
  authorityVariants: 2n,
  cleanupJobsPerScope: 16n,
  stageMetadataCharge: 2_048n,
  generalReceiptCharge: 1_024n,
  stageKeyValueCharge: 768n,
  blockMetadataCharge: 160n,
  recordKeyValueCharge: 768n,
  recordMetadataCharge: 1_024n,
  routeIndexCharge: 256n,
  deleteReceiptLaneCharge: 768n,
  maximumRecordDynamicCharge: 1_024n,
  certificationLeafCharge: 320n,
  maximumLeafDynamicCharge: 768n,
  authNodeCharge: 256n,
  cleanupJobCharge: 256n,
  forestCatalogReservePerMount: 16_384n,
  extentWorstCaseOverhead: 270n,
  arenaMetadataReserveBytes: 72_000_528n,
  arenaAllocatableBytesMax: 1_879_048_192n,
  arenaExtentsMax: 250_000n,
});
export const CERTIFIED_ASSETS_GLOBAL_CHARGED_HEADROOM_BYTES =
  CERTIFIED_ASSETS_PHYSICAL_RESERVATION_POLICY_V1.arenaAllocatableBytesMax /
  2n;
export const CERTIFIED_ASSETS_GLOBAL_CHARGED_BYTES_MAX =
  CERTIFIED_ASSETS_PHYSICAL_RESERVATION_POLICY_V1.arenaAllocatableBytesMax +
  CERTIFIED_ASSETS_PHYSICAL_RESERVATION_POLICY_V1.arenaMetadataReserveBytes +
  CERTIFIED_ASSETS_GLOBAL_CHARGED_HEADROOM_BYTES;
export const PUBLIC_INGRESS_MAX_ROUTES_PER_APP = 32;
export const PUBLIC_INGRESS_MAX_ROUTES_GLOBAL = 2_048;
export const PUBLIC_INGRESS_MAX_RESOURCE_ID_LENGTH = 64;
export const PUBLIC_INGRESS_MAX_REQUEST_BYTES = 1_048_576;
export const PUBLIC_INGRESS_MAX_RESPONSE_BYTES = 1_048_576;
export const PUBLIC_INGRESS_MAX_CALLS_PER_ROUTE_PER_HOUR = 3_600;
export const PUBLIC_INGRESS_MAX_CALLS_PER_APP_PER_HOUR = 3_600;
export const PUBLIC_INGRESS_MAX_CALLS_GLOBAL_PER_HOUR = 16_384;
export const PUBLIC_INGRESS_MAX_REQUIRED_CYCLES = 100_000_000_000_000;
export const SCHEDULED_TASK_MIN_INTERVAL_SECONDS = 10;
export const SCHEDULED_TASK_MAX_INTERVAL_SECONDS = 2_592_000;
export const BACKEND_CALLS_MAX_CYCLES_PER_CALL = 100_000_000_000_000;
export const BACKEND_CALLS_MAX_CYCLES_PER_DAY = 1_000_000_000_000_000;
export const BACKEND_CALLS_MAX_INSTALL_RESERVATIONS_PER_APP = 64;
/** Must match backend_calls/Memory.MAX_TOTAL. */
export const BACKEND_CALLS_MAX_INSTALL_RESERVATIONS_GLOBAL = 2_048;

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
const SCOPE_PATTERN = /^[a-zA-Z0-9._:/-]+$/;
const METHOD_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/;
const AGENT_ENTRYPOINT_PATTERN = /^[a-zA-Z0-9_.-]{1,128}$/;
const TASK_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const HTTPS_OUTCALL_ENDPOINT_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const HTTPS_OUTCALL_HEADER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HTTPS_OUTCALL_FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "cookie",
  "host",
  "ic-certificate",
  "ic-certificateexpression",
  "idempotency-key",
  "keep-alive",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const HTTP_ROUTE_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const PUBLIC_INGRESS_ID_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const HTTP_HEADER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HTTP_POST_UPDATE_HANDLER_FORBIDDEN_FORWARD_HEADERS = new Set([
  "connection",
  "content-length",
  "content-encoding",
  "cookie",
  "host",
  "ic-certificate",
  "ic-certificateexpression",
  "idempotency-key",
  "keep-alive",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function isAllowedHttpsOutcallRequestHeader(header: string): boolean {
  return (
    HTTPS_OUTCALL_HEADER_NAME_PATTERN.test(header) &&
    !HTTPS_OUTCALL_FORBIDDEN_REQUEST_HEADERS.has(header) &&
    !header.startsWith("ic-") &&
    !header.startsWith("proxy-") &&
    !header.startsWith("sec-")
  );
}
const HTTP_ROUTE_PREFIX_PATTERN = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
const HTTP_ROUTE_PREFIX_MAX_LENGTH = 256;
const CERTIFIED_READ_SHARED_ROUTE_SEGMENTS = 4;
const CERTIFIED_BLOB_KEY_SEGMENTS = 1;
const CERTIFIED_COLLECTION_PREFIX_SEGMENTS_MAX =
  CERTIFIED_HTTP_PATH_SEGMENTS_MAX_V2 -
  CERTIFIED_READ_SHARED_ROUTE_SEGMENTS -
  CERTIFIED_BLOB_KEY_SEGMENTS;
const CERTIFIED_COLLECTION_EXACT_SEGMENTS_MAX =
  CERTIFIED_HTTP_PATH_SEGMENTS_MAX_V2 - CERTIFIED_READ_SHARED_ROUTE_SEGMENTS;
const CERTIFIED_COLLECTION_PATH_SEGMENT_PATTERN = "[a-z0-9._~-]+";
const CERTIFIED_COLLECTION_PREFIX_PATTERN =
  `^/${CERTIFIED_COLLECTION_PATH_SEGMENT_PATTERN}(?:/${CERTIFIED_COLLECTION_PATH_SEGMENT_PATTERN}){0,${CERTIFIED_COLLECTION_PREFIX_SEGMENTS_MAX - 1}}/$`;
const CERTIFIED_COLLECTION_EXACT_PATTERN =
  `^/${CERTIFIED_COLLECTION_PATH_SEGMENT_PATTERN}(?:/${CERTIFIED_COLLECTION_PATH_SEGMENT_PATTERN}){0,${CERTIFIED_COLLECTION_EXACT_SEGMENTS_MAX - 1}}$`;
const HTTP_ROUTE_RESERVED_PREFIXES = [
  "/app",
  "/system",
  "/pkg",
  "/mo",
  "/.well-known",
] as const;

/** Canonical app-local runtime resource id for one public ingress route. */
export function publicIngressResourceId(protocol: string, id: string): string {
  const resourceId = `${protocol}:${id}`;
  if (
    !PUBLIC_INGRESS_ID_PATTERN.test(protocol) ||
    !PUBLIC_INGRESS_ID_PATTERN.test(id) ||
    resourceId.length > PUBLIC_INGRESS_MAX_RESOURCE_ID_LENGTH
  ) {
    throw new Error("Invalid public_ingress protocol or route id");
  }
  return resourceId;
}

export type CapabilityApiVersion = 1 | 2;
export type CapabilityProvenance = "declared" | "derived";
export type CapabilityDelivery =
  | "backend_environment"
  | "frontend_endpoint"
  | "invocation"
  | "compiler_registration";
export type CapabilityNamespace = "app_installation";

export const DECLARED_CAPABILITY_IDS = [
  "backend_calls",
  "randomness",
  "chain_key_signing",
  "stable_store",
  "https_outcalls",
  "vetkeys",
  "scheduled_tasks",
  "preapproved_self_calls",
  "agent_entrypoints",
  "background_ui_requests",
  "ethereum_provider",
  "connections",
  "persistent_browser_storage",
  "dedicated_resident_origin",
  "public_ingress",
  "http_routes",
  "certified_assets",
  "browser_permissions",
] as const;

export const DERIVED_CAPABILITY_IDS = [
  "stable_memory",
  "memory_lifecycle",
  "app_calls",
  "backend_environment",
  "certified_read_routes",
  "function_resources",
  "app_exports",
  "tile_endpoints",
  "background_endpoint",
  "tray_endpoint",
] as const;

export const CAPABILITY_IDS = [
  ...DECLARED_CAPABILITY_IDS,
  ...DERIVED_CAPABILITY_IDS,
] as const;

export type DeclaredCapabilityId = (typeof DECLARED_CAPABILITY_IDS)[number];
export type DerivedCapabilityId = (typeof DERIVED_CAPABILITY_IDS)[number];
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/**
 * Public, versioned handles that may be delivered to a long-lived app
 * backend. The interface name is deliberately separate from the authored
 * declaration id: browser vetKey authority is declared as `vetkeys`, while
 * its attenuated backend interface is `vetkeys_public`.
 */
export const BACKEND_CAPABILITY_INTERFACES = Object.freeze({
  deferred_timers: Object.freeze({
    api: CAPABILITY_API_VERSION,
    declaration: null,
  }),
  backend_calls: Object.freeze({
    api: CAPABILITY_API_VERSION,
    declaration: "backend_calls",
  }),
  randomness: Object.freeze({
    api: CAPABILITY_API_VERSION,
    declaration: "randomness",
  }),
  chain_key_signing: Object.freeze({
    api: CAPABILITY_API_VERSION,
    declaration: "chain_key_signing",
  }),
  stable_store: Object.freeze({
    api: CAPABILITY_API_VERSION,
    declaration: "stable_store",
  }),
  https_outcalls: Object.freeze({
    api: CAPABILITY_API_VERSION,
    declaration: "https_outcalls",
  }),
  vetkeys_public: Object.freeze({
    api: CAPABILITY_API_VERSION,
    declaration: "vetkeys",
  }),
  certified_assets: Object.freeze({
    api: 2 as const,
    declaration: "certified_assets",
  }),
} as const satisfies Record<
  string,
  {
    api: CapabilityApiVersion;
    declaration: DeclaredCapabilityId | null;
  }
>);

export type BackendCapabilityInterfaceId =
  keyof typeof BACKEND_CAPABILITY_INTERFACES;

export type CapabilityCatalogEntry = {
  readonly id: CapabilityId;
  readonly api: readonly CapabilityApiVersion[];
  readonly provenance: CapabilityProvenance;
  readonly delivery: readonly CapabilityDelivery[];
  readonly title: string;
  readonly summary: string;
  readonly namespace: CapabilityNamespace;
  readonly lifecycle: "staged_installation";
  readonly grant:
    "declaration" | "owner_runtime_grant" | "structural_registration";
  readonly escalation: "owner_approval" | "structural_diff";
  readonly disable: "broker_enforced" | "registration_enforced";
  readonly revocation: "live_recheck" | "remove_registration";
  readonly quota: string;
  readonly audit: string;
  readonly reconciliation: {
    readonly commit: "activate_staged";
    readonly abort: "discard_staged";
    readonly removal: "revoke_or_remove";
    readonly uninstall: "purge_scope";
  };
  readonly compatible_changes: readonly ("identical" | "narrowing")[];
  readonly authored?: {
    readonly schema: (untrustedTextPattern: string) => Schema;
    readonly normalize: (
      value: unknown,
      context: CapabilityNormalizationContext,
    ) => unknown;
  };
};

function declared(
  id: DeclaredCapabilityId,
  options: Omit<
    CapabilityCatalogEntry,
    | "id"
    | "api"
    | "provenance"
    | "namespace"
    | "lifecycle"
    | "reconciliation"
    | "compatible_changes"
    | "authored"
  > & { api?: readonly CapabilityApiVersion[] },
): CapabilityCatalogEntry {
  const { api = [CAPABILITY_API_VERSION], ...catalogOptions } = options;
  return Object.freeze({
    id,
    api: Object.freeze([...api]),
    provenance: "declared",
    namespace: "app_installation",
    lifecycle: "staged_installation",
    reconciliation: Object.freeze({
      commit: "activate_staged",
      abort: "discard_staged",
      removal: "revoke_or_remove",
      uninstall: "purge_scope",
    }),
    compatible_changes: Object.freeze(["identical", "narrowing"] as const),
    authored: Object.freeze({
      schema: (untrustedTextPattern: string) =>
        schemaForDeclaredCapability(id, untrustedTextPattern),
      normalize: (value: unknown, context: CapabilityNormalizationContext) =>
        normalizeDeclaredCapability(id, value, context),
    }),
    ...catalogOptions,
    delivery: Object.freeze([...catalogOptions.delivery]),
  });
}

function derived(
  id: DerivedCapabilityId,
  options: Omit<
    CapabilityCatalogEntry,
    | "id"
    | "api"
    | "provenance"
    | "namespace"
    | "lifecycle"
    | "reconciliation"
    | "compatible_changes"
    | "authored"
  >,
): CapabilityCatalogEntry {
  return Object.freeze({
    id,
    api: Object.freeze([1] as const),
    provenance: "derived",
    namespace: "app_installation",
    lifecycle: "staged_installation",
    reconciliation: Object.freeze({
      commit: "activate_staged",
      abort: "discard_staged",
      removal: "revoke_or_remove",
      uninstall: "purge_scope",
    }),
    compatible_changes: Object.freeze(["identical", "narrowing"] as const),
    ...options,
    delivery: Object.freeze([...options.delivery]),
  });
}

export const CAPABILITY_CATALOG = Object.freeze({
  backend_calls: declared("backend_calls", {
    delivery: ["backend_environment", "invocation"],
    title: "Backend canister calls",
    summary: "Call only canisters and methods reserved for this app.",
    grant: "owner_runtime_grant",
    escalation: "owner_approval",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota:
      "Declared concurrency, per-call and daily cycle-transfer ceilings, and per-operation transport bounds.",
    audit:
      "Persistent bounded call and batch outcome totals; reservation records show the current exact grants.",
  }),
  randomness: declared("randomness", {
    delivery: ["backend_environment"],
    title: "Consensus randomness",
    summary: "Request 32-byte consensus entropy from the kernel broker.",
    grant: "declaration",
    escalation: "owner_approval",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota: "Bounded concurrency and a kernel low-cycle reserve.",
    audit: "Persistent bounded outcome totals and last operation.",
  }),
  chain_key_signing: declared("chain_key_signing", {
    delivery: ["backend_environment"],
    title: "Autonomous cryptographic assertions",
    summary:
      "Create domain-separated threshold signatures for bounded app assertions.",
    grant: "declaration",
    escalation: "owner_approval",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota:
      "At most four isolated slots, 4 KiB per assertion, bounded concurrency, a per-call cost ceiling, and a kernel low-cycle reserve.",
    audit:
      "Bounded generic public-key, signature, denial, busy, revocation, cost, and failure totals; assertions, digests, keys, and signatures are not logged.",
  }),
  stable_store: declared("stable_store", {
    delivery: ["backend_environment"],
    title: "Durable backend stores",
    summary: "Keep bounded key/value blobs in installation-isolated stores.",
    grant: "declaration",
    escalation: "owner_approval",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota:
      "At most eight stores, 8,192 entries, and 32 MiB of declared key/value data per app installation.",
    audit:
      "Bounded generic mutation success and denial totals; operation labels distinguish put, delete, and clear-page calls, keys and values are not logged, and query reads are not counted.",
  }),
  https_outcalls: declared("https_outcalls", {
    delivery: ["backend_environment"],
    title: "HTTPS outcalls",
    summary:
      "Call exact external HTTPS URL prefixes through the kernel broker.",
    grant: "declaration",
    escalation: "owner_approval",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota:
      "At most eight endpoints, strict transport bounds, bounded concurrency, a per-call cost ceiling, and a kernel low-cycle reserve.",
    audit:
      "Bounded generic success, denial, busy, revocation, cost, and failure totals for live declared endpoints; URLs and payloads are not logged.",
  }),
  vetkeys: declared("vetkeys", {
    delivery: ["frontend_endpoint", "backend_environment"],
    title: "Private key slots",
    summary: "Use bounded encrypted-key slots isolated to this installation.",
    grant: "declaration",
    escalation: "owner_approval",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota: "At most four declared slots; broker operations remain bounded.",
    audit: "Bounded reserve, derive, rotate, and retire summaries.",
  }),
  scheduled_tasks: declared("scheduled_tasks", {
    delivery: ["invocation", "compiler_registration"],
    title: "Scheduled tasks",
    summary: "Run exact backend methods on declared bounded schedules.",
    grant: "declaration",
    escalation: "owner_approval",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota: "Two tasks, bounded intervals, and bounded backend calls per run.",
    audit: "Persistent bounded run outcomes and the last run time and result.",
  }),
  preapproved_self_calls: declared("preapproved_self_calls", {
    delivery: ["frontend_endpoint"],
    title: "Preapproved app calls",
    summary: "Call exact methods on this Neutron without another prompt.",
    grant: "declaration",
    escalation: "owner_approval",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota: "At most 32 exact owner-authorized query or update methods.",
    audit:
      "Metadata-only bounded call and rejection totals; arguments, results, and progress are not retained.",
  }),
  agent_entrypoints: declared("agent_entrypoints", {
    delivery: ["compiler_registration"],
    title: "Agent entrypoints",
    summary: "Expose exact resident-background tools to authorized agents.",
    grant: "declaration",
    escalation: "owner_approval",
    disable: "registration_enforced",
    revocation: "remove_registration",
    quota: "At most four exact entrypoints.",
    audit: "Bounded invocation and rejection totals.",
  }),
  background_ui_requests: declared("background_ui_requests", {
    delivery: ["frontend_endpoint"],
    title: "Background permission prompts",
    summary: "Let the resident background request exact dialog categories.",
    grant: "declaration",
    escalation: "owner_approval",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota: "Four fixed request categories.",
    audit: "Bounded requested, approved, denied, and expired totals.",
  }),
  ethereum_provider: declared("ethereum_provider", {
    delivery: ["frontend_endpoint"],
    title: "Ethereum provider",
    summary: "Use exact EIP-1193 methods on declared chains.",
    grant: "owner_runtime_grant",
    escalation: "owner_approval",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota: "Eight chains and the fixed supported method set.",
    audit: "Bounded method, chain, approval, and failure totals.",
  }),
  connections: declared("connections", {
    delivery: ["frontend_endpoint"],
    title: "Provider connections",
    summary:
      "Connect a resident background to exact providers with declared scopes.",
    grant: "owner_runtime_grant",
    escalation: "owner_approval",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota: "Eight providers and 32 scopes per provider.",
    audit: "Generic bounded operation outcomes in the capability registry.",
  }),
  persistent_browser_storage: declared("persistent_browser_storage", {
    delivery: ["frontend_endpoint"],
    title: "Persistent background storage",
    summary: "Keep browser data in this installation's background origin.",
    grant: "declaration",
    escalation: "owner_approval",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota:
      "One isolated background origin; explicit byte quota and orphan cleanup remain future work.",
    audit:
      "Generic enable/disable changes are recorded; browser-local reads are not audited.",
  }),
  dedicated_resident_origin: declared("dedicated_resident_origin", {
    delivery: ["frontend_endpoint"],
    title: "Ephemeral isolated resident origin",
    summary:
      "Run the resident background on an isolated resident origin with an ephemeral credential partition.",
    grant: "declaration",
    escalation: "owner_approval",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota: "One isolated resident origin and one current frame binding.",
    audit:
      "Origin allocation, authority rotation, launch denial, and lifecycle outcomes.",
  }),
  public_ingress: declared("public_ingress", {
    delivery: ["compiler_registration"],
    title: "Public protocol ingress",
    summary:
      "Accept bounded public protocol calls on exact compiler-bound routes.",
    grant: "declaration",
    escalation: "owner_approval",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota:
      "At most 32 exact protocol routes; request and response bodies are capped at 1 MiB, and update routes declare at most 3,600 calls per hour.",
    audit: "Bounded accepted, denied, rate-limited, and failed call totals.",
  }),
  http_routes: declared("http_routes", {
    delivery: ["compiler_registration"],
    title: "Public POST routes",
    summary: "Handle bounded POST requests on exact app routes.",
    grant: "declaration",
    escalation: "owner_approval",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota:
      "At most 16 mounts; paths, bodies, responses, rates, and forwarded headers are explicitly bounded.",
    audit: "Bounded http_post_update_handler outcomes per mount.",
  }),
  certified_assets: declared("certified_assets", {
    api: [2],
    delivery: ["backend_environment"],
    title: "Certified route storage",
    summary: "Publish bounded responses beneath this app's declared routes.",
    grant: "declaration",
    escalation: "owner_approval",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota:
      "Install-reviewed collection, entry, committed-byte, object, stage, batch, and idempotency maxima; public plaintext is bounded to 100,000 records and 1 GiB per installation.",
    audit:
      "Metadata-only bounded stage, publish, conditional delete, maintenance, denial, and configuration outcomes; bodies and public query serving are not retained in audit.",
  }),
  browser_permissions: declared("browser_permissions", {
    delivery: ["frontend_endpoint", "compiler_registration"],
    title: "Browser device access",
    summary:
      "Let exact open tiles request declared browser device features; capture may continue while an open tile's workspace is hidden.",
    grant: "declaration",
    escalation: "owner_approval",
    disable: "registration_enforced",
    revocation: "remove_registration",
    quota:
      "At most 16 exact tiles and the closed camera and microphone feature set.",
    audit:
      "The approved declaration is retained in the capability plan; browser prompts, decisions, and device use are not observed or audited by Neutron.",
  }),
  certified_read_routes: derived("certified_read_routes", {
    delivery: ["compiler_registration"],
    title: "Certified read routes",
    summary:
      "Serve each certified collection through its fixed kind-derived read policy.",
    grant: "declaration",
    escalation: "structural_diff",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota:
      "One exact read mount per collection mount group; together with POST routes, at most 16 mounts.",
    audit:
      "Route authority and enablement are retained per mount; public query serving is not counted.",
  }),
  stable_memory: derived("stable_memory", {
    delivery: ["backend_environment"],
    title: "Stable memory",
    summary: "Use exact active memory roots declared by this app.",
    grant: "structural_registration",
    escalation: "structural_diff",
    disable: "registration_enforced",
    revocation: "remove_registration",
    quota: "One resource per active memory declaration.",
    audit: "Version, ownership, upgrade, and retirement summaries.",
  }),
  memory_lifecycle: derived("memory_lifecycle", {
    delivery: ["backend_environment", "compiler_registration"],
    title: "Memory lifecycle",
    summary:
      "Retire exact app memory roots and disclose any ordered consolidation inputs.",
    grant: "structural_registration",
    escalation: "structural_diff",
    disable: "registration_enforced",
    revocation: "remove_registration",
    quota: "64 roots, 256 migration edges, and 16 consumed roots per edge.",
    audit: "Retirement, deletion, consolidation, and migration outcomes.",
  }),
  app_calls: derived("app_calls", {
    delivery: ["backend_environment"],
    title: "App dependencies",
    summary: "Call exact functions from declared typed app dependencies.",
    grant: "structural_registration",
    escalation: "structural_diff",
    disable: "broker_enforced",
    revocation: "live_recheck",
    quota: "32 dependencies and 64 exact functions per dependency.",
    audit: "Bounded dependency dispatch and failure totals.",
  }),
  backend_environment: derived("backend_environment", {
    delivery: ["backend_environment"],
    title: "Backend capability delivery",
    summary:
      "Deliver only the exact versioned broker interfaces selected for this backend.",
    grant: "structural_registration",
    escalation: "structural_diff",
    disable: "registration_enforced",
    revocation: "remove_registration",
    quota: "At most the fixed reviewed backend interface catalogue.",
    audit: "Selected interface ids, API versions, and plan fingerprint.",
  }),
  function_resources: derived("function_resources", {
    delivery: ["backend_environment", "invocation"],
    title: "Function resources",
    summary:
      "Inject exact kernel-owned resources into exact backend functions.",
    grant: "structural_registration",
    escalation: "structural_diff",
    disable: "registration_enforced",
    revocation: "remove_registration",
    quota: "256 functions and 16 ordered resources per function.",
    audit: "Compiler registration and invocation failure summaries.",
  }),
  app_exports: derived("app_exports", {
    delivery: ["compiler_registration"],
    title: "App exports",
    summary: "Expose exact internal methods to other installed apps.",
    grant: "structural_registration",
    escalation: "structural_diff",
    disable: "registration_enforced",
    revocation: "remove_registration",
    quota: "Exact function declarations and compiler transport bounds.",
    audit: "Bounded dispatch, denial, and failure totals.",
  }),
  tile_endpoints: derived("tile_endpoints", {
    delivery: ["frontend_endpoint"],
    title: "Tile surfaces",
    summary: "Run exact disposable tile endpoints declared by this app.",
    grant: "structural_registration",
    escalation: "structural_diff",
    disable: "registration_enforced",
    revocation: "remove_registration",
    quota: "One endpoint per normalized tile.",
    audit: "Bounded launch and failure totals.",
  }),
  background_endpoint: derived("background_endpoint", {
    delivery: ["frontend_endpoint"],
    title: "Resident background",
    summary: "Run this app's exact resident background endpoint.",
    grant: "structural_registration",
    escalation: "structural_diff",
    disable: "registration_enforced",
    revocation: "remove_registration",
    quota: "At most one resident background endpoint.",
    audit: "Lifecycle, restart, and failure summaries.",
  }),
  tray_endpoint: derived("tray_endpoint", {
    delivery: ["frontend_endpoint"],
    title: "Tray surface",
    summary: "Run this app's exact tray endpoint.",
    grant: "structural_registration",
    escalation: "structural_diff",
    disable: "registration_enforced",
    revocation: "remove_registration",
    quota: "At most one tray endpoint.",
    audit: "Bounded launch and failure totals.",
  }),
} satisfies Record<CapabilityId, CapabilityCatalogEntry>);

export type NeutronConnectionConfig = {
  provider: string;
  scopes?: string[];
};
export type NormalizedNeutronConnectionConfig = {
  provider: string;
  scopes: string[];
};
export type ConnectionProviderSupport = Readonly<{
  provider: string;
  scopes: readonly string[];
}>;
export type ConnectionProviderSupportCatalog = Readonly<{
  schema: typeof CONNECTION_PROVIDER_SUPPORT_SCHEMA;
  providers: readonly ConnectionProviderSupport[];
}>;

/**
 * Parse the provider support metadata carried by a Kernel package.
 *
 * Product names, authorization endpoints, and provider implementations stay
 * in the Kernel. This portable parser only closes and canonicalizes the small
 * compatibility boundary used while compiling an installation target.
 */
export function parseConnectionProviderSupportCatalog(
  value: unknown,
): ConnectionProviderSupportCatalog {
  assertClosed(value, "connection provider support catalog", [
    "schema",
    "providers",
  ]);
  if (
    !Object.hasOwn(value, "schema") ||
    !Object.hasOwn(value, "providers") ||
    value.schema !== CONNECTION_PROVIDER_SUPPORT_SCHEMA
  ) {
    throw new Error("Unsupported connection provider support catalog");
  }
  if (
    !Array.isArray(value.providers) ||
    value.providers.length > CONNECTIONS_MAX_PROVIDERS_GLOBAL
  ) {
    throw new Error("Invalid connection provider support catalog");
  }

  const providers = value.providers.map((entry) => {
    assertClosed(entry, "connection provider support", ["provider", "scopes"]);
    if (!Object.hasOwn(entry, "provider") || !Object.hasOwn(entry, "scopes")) {
      throw new Error("Invalid connection provider support");
    }
    if (
      typeof entry.provider !== "string" ||
      !PROVIDER_ID_PATTERN.test(entry.provider)
    ) {
      throw new Error("Invalid connection provider support");
    }
    const scopes = sortedUniqueStrings(
      entry.scopes,
      `connection provider support scope for ${entry.provider}`,
      0,
      32,
      (scope) => scope.length <= 80 && SCOPE_PATTERN.test(scope),
    );
    if (
      !Array.isArray(entry.scopes) ||
      entry.scopes.some((scope, index) => scope !== scopes[index])
    ) {
      throw new Error(
        `Connection provider '${entry.provider}' scopes are not canonical`,
      );
    }
    return Object.freeze({
      provider: entry.provider,
      scopes: Object.freeze(scopes),
    });
  });
  const sortedProviders = [...providers].sort((left, right) =>
    compareCanonicalText(left.provider, right.provider),
  );
  if (
    providers.some(
      (provider, index) =>
        provider.provider !== sortedProviders[index]?.provider,
    )
  ) {
    throw new Error("Connection provider support catalog is not canonical");
  }
  for (let index = 1; index < providers.length; index += 1) {
    if (providers[index - 1]!.provider === providers[index]!.provider) {
      throw new Error(
        `Duplicate connection provider support ${providers[index]!.provider}`,
      );
    }
  }
  return Object.freeze({
    schema: CONNECTION_PROVIDER_SUPPORT_SCHEMA,
    providers: Object.freeze(providers),
  });
}

/** Reject a target app declaration that the selected Kernel cannot serve. */
export function assertConnectionProvidersSupported(
  connections: readonly NormalizedNeutronConnectionConfig[],
  catalog: ConnectionProviderSupportCatalog,
  label?: string,
): void {
  const supported = new Map(
    catalog.providers.map((provider) => [
      provider.provider,
      new Set(provider.scopes),
    ]),
  );
  const context = label ? ` for ${label}` : "";
  for (const connection of connections) {
    const scopes = supported.get(connection.provider);
    if (!scopes) {
      throw new Error(
        `Unsupported connection provider '${connection.provider}'${context}`,
      );
    }
    for (const scope of connection.scopes) {
      if (!scopes.has(scope)) {
        throw new Error(
          `Provider '${connection.provider}' does not support scope '${scope}'${context}`,
        );
      }
    }
  }
}
export type NeutronBackendCallReservationScope =
  "exact" | "principal" | "method";
export type NeutronBackendCallReservation = {
  principal?: string;
  method?: string;
} & (
  | { kind: "exact"; principal: string; method: string }
  | { kind: "principal"; principal: string }
  | { kind: "method"; method: string }
);
/** Canonical identity used by both normalization and target-wide ownership checks. */
export function backendCallInstallReservationKey(
  reservation: NeutronBackendCallReservation,
): string {
  return `${reservation.kind}:${
    reservation.kind === "method" ? "" : reservation.principal
  }:${reservation.kind === "principal" ? "" : reservation.method}`;
}
export type NeutronBackendCallsCapabilityConfig = {
  api: 1;
  description: string;
  reservation_scopes: NeutronBackendCallReservationScope[];
  install_reservations?: NeutronBackendCallReservation[];
  max_concurrency: number;
  max_cycles_per_call: number;
  max_cycles_per_day: number;
};
export type NeutronRandomnessCapabilityConfig = { api: 1 };
export const CHAIN_KEY_SIGNING_ALGORITHMS = [
  "ecdsa_secp256k1",
  "schnorr_bip340secp256k1",
  "schnorr_ed25519",
] as const;
export type NeutronChainKeySigningAlgorithmV1 =
  (typeof CHAIN_KEY_SIGNING_ALGORITHMS)[number];
export type NeutronChainKeySigningSlotV1 = {
  id: string;
  algorithm: NeutronChainKeySigningAlgorithmV1;
  purpose: string;
  max_assertion_bytes: number;
};
export type NeutronChainKeySigningCapabilityV1 = {
  api: 1;
  slots: NeutronChainKeySigningSlotV1[];
};
export type NeutronChainKeySigningCapabilityConfig =
  NeutronChainKeySigningCapabilityV1;
export type NeutronStableStoreV1 = {
  id: string;
  purpose: string;
  schema_version: number;
  max_entries: number;
  max_key_bytes: number;
  max_value_bytes: number;
  max_bytes: number;
};
export type NeutronStableStoreCapabilityV1 = {
  api: 1;
  stores: NeutronStableStoreV1[];
};
export type NeutronStableStoreCapabilityConfig = NeutronStableStoreCapabilityV1;
export type NeutronHttpsOutcallMethodV1 = "get" | "head" | "post";
export type NeutronHttpsOutcallEndpointV1 = {
  id: string;
  url_prefix: string;
  methods: NeutronHttpsOutcallMethodV1[];
  request_headers: string[];
  max_request_bytes: number;
  max_response_bytes: number;
  transform: "strip_headers";
};
export type NeutronHttpsOutcallsCapabilityV1 = {
  api: 1;
  endpoints: NeutronHttpsOutcallEndpointV1[];
};
export type NeutronHttpsOutcallsCapabilityConfig =
  NeutronHttpsOutcallsCapabilityV1;
export type NeutronVetKeysSlotConfig = { id: string; purpose: string };
export type NeutronVetKeysCapabilityConfig = {
  api: 1;
  description: string;
  slots: NeutronVetKeysSlotConfig[];
};
export type NeutronScheduledTaskConfig = {
  id: string;
  method: string;
  interval_seconds: number;
  run_on_start: boolean;
  max_backend_calls: number;
};
export type NeutronScheduledTasksCapabilityConfig = {
  api: 1;
  tasks: NeutronScheduledTaskConfig[];
};
export type NeutronPreapprovedSelfCallsCapabilityV1 = {
  api: 1;
  methods: string[];
};
export type NeutronPreapprovedSelfCallsCapabilityConfig =
  NeutronPreapprovedSelfCallsCapabilityV1;
export type NormalizedNeutronPreapprovedSelfCallsCapabilityConfig =
  NeutronPreapprovedSelfCallsCapabilityV1;
export type NeutronAgentEntrypointsCapabilityConfig = {
  api: 1;
  entrypoints: string[];
};
export type NeutronBackgroundUiRequest =
  "frontend_tool" | "signed_canister_call" | "backend_access" | "connection";
export type NeutronBackgroundUiRequestsCapabilityConfig = {
  api: 1;
  categories: NeutronBackgroundUiRequest[];
};
export type NeutronEthereumProviderMethod =
  (typeof ETHEREUM_PROVIDER_METHODS)[number];
export type NeutronEthereumProviderCapabilityConfig = {
  api: 1;
  chains: number[];
  methods: NeutronEthereumProviderMethod[];
};
export type NeutronConnectionsCapabilityConfig = {
  api: 1;
  providers: NeutronConnectionConfig[];
};
export type NormalizedNeutronConnectionsCapabilityConfig = {
  api: 1;
  providers: NormalizedNeutronConnectionConfig[];
};
export type NeutronPersistentBrowserStorageCapabilityConfig = {
  api: 1;
  surface: "background";
};
export type NeutronDedicatedResidentOriginCapabilityConfig = {
  api: 1;
  surface: "background";
  mode: "credentialless_ephemeral_v1";
};
export type NeutronBrowserPermissionFeature =
  (typeof BROWSER_PERMISSION_FEATURES)[number];
export type NeutronBrowserPermissionTileConfig = {
  id: string;
  features: NeutronBrowserPermissionFeature[];
};
export type NeutronBrowserPermissionsCapabilityConfig = {
  api: 1;
  tiles: NeutronBrowserPermissionTileConfig[];
};
export type NeutronResidentFrameSecurityMode =
  | "credentialless_opaque_v1"
  | "credentialless_ephemeral_dedicated_v1"
  | "persistent_dedicated_v1";
export type NeutronPublicIngressCallerV1 = "any" | "authenticated" | "canister";
export type NeutronPublicIngressQueryRouteV1 = {
  protocol: string;
  id: string;
  handler: string;
  mode: "query";
  caller: NeutronPublicIngressCallerV1;
  max_request_bytes: number;
  max_response_bytes: number;
  max_calls_per_hour?: never;
  required_cycles?: never;
};
/** Direct ingress signed by a self-authenticating principal; never cycle-paid. */
export type NeutronPublicIngressAuthenticatedUpdateRouteV1 = {
  protocol: string;
  id: string;
  handler: string;
  mode: "update";
  caller: "authenticated";
  max_request_bytes: number;
  max_response_bytes: number;
  max_calls_per_hour: number;
  max_calls_per_caller_per_hour?: number;
  required_cycles?: never;
};
export type NeutronPublicIngressCanisterUpdateRouteV1 = {
  protocol: string;
  id: string;
  handler: string;
  mode: "update";
  caller: "canister";
  max_request_bytes: number;
  max_response_bytes: number;
  max_calls_per_hour: number;
  max_calls_per_caller_per_hour?: number;
  required_cycles: number;
};
export type NeutronPublicIngressUpdateRouteV1 =
  | NeutronPublicIngressAuthenticatedUpdateRouteV1
  | NeutronPublicIngressCanisterUpdateRouteV1;
export type NeutronPublicIngressRouteV1 =
  NeutronPublicIngressQueryRouteV1 | NeutronPublicIngressUpdateRouteV1;
export type NeutronPublicIngressCapabilityV1 = {
  api: 1;
  routes: NeutronPublicIngressRouteV1[];
};
export type NeutronPublicIngressCapabilityConfig =
  NeutronPublicIngressCapabilityV1;
export type NeutronHttpPostUpdateHandlerRouteMethod = "POST";
export type NeutronHttpRouteMethod = NeutronHttpPostUpdateHandlerRouteMethod;
export type NeutronHttpRouteSurface = "app_host" | "shared_app_path";
export type NeutronAppHostHttpRouteLocationConfig = {
  surface: "app_host";
  prefix: string;
};
export type NeutronSharedAppPathHttpRouteLocationConfig = {
  surface: "shared_app_path";
  /** The kernel derives /app/<app-id>/_route/<mount-id>. */
  prefix?: never;
};
export type NeutronHttpRouteLocationConfig =
  | NeutronAppHostHttpRouteLocationConfig
  | NeutronSharedAppPathHttpRouteLocationConfig;
export type NeutronCertifiedReadAuthorityMode =
  "exact_neutron_host_v1" | "canister_gateway_v1";
export type NeutronCertifiedReadRouteMountConfig =
  NeutronSharedAppPathHttpRouteLocationConfig & {
    id: string;
    authority_mode: NeutronCertifiedReadAuthorityMode;
    methods: ["GET", "HEAD"] | ["GET"];
    mode: "certified_store";
    store: "certified_assets";
    max_request_bytes: 0;
  };
export type NeutronHttpPostUpdateHandlerRouteMountConfig =
  NeutronHttpRouteLocationConfig & {
    id: string;
    methods: NeutronHttpPostUpdateHandlerRouteMethod[];
    mode: "http_post_update_handler";
    handler: string;
    max_request_bytes: number;
    max_response_bytes: number;
    max_calls_per_hour: number;
    forward_headers: string[];
  };
export type NeutronHttpRouteMountConfig =
  NeutronHttpPostUpdateHandlerRouteMountConfig;
export type NeutronHttpRoutesCapabilityV1 = {
  api: 1;
  mounts: NeutronHttpPostUpdateHandlerRouteMountConfig[];
};
export type NeutronHttpRoutesCapabilityConfig = NeutronHttpRoutesCapabilityV1;

type NeutronCertifiedAssetsCollectionBase = {
  id: string;
  mount: string;
  max_object_bytes?: number;
};
export type NeutronCertifiedAssetsPublicationCollectionConfig =
  NeutronCertifiedAssetsCollectionBase & {
    kind: "publication";
    path_prefix?: never;
    exact_path?: never;
  };
export type NeutronCertifiedAssetsImmutableBlobCollectionConfig =
  NeutronCertifiedAssetsCollectionBase & {
    kind: "immutable_blob";
    path_prefix: string;
    exact_path?: never;
  };
type NeutronCertifiedAssetsMutableBlobLocation =
  | { path_prefix: string; exact_path?: never }
  | { exact_path: string; path_prefix?: never };
export type NeutronCertifiedAssetsMutableBlobCollectionConfig =
  NeutronCertifiedAssetsCollectionBase &
    NeutronCertifiedAssetsMutableBlobLocation & {
      kind: "mutable_blob";
    };
export type NeutronCertifiedAssetsCollectionConfig =
  | NeutronCertifiedAssetsPublicationCollectionConfig
  | NeutronCertifiedAssetsImmutableBlobCollectionConfig
  | NeutronCertifiedAssetsMutableBlobCollectionConfig;
export type NeutronCertifiedAssetsCapabilityV2 = {
  api: 2;
  max_entries: number;
  max_committed_bytes: number;
  max_object_bytes: number;
  max_pending_stages: number;
  max_staged_bytes: number;
  max_batch_operations: number;
  max_batch_bytes: number;
  max_idempotency_receipts: number;
  collections: NeutronCertifiedAssetsCollectionConfig[];
};
export type NeutronCertifiedAssetsCapabilityConfig =
  NeutronCertifiedAssetsCapabilityV2;

export type CertifiedAssetsPhysicalReservation = Readonly<{
  chargedBytes: bigint;
  arenaBytes: bigint;
  arenaExtents: bigint;
}>;

/**
 * Mirrors CertifiedAssetsService.installedScopeReservations. This target-wide
 * admission model is deliberately physical: it reserves allocator bytes,
 * descriptor geometry, and conservative metadata rather than fitting a known
 * app suite's logical quotas.
 */
export function certifiedAssetsPhysicalReservation(
  certifiedAssets: NeutronCertifiedAssetsCapabilityConfig,
  appId: string,
): CertifiedAssetsPhysicalReservation {
  const policy = CERTIFIED_ASSETS_PHYSICAL_RESERVATION_POLICY_V1;
  const maximum = (left: bigint, right: bigint) =>
    left > right ? left : right;
  const minimum = (left: bigint, right: bigint) =>
    left < right ? left : right;
  const segments = (path: string) =>
    BigInt(path.split("/").filter(Boolean).length);
  const utf8Bytes = (value: string) =>
    BigInt(new TextEncoder().encode(value).byteLength);
  const sharedMountSegments = 4n;

  let maximumRecordCharge = 0n;
  let maximumExtentsPerRecord = 1n;
  let maximumObjectBytes = 0n;
  let maximumStageCharge = 0n;
  let hasPublication = false;
  const mounts = new Set<string>();

  for (const collection of certifiedAssets.collections) {
    mounts.add(collection.mount);
    const objectBytes = BigInt(
      collection.max_object_bytes ?? certifiedAssets.max_object_bytes,
    );
    const publication = collection.kind === "publication";
    const blocks = publication
      ? maximum(
          1n,
          (objectBytes + policy.stageBlockBytes - 1n) /
            policy.stageBlockBytes,
        )
      : 1n;
    const responses = publication
      ? policy.authorityVariants * (blocks + 1n)
      : 1n;
    const pathSegments = publication
      ? sharedMountSegments + 2n
      : collection.kind === "immutable_blob"
        ? sharedMountSegments + segments(collection.path_prefix) + 1n
        : "path_prefix" in collection &&
            collection.path_prefix !== undefined
          ? sharedMountSegments + segments(collection.path_prefix) + 1n
          : sharedMountSegments + segments(collection.exact_path!);
    const authNodes = publication
      ? pathSegments + 7n + responses
      : pathSegments + 5n;
    const recordCharge =
      policy.recordKeyValueCharge +
      policy.recordMetadataCharge +
      policy.routeIndexCharge +
      policy.deleteReceiptLaneCharge +
      policy.maximumRecordDynamicCharge +
      blocks * policy.blockMetadataCharge +
      responses *
        (policy.certificationLeafCharge +
          policy.maximumLeafDynamicCharge) +
      authNodes * policy.authNodeCharge;

    maximumRecordCharge = maximum(maximumRecordCharge, recordCharge);
    maximumExtentsPerRecord = maximum(
      maximumExtentsPerRecord,
      blocks,
    );
    maximumObjectBytes = maximum(maximumObjectBytes, objectBytes);
    hasPublication ||= publication;

    if (collection.kind !== "mutable_blob") {
      const stageCharge =
        policy.stageMetadataCharge +
        policy.generalReceiptCharge +
        policy.stageKeyValueCharge +
        utf8Bytes(appId) +
        utf8Bytes(collection.id) +
        blocks * policy.blockMetadataCharge +
        policy.generalReceiptCharge +
        policy.cleanupJobCharge +
        recordCharge;
      maximumStageCharge = maximum(maximumStageCharge, stageCharge);
    }
  }

  const entries = BigInt(certifiedAssets.max_entries);
  const committedBytes = BigInt(certifiedAssets.max_committed_bytes);
  const batchOperations = BigInt(certifiedAssets.max_batch_operations);
  const batchBytes = BigInt(certifiedAssets.max_batch_bytes);
  const generalReceipts = BigInt(
    certifiedAssets.max_idempotency_receipts,
  );
  const baseCommittedExtents = minimum(entries, committedBytes);
  const committedExtents = hasPublication
    ? minimum(
        baseCommittedExtents * maximumExtentsPerRecord,
        baseCommittedExtents +
          (committedBytes - baseCommittedExtents) /
            policy.stageBlockBytes,
      )
    : baseCommittedExtents;
  const detachedBodies = minimum(
    committedBytes,
    policy.cleanupJobsPerScope * maximumObjectBytes,
  );
  const detachedExtents = minimum(
    committedExtents,
    policy.cleanupJobsPerScope * maximumExtentsPerRecord,
  );
  const batchExtents = minimum(batchOperations, batchBytes);
  const arenaExtents =
    committedExtents + detachedExtents + batchExtents;
  const arenaBytes =
    committedBytes +
    detachedBodies +
    batchBytes +
    arenaExtents * policy.extentWorstCaseOverhead;
  const recordRows =
    entries * maximumRecordCharge +
    (committedBytes / policy.stageBlockBytes) *
      policy.blockMetadataCharge;
  const batchMetadata =
    batchOperations *
    (maximumRecordCharge + policy.cleanupJobCharge);
  const receiptRows =
    generalReceipts * policy.generalReceiptCharge;
  const cleanupRows =
    policy.cleanupJobsPerScope * policy.cleanupJobCharge;
  const forestCatalogReserve =
    BigInt(mounts.size) * policy.forestCatalogReservePerMount;

  return Object.freeze({
    arenaBytes,
    arenaExtents,
    chargedBytes:
      arenaBytes +
      recordRows +
      batchMetadata +
      receiptRows +
      cleanupRows +
      maximumStageCharge +
      forestCatalogReserve,
  });
}

export type NeutronCertifiedReadRoutesCapabilityConfig = {
  mounts: NeutronCertifiedReadRouteMountConfig[];
};

export type NeutronCapabilitiesConfig = {
  backend_calls?: NeutronBackendCallsCapabilityConfig;
  randomness?: NeutronRandomnessCapabilityConfig;
  chain_key_signing?: NeutronChainKeySigningCapabilityConfig;
  stable_store?: NeutronStableStoreCapabilityConfig;
  https_outcalls?: NeutronHttpsOutcallsCapabilityConfig;
  vetkeys?: NeutronVetKeysCapabilityConfig;
  scheduled_tasks?: NeutronScheduledTasksCapabilityConfig;
  preapproved_self_calls?: NeutronPreapprovedSelfCallsCapabilityConfig;
  agent_entrypoints?: NeutronAgentEntrypointsCapabilityConfig;
  background_ui_requests?: NeutronBackgroundUiRequestsCapabilityConfig;
  ethereum_provider?: NeutronEthereumProviderCapabilityConfig;
  connections?: NeutronConnectionsCapabilityConfig;
  persistent_browser_storage?: NeutronPersistentBrowserStorageCapabilityConfig;
  dedicated_resident_origin?: NeutronDedicatedResidentOriginCapabilityConfig;
  public_ingress?: NeutronPublicIngressCapabilityConfig;
  http_routes?: NeutronHttpRoutesCapabilityConfig;
  certified_assets?: NeutronCertifiedAssetsCapabilityConfig;
  browser_permissions?: NeutronBrowserPermissionsCapabilityConfig;
};

export type NormalizedNeutronCapabilitiesConfig = Omit<
  NeutronCapabilitiesConfig,
  "connections" | "preapproved_self_calls"
> & {
  connections?: NormalizedNeutronConnectionsCapabilityConfig;
  preapproved_self_calls?: NormalizedNeutronPreapprovedSelfCallsCapabilityConfig;
};

type NormalizeText = (
  value: unknown,
  label: string,
  limits: { minimumLength?: number; maximumLength: number },
) => string;

export type CapabilityNormalizationContext = {
  appId?: string;
  hasBackground: boolean;
  tileIds?: readonly string[];
  normalizeText: NormalizeText;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertClosed(
  value: unknown,
  label: string,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined)
    throw new Error(`Unknown ${label} field ${unknown}`);
}

function assertApi(
  value: Record<string, unknown>,
  id: string,
  expected: CapabilityApiVersion = 1,
): void {
  if (value.api !== expected) {
    throw new Error(`Unsupported ${id} capability API`);
  }
}

function sortedUniqueStrings(
  value: unknown,
  label: string,
  min: number,
  max: number,
  valid: (item: string) => boolean,
): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`Invalid ${label}`);
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !valid(item))
      throw new Error(`Invalid ${label}`);
    if (seen.has(item)) throw new Error(`Duplicate ${label} ${item}`);
    seen.add(item);
  }
  return [...seen].sort(compareCanonicalText);
}

function positiveBoundedInteger(
  value: unknown,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > maximum
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return Number(value);
}

function normalizeCertifiedCollectionPath(
  value: unknown,
  label: string,
  kind: "prefix" | "exact",
): string {
  const maximumSegments =
    kind === "prefix"
      ? CERTIFIED_COLLECTION_PREFIX_SEGMENTS_MAX
      : CERTIFIED_COLLECTION_EXACT_SEGMENTS_MAX;
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > HTTP_ROUTE_PREFIX_MAX_LENGTH ||
    !/^\/[a-z0-9._~-]+(?:\/[a-z0-9._~-]+)*\/?$/u.test(value) ||
    value.split("/").some((segment) => segment === "." || segment === "..") ||
    value.split("/").filter((segment) => segment !== "").length >
      maximumSegments ||
    (kind === "prefix" ? !value.endsWith("/") : value.endsWith("/"))
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function certifiedCollectionPathsOverlap(
  left: NeutronCertifiedAssetsCollectionConfig,
  right: NeutronCertifiedAssetsCollectionConfig,
): boolean {
  if (left.mount !== right.mount) return false;
  if (left.kind === "publication" || right.kind === "publication") {
    return true;
  }
  const leftPath =
    left.path_prefix !== undefined ? left.path_prefix : left.exact_path;
  const rightPath =
    right.path_prefix !== undefined ? right.path_prefix : right.exact_path;
  const leftPrefix = left.path_prefix !== undefined;
  const rightPrefix = right.path_prefix !== undefined;
  if (leftPrefix && rightPrefix) {
    return leftPath.startsWith(rightPath) || rightPath.startsWith(leftPath);
  }
  if (leftPrefix) return rightPath.startsWith(leftPath);
  if (rightPrefix) return leftPath.startsWith(rightPath);
  return leftPath === rightPath;
}

/** Derive the exact certified read routes owned by a normalized declaration. */
export function deriveCertifiedReadRoutes(
  capability: NeutronCertifiedAssetsCapabilityConfig,
): NeutronCertifiedReadRoutesCapabilityConfig {
  const authorities = new Map<string, NeutronCertifiedReadAuthorityMode>();
  for (const collection of capability.collections) {
    const authority: NeutronCertifiedReadAuthorityMode =
      collection.kind === "publication"
        ? "exact_neutron_host_v1"
        : "canister_gateway_v1";
    const existing = authorities.get(collection.mount);
    if (existing !== undefined && existing !== authority) {
      throw new Error(
        `Certified read mount ${collection.mount} mixes host-bound publications and portable blobs`,
      );
    }
    authorities.set(collection.mount, authority);
  }
  const mounts = [...authorities]
    .map(([id, authority_mode]): NeutronCertifiedReadRouteMountConfig => ({
      id,
      surface: "shared_app_path",
      authority_mode,
      methods:
        authority_mode === "exact_neutron_host_v1" ? ["GET", "HEAD"] : ["GET"],
      mode: "certified_store",
      store: "certified_assets",
      max_request_bytes: 0,
    }))
    .sort((left, right) => compareCanonicalText(left.id, right.id));
  return { mounts };
}

function normalizeHttpsOutcallUrlPrefix(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < "https://a.b/".length ||
    value.length > HTTPS_OUTCALL_MAX_URL_BYTES ||
    !value.endsWith("/")
  ) {
    throw new Error("Invalid HTTPS outcall URL prefix");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid HTTPS outcall URL prefix");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.href !== value
  ) {
    throw new Error("Invalid HTTPS outcall URL prefix");
  }

  const hostname = parsed.hostname;
  const labels = hostname.split(".");
  const forbiddenSuffixes = new Set([
    "arpa",
    "home",
    "internal",
    "invalid",
    "lan",
    "local",
    "localhost",
    "onion",
    "test",
  ]);
  if (
    hostname.length > 253 ||
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length < 1 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    ) ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname) ||
    forbiddenSuffixes.has(labels.at(-1) ?? "")
  ) {
    throw new Error("Invalid HTTPS outcall public DNS host");
  }

  const pathSegments = parsed.pathname.split("/");
  if (
    pathSegments[0] !== "" ||
    pathSegments.at(-1) !== "" ||
    pathSegments
      .slice(1, -1)
      .some(
        (segment) =>
          segment === "" ||
          segment === "." ||
          segment === ".." ||
          !/^[A-Za-z0-9._~-]+$/u.test(segment),
      )
  ) {
    throw new Error("Invalid HTTPS outcall path prefix");
  }
  return value;
}

function normalizeHttpRoutePrefix(value: unknown): string {
  if (
    typeof value !== "string" ||
    value === "/" ||
    value.length > HTTP_ROUTE_PREFIX_MAX_LENGTH ||
    !HTTP_ROUTE_PREFIX_PATTERN.test(value) ||
    value.split("/").filter(Boolean).length > 64 ||
    value.split("/").some((segment) => segment === "." || segment === "..") ||
    HTTP_ROUTE_RESERVED_PREFIXES.some(
      (reserved) => value === reserved || value.startsWith(`${reserved}/`),
    )
  ) {
    throw new Error("Invalid HTTP route prefix");
  }
  return value;
}

function httpRoutePrefixesOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function normalizeCapabilityDeclarationFields(
  declaration: unknown,
  context: CapabilityNormalizationContext,
): NormalizedNeutronCapabilitiesConfig {
  if (declaration === undefined) return {};
  if (context.appId === "kernel") {
    throw new Error("Kernel cannot declare ordinary app capabilities");
  }
  assertClosed(
    declaration,
    "capabilities declaration",
    DECLARED_CAPABILITY_IDS,
  );
  if (Object.keys(declaration).length === 0) {
    throw new Error("Capabilities declaration cannot be empty");
  }

  const normalized: NormalizedNeutronCapabilitiesConfig = {};
  const backendCalls = declaration.backend_calls;
  if (backendCalls !== undefined) {
    assertClosed(backendCalls, "backend_calls capability", [
      "api",
      "description",
      "reservation_scopes",
      "install_reservations",
      "max_concurrency",
      "max_cycles_per_call",
      "max_cycles_per_day",
    ]);
    assertApi(backendCalls, "backend_calls");
    const scopes = sortedUniqueStrings(
      backendCalls.reservation_scopes,
      "backend_calls reservation scope",
      1,
      3,
      (scope) =>
        scope === "exact" || scope === "principal" || scope === "method",
    ) as NeutronBackendCallReservationScope[];
    if (
      !Number.isSafeInteger(backendCalls.max_concurrency) ||
      Number(backendCalls.max_concurrency) < 1 ||
      Number(backendCalls.max_concurrency) > 20
    ) {
      throw new Error("Invalid backend_calls max_concurrency");
    }
    const maxCyclesPerCall = Number(backendCalls.max_cycles_per_call);
    if (
      !Number.isSafeInteger(maxCyclesPerCall) ||
      maxCyclesPerCall < 0 ||
      maxCyclesPerCall > BACKEND_CALLS_MAX_CYCLES_PER_CALL
    ) {
      throw new Error("Invalid backend_calls max_cycles_per_call");
    }
    const maxCyclesPerDay = Number(backendCalls.max_cycles_per_day);
    if (
      !Number.isSafeInteger(maxCyclesPerDay) ||
      maxCyclesPerDay < 0 ||
      maxCyclesPerDay > BACKEND_CALLS_MAX_CYCLES_PER_DAY
    ) {
      throw new Error("Invalid backend_calls max_cycles_per_day");
    }
    if (maxCyclesPerCall > maxCyclesPerDay) {
      throw new Error(
        "backend_calls max_cycles_per_call cannot exceed max_cycles_per_day",
      );
    }
    normalized.backend_calls = {
      api: 1,
      description: context.normalizeText(
        backendCalls.description,
        "backend_calls description",
        { maximumLength: 280 },
      ),
      reservation_scopes: scopes,
      ...(backendCalls.install_reservations === undefined
        ? {}
        : {
            install_reservations: normalizeBackendCallInstallReservations(
              backendCalls.install_reservations,
              scopes,
            ),
          }),
      max_concurrency: Number(backendCalls.max_concurrency),
      max_cycles_per_call: maxCyclesPerCall,
      max_cycles_per_day: maxCyclesPerDay,
    };
  }

  const randomness = declaration.randomness;
  if (randomness !== undefined) {
    assertClosed(randomness, "randomness capability", ["api"]);
    assertApi(randomness, "randomness");
    normalized.randomness = { api: 1 };
  }

  const chainKeySigning = declaration.chain_key_signing;
  if (chainKeySigning !== undefined) {
    assertClosed(chainKeySigning, "chain_key_signing capability", [
      "api",
      "slots",
    ]);
    assertApi(chainKeySigning, "chain_key_signing");
    if (
      !Array.isArray(chainKeySigning.slots) ||
      chainKeySigning.slots.length < 1 ||
      chainKeySigning.slots.length > CHAIN_KEY_SIGNING_MAX_SLOTS_PER_APP
    ) {
      throw new Error("Invalid chain_key_signing capability");
    }
    const algorithms = new Set<string>(CHAIN_KEY_SIGNING_ALGORITHMS);
    const ids = new Set<string>();
    const slots = chainKeySigning.slots.map((slot) => {
      assertClosed(slot, "chain_key_signing slot", [
        "id",
        "algorithm",
        "purpose",
        "max_assertion_bytes",
      ]);
      if (
        typeof slot.id !== "string" ||
        !CHAIN_KEY_SIGNING_SLOT_ID_PATTERN.test(slot.id) ||
        ids.has(slot.id) ||
        typeof slot.algorithm !== "string" ||
        !algorithms.has(slot.algorithm) ||
        !Number.isSafeInteger(slot.max_assertion_bytes) ||
        Number(slot.max_assertion_bytes) < 1 ||
        Number(slot.max_assertion_bytes) > CHAIN_KEY_SIGNING_MAX_ASSERTION_BYTES
      ) {
        throw new Error("Invalid chain_key_signing slot");
      }
      ids.add(slot.id);
      return {
        id: slot.id,
        algorithm: slot.algorithm as NeutronChainKeySigningAlgorithmV1,
        purpose: context.normalizeText(
          slot.purpose,
          `chain_key_signing purpose for ${slot.id}`,
          { minimumLength: 1, maximumLength: 160 },
        ),
        max_assertion_bytes: Number(slot.max_assertion_bytes),
      };
    });
    slots.sort((left, right) => compareCanonicalText(left.id, right.id));
    normalized.chain_key_signing = {
      api: 1,
      slots,
    };
  }

  const stableStore = declaration.stable_store;
  if (stableStore !== undefined) {
    assertClosed(stableStore, "stable_store capability", ["api", "stores"]);
    assertApi(stableStore, "stable_store");
    if (
      !Array.isArray(stableStore.stores) ||
      stableStore.stores.length < 1 ||
      stableStore.stores.length > STABLE_STORE_MAX_STORES_PER_APP
    ) {
      throw new Error("Invalid stable_store capability");
    }
    const ids = new Set<string>();
    let totalEntries = 0;
    let totalBytes = 0;
    const stores = stableStore.stores.map((store) => {
      assertClosed(store, "stable_store store", [
        "id",
        "purpose",
        "schema_version",
        "max_entries",
        "max_key_bytes",
        "max_value_bytes",
        "max_bytes",
      ]);
      if (
        typeof store.id !== "string" ||
        !STABLE_STORE_ID_PATTERN.test(store.id) ||
        ids.has(store.id) ||
        !Number.isSafeInteger(store.schema_version) ||
        Number(store.schema_version) < 1 ||
        Number(store.schema_version) > STABLE_STORE_MAX_SCHEMA_VERSION ||
        !Number.isSafeInteger(store.max_entries) ||
        Number(store.max_entries) < 1 ||
        Number(store.max_entries) > STABLE_STORE_MAX_ENTRIES_PER_STORE ||
        !Number.isSafeInteger(store.max_key_bytes) ||
        Number(store.max_key_bytes) < 1 ||
        Number(store.max_key_bytes) > STABLE_STORE_MAX_KEY_BYTES ||
        !Number.isSafeInteger(store.max_value_bytes) ||
        Number(store.max_value_bytes) < 1 ||
        Number(store.max_value_bytes) > STABLE_STORE_MAX_VALUE_BYTES ||
        !Number.isSafeInteger(store.max_bytes) ||
        Number(store.max_bytes) < 1 ||
        Number(store.max_bytes) > STABLE_STORE_MAX_BYTES_PER_STORE ||
        Number(store.max_key_bytes) + Number(store.max_value_bytes) >
          Number(store.max_bytes)
      ) {
        throw new Error("Invalid stable_store store");
      }
      ids.add(store.id);
      totalEntries += Number(store.max_entries);
      totalBytes += Number(store.max_bytes);
      return {
        id: store.id,
        purpose: context.normalizeText(
          store.purpose,
          `stable_store purpose for ${store.id}`,
          { minimumLength: 1, maximumLength: 160 },
        ),
        schema_version: Number(store.schema_version),
        max_entries: Number(store.max_entries),
        max_key_bytes: Number(store.max_key_bytes),
        max_value_bytes: Number(store.max_value_bytes),
        max_bytes: Number(store.max_bytes),
      };
    });
    if (
      totalEntries > STABLE_STORE_MAX_ENTRIES_PER_APP ||
      totalBytes > STABLE_STORE_MAX_BYTES_PER_APP
    ) {
      throw new Error(
        `stable_store declarations exceed the per-app aggregate limit`,
      );
    }
    stores.sort((left, right) => compareCanonicalText(left.id, right.id));
    normalized.stable_store = { api: 1, stores };
  }

  const httpsOutcalls = declaration.https_outcalls;
  if (httpsOutcalls !== undefined) {
    assertClosed(httpsOutcalls, "https_outcalls capability", [
      "api",
      "endpoints",
    ]);
    assertApi(httpsOutcalls, "https_outcalls");
    if (
      !Array.isArray(httpsOutcalls.endpoints) ||
      httpsOutcalls.endpoints.length < 1 ||
      httpsOutcalls.endpoints.length > HTTPS_OUTCALLS_MAX_ENDPOINTS_PER_APP
    ) {
      throw new Error("Invalid https_outcalls capability");
    }
    const endpointIds = new Set<string>();
    const endpoints = httpsOutcalls.endpoints.map((endpoint) => {
      assertClosed(endpoint, "HTTPS outcall endpoint", [
        "id",
        "url_prefix",
        "methods",
        "request_headers",
        "max_request_bytes",
        "max_response_bytes",
        "transform",
      ]);
      if (
        typeof endpoint.id !== "string" ||
        !HTTPS_OUTCALL_ENDPOINT_ID_PATTERN.test(endpoint.id) ||
        endpointIds.has(endpoint.id) ||
        !Number.isSafeInteger(endpoint.max_request_bytes) ||
        Number(endpoint.max_request_bytes) < 1 ||
        Number(endpoint.max_request_bytes) > HTTPS_OUTCALL_MAX_REQUEST_BYTES ||
        !Number.isSafeInteger(endpoint.max_response_bytes) ||
        Number(endpoint.max_response_bytes) < 1 ||
        Number(endpoint.max_response_bytes) >
          HTTPS_OUTCALL_MAX_RESPONSE_BYTES ||
        endpoint.transform !== "strip_headers"
      ) {
        throw new Error("Invalid HTTPS outcall endpoint");
      }
      endpointIds.add(endpoint.id);
      const methods = sortedUniqueStrings(
        endpoint.methods,
        `HTTPS outcall method for ${endpoint.id}`,
        1,
        3,
        (method) => method === "get" || method === "head" || method === "post",
      ) as NeutronHttpsOutcallMethodV1[];
      const requestHeaders = sortedUniqueStrings(
        endpoint.request_headers,
        `HTTPS outcall request header for ${endpoint.id}`,
        0,
        HTTPS_OUTCALL_MAX_REQUEST_HEADERS,
        (header) => isAllowedHttpsOutcallRequestHeader(header),
      );
      const urlPrefix = normalizeHttpsOutcallUrlPrefix(endpoint.url_prefix);
      if (urlPrefix.length > Number(endpoint.max_request_bytes)) {
        throw new Error(
          `HTTPS outcall endpoint ${endpoint.id} URL prefix exceeds max_request_bytes`,
        );
      }
      return {
        id: endpoint.id,
        url_prefix: urlPrefix,
        methods,
        request_headers: requestHeaders,
        max_request_bytes: Number(endpoint.max_request_bytes),
        max_response_bytes: Number(endpoint.max_response_bytes),
        transform: "strip_headers" as const,
      };
    });
    endpoints.sort((left, right) => compareCanonicalText(left.id, right.id));
    normalized.https_outcalls = {
      api: 1,
      endpoints,
    };
  }

  const vetkeys = declaration.vetkeys;
  if (vetkeys !== undefined) {
    assertClosed(vetkeys, "vetkeys capability", [
      "api",
      "description",
      "slots",
    ]);
    assertApi(vetkeys, "vetkeys");
    if (
      !Array.isArray(vetkeys.slots) ||
      vetkeys.slots.length < 1 ||
      vetkeys.slots.length > VETKEYS_MAX_SLOTS_PER_APP
    ) {
      throw new Error("Invalid vetkeys slots");
    }
    const ids = new Set<string>();
    const slots = vetkeys.slots.map((slot) => {
      assertClosed(slot, "vetkeys slot", ["id", "purpose"]);
      if (
        typeof slot.id !== "string" ||
        !VETKEYS_SLOT_ID_PATTERN.test(slot.id)
      ) {
        throw new Error("Invalid vetkeys slot");
      }
      if (ids.has(slot.id))
        throw new Error(`Duplicate vetkeys slot ${slot.id}`);
      ids.add(slot.id);
      return {
        id: slot.id,
        purpose: context.normalizeText(
          slot.purpose,
          `vetkeys purpose for ${slot.id}`,
          { maximumLength: 280 },
        ),
      };
    });
    slots.sort((a, b) => compareCanonicalText(a.id, b.id));
    normalized.vetkeys = {
      api: 1,
      description: context.normalizeText(
        vetkeys.description,
        "vetkeys description",
        { maximumLength: 280 },
      ),
      slots,
    };
  }

  const scheduledTasks = declaration.scheduled_tasks;
  if (scheduledTasks !== undefined) {
    assertClosed(scheduledTasks, "scheduled_tasks capability", [
      "api",
      "tasks",
    ]);
    assertApi(scheduledTasks, "scheduled_tasks");
    if (
      !Array.isArray(scheduledTasks.tasks) ||
      scheduledTasks.tasks.length < 1 ||
      scheduledTasks.tasks.length > 2
    ) {
      throw new Error("Invalid scheduled_tasks capability");
    }
    const ids = new Set<string>();
    const methods = new Set<string>();
    const tasks = scheduledTasks.tasks.map((task) => {
      assertClosed(task, "scheduled task", [
        "id",
        "method",
        "interval_seconds",
        "run_on_start",
        "max_backend_calls",
      ]);
      if (
        typeof task.id !== "string" ||
        !TASK_ID_PATTERN.test(task.id) ||
        typeof task.method !== "string" ||
        !METHOD_NAME_PATTERN.test(task.method) ||
        !Number.isSafeInteger(task.interval_seconds) ||
        Number(task.interval_seconds) < SCHEDULED_TASK_MIN_INTERVAL_SECONDS ||
        Number(task.interval_seconds) > SCHEDULED_TASK_MAX_INTERVAL_SECONDS ||
        typeof task.run_on_start !== "boolean" ||
        !Number.isSafeInteger(task.max_backend_calls) ||
        Number(task.max_backend_calls) < 1 ||
        Number(task.max_backend_calls) > 100
      ) {
        throw new Error("Invalid scheduled task");
      }
      if (ids.has(task.id))
        throw new Error(`Duplicate scheduled task id ${task.id}`);
      if (methods.has(task.method)) {
        throw new Error(`Duplicate scheduled task method ${task.method}`);
      }
      ids.add(task.id);
      methods.add(task.method);
      return {
        id: task.id,
        method: task.method,
        interval_seconds: Number(task.interval_seconds),
        run_on_start: task.run_on_start,
        max_backend_calls: Number(task.max_backend_calls),
      };
    });
    tasks.sort((a, b) => compareCanonicalText(a.id, b.id));
    normalized.scheduled_tasks = { api: 1, tasks };
  }

  const selfCalls = declaration.preapproved_self_calls;
  if (selfCalls !== undefined) {
    assertClosed(selfCalls, "preapproved_self_calls capability", [
      "api",
      "methods",
    ]);
    if (selfCalls.api !== 1) {
      throw new Error("Unsupported preapproved_self_calls capability API");
    }
    normalized.preapproved_self_calls = {
      api: 1,
      methods: sortedUniqueStrings(
        selfCalls.methods,
        "preapproved self-call method",
        1,
        32,
        (method) => METHOD_NAME_PATTERN.test(method),
      ),
    };
  }

  const agentEntrypoints = declaration.agent_entrypoints;
  if (agentEntrypoints !== undefined) {
    assertClosed(agentEntrypoints, "agent_entrypoints capability", [
      "api",
      "entrypoints",
    ]);
    assertApi(agentEntrypoints, "agent_entrypoints");
    if (!context.hasBackground)
      throw new Error("Invalid agent_entrypoints capability");
    normalized.agent_entrypoints = {
      api: 1,
      entrypoints: sortedUniqueStrings(
        agentEntrypoints.entrypoints,
        "agent entrypoint",
        1,
        4,
        (entrypoint) => AGENT_ENTRYPOINT_PATTERN.test(entrypoint),
      ),
    };
  }

  const uiRequests = declaration.background_ui_requests;
  if (uiRequests !== undefined) {
    assertClosed(uiRequests, "background_ui_requests capability", [
      "api",
      "categories",
    ]);
    assertApi(uiRequests, "background_ui_requests");
    if (!context.hasBackground) {
      throw new Error("Invalid background_ui_requests capability");
    }
    normalized.background_ui_requests = {
      api: 1,
      categories: sortedUniqueStrings(
        uiRequests.categories,
        "background UI request category",
        1,
        4,
        (category) =>
          category === "frontend_tool" ||
          category === "signed_canister_call" ||
          category === "backend_access" ||
          category === "connection",
      ) as NeutronBackgroundUiRequest[],
    };
  }

  const ethereum = declaration.ethereum_provider;
  if (ethereum !== undefined) {
    assertClosed(ethereum, "ethereum_provider capability", [
      "api",
      "chains",
      "methods",
    ]);
    assertApi(ethereum, "ethereum_provider");
    if (
      !Array.isArray(ethereum.chains) ||
      ethereum.chains.length < 1 ||
      ethereum.chains.length > 8
    ) {
      throw new Error("Invalid ethereum_provider chains");
    }
    const chains = new Set<number>();
    for (const chain of ethereum.chains) {
      if (!Number.isSafeInteger(chain) || Number(chain) < 1) {
        throw new Error("Invalid ethereum_provider chain");
      }
      if (chains.has(Number(chain))) {
        throw new Error(`Duplicate ethereum_provider chain ${String(chain)}`);
      }
      chains.add(Number(chain));
    }
    const allowedMethods = new Set<string>(ETHEREUM_PROVIDER_METHODS);
    const methods = sortedUniqueStrings(
      ethereum.methods,
      "ethereum_provider method",
      1,
      ETHEREUM_PROVIDER_METHODS.length,
      (method) => allowedMethods.has(method),
    ) as NeutronEthereumProviderMethod[];
    if (
      methods.includes("eth_sendTransaction") &&
      !methods.includes("eth_requestAccounts")
    ) {
      throw new Error(
        "ethereum_provider transactions require eth_requestAccounts",
      );
    }
    normalized.ethereum_provider = {
      api: 1,
      chains: [...chains].sort((a, b) => a - b),
      methods,
    };
  }

  const connections = declaration.connections;
  if (connections !== undefined) {
    assertClosed(connections, "connections capability", ["api", "providers"]);
    assertApi(connections, "connections");
    if (!context.hasBackground) {
      throw new Error("Invalid connections capability");
    }
    if (
      !Array.isArray(connections.providers) ||
      connections.providers.length < 1 ||
      connections.providers.length > CONNECTIONS_MAX_PROVIDERS_PER_APP
    ) {
      throw new Error("Invalid connections providers");
    }
    const providerIds = new Set<string>();
    const providers = connections.providers.map((provider) => {
      assertClosed(provider, "connection provider", ["provider", "scopes"]);
      if (
        typeof provider.provider !== "string" ||
        !PROVIDER_ID_PATTERN.test(provider.provider)
      ) {
        throw new Error("Invalid connection provider");
      }
      if (providerIds.has(provider.provider)) {
        throw new Error(`Duplicate connection provider ${provider.provider}`);
      }
      providerIds.add(provider.provider);
      const scopes = sortedUniqueStrings(
        provider.scopes ?? [],
        `connection scope for ${provider.provider}`,
        0,
        32,
        (scope) => scope.length <= 80 && SCOPE_PATTERN.test(scope),
      );
      return { provider: provider.provider, scopes };
    });
    providers.sort((a, b) => compareCanonicalText(a.provider, b.provider));
    normalized.connections = { api: 1, providers };
  }

  const persistentStorage = declaration.persistent_browser_storage;
  if (persistentStorage !== undefined) {
    assertClosed(persistentStorage, "persistent_browser_storage capability", [
      "api",
      "surface",
    ]);
    assertApi(persistentStorage, "persistent_browser_storage");
    if (!context.hasBackground || persistentStorage.surface !== "background") {
      throw new Error("Invalid persistent_browser_storage capability");
    }
    normalized.persistent_browser_storage = { api: 1, surface: "background" };
  }

  const dedicatedResidentOrigin = declaration.dedicated_resident_origin;
  if (dedicatedResidentOrigin !== undefined) {
    assertClosed(
      dedicatedResidentOrigin,
      "dedicated_resident_origin capability",
      ["api", "surface", "mode"],
    );
    assertApi(dedicatedResidentOrigin, "dedicated_resident_origin");
    if (
      !context.hasBackground ||
      dedicatedResidentOrigin.surface !== "background" ||
      dedicatedResidentOrigin.mode !== "credentialless_ephemeral_v1"
    ) {
      throw new Error("Invalid dedicated_resident_origin capability");
    }
    if (persistentStorage !== undefined) {
      throw new Error(
        "dedicated_resident_origin and persistent_browser_storage are mutually exclusive",
      );
    }
    normalized.dedicated_resident_origin = {
      api: 1,
      surface: "background",
      mode: "credentialless_ephemeral_v1",
    };
  }

  const browserPermissions = declaration.browser_permissions;
  if (browserPermissions !== undefined) {
    assertClosed(browserPermissions, "browser_permissions capability", [
      "api",
      "tiles",
    ]);
    assertApi(browserPermissions, "browser_permissions");
    if (
      !Array.isArray(browserPermissions.tiles) ||
      browserPermissions.tiles.length < 1 ||
      browserPermissions.tiles.length > BROWSER_PERMISSIONS_MAX_TILES
    ) {
      throw new Error("Invalid browser_permissions tiles");
    }
    const tileIds = new Set<string>();
    const allowedFeatures = new Set<string>(BROWSER_PERMISSION_FEATURES);
    const tiles = browserPermissions.tiles.map((tile) => {
      assertClosed(tile, "browser_permissions tile", ["id", "features"]);
      if (!isValidTileId(tile.id)) {
        throw new Error("Invalid browser_permissions tile id");
      }
      if (tileIds.has(tile.id)) {
        throw new Error(`Duplicate browser_permissions tile ${tile.id}`);
      }
      tileIds.add(tile.id);
      return {
        id: tile.id,
        features: sortedUniqueStrings(
          tile.features,
          `browser_permissions feature for ${tile.id}`,
          1,
          BROWSER_PERMISSION_FEATURES.length,
          (feature) => allowedFeatures.has(feature),
        ) as NeutronBrowserPermissionFeature[],
      };
    });
    tiles.sort((left, right) => compareCanonicalText(left.id, right.id));
    normalized.browser_permissions = { api: 1, tiles };
  }

  const publicIngress = declaration.public_ingress;
  if (publicIngress !== undefined) {
    assertClosed(publicIngress, "public_ingress capability", ["api", "routes"]);
    assertApi(publicIngress, "public_ingress");
    if (
      !Array.isArray(publicIngress.routes) ||
      publicIngress.routes.length < 1 ||
      publicIngress.routes.length > PUBLIC_INGRESS_MAX_ROUTES_PER_APP
    ) {
      throw new Error("Invalid public_ingress routes");
    }
    const resourceIds = new Set<string>();
    const routes: NeutronPublicIngressRouteV1[] = publicIngress.routes.map(
      (route) => {
        if (!isRecord(route)) throw new Error("Invalid public_ingress route");
        const fields = [
          "protocol",
          "id",
          "handler",
          "mode",
          "caller",
          "max_request_bytes",
          "max_response_bytes",
        ];
        if (route.mode === "update") {
          fields.push("max_calls_per_hour");
          fields.push("max_calls_per_caller_per_hour");
          if (route.caller === "canister") fields.push("required_cycles");
        }
        assertClosed(route, "public_ingress route", fields);
        if (route.mode !== "query" && route.mode !== "update") {
          throw new Error("Invalid public_ingress route mode");
        }
        const caller = route.caller;
        if (
          typeof route.protocol !== "string" ||
          typeof route.id !== "string" ||
          typeof route.handler !== "string" ||
          !METHOD_NAME_PATTERN.test(route.handler) ||
          (caller !== "any" &&
            caller !== "authenticated" &&
            caller !== "canister") ||
          !Number.isSafeInteger(route.max_request_bytes) ||
          Number(route.max_request_bytes) < 1 ||
          Number(route.max_request_bytes) > PUBLIC_INGRESS_MAX_REQUEST_BYTES ||
          !Number.isSafeInteger(route.max_response_bytes) ||
          Number(route.max_response_bytes) < 1 ||
          Number(route.max_response_bytes) > PUBLIC_INGRESS_MAX_RESPONSE_BYTES
        ) {
          throw new Error("Invalid public_ingress route");
        }
        const callerPolicy: NeutronPublicIngressCallerV1 = caller;
        const resourceId = publicIngressResourceId(route.protocol, route.id);
        if (resourceIds.has(resourceId)) {
          throw new Error(`Duplicate public_ingress route ${resourceId}`);
        }
        resourceIds.add(resourceId);
        const common = {
          protocol: route.protocol,
          id: route.id,
          handler: route.handler,
          caller: callerPolicy,
          max_request_bytes: Number(route.max_request_bytes),
          max_response_bytes: Number(route.max_response_bytes),
        };
        if (route.mode === "query") {
          return { ...common, mode: "query" };
        }
        if (caller !== "authenticated" && caller !== "canister") {
          throw new Error("Invalid public_ingress update caller");
        }
        if (
          !Number.isSafeInteger(route.max_calls_per_hour) ||
          Number(route.max_calls_per_hour) < 1 ||
          Number(route.max_calls_per_hour) >
            PUBLIC_INGRESS_MAX_CALLS_PER_ROUTE_PER_HOUR
        ) {
          throw new Error("Invalid public_ingress update rate");
        }
        const maxCallsPerHour = Number(route.max_calls_per_hour);
        const maxCallsPerCallerPerHour =
          route.max_calls_per_caller_per_hour === undefined
            ? undefined
            : Number(route.max_calls_per_caller_per_hour);
        if (
          maxCallsPerCallerPerHour !== undefined &&
          (!Number.isSafeInteger(maxCallsPerCallerPerHour) ||
            maxCallsPerCallerPerHour < 1 ||
            maxCallsPerCallerPerHour > maxCallsPerHour)
        ) {
          throw new Error("Invalid public_ingress update caller rate");
        }
        if (caller === "authenticated") {
          return {
            ...common,
            mode: "update",
            caller: "authenticated",
            max_calls_per_hour: maxCallsPerHour,
            ...(maxCallsPerCallerPerHour === undefined
              ? {}
              : {
                  max_calls_per_caller_per_hour: maxCallsPerCallerPerHour,
                }),
          };
        }
        if (
          !Number.isSafeInteger(route.required_cycles) ||
          Number(route.required_cycles) < 1 ||
          Number(route.required_cycles) > PUBLIC_INGRESS_MAX_REQUIRED_CYCLES
        ) {
          throw new Error("Invalid public_ingress required cycles");
        }
        return {
          ...common,
          mode: "update",
          caller: "canister",
          max_calls_per_hour: maxCallsPerHour,
          ...(maxCallsPerCallerPerHour === undefined
            ? {}
            : {
                max_calls_per_caller_per_hour: maxCallsPerCallerPerHour,
              }),
          required_cycles: Number(route.required_cycles),
        };
      },
    );
    const updateCallsPerHour = routes.reduce(
      (total, route) =>
        total + (route.mode === "update" ? route.max_calls_per_hour : 0),
      0,
    );
    if (updateCallsPerHour > PUBLIC_INGRESS_MAX_CALLS_PER_APP_PER_HOUR) {
      throw new Error(
        `public_ingress update routes declare ${updateCallsPerHour} calls per hour; per-app maximum is ${PUBLIC_INGRESS_MAX_CALLS_PER_APP_PER_HOUR}`,
      );
    }
    routes.sort(
      (left, right) =>
        compareCanonicalText(left.protocol, right.protocol) ||
        compareCanonicalText(left.id, right.id),
    );
    normalized.public_ingress = { api: 1, routes };
  }

  const httpRoutes = declaration.http_routes;
  if (httpRoutes !== undefined) {
    assertClosed(httpRoutes, "http_routes capability", ["api", "mounts"]);
    if (
      !Array.isArray(httpRoutes.mounts) ||
      httpRoutes.mounts.length < 1 ||
      httpRoutes.mounts.length > HTTP_ROUTES_MAX_MOUNTS
    ) {
      throw new Error("Invalid http_routes mounts");
    }
    const ids = new Set<string>();
    const occupiedAppHost: Array<{
      prefix: string;
      methods: Set<NeutronHttpRouteMethod>;
    }> = [];
    let updateCallsPerHour = 0;
    let updateReplayBytesPerHour = 0;
    const mounts: NeutronHttpPostUpdateHandlerRouteMountConfig[] =
      httpRoutes.mounts.map((mount) => {
        if (!isRecord(mount)) throw new Error("Invalid HTTP route mount");
        if (
          typeof mount.id !== "string" ||
          !HTTP_ROUTE_ID_PATTERN.test(mount.id)
        ) {
          throw new Error("Invalid HTTP route mount");
        }
        if (ids.has(mount.id)) {
          throw new Error(`Duplicate HTTP route mount ${mount.id}`);
        }
        ids.add(mount.id);
        if (httpRoutes.api !== 1) {
          throw new Error("Unsupported http_routes capability API");
        }
        assertClosed(mount, "HTTP route mount", [
          "id",
          "surface",
          ...(mount.surface === "app_host" ? ["prefix"] : []),
          "methods",
          "mode",
          "handler",
          "max_request_bytes",
          "max_response_bytes",
          "max_calls_per_hour",
          "forward_headers",
        ]);
        const location =
          mount.surface === "app_host"
            ? {
                surface: "app_host" as const,
                prefix: normalizeHttpRoutePrefix(mount.prefix),
              }
            : mount.surface === "shared_app_path"
              ? { surface: "shared_app_path" as const }
              : null;
        if (
          location === null ||
          mount.mode !== "http_post_update_handler" ||
          typeof mount.handler !== "string" ||
          !METHOD_NAME_PATTERN.test(mount.handler) ||
          !Number.isSafeInteger(mount.max_request_bytes) ||
          Number(mount.max_request_bytes) < 1 ||
          Number(mount.max_request_bytes) >
            HTTP_POST_UPDATE_HANDLER_MAX_REQUEST_BYTES ||
          !Number.isSafeInteger(mount.max_response_bytes) ||
          Number(mount.max_response_bytes) < 1 ||
          Number(mount.max_response_bytes) >
            HTTP_POST_UPDATE_HANDLER_MAX_RESPONSE_BYTES ||
          !Number.isSafeInteger(mount.max_calls_per_hour) ||
          Number(mount.max_calls_per_hour) < 1 ||
          Number(mount.max_calls_per_hour) >
            HTTP_POST_UPDATE_HANDLER_MAX_CALLS_PER_HOUR
        ) {
          throw new Error("Invalid http_post_update_handler mount");
        }
        const methods = sortedUniqueStrings(
          mount.methods,
          `HTTP route methods for ${mount.id}`,
          1,
          1,
          (method) => method === "POST",
        ) as NeutronHttpPostUpdateHandlerRouteMethod[];
        const forwardHeaders = sortedUniqueStrings(
          mount.forward_headers,
          `HTTP forwarded headers for ${mount.id}`,
          0,
          HTTP_POST_UPDATE_HANDLER_MAX_FORWARD_HEADERS,
          (header) =>
            HTTP_HEADER_NAME_PATTERN.test(header) &&
            !HTTP_POST_UPDATE_HANDLER_FORBIDDEN_FORWARD_HEADERS.has(header) &&
            !header.startsWith("ic-") &&
            !header.startsWith("proxy-") &&
            !header.startsWith("sec-"),
        );
        const maxCallsPerHour = Number(mount.max_calls_per_hour);
        const maxResponseBytes = Number(mount.max_response_bytes);
        updateCallsPerHour += maxCallsPerHour;
        updateReplayBytesPerHour += maxCallsPerHour * maxResponseBytes;
        const normalizedMount: NeutronHttpPostUpdateHandlerRouteMountConfig = {
          id: mount.id,
          ...location!,
          methods,
          mode: "http_post_update_handler",
          handler: mount.handler,
          max_request_bytes: Number(mount.max_request_bytes),
          max_response_bytes: maxResponseBytes,
          max_calls_per_hour: maxCallsPerHour,
          forward_headers: forwardHeaders,
        };

        if (normalizedMount.surface === "app_host") {
          const methods = new Set(normalizedMount.methods);
          for (const existing of occupiedAppHost) {
            if (
              httpRoutePrefixesOverlap(
                existing.prefix,
                normalizedMount.prefix,
              ) &&
              [...methods].some((method) => existing.methods.has(method))
            ) {
              throw new Error(
                `Overlapping HTTP route prefixes ${existing.prefix} and ${normalizedMount.prefix}`,
              );
            }
          }
          occupiedAppHost.push({ prefix: normalizedMount.prefix, methods });
        }
        return normalizedMount;
      });
    if (
      updateCallsPerHour > HTTP_POST_UPDATE_HANDLERS_MAX_CALLS_PER_HOUR ||
      updateReplayBytesPerHour >
        HTTP_POST_UPDATE_HANDLERS_MAX_REPLAY_BYTES_PER_HOUR
    ) {
      throw new Error("http_post_update_handler aggregate limits exceeded");
    }
    mounts.sort((left, right) => compareCanonicalText(left.id, right.id));
    normalized.http_routes = { api: 1, mounts };
  }

  const certifiedAssets = declaration.certified_assets;
  if (certifiedAssets !== undefined) {
    assertClosed(certifiedAssets, "certified_assets capability", [
      "api",
      "max_entries",
      "max_committed_bytes",
      "max_object_bytes",
      "max_pending_stages",
      "max_staged_bytes",
      "max_batch_operations",
      "max_batch_bytes",
      "max_idempotency_receipts",
      "collections",
    ]);
    assertApi(certifiedAssets, "certified_assets", 2);
    const maxEntries = positiveBoundedInteger(
      certifiedAssets.max_entries,
      CERTIFIED_ASSETS_MAX_ENTRIES,
      "certified_assets max_entries",
    );
    const maxCommittedBytes = positiveBoundedInteger(
      certifiedAssets.max_committed_bytes,
      CERTIFIED_ASSETS_MAX_COMMITTED_BYTES,
      "certified_assets max_committed_bytes",
    );
    const maxObjectBytes = positiveBoundedInteger(
      certifiedAssets.max_object_bytes,
      CERTIFIED_ASSETS_MAX_OBJECT_BYTES,
      "certified_assets max_object_bytes",
    );
    const maxPendingStages = positiveBoundedInteger(
      certifiedAssets.max_pending_stages,
      CERTIFIED_ASSETS_MAX_PENDING_STAGES,
      "certified_assets max_pending_stages",
    );
    const maxStagedBytes = positiveBoundedInteger(
      certifiedAssets.max_staged_bytes,
      CERTIFIED_ASSETS_MAX_STAGED_BYTES,
      "certified_assets max_staged_bytes",
    );
    const maxBatchOperations = positiveBoundedInteger(
      certifiedAssets.max_batch_operations,
      CERTIFIED_ASSETS_MAX_BATCH_OPERATIONS,
      "certified_assets max_batch_operations",
    );
    const maxBatchBytes = positiveBoundedInteger(
      certifiedAssets.max_batch_bytes,
      CERTIFIED_ASSETS_MAX_BATCH_BYTES,
      "certified_assets max_batch_bytes",
    );
    const maxIdempotencyReceipts = positiveBoundedInteger(
      certifiedAssets.max_idempotency_receipts,
      CERTIFIED_ASSETS_MAX_IDEMPOTENCY_RECEIPTS,
      "certified_assets max_idempotency_receipts",
    );
    if (
      maxIdempotencyReceipts < CERTIFIED_ASSETS_MIN_IDEMPOTENCY_RECEIPTS ||
      maxObjectBytes > maxCommittedBytes ||
      maxObjectBytes > maxStagedBytes ||
      maxObjectBytes > maxBatchBytes ||
      maxBatchOperations > maxEntries ||
      maxPendingStages > maxIdempotencyReceipts ||
      !Array.isArray(certifiedAssets.collections) ||
      certifiedAssets.collections.length < 1 ||
      certifiedAssets.collections.length > CERTIFIED_ASSETS_MAX_COLLECTIONS ||
      certifiedAssets.collections.length > maxEntries
    ) {
      throw new Error("Invalid certified_assets limits");
    }
    const collectionIds = new Set<string>();
    const collections = certifiedAssets.collections.map((collection) => {
      assertClosed(collection, "certified_assets collection", [
        "id",
        "mount",
        "kind",
        "path_prefix",
        "exact_path",
        "max_object_bytes",
      ]);
      if (
        typeof collection.id !== "string" ||
        !HTTP_ROUTE_ID_PATTERN.test(collection.id) ||
        typeof collection.mount !== "string" ||
        !HTTP_ROUTE_ID_PATTERN.test(collection.mount)
      ) {
        throw new Error("Invalid certified_assets collection");
      }
      if (collectionIds.has(collection.id)) {
        throw new Error(
          `Duplicate certified_assets collection ${collection.id}`,
        );
      }
      collectionIds.add(collection.id);
      const collectionMaximum =
        collection.max_object_bytes === undefined
          ? undefined
          : positiveBoundedInteger(
              collection.max_object_bytes,
              maxObjectBytes,
              `certified_assets collection ${collection.id} max_object_bytes`,
            );
      const common = {
        id: collection.id,
        mount: collection.mount,
        ...(collectionMaximum === undefined
          ? {}
          : { max_object_bytes: collectionMaximum }),
      };
      if (collection.kind === "publication") {
        if (
          Object.prototype.hasOwnProperty.call(collection, "path_prefix") ||
          Object.prototype.hasOwnProperty.call(collection, "exact_path")
        ) {
          throw new Error(`Invalid publication collection ${collection.id}`);
        }
        return { ...common, kind: "publication" as const };
      }
      if (collection.kind === "immutable_blob") {
        if (Object.prototype.hasOwnProperty.call(collection, "exact_path")) {
          throw new Error(`Invalid immutable_blob collection ${collection.id}`);
        }
        if (
          (collectionMaximum ?? maxObjectBytes) >
          CERTIFIED_ASSETS_PORTABLE_BLOB_BODY_BYTES_MAX
        ) {
          throw new Error(
            `certified_assets collection ${collection.id} max_object_bytes exceeds the portable blob limit`,
          );
        }
        return {
          ...common,
          kind: "immutable_blob" as const,
          path_prefix: normalizeCertifiedCollectionPath(
            collection.path_prefix,
            `certified_assets collection ${collection.id} path_prefix`,
            "prefix",
          ),
        };
      }
      if (collection.kind === "mutable_blob") {
        const hasPrefix = Object.prototype.hasOwnProperty.call(
          collection,
          "path_prefix",
        );
        const hasExact = Object.prototype.hasOwnProperty.call(
          collection,
          "exact_path",
        );
        if (hasPrefix === hasExact) {
          throw new Error(`Invalid mutable_blob collection ${collection.id}`);
        }
        if (
          (collectionMaximum ?? maxObjectBytes) >
          CERTIFIED_ASSETS_PORTABLE_BLOB_BODY_BYTES_MAX
        ) {
          throw new Error(
            `certified_assets collection ${collection.id} max_object_bytes exceeds the portable blob limit`,
          );
        }
        return hasPrefix
          ? {
              ...common,
              kind: "mutable_blob" as const,
              path_prefix: normalizeCertifiedCollectionPath(
                collection.path_prefix,
                `certified_assets collection ${collection.id} path_prefix`,
                "prefix",
              ),
            }
          : {
              ...common,
              kind: "mutable_blob" as const,
              exact_path: normalizeCertifiedCollectionPath(
                collection.exact_path,
                `certified_assets collection ${collection.id} exact_path`,
                "exact",
              ),
            };
      }
      throw new Error(
        `Invalid certified_assets collection kind ${collection.id}`,
      );
    }) as NeutronCertifiedAssetsCollectionConfig[];
    collections.sort((left, right) => compareCanonicalText(left.id, right.id));
    for (let left = 0; left < collections.length; left += 1) {
      for (let right = left + 1; right < collections.length; right += 1) {
        if (
          certifiedCollectionPathsOverlap(
            collections[left]!,
            collections[right]!,
          )
        ) {
          throw new Error(
            `Overlapping certified_assets collections ${collections[left]!.id} and ${collections[right]!.id}`,
          );
        }
      }
    }
    normalized.certified_assets = {
      api: 2,
      max_entries: maxEntries,
      max_committed_bytes: maxCommittedBytes,
      max_object_bytes: maxObjectBytes,
      max_pending_stages: maxPendingStages,
      max_staged_bytes: maxStagedBytes,
      max_batch_operations: maxBatchOperations,
      max_batch_bytes: maxBatchBytes,
      max_idempotency_receipts: maxIdempotencyReceipts,
      collections,
    };
  }

  return normalized;
}

function normalizeBackendCallInstallReservations(
  value: unknown,
  allowedScopes: readonly NeutronBackendCallReservationScope[],
): NeutronBackendCallReservation[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > BACKEND_CALLS_MAX_INSTALL_RESERVATIONS_PER_APP
  ) {
    throw new Error("Invalid backend_calls install_reservations");
  }
  const seen = new Set<string>();
  const reservations = value.map((candidate) => {
    assertClosed(candidate, "backend_calls install reservation", [
      "kind",
      "principal",
      "method",
    ]);
    if (
      candidate.kind !== "exact" &&
      candidate.kind !== "principal" &&
      candidate.kind !== "method"
    ) {
      throw new Error("Invalid backend_calls install reservation kind");
    }
    if (!allowedScopes.includes(candidate.kind)) {
      throw new Error(
        `backend_calls install reservation uses undeclared ${candidate.kind} scope`,
      );
    }
    const expected =
      candidate.kind === "exact"
        ? ["kind", "principal", "method"]
        : candidate.kind === "principal"
          ? ["kind", "principal"]
          : ["kind", "method"];
    assertClosed(candidate, "backend_calls install reservation", expected);
    const principal =
      candidate.kind === "exact" || candidate.kind === "principal"
        ? normalizeBackendCallPrincipal(candidate.principal)
        : undefined;
    const method =
      candidate.kind === "exact" || candidate.kind === "method"
        ? normalizeBackendCallMethod(candidate.method)
        : undefined;
    const normalized = {
      kind: candidate.kind,
      ...(principal ? { principal } : {}),
      ...(method ? { method } : {}),
    } as NeutronBackendCallReservation;
    const key = backendCallInstallReservationKey(normalized);
    if (seen.has(key)) {
      throw new Error("Duplicate backend_calls install reservation");
    }
    seen.add(key);
    return normalized;
  });
  reservations.sort((left, right) =>
    compareCanonicalText(
      backendCallInstallReservationKey(left),
      backendCallInstallReservationKey(right),
    ),
  );
  return reservations;
}

function normalizeBackendCallPrincipal(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid backend_calls install reservation principal");
  }
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch (cause) {
    throw new Error("Invalid backend_calls install reservation principal", {
      cause,
    });
  }
  const bytes = principal.toUint8Array();
  if (
    principal.toText() !== value ||
    principal.isAnonymous() ||
    value === "aaaaa-aa" ||
    bytes.length < 1 ||
    bytes.length > 29 ||
    bytes.at(-1) !== 0x01
  ) {
    throw new Error(
      "backend_calls install reservation principal must be a canonical canister principal",
    );
  }
  return value;
}

function normalizeBackendCallMethod(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > CANISTER_METHOD_MAX_LENGTH ||
    !/^[a-zA-Z0-9_]+$/u.test(value)
  ) {
    throw new Error("Invalid backend_calls install reservation method");
  }
  return value;
}

function createCapabilityDeclarationFieldsSchema(
  untrustedTextPattern: string,
): Schema {
  const api: Schema = { type: "integer", enum: [1] };
  const api2: Schema = { type: "integer", enum: [2] };
  const displayText: Schema = {
    type: "string",
    minLength: 1,
    maxLength: 280,
    pattern: untrustedTextPattern,
  };
  return {
    type: "object",
    minProperties: 1,
    properties: {
      backend_calls: {
        type: "object",
        properties: {
          api,
          description: displayText,
          reservation_scopes: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            uniqueItems: true,
            items: { type: "string", enum: ["exact", "principal", "method"] },
          },
          install_reservations: {
            type: "array",
            minItems: 1,
            maxItems: 64,
            uniqueItems: true,
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    kind: { type: "string", enum: ["exact"] },
                    principal: {
                      type: "string",
                      minLength: 1,
                      maxLength: 63,
                    },
                    method: {
                      type: "string",
                      minLength: 1,
                      maxLength: CANISTER_METHOD_MAX_LENGTH,
                      pattern: "^[a-zA-Z0-9_]+$",
                    },
                  },
                  required: ["kind", "principal", "method"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    kind: { type: "string", enum: ["principal"] },
                    principal: {
                      type: "string",
                      minLength: 1,
                      maxLength: 63,
                    },
                  },
                  required: ["kind", "principal"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    kind: { type: "string", enum: ["method"] },
                    method: {
                      type: "string",
                      minLength: 1,
                      maxLength: CANISTER_METHOD_MAX_LENGTH,
                      pattern: "^[a-zA-Z0-9_]+$",
                    },
                  },
                  required: ["kind", "method"],
                  additionalProperties: false,
                },
              ],
            },
          },
          max_concurrency: { type: "integer", minimum: 1, maximum: 20 },
          max_cycles_per_call: {
            type: "integer",
            minimum: 0,
            maximum: BACKEND_CALLS_MAX_CYCLES_PER_CALL,
          },
          max_cycles_per_day: {
            type: "integer",
            minimum: 0,
            maximum: BACKEND_CALLS_MAX_CYCLES_PER_DAY,
          },
        },
        required: [
          "api",
          "description",
          "reservation_scopes",
          "max_concurrency",
          "max_cycles_per_call",
          "max_cycles_per_day",
        ],
        additionalProperties: false,
      },
      randomness: {
        type: "object",
        properties: { api },
        required: ["api"],
        additionalProperties: false,
      },
      chain_key_signing: {
        type: "object",
        properties: {
          api,
          slots: {
            type: "array",
            minItems: 1,
            maxItems: CHAIN_KEY_SIGNING_MAX_SLOTS_PER_APP,
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  minLength: 1,
                  maxLength: 40,
                  pattern: "^[a-z][a-z0-9_]{0,39}$",
                },
                algorithm: {
                  type: "string",
                  enum: [...CHAIN_KEY_SIGNING_ALGORITHMS],
                },
                purpose: {
                  type: "string",
                  minLength: 1,
                  maxLength: 160,
                  pattern: untrustedTextPattern,
                },
                max_assertion_bytes: {
                  type: "integer",
                  minimum: 1,
                  maximum: CHAIN_KEY_SIGNING_MAX_ASSERTION_BYTES,
                },
              },
              required: ["id", "algorithm", "purpose", "max_assertion_bytes"],
              additionalProperties: false,
            },
          },
        },
        required: ["api", "slots"],
        additionalProperties: false,
      },
      stable_store: {
        type: "object",
        properties: {
          api,
          stores: {
            type: "array",
            minItems: 1,
            maxItems: STABLE_STORE_MAX_STORES_PER_APP,
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  minLength: 1,
                  maxLength: 40,
                  pattern: "^[a-z][a-z0-9_]{0,39}$",
                },
                purpose: {
                  type: "string",
                  minLength: 1,
                  maxLength: 160,
                  pattern: untrustedTextPattern,
                },
                schema_version: {
                  type: "integer",
                  minimum: 1,
                  maximum: STABLE_STORE_MAX_SCHEMA_VERSION,
                },
                max_entries: {
                  type: "integer",
                  minimum: 1,
                  maximum: STABLE_STORE_MAX_ENTRIES_PER_STORE,
                },
                max_key_bytes: {
                  type: "integer",
                  minimum: 1,
                  maximum: STABLE_STORE_MAX_KEY_BYTES,
                },
                max_value_bytes: {
                  type: "integer",
                  minimum: 1,
                  maximum: STABLE_STORE_MAX_VALUE_BYTES,
                },
                max_bytes: {
                  type: "integer",
                  minimum: 1,
                  maximum: STABLE_STORE_MAX_BYTES_PER_STORE,
                },
              },
              required: [
                "id",
                "purpose",
                "schema_version",
                "max_entries",
                "max_key_bytes",
                "max_value_bytes",
                "max_bytes",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["api", "stores"],
        additionalProperties: false,
      },
      https_outcalls: {
        type: "object",
        properties: {
          api,
          endpoints: {
            type: "array",
            minItems: 1,
            maxItems: HTTPS_OUTCALLS_MAX_ENDPOINTS_PER_APP,
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  minLength: 1,
                  maxLength: 40,
                  pattern: "^[a-z][a-z0-9_]{0,39}$",
                },
                url_prefix: {
                  type: "string",
                  minLength: 12,
                  maxLength: HTTPS_OUTCALL_MAX_URL_BYTES,
                  pattern: "^https://[^/?#@]+/(?:[A-Za-z0-9._~-]+/)*$",
                },
                methods: {
                  type: "array",
                  minItems: 1,
                  maxItems: 3,
                  uniqueItems: true,
                  items: { type: "string", enum: ["get", "head", "post"] },
                },
                request_headers: {
                  type: "array",
                  maxItems: HTTPS_OUTCALL_MAX_REQUEST_HEADERS,
                  uniqueItems: true,
                  items: {
                    type: "string",
                    minLength: 1,
                    maxLength: 64,
                    pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
                    not: {
                      anyOf: [
                        { enum: [...HTTPS_OUTCALL_FORBIDDEN_REQUEST_HEADERS] },
                        { pattern: "^(?:ic|proxy|sec)-" },
                      ],
                    },
                  },
                },
                max_request_bytes: {
                  type: "integer",
                  minimum: 1,
                  maximum: HTTPS_OUTCALL_MAX_REQUEST_BYTES,
                },
                max_response_bytes: {
                  type: "integer",
                  minimum: 1,
                  maximum: HTTPS_OUTCALL_MAX_RESPONSE_BYTES,
                },
                transform: { type: "string", enum: ["strip_headers"] },
              },
              required: [
                "id",
                "url_prefix",
                "methods",
                "request_headers",
                "max_request_bytes",
                "max_response_bytes",
                "transform",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["api", "endpoints"],
        additionalProperties: false,
      },
      vetkeys: {
        type: "object",
        properties: {
          api,
          description: displayText,
          slots: {
            type: "array",
            minItems: 1,
            maxItems: VETKEYS_MAX_SLOTS_PER_APP,
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  minLength: 1,
                  maxLength: 40,
                  pattern: "^[a-z][a-z0-9_]{0,39}$",
                },
                purpose: displayText,
              },
              required: ["id", "purpose"],
              additionalProperties: false,
            },
          },
        },
        required: ["api", "description", "slots"],
        additionalProperties: false,
      },
      scheduled_tasks: {
        type: "object",
        properties: {
          api,
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: 2,
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  minLength: 1,
                  maxLength: 40,
                  pattern: "^[a-z][a-z0-9_]{0,39}$",
                },
                method: {
                  type: "string",
                  minLength: 1,
                  maxLength: 128,
                  pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$",
                },
                interval_seconds: {
                  type: "integer",
                  minimum: SCHEDULED_TASK_MIN_INTERVAL_SECONDS,
                  maximum: SCHEDULED_TASK_MAX_INTERVAL_SECONDS,
                },
                run_on_start: { type: "boolean" },
                max_backend_calls: {
                  type: "integer",
                  minimum: 1,
                  maximum: 100,
                },
              },
              required: [
                "id",
                "method",
                "interval_seconds",
                "run_on_start",
                "max_backend_calls",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["api", "tasks"],
        additionalProperties: false,
      },
      preapproved_self_calls: {
        type: "object",
        properties: {
          api,
          methods: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            uniqueItems: true,
            items: {
              type: "string",
              minLength: 1,
              maxLength: 128,
              pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$",
            },
          },
        },
        required: ["api", "methods"],
        additionalProperties: false,
      },
      agent_entrypoints: {
        type: "object",
        properties: {
          api,
          entrypoints: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            uniqueItems: true,
            items: {
              type: "string",
              minLength: 1,
              maxLength: 128,
              pattern: "^[a-zA-Z0-9_.-]+$",
            },
          },
        },
        required: ["api", "entrypoints"],
        additionalProperties: false,
      },
      background_ui_requests: {
        type: "object",
        properties: {
          api,
          categories: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            uniqueItems: true,
            items: {
              type: "string",
              enum: [
                "frontend_tool",
                "signed_canister_call",
                "backend_access",
                "connection",
              ],
            },
          },
        },
        required: ["api", "categories"],
        additionalProperties: false,
      },
      ethereum_provider: {
        type: "object",
        properties: {
          api,
          chains: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            uniqueItems: true,
            items: { type: "integer", minimum: 1 },
          },
          methods: {
            type: "array",
            minItems: 1,
            maxItems: ETHEREUM_PROVIDER_METHODS.length,
            uniqueItems: true,
            items: { type: "string", enum: [...ETHEREUM_PROVIDER_METHODS] },
          },
        },
        required: ["api", "chains", "methods"],
        additionalProperties: false,
      },
      connections: {
        type: "object",
        properties: {
          api,
          providers: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                provider: {
                  type: "string",
                  minLength: 2,
                  maxLength: 32,
                  pattern: "^[a-z][a-z0-9_]{1,31}$",
                },
                scopes: {
                  type: "array",
                  maxItems: 32,
                  uniqueItems: true,
                  items: {
                    type: "string",
                    minLength: 1,
                    maxLength: 80,
                    pattern: "^[a-zA-Z0-9._:/-]+$",
                  },
                },
              },
              required: ["provider"],
              additionalProperties: false,
            },
          },
        },
        required: ["api", "providers"],
        additionalProperties: false,
      },
      persistent_browser_storage: {
        type: "object",
        properties: { api, surface: { type: "string", enum: ["background"] } },
        required: ["api", "surface"],
        additionalProperties: false,
      },
      dedicated_resident_origin: {
        type: "object",
        properties: {
          api,
          surface: { type: "string", enum: ["background"] },
          mode: {
            type: "string",
            enum: ["credentialless_ephemeral_v1"],
          },
        },
        required: ["api", "surface", "mode"],
        additionalProperties: false,
      },
      browser_permissions: {
        type: "object",
        properties: {
          api,
          tiles: {
            type: "array",
            minItems: 1,
            maxItems: BROWSER_PERMISSIONS_MAX_TILES,
            uniqueItems: true,
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  minLength: 1,
                  maxLength: TILE_ID_MAX_LENGTH,
                  pattern: TILE_ID_SCHEMA_PATTERN,
                },
                features: {
                  type: "array",
                  minItems: 1,
                  maxItems: BROWSER_PERMISSION_FEATURES.length,
                  uniqueItems: true,
                  items: {
                    type: "string",
                    enum: [...BROWSER_PERMISSION_FEATURES],
                  },
                },
              },
              required: ["id", "features"],
              additionalProperties: false,
            },
          },
        },
        required: ["api", "tiles"],
        additionalProperties: false,
      },
      public_ingress: {
        type: "object",
        properties: {
          api,
          routes: {
            type: "array",
            minItems: 1,
            maxItems: PUBLIC_INGRESS_MAX_ROUTES_PER_APP,
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    protocol: {
                      type: "string",
                      minLength: 1,
                      maxLength: 63,
                      pattern: "^[a-z][a-z0-9_]{0,62}$",
                    },
                    id: {
                      type: "string",
                      minLength: 1,
                      maxLength: 63,
                      pattern: "^[a-z][a-z0-9_]{0,62}$",
                    },
                    handler: {
                      type: "string",
                      minLength: 1,
                      maxLength: 128,
                      pattern: "^[a-zA-Z_][a-zA-Z0-9_]{0,127}$",
                    },
                    mode: { type: "string", enum: ["query"] },
                    caller: {
                      type: "string",
                      enum: ["any", "authenticated", "canister"],
                    },
                    max_request_bytes: {
                      type: "integer",
                      minimum: 1,
                      maximum: PUBLIC_INGRESS_MAX_REQUEST_BYTES,
                    },
                    max_response_bytes: {
                      type: "integer",
                      minimum: 1,
                      maximum: PUBLIC_INGRESS_MAX_RESPONSE_BYTES,
                    },
                  },
                  required: [
                    "protocol",
                    "id",
                    "handler",
                    "mode",
                    "caller",
                    "max_request_bytes",
                    "max_response_bytes",
                  ],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    protocol: {
                      type: "string",
                      minLength: 1,
                      maxLength: 63,
                      pattern: "^[a-z][a-z0-9_]{0,62}$",
                    },
                    id: {
                      type: "string",
                      minLength: 1,
                      maxLength: 63,
                      pattern: "^[a-z][a-z0-9_]{0,62}$",
                    },
                    handler: {
                      type: "string",
                      minLength: 1,
                      maxLength: 128,
                      pattern: "^[a-zA-Z_][a-zA-Z0-9_]{0,127}$",
                    },
                    mode: { type: "string", enum: ["update"] },
                    caller: {
                      type: "string",
                      enum: ["authenticated"],
                    },
                    max_request_bytes: {
                      type: "integer",
                      minimum: 1,
                      maximum: PUBLIC_INGRESS_MAX_REQUEST_BYTES,
                    },
                    max_response_bytes: {
                      type: "integer",
                      minimum: 1,
                      maximum: PUBLIC_INGRESS_MAX_RESPONSE_BYTES,
                    },
                    max_calls_per_hour: {
                      type: "integer",
                      minimum: 1,
                      maximum: PUBLIC_INGRESS_MAX_CALLS_PER_ROUTE_PER_HOUR,
                    },
                    max_calls_per_caller_per_hour: {
                      type: "integer",
                      minimum: 1,
                      maximum: PUBLIC_INGRESS_MAX_CALLS_PER_ROUTE_PER_HOUR,
                    },
                  },
                  required: [
                    "protocol",
                    "id",
                    "handler",
                    "mode",
                    "caller",
                    "max_request_bytes",
                    "max_response_bytes",
                    "max_calls_per_hour",
                  ],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    protocol: {
                      type: "string",
                      minLength: 1,
                      maxLength: 63,
                      pattern: "^[a-z][a-z0-9_]{0,62}$",
                    },
                    id: {
                      type: "string",
                      minLength: 1,
                      maxLength: 63,
                      pattern: "^[a-z][a-z0-9_]{0,62}$",
                    },
                    handler: {
                      type: "string",
                      minLength: 1,
                      maxLength: 128,
                      pattern: "^[a-zA-Z_][a-zA-Z0-9_]{0,127}$",
                    },
                    mode: { type: "string", enum: ["update"] },
                    caller: {
                      type: "string",
                      enum: ["canister"],
                    },
                    max_request_bytes: {
                      type: "integer",
                      minimum: 1,
                      maximum: PUBLIC_INGRESS_MAX_REQUEST_BYTES,
                    },
                    max_response_bytes: {
                      type: "integer",
                      minimum: 1,
                      maximum: PUBLIC_INGRESS_MAX_RESPONSE_BYTES,
                    },
                    max_calls_per_hour: {
                      type: "integer",
                      minimum: 1,
                      maximum: PUBLIC_INGRESS_MAX_CALLS_PER_ROUTE_PER_HOUR,
                    },
                    max_calls_per_caller_per_hour: {
                      type: "integer",
                      minimum: 1,
                      maximum: PUBLIC_INGRESS_MAX_CALLS_PER_ROUTE_PER_HOUR,
                    },
                    required_cycles: {
                      type: "integer",
                      minimum: 1,
                      maximum: PUBLIC_INGRESS_MAX_REQUIRED_CYCLES,
                    },
                  },
                  required: [
                    "protocol",
                    "id",
                    "handler",
                    "mode",
                    "caller",
                    "max_request_bytes",
                    "max_response_bytes",
                    "max_calls_per_hour",
                    "required_cycles",
                  ],
                  additionalProperties: false,
                },
              ],
            },
          },
        },
        required: ["api", "routes"],
        additionalProperties: false,
      },
      http_routes: {
        type: "object",
        properties: {
          api,
          mounts: {
            type: "array",
            minItems: 1,
            maxItems: HTTP_ROUTES_MAX_MOUNTS,
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  minLength: 1,
                  maxLength: 40,
                  pattern: "^[a-z][a-z0-9_]{0,39}$",
                },
                surface: {
                  type: "string",
                  enum: ["app_host", "shared_app_path"],
                },
                prefix: {
                  type: "string",
                  minLength: 2,
                  maxLength: HTTP_ROUTE_PREFIX_MAX_LENGTH,
                  pattern: "^/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$",
                },
                methods: {
                  type: "array",
                  minItems: 1,
                  maxItems: 1,
                  uniqueItems: true,
                  items: { type: "string", enum: ["POST"] },
                },
                mode: {
                  type: "string",
                  enum: ["http_post_update_handler"],
                },
                handler: {
                  type: "string",
                  pattern: "^[a-zA-Z_][a-zA-Z0-9_]{0,127}$",
                },
                max_request_bytes: {
                  type: "integer",
                  minimum: 1,
                  maximum: HTTP_POST_UPDATE_HANDLER_MAX_REQUEST_BYTES,
                },
                max_response_bytes: {
                  type: "integer",
                  minimum: 1,
                  maximum: HTTP_POST_UPDATE_HANDLER_MAX_RESPONSE_BYTES,
                },
                max_calls_per_hour: {
                  type: "integer",
                  minimum: 1,
                  maximum: HTTP_POST_UPDATE_HANDLER_MAX_CALLS_PER_HOUR,
                },
                forward_headers: {
                  type: "array",
                  maxItems: HTTP_POST_UPDATE_HANDLER_MAX_FORWARD_HEADERS,
                  uniqueItems: true,
                  items: {
                    type: "string",
                    pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
                    not: {
                      anyOf: [
                        {
                          enum: [
                            "connection",
                            "content-encoding",
                            "content-length",
                            "cookie",
                            "host",
                            "idempotency-key",
                            "keep-alive",
                            "origin",
                            "set-cookie",
                            "te",
                            "trailer",
                            "transfer-encoding",
                            "upgrade",
                          ],
                        },
                        { pattern: "^(?:ic-|proxy-|sec-)" },
                      ],
                    },
                  },
                },
              },
              required: [
                "id",
                "surface",
                "methods",
                "mode",
                "handler",
                "max_request_bytes",
                "max_response_bytes",
                "max_calls_per_hour",
                "forward_headers",
              ],
              oneOf: [
                {
                  properties: {
                    surface: { type: "string", enum: ["app_host"] },
                  },
                  required: ["prefix"],
                },
                {
                  properties: {
                    surface: {
                      type: "string",
                      enum: ["shared_app_path"],
                    },
                  },
                  not: { required: ["prefix"] },
                },
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["api", "mounts"],
        additionalProperties: false,
      },
      certified_assets: {
        type: "object",
        properties: {
          api: api2,
          max_entries: {
            type: "integer",
            minimum: 1,
            maximum: CERTIFIED_ASSETS_MAX_ENTRIES,
          },
          max_committed_bytes: {
            type: "integer",
            minimum: 1,
            maximum: CERTIFIED_ASSETS_MAX_COMMITTED_BYTES,
          },
          max_object_bytes: {
            type: "integer",
            minimum: 1,
            maximum: CERTIFIED_ASSETS_MAX_OBJECT_BYTES,
          },
          max_pending_stages: {
            type: "integer",
            minimum: 1,
            maximum: CERTIFIED_ASSETS_MAX_PENDING_STAGES,
          },
          max_staged_bytes: {
            type: "integer",
            minimum: 1,
            maximum: CERTIFIED_ASSETS_MAX_STAGED_BYTES,
          },
          max_batch_operations: {
            type: "integer",
            minimum: 1,
            maximum: CERTIFIED_ASSETS_MAX_BATCH_OPERATIONS,
          },
          max_batch_bytes: {
            type: "integer",
            minimum: 1,
            maximum: CERTIFIED_ASSETS_MAX_BATCH_BYTES,
          },
          max_idempotency_receipts: {
            type: "integer",
            minimum: CERTIFIED_ASSETS_MIN_IDEMPOTENCY_RECEIPTS,
            maximum: CERTIFIED_ASSETS_MAX_IDEMPOTENCY_RECEIPTS,
          },
          collections: {
            type: "array",
            minItems: 1,
            maxItems: CERTIFIED_ASSETS_MAX_COLLECTIONS,
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  minLength: 1,
                  maxLength: 40,
                  pattern: "^[a-z][a-z0-9_]{0,39}$",
                },
                mount: {
                  type: "string",
                  minLength: 1,
                  maxLength: 40,
                  pattern: "^[a-z][a-z0-9_]{0,39}$",
                },
                path_prefix: {
                  type: "string",
                  minLength: 2,
                  maxLength: HTTP_ROUTE_PREFIX_MAX_LENGTH,
                  pattern: CERTIFIED_COLLECTION_PREFIX_PATTERN,
                },
                exact_path: {
                  type: "string",
                  minLength: 2,
                  maxLength: HTTP_ROUTE_PREFIX_MAX_LENGTH,
                  pattern: CERTIFIED_COLLECTION_EXACT_PATTERN,
                },
                kind: {
                  type: "string",
                  enum: ["publication", "immutable_blob", "mutable_blob"],
                },
                max_object_bytes: {
                  type: "integer",
                  minimum: 1,
                  maximum: CERTIFIED_ASSETS_MAX_OBJECT_BYTES,
                },
              },
              required: ["id", "mount", "kind"],
              oneOf: [
                {
                  properties: {
                    kind: {
                      type: "string",
                      enum: ["publication"],
                    },
                  },
                  not: {
                    anyOf: [
                      { required: ["path_prefix"] },
                      { required: ["exact_path"] },
                    ],
                  },
                },
                {
                  properties: {
                    kind: {
                      type: "string",
                      enum: ["immutable_blob"],
                    },
                  },
                  required: ["path_prefix"],
                  not: { required: ["exact_path"] },
                },
                {
                  properties: {
                    kind: {
                      type: "string",
                      enum: ["mutable_blob"],
                    },
                  },
                  required: ["path_prefix"],
                  not: { required: ["exact_path"] },
                },
                {
                  properties: {
                    kind: {
                      type: "string",
                      enum: ["mutable_blob"],
                    },
                  },
                  required: ["exact_path"],
                  not: { required: ["path_prefix"] },
                },
              ],
              additionalProperties: false,
            },
          },
        },
        required: [
          "api",
          "max_entries",
          "max_committed_bytes",
          "max_object_bytes",
          "max_pending_stages",
          "max_staged_bytes",
          "max_batch_operations",
          "max_batch_bytes",
          "max_idempotency_receipts",
          "collections",
        ],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
}

export function normalizeDeclaredCapability(
  id: DeclaredCapabilityId,
  value: unknown,
  context: CapabilityNormalizationContext,
): unknown {
  return normalizeCapabilityDeclarationFields({ [id]: value }, context)[id];
}

function schemaForDeclaredCapability(
  id: DeclaredCapabilityId,
  untrustedTextPattern: string,
): Schema {
  const properties = createCapabilityDeclarationFieldsSchema(
    untrustedTextPattern,
  ).properties as Record<string, Schema> | undefined;
  const capabilitySchema = properties?.[id];
  if (!capabilitySchema) throw new Error(`Missing catalogue schema for ${id}`);
  return capabilitySchema;
}

export function normalizeCapabilityDeclarations(
  declaration: unknown,
  context: CapabilityNormalizationContext,
): NormalizedNeutronCapabilitiesConfig {
  if (declaration === undefined) return {};
  assertClosed(
    declaration,
    "capabilities declaration",
    DECLARED_CAPABILITY_IDS,
  );
  if (Object.keys(declaration).length === 0) {
    throw new Error("Capabilities declaration cannot be empty");
  }
  const normalized: Record<string, unknown> = {};
  for (const id of DECLARED_CAPABILITY_IDS) {
    if (declaration[id] === undefined) continue;
    const authored = CAPABILITY_CATALOG[id].authored;
    if (!authored) throw new Error(`Missing authored policy for ${id}`);
    normalized[id] = authored.normalize(declaration[id], context);
  }
  assertCapabilityComposition(
    normalized as NormalizedNeutronCapabilitiesConfig,
    context,
  );
  return normalized as NormalizedNeutronCapabilitiesConfig;
}

export function assertCapabilityComposition(
  normalized: NormalizedNeutronCapabilitiesConfig,
  context: Pick<CapabilityNormalizationContext, "tileIds"> = {},
): void {
  if (
    normalized.persistent_browser_storage &&
    normalized.dedicated_resident_origin
  ) {
    throw new Error(
      "dedicated_resident_origin and persistent_browser_storage are mutually exclusive",
    );
  }
  if (normalized.browser_permissions) {
    const declaredTileIds = new Set(context.tileIds ?? []);
    for (const tile of normalized.browser_permissions.tiles) {
      if (!declaredTileIds.has(tile.id)) {
        throw new Error(
          `browser_permissions references undeclared tile ${tile.id}`,
        );
      }
    }
  }
  const httpRoutes = normalized.http_routes;
  const certifiedAssets = normalized.certified_assets;
  if (!certifiedAssets) return;
  const certifiedReadRoutes = deriveCertifiedReadRoutes(certifiedAssets);
  if (
    (httpRoutes?.mounts.length ?? 0) + certifiedReadRoutes.mounts.length >
    HTTP_ROUTES_MAX_MOUNTS
  ) {
    throw new Error("Aggregate HTTP route mount limit exceeded");
  }
  const postMountIds = new Set(httpRoutes?.mounts.map(({ id }) => id) ?? []);
  for (const mount of certifiedReadRoutes.mounts) {
    if (postMountIds.has(mount.id)) {
      throw new Error(
        `HTTP route mount ${mount.id} collides with a certified read mount`,
      );
    }
  }
}

export function createCapabilityDeclarationsSchema(
  untrustedTextPattern: string,
): Schema {
  return {
    type: "object",
    minProperties: 1,
    properties: Object.fromEntries(
      DECLARED_CAPABILITY_IDS.map((id) => {
        const authored = CAPABILITY_CATALOG[id].authored;
        if (!authored) throw new Error(`Missing authored policy for ${id}`);
        return [id, authored.schema(untrustedTextPattern)];
      }),
    ),
    allOf: [
      {
        not: {
          required: ["persistent_browser_storage", "dedicated_resident_origin"],
        },
      },
    ],
    additionalProperties: false,
  };
}
