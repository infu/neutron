import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const baselineUrl = new URL("../candid/files-v2.did", import.meta.url);
const outputUrl = new URL(
  "../candid/compat/files-v2-methods-future.did",
  import.meta.url,
);

type Replacement = Readonly<{
  from: string;
  to: string;
  count?: number;
}>;

const FUTURE_VARIANTS = Object.freeze([
  ["FilesRejectionReasonV2", "future_reason"],
  ["FilesNodeKindV2", "future_node_kind"],
  ["FilesContentCryptoProfileV2", "future_crypto_profile"],
  ["FilesCleanupStateV2", "future_cleanup_state"],
  ["FilesOperationKindV2", "future_operation_kind"],
  ["FilesVaultStateV2", "future_vault_state"],
  ["FilesLookupLocatorV2", "future_lookup_locator"],
  ["FilesOperationTargetV2", "future_operation_target"],
  ["FilesCommittedDetailV2", "future_committed_detail"],
  ["FilesOperationStateV2", "future_operation_state"],
  ["FilesVaultWriteOperationV2", "future_vault_write_operation"],
  ["FilesMutationActionV2", "future_mutation_action"],
] as const);

export function generateFilesV2FutureCompat(baseline: string): string {
  const replacements: Replacement[] = [
    {
      from: "// Canonical logical Files V2 service contract.",
      to: [
        "// Synthetic future Files V2 service used only as a rolling-compatibility encoder.",
        "// It preserves every published method while adding ignorable optional fields",
        "// and future tags only at the baseline optional-variant boundaries.",
      ].join("\n"),
    },
    ...FUTURE_VARIANTS.map(([type, tag]) => ({
      from: `type ${type} = variant {`,
      to: `type ${type} = variant {\n  ${tag};`,
    })),
    {
      from: "outcome : opt variant {",
      to: "outcome : opt variant {\n    future_outcome;",
      count: 11,
    },
    {
      from: "frame_kind : opt variant {",
      to: "frame_kind : opt variant {\n        future_frame_kind;",
    },
    {
      from: [
        "type FilesOperationStatusRequestV2 = record {",
        "  request_id : Id128V2;",
        "  target : opt FilesOperationTargetV2;",
        "};",
      ].join("\n"),
      to: [
        "type FilesOperationStatusRequestV2 = record {",
        "  request_id : Id128V2;",
        "  target : opt FilesOperationTargetV2;",
        "  advisory : opt text;",
        "};",
      ].join("\n"),
    },
    {
      from: [
        "type FilesOperationStatusResponseV2 = record {",
        "  outcome : opt variant {",
      ].join("\n"),
      to: [
        "type FilesOperationStatusResponseV2 = record {",
        "  server_advisory : opt text;",
        "  outcome : opt variant {",
      ].join("\n"),
    },
  ];

  let result = baseline;
  for (const replacement of replacements) {
    const expected = replacement.count ?? 1;
    const actual = result.split(replacement.from).length - 1;
    if (actual !== expected) {
      throw new Error(
        `Files V2 future compatibility replacement drifted: expected ${expected} occurrence(s), found ${actual}`,
      );
    }
    result = result.split(replacement.from).join(replacement.to);
  }
  return result;
}

if (import.meta.main) {
  const baseline = await readFile(baselineUrl, "utf8");
  await writeFile(outputUrl, generateFilesV2FutureCompat(baseline), "utf8");
  console.log(fileURLToPath(outputUrl));
}
