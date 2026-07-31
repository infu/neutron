export const SUPPORTED_CERTIFICATE_VERSIONS_SECTION_NAME =
  "icp:public supported_certificate_versions";
export const SUPPORTED_CERTIFICATE_VERSIONS_VALUE = "2";

export type SupportedCertificateVersionsMetadataV1 = {
  sectionName: typeof SUPPORTED_CERTIFICATE_VERSIONS_SECTION_NAME;
  sectionCount: 1;
  value: typeof SUPPORTED_CERTIFICATE_VERSIONS_VALUE;
};

export const SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1 =
  Object.freeze<SupportedCertificateVersionsMetadataV1>({
    sectionName: SUPPORTED_CERTIFICATE_VERSIONS_SECTION_NAME,
    sectionCount: 1,
    value: SUPPORTED_CERTIFICATE_VERSIONS_VALUE,
  });

const WASM_HEADER = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);
const SUPPORTED_CERTIFICATE_VERSIONS = new Uint8Array([0x32]);
const textEncoder = new TextEncoder();
const sectionName = textEncoder.encode(
  SUPPORTED_CERTIFICATE_VERSIONS_SECTION_NAME,
);

/**
 * Ensures an IC Wasm module advertises HTTP certification version 2.
 *
 * Existing exact metadata is accepted to keep the operation idempotent.
 * Duplicate sections and conflicting values are rejected because gateways
 * must not have to choose between ambiguous public metadata declarations.
 */
export function withSupportedCertificateVersions(
  wasm: Uint8Array,
): Uint8Array {
  const values = supportedCertificateVersionSections(wasm);

  if (values.length > 1) {
    throw new Error(
      `Duplicate Wasm custom section: ${SUPPORTED_CERTIFICATE_VERSIONS_SECTION_NAME}`,
    );
  }
  if (values.length === 1) {
    if (!bytesEqual(values[0]!, SUPPORTED_CERTIFICATE_VERSIONS)) {
      throw new Error(
        `Wasm custom section ${SUPPORTED_CERTIFICATE_VERSIONS_SECTION_NAME} must contain exact UTF-8 "2"`,
      );
    }
    return wasm;
  }

  const encodedNameSize = encodeU32Leb(sectionName.length);
  const payloadSize =
    encodedNameSize.length +
    sectionName.length +
    SUPPORTED_CERTIFICATE_VERSIONS.length;
  const encodedPayloadSize = encodeU32Leb(payloadSize);
  const result = new Uint8Array(
    wasm.length + 1 + encodedPayloadSize.length + payloadSize,
  );
  let writeOffset = 0;
  result.set(wasm, writeOffset);
  writeOffset += wasm.length;
  result[writeOffset++] = 0;
  result.set(encodedPayloadSize, writeOffset);
  writeOffset += encodedPayloadSize.length;
  result.set(encodedNameSize, writeOffset);
  writeOffset += encodedNameSize.length;
  result.set(sectionName, writeOffset);
  writeOffset += sectionName.length;
  result.set(SUPPORTED_CERTIFICATE_VERSIONS, writeOffset);
  return result;
}

/**
 * Proves that the final deployable Wasm has exactly one public HTTP
 * certification-version section and that its complete payload is UTF-8 `2`.
 *
 * Unlike `withSupportedCertificateVersions`, this never repairs the artifact:
 * callers use it as a release/deployment gate after all compilation and cache
 * reads are complete.
 */
export function assertSupportedCertificateVersions(
  wasm: Uint8Array,
): SupportedCertificateVersionsMetadataV1 {
  const values = supportedCertificateVersionSections(wasm);
  if (values.length !== 1) {
    throw new Error(
      values.length === 0
        ? `Missing Wasm custom section: ${SUPPORTED_CERTIFICATE_VERSIONS_SECTION_NAME}`
        : `Duplicate Wasm custom section: ${SUPPORTED_CERTIFICATE_VERSIONS_SECTION_NAME}`,
    );
  }
  if (!bytesEqual(values[0]!, SUPPORTED_CERTIFICATE_VERSIONS)) {
    throw new Error(
      `Wasm custom section ${SUPPORTED_CERTIFICATE_VERSIONS_SECTION_NAME} must contain exact UTF-8 "2"`,
    );
  }
  return SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1;
}

export function assertSupportedCertificateVersionsMetadata(
  value: unknown,
  label = "supported certificate versions metadata",
): SupportedCertificateVersionsMetadataV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be a record`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "sectionCount" ||
    keys[1] !== "sectionName" ||
    keys[2] !== "value"
  ) {
    throw new Error(`${label} must contain exactly sectionName, sectionCount, and value`);
  }
  if (
    record.sectionName !== SUPPORTED_CERTIFICATE_VERSIONS_SECTION_NAME ||
    record.sectionCount !== 1 ||
    record.value !== SUPPORTED_CERTIFICATE_VERSIONS_VALUE
  ) {
    throw new Error(
      `${label} must name the exact single public supported-certificate section with UTF-8 value "2"`,
    );
  }
  return SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1;
}

function supportedCertificateVersionSections(
  wasm: Uint8Array,
): Uint8Array[] {
  assertWasmHeader(wasm);

  const values: Uint8Array[] = [];
  let offset = WASM_HEADER.length;
  while (offset < wasm.length) {
    const sectionId = wasm[offset++];
    if (sectionId === undefined) throw malformedWasm("missing section id");

    const sectionSize = readU32Leb(
      wasm,
      offset,
      wasm.length,
      "section size",
    );
    offset = sectionSize.next;
    const sectionEnd = offset + sectionSize.value;
    if (sectionEnd > wasm.length) {
      throw malformedWasm("section extends past the end of the module");
    }

    if (sectionId === 0) {
      const nameSize = readU32Leb(
        wasm,
        offset,
        sectionEnd,
        "custom section name",
      );
      const nameStart = nameSize.next;
      const nameEnd = nameStart + nameSize.value;
      if (nameEnd > sectionEnd) {
        throw malformedWasm("custom section name extends past its section");
      }
      if (bytesEqual(wasm.subarray(nameStart, nameEnd), sectionName)) {
        values.push(wasm.subarray(nameEnd, sectionEnd));
      }
    }

    offset = sectionEnd;
  }
  return values;
}

function assertWasmHeader(wasm: Uint8Array): void {
  if (
    wasm.length < WASM_HEADER.length ||
    !bytesEqual(wasm.subarray(0, WASM_HEADER.length), WASM_HEADER)
  ) {
    throw malformedWasm("missing the Wasm magic or version 1 header");
  }
}

function readU32Leb(
  bytes: Uint8Array,
  start: number,
  limit: number,
  field: string,
): { value: number; next: number } {
  let value = 0;
  let offset = start;
  for (let index = 0; index < 5; index++) {
    if (offset >= limit) throw malformedWasm(`truncated ${field}`);
    const byte = bytes[offset++]!;
    if (index === 4 && (byte & 0xf0) !== 0) {
      throw malformedWasm(`${field} exceeds u32`);
    }
    value += (byte & 0x7f) * 2 ** (index * 7);
    if ((byte & 0x80) === 0) return { value, next: offset };
  }
  throw malformedWasm(`${field} exceeds u32`);
}

function encodeU32Leb(value: number): Uint8Array {
  const encoded: number[] = [];
  do {
    const low = value % 0x80;
    value = Math.floor(value / 0x80);
    encoded.push(value === 0 ? low : low | 0x80);
  } while (value !== 0);
  return new Uint8Array(encoded);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function malformedWasm(detail: string): Error {
  return new Error(`Malformed Wasm: ${detail}`);
}
