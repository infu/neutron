const CANISTER_RESULT_BYTES = 2 * 1024 * 1024;
const SCRIPT_HOST_WRAPPER_BYTES = 8_192;
const COLLECTION_PAGE_BYTES = 2 * 1024 * 1024;
const JSON_ENVELOPE_DEPTH = 3;
const JSON_ENVELOPE_NODES = 64;

// Blast v0.1.0 wrote browser-local schema-v1 values with these bounds. Keep
// them immutable for validating retained rows; narrower limits below apply to
// new writes and values crossing the current public MessagePort envelope.
export const BLAST_STORED_V1_JSON_LIMITS = Object.freeze({
  depth: 64,
  nodes: 100_000,
});

export const BLAST_LIMITS = Object.freeze({
  scriptSourceBytes: 128 * 1024,
  scriptArgumentsBytes: 64 * 1024,
  scriptResultBytes: 128 * 1024,
  scriptHeapBytes: 32 * 1024 * 1024,
  scriptStackBytes: 512 * 1024,
  scriptDefaultTimeoutMs: 120_000,
  scriptMaximumTimeoutMs: 240_000,
  scriptHostCalls: 512,
  scriptConcurrentHostCalls: 4,
  scriptPendingJobs: 20_000,
  // A maximum collection value plus the guest host-call object wrapper.
  scriptHostRequestBytes:
    COLLECTION_PAGE_BYTES + SCRIPT_HOST_WRAPPER_BYTES,
  // A complete canister value plus Blast's closed result envelope.
  scriptHostResponseBytes:
    CANISTER_RESULT_BYTES + SCRIPT_HOST_WRAPPER_BYTES,
  collectionNameCharacters: 120,
  collectionDescriptionCharacters: 1_000,
  collectionSummaryBytes: 16 * 1024,
  collectionPageBytes: COLLECTION_PAGE_BYTES,
  collectionBatchPages: 50,
  collectionBatchBytes: 2 * 1024 * 1024,
  collectionListPage: 100,
  collectionDeleteBatch: 200,
  inlineCallResultBytes: 128 * 1024,
  canisterOperationTimeoutMs: 120_000,
  canisterArgumentItems: 128,
  canisterMethodCharacters: 192,
  canisterResultBytes: CANISTER_RESULT_BYTES,
  canisterSchemaBytes: 128 * 1024,
  canisterGeneratedBindingBytes: 2 * 1024 * 1024,
  // Leave room inside the public MessagePort boundary for the result root and
  // the three ancestors above collection.describe.pages[*].value. Blast counts
  // a value root at depth zero while the SDK counts the result root at one.
  jsonDepth: 60,
  jsonNodes: 99_936,
  jsonEnvelopeDepth: JSON_ENVELOPE_DEPTH,
  jsonEnvelopeNodes: JSON_ENVELOPE_NODES,
  jsonataExpressionCharacters: 16_384,
  jsonataInputBytes: 2 * 1024 * 1024,
  // Keep the complete collection.query envelope below Agent's 192 KiB tool
  // result boundary so its trailing cursor is never replaced by a preview.
  jsonataOutputBytes: 128 * 1024,
  jsonataTimeoutMs: 2_000,
  progressBytes: 16 * 1024,
});
