import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const oldDidUrl = new URL(
  "../../candid/compat/files-v2-optional-old.did",
  import.meta.url,
);
const newDidUrl = new URL(
  "../../candid/compat/files-v2-optional-new.did",
  import.meta.url,
);

const futureProbe = `record {
  write_intent = opt variant { future_write };
  mutation_action = opt variant { future_mutation };
  requested_node_kind = opt variant { future_node };
  outcome = opt variant { future_outcome };
  reason = opt variant { future_reason };
  returned_node_kind = opt variant { future_returned_node };
  operation_state = opt variant { future_operation_state };
  committed_detail = opt variant { future_committed_detail };
  cleanup_state = opt variant { future_cleanup_state };
  attachment_frame_kind = opt variant { future_frame_kind };
  advisory = opt "new";
}`;

const knownOldProbe = `record {
  write_intent = opt variant { create };
  mutation_action = opt variant { move };
  requested_node_kind = opt variant { file };
  outcome = opt variant { rejected };
  reason = opt variant { conflict };
  returned_node_kind = opt variant { folder };
  operation_state = opt variant { committed };
  committed_detail = opt variant { private_write };
  cleanup_state = opt variant { pending };
  attachment_frame_kind = opt variant { continuation };
}`;

const knownNewProbe = `record {
  write_intent = opt variant { create };
  mutation_action = opt variant { move };
  requested_node_kind = opt variant { file };
  outcome = opt variant { rejected };
  reason = opt variant { conflict };
  returned_node_kind = opt variant { folder };
  operation_state = opt variant { committed };
  committed_detail = opt variant { private_write };
  cleanup_state = opt variant { pending };
  attachment_frame_kind = opt variant { continuation };
  advisory = opt "ignored by old";
}`;

test("old and future optional-variant fixture files type-check", () => {
  for (const fixture of [oldDidUrl, newDidUrl]) {
    const result = command("didc", ["check", fileURLToPath(fixture)]);
    expect(result.status, output(result)).toBe(0);
  }
});

test("every future extensible tag decodes to null in the initial Files fixture", () => {
  const encoded = encode(newDidUrl, "CompatibilityProbeV2", futureProbe);
  const decoded = decode(oldDidUrl, "CompatibilityProbeV2", encoded);
  for (const field of [
    "write_intent",
    "mutation_action",
    "requested_node_kind",
    "outcome",
    "reason",
    "returned_node_kind",
    "operation_state",
    "committed_detail",
    "cleanup_state",
    "attachment_frame_kind",
  ]) {
    expect(decoded).toContain(`${field} = null`);
  }
  expect(decoded).not.toContain("advisory");
  expect(decoded.match(/ = null/g)).toHaveLength(10);
});

test("known old tags survive future decoding and a missing optional field becomes null", () => {
  const encoded = encode(oldDidUrl, "CompatibilityProbeV2", knownOldProbe);
  const decoded = decode(newDidUrl, "CompatibilityProbeV2", encoded);
  for (const tag of [
    "create",
    "move",
    "file",
    "rejected",
    "conflict",
    "folder",
    "committed",
    "private_write",
    "pending",
    "continuation",
  ]) {
    expect(decoded).toContain(`variant { ${tag} }`);
  }
  expect(decoded).toContain("advisory = null");
});

test("an added optional record field is ignored by the old decoder", () => {
  const encoded = encode(newDidUrl, "CompatibilityProbeV2", knownNewProbe);
  const decoded = decode(oldDidUrl, "CompatibilityProbeV2", encoded);
  expect(decoded).not.toContain("advisory");
  expect(decoded).toContain("write_intent = opt variant { create }");
  expect(decoded).toContain("outcome = opt variant { rejected }");
});

test("the same future tag in a plain variant fails old decoding", () => {
  const encoded = encode(
    newDidUrl,
    "PlainVariantProbeV2",
    "variant { future_plain }",
  );
  const result = command("didc", [
    "decode",
    "--defs",
    fileURLToPath(oldDidUrl),
    "--types",
    "(PlainVariantProbeV2)",
    encoded,
  ]);
  expect(result.status).not.toBe(0);
  expect(output(result)).toContain("Unknown variant field");
});

function encode(
  fixture: URL,
  type: string,
  value: string,
): string {
  const result = command("didc", [
    "encode",
    "--defs",
    fileURLToPath(fixture),
    "--types",
    `(${type})`,
    `(${value})`,
  ]);
  if (result.status !== 0) throw new Error(output(result));
  return processText(result.stdout).trim();
}

function decode(
  fixture: URL,
  type: string,
  encoded: string,
): string {
  const result = command("didc", [
    "decode",
    "--defs",
    fileURLToPath(fixture),
    "--types",
    `(${type})`,
    encoded,
  ]);
  if (result.status !== 0) throw new Error(output(result));
  return processText(result.stdout);
}

function command(
  executable: string,
  arguments_: string[],
): ReturnType<typeof spawnSync> {
  return spawnSync(executable, arguments_, { encoding: "utf8" });
}

function output(result: ReturnType<typeof spawnSync>): string {
  return [result.stdout, result.stderr]
    .map(processText)
    .filter(Boolean)
    .join("\n");
}

function processText(value: string | Buffer | null): string {
  return value === null ? "" : value.toString();
}
