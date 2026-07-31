import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const ATTACHMENT_CAPACITY_EVIDENCE_SCHEMA =
  "neutron.kernel.attachment-capacity.v1" as const;
export const ATTACHMENT_CAPACITY_IMPLEMENTATION_FINGERPRINT_SCHEMA =
  "neutron.kernel.attachment-capacity-implementation.v1" as const;

export const ATTACHMENT_CAPACITY_LIMITS = [
  {
    name: "MAX_ATTACHMENT_IN_FLIGHT_BYTES_PER_ENDPOINT",
    bytes: 32 * 1024 * 1024,
  },
  {
    name: "MAX_ATTACHMENT_IN_FLIGHT_BYTES_GLOBAL",
    bytes: 64 * 1024 * 1024,
  },
] as const;

export const ATTACHMENT_CAPACITY_IMPLEMENTATION_SOURCES = [
  "apps/kernel/src/attachment_bus.ts",
  "apps/kernel/src/expose.ts",
  "apps/kernel/src/raw_self_update.ts",
  "apps/kernel/src/self_call_transport.ts",
  "apps/kernel/src/self_calls.ts",
  "packages/neutron-tools/src/app_attachments.ts",
] as const;

export type AttachmentCapacityEvidence = {
  schema: typeof ATTACHMENT_CAPACITY_EVIDENCE_SCHEMA;
  limits: {
    name: (typeof ATTACHMENT_CAPACITY_LIMITS)[number]["name"];
    bytes: number;
  }[];
  implementation: {
    fingerprint_schema:
      typeof ATTACHMENT_CAPACITY_IMPLEMENTATION_FINGERPRINT_SCHEMA;
    fingerprint_sha256: string;
    sources: {
      path: (typeof ATTACHMENT_CAPACITY_IMPLEMENTATION_SOURCES)[number];
      sha256: string;
      bytes: number;
    }[];
  };
};

/**
 * Generate the attachment concurrency release binding from exact source
 * bytes. The checked values below are deliberately independent of the
 * implementation declarations: changing either limit requires an explicit
 * evidence-policy update rather than silently changing a release ceiling.
 */
export function buildAttachmentCapacityEvidence(
  repositoryRoot = path.resolve(import.meta.dir, "../../.."),
): AttachmentCapacityEvidence {
  assertImplementationLimitDeclarations(repositoryRoot);
  const sources = ATTACHMENT_CAPACITY_IMPLEMENTATION_SOURCES.map(
    (sourcePath) => {
      const bytes = readFileSync(path.join(repositoryRoot, sourcePath));
      return {
        path: sourcePath,
        sha256: sha256Hex(bytes),
        bytes: bytes.byteLength,
      };
    },
  );
  const fingerprint = Buffer.from(
    JSON.stringify({
      schema: ATTACHMENT_CAPACITY_IMPLEMENTATION_FINGERPRINT_SCHEMA,
      sources,
    }),
    "utf8",
  );
  return {
    schema: ATTACHMENT_CAPACITY_EVIDENCE_SCHEMA,
    limits: ATTACHMENT_CAPACITY_LIMITS.map((limit) => ({ ...limit })),
    implementation: {
      fingerprint_schema:
        ATTACHMENT_CAPACITY_IMPLEMENTATION_FINGERPRINT_SCHEMA,
      fingerprint_sha256: sha256Hex(fingerprint),
      sources,
    },
  };
}

function assertImplementationLimitDeclarations(repositoryRoot: string): void {
  const source = readFileSync(
    path.join(repositoryRoot, "apps/kernel/src/attachment_bus.ts"),
    "utf8",
  );
  for (const limit of ATTACHMENT_CAPACITY_LIMITS) {
    const match = new RegExp(
      `export\\s+const\\s+${limit.name}\\s*=\\s*([^;]+);`,
      "u",
    ).exec(source);
    if (!match) {
      throw new Error(
        `Attachment capacity implementation does not declare ${limit.name}`,
      );
    }
    const actual = evaluateIntegerProduct(
      match[1]!,
      `Attachment capacity implementation declaration ${limit.name}`,
    );
    if (actual !== limit.bytes) {
      throw new Error(
        `Attachment capacity implementation declaration ${limit.name} is ${actual}, expected release-gated value ${limit.bytes}`,
      );
    }
  }
}

function evaluateIntegerProduct(source: string, label: string): number {
  const factors = source
    .trim()
    .split("*")
    .map((factor) => factor.trim());
  if (
    factors.length === 0 ||
    factors.some((factor) => !/^(?:0|[1-9][0-9]*)$/u.test(factor))
  ) {
    throw new Error(`${label} must be a literal integer product`);
  }
  const value = factors.reduce(
    (product, factor) => product * Number(factor),
    1,
  );
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} is outside the positive safe-integer range`);
  }
  return value;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
