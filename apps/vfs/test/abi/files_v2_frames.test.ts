import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type FrameVector = {
  type: string;
  text: string;
  control_candid_hex: string;
  payload_hex?: string;
  files_frame_v2_hex?: string;
};

type FrameContract = {
  frame_api: number;
  encoding: Record<string, unknown>;
  decoder: Record<string, number>;
  classes: Array<{
    id: string;
    method: string;
    direction: "input" | "output";
    control_type: string;
    frame_max_bytes: number;
    control_max_bytes: number | null;
  }>;
  write_geometry: Record<string, number>;
};

type PayloadSlice = Readonly<{ offset: number; length: number }>;
type BlockSlice = PayloadSlice &
  Readonly<{ contentId: string; blockIndex: number }>;

const framesDidUrl = new URL(
  "../../candid/files-v2-frames.did",
  import.meta.url,
);
const contractUrl = new URL(
  "../../candid/files-v2-frames.abi.json",
  import.meta.url,
);
const outerContractUrl = new URL(
  "../../candid/files-v2.abi.json",
  import.meta.url,
);
const vectorsUrl = new URL(
  "../../candid/fixtures/files-v2-frame-vectors.json",
  import.meta.url,
);

test("inner frame controls are valid, named, binary-free Candid records", async () => {
  const did = await readFile(framesDidUrl, "utf8");
  const checked = spawnSync("didc", ["check", fileURLToPath(framesDidUrl)], {
    encoding: "utf8",
  });
  expect(
    checked.status,
    [checked.stdout, checked.stderr].filter(Boolean).join("\n"),
  ).toBe(0);

  const compact = compactCandid(did);
  for (const type of [
    "VaultReadFrameControlV2",
    "VaultWriteFrameControlV2",
    "ListFrameControlV2",
    "LookupFrameControlV2",
    "ReadBlockFrameControlV2",
    "MutateFrameControlV2",
    "WriteBlockFrameControlV2",
  ]) {
    expect(compact).toContain(`type${type}=record{`);
  }
  for (const optionalBoundary of [
    "kind:optFrameNodeKindV2",
    "crypto_profile:optFrameContentCryptoProfileV2",
    "operation:optvariant{",
    "frame:optvariant{first:ReadFirstFrameV2;continuation:ReadContinuationFrameV2;}",
    "requested_kind:optFrameNodeKindV2",
    "action:optvariant{create_folder;rename;move;}",
    "intent:optWriteIntentV2",
    "frame:optvariant{first:WriteFirstFrameV2;continuation:WriteContinuationFrameV2;}",
  ]) {
    expect(compact).toContain(optionalBoundary);
  }
  expect(compact).not.toContain(":blob");
  expect(compact).not.toContain("vecnat8");
  expect(compact).toContain("service:{};");
});

test("the frame-class fixture freezes every method bound and correlated write geometry", async () => {
  const [contract, outer] = await Promise.all([
    readFile(contractUrl, "utf8").then(
      (text) => JSON.parse(text) as FrameContract,
    ),
    readFile(outerContractUrl, "utf8").then(
      (text) =>
        JSON.parse(text) as {
          methods: Array<{
            name: string;
            input_blob: { max_bytes: number } | null;
            output_blob: { max_bytes: number } | null;
          }>;
        },
    ),
  ]);
  expect(contract.frame_api).toBe(2);
  expect(contract.encoding).toEqual({
    prefix: "u32be_control_candid_length",
    prefix_bytes: 4,
    inner_candid_value_count: 1,
    payload_slice_origin: "raw_payload_start",
    payload_partition: "strict_offset_order_exact_gapless",
    write_first_partition:
      "node_metadata_then_wrapped_keys_then_ordinal_zero_blocks",
    write_future_partition: "pinned_blocks_only",
    preserve_exact_received_frame_for_fingerprint: true,
    reject_trailing_inner_candid_values: true,
    reject_unaccounted_payload: true,
  });
  expect(contract.decoder).toEqual({
    control_allocation_bytes: 524_288,
    type_entries: 256,
    recursive_depth: 32,
    decoded_elements: 4_096,
  });
  expect(contract.classes).toEqual([
    frameClass("vault_read", "files_bootstrap_v2", "output", "VaultReadFrameControlV2", 65_536, null),
    frameClass("vault_write", "files_vault_write_v2", "input", "VaultWriteFrameControlV2", 65_536, null),
    frameClass("list", "files_list_v2", "output", "ListFrameControlV2", 524_288, null),
    frameClass("lookup", "files_lookup_v2", "output", "LookupFrameControlV2", 8_192, null),
    frameClass("read", "files_read_chunk_v2", "output", "ReadBlockFrameControlV2", 1_900_000, null),
    frameClass("mutate", "files_mutate_v2", "input", "MutateFrameControlV2", 262_144, null),
    frameClass("write_single_first", "files_write_block_v2", "input", "WriteBlockFrameControlV2", 1_900_000, 9_996),
    frameClass("write_batch_first", "files_write_block_v2", "input", "WriteBlockFrameControlV2", 1_900_000, 196_608),
    frameClass("write_continuation", "files_write_block_v2", "input", "WriteBlockFrameControlV2", 1_900_000, 9_996),
  ]);
  expect(contract.write_geometry).toEqual({
    normal_plaintext_block_bytes: 1_889_984,
    aes_gcm_tag_bytes: 16,
    maximum_ciphertext_block_bytes: 1_890_000,
    maximum_file_bytes: 67_108_864,
    maximum_file_blocks: 36,
    maximum_batch_blocks: 36,
    maximum_single_frames: 36,
    maximum_batch_frames: 7,
    single_control_max_bytes: 9_996,
    batch_first_control_max_bytes: 196_608,
  });
  const outerMethods = new Map(
    outer.methods.map((method) => [method.name, method]),
  );
  for (const frame of contract.classes) {
    const method = outerMethods.get(frame.method);
    if (method === undefined) {
      throw new Error(`${frame.id} has no outer method`);
    }
    expect(
      frame.direction === "input"
        ? method.input_blob?.max_bytes
        : method.output_blob?.max_bytes,
      `${frame.id} outer Blob maximum`,
    ).toBe(frame.frame_max_bytes);
  }

  assertCorrelatedBound(9_996, 1_890_000, 1_900_000, 9_996);
  expect(() =>
    assertCorrelatedBound(9_997, 1_889_999, 1_900_000, 9_996)
  ).toThrow("control");
  expect(() =>
    assertCorrelatedBound(9_996, 1_890_001, 1_900_000, 9_996)
  ).toThrow("frame");

  assertCorrelatedBound(196_608, 1_703_388, 1_900_000, 196_608);
  expect(() =>
    assertCorrelatedBound(196_608, 1_703_389, 1_900_000, 196_608)
  ).toThrow("frame");
});

test("golden inner Candid and FilesFrameV2 bytes stay exact", async () => {
  const vectors = JSON.parse(
    await readFile(vectorsUrl, "utf8"),
  ) as Record<string, FrameVector>;
  for (const vector of Object.values(vectors)) {
    const encoded = didcEncode(vector.type, vector.text);
    expect(encoded).toBe(vector.control_candid_hex);
  }

  const vector = vectors.read_continuation_three_bytes;
  if (
    vector === undefined ||
    vector.payload_hex === undefined ||
    vector.files_frame_v2_hex === undefined
  ) {
    throw new Error("read continuation golden vector is incomplete");
  }
  const control = hexBytes(vector.control_candid_hex);
  const payload = hexBytes(vector.payload_hex);
  const frame = encodeFilesFrame(control, payload);
  expect(bytesHex(frame)).toBe(vector.files_frame_v2_hex);

  const decoded = decodeFilesFrame(frame, 1_900_000);
  expect(decoded.received).toBe(frame);
  expect(bytesHex(decoded.control)).toBe(vector.control_candid_hex);
  expect(bytesHex(decoded.payload)).toBe(vector.payload_hex);
  expect(decoded.control.buffer).toBe(frame.buffer);
  expect(decoded.payload.buffer).toBe(frame.buffer);
});

test("FilesFrameV2 rejects malformed prefixes, invalid controls, trailing values, and plus-one frames", () => {
  const control = hexBytes(
    didcEncode(
      "PayloadSliceV2",
      "record { offset = 0 : nat32; length = 3 : nat32 }",
    ),
  );
  const valid = encodeFilesFrame(control, new Uint8Array([1, 2, 3]));
  expect(decodeFilesFrame(valid, valid.byteLength).payload.byteLength).toBe(3);

  expect(() => decodeFilesFrame(new Uint8Array(3), 100)).toThrow("prefix");

  const zeroControl = new Uint8Array(4);
  expect(() => decodeFilesFrame(zeroControl, 100)).toThrow("empty control");

  const truncated = valid.slice();
  new DataView(truncated.buffer).setUint32(
    0,
    control.byteLength + 4,
    false,
  );
  expect(() => decodeFilesFrame(truncated, truncated.byteLength)).toThrow(
    "truncated control",
  );

  const invalidCandid = encodeFilesFrame(
    new Uint8Array([0x44, 0x49, 0x44, 0x58]),
    new Uint8Array(0),
  );
  expect(() => decodeFilesFrame(invalidCandid, 100)).toThrow("DIDL");

  const twoValues = hexBytes(
    didcEncode(
      "PayloadSliceV2, nat8",
      "record { offset = 0 : nat32; length = 3 : nat32 }, 7 : nat8",
    ),
  );
  expect(() =>
    decodeFilesFrame(encodeFilesFrame(twoValues, new Uint8Array(0)), 1_000)
  ).toThrow("exactly one");

  expect(() => decodeFilesFrame(valid, valid.byteLength - 1)).toThrow(
    "frame maximum",
  );
  expect(() => decodeFilesFrame(valid, valid.byteLength, control.byteLength - 1))
    .toThrow("control maximum");
});

test("every frame class accepts its exact attachment ceiling and rejects one byte more", async () => {
  const contract = JSON.parse(
    await readFile(contractUrl, "utf8"),
  ) as FrameContract;
  const control = hexBytes(
    didcEncode(
      "PayloadSliceV2",
      "record { offset = 0 : nat32; length = 1 : nat32 }",
    ),
  );
  for (const frameClass of contract.classes) {
    const payloadBytes =
      frameClass.frame_max_bytes - 4 - control.byteLength;
    expect(payloadBytes, `${frameClass.id} fixture capacity`).toBeGreaterThanOrEqual(0);
    const exact = encodeFilesFrame(control, new Uint8Array(payloadBytes));
    expect(exact.byteLength, `${frameClass.id} exact frame size`).toBe(
      frameClass.frame_max_bytes,
    );
    expect(
      decodeFilesFrame(exact, frameClass.frame_max_bytes).received,
      `${frameClass.id} exact frame`,
    ).toBe(exact);

    const plusOne = encodeFilesFrame(
      control,
      new Uint8Array(payloadBytes + 1),
    );
    expect(
      () => decodeFilesFrame(plusOne, frameClass.frame_max_bytes),
      `${frameClass.id} plus-one frame`,
    ).toThrow("frame maximum");
  }
});

test("raw slices reject overlap, gaps, zero lengths, bounds errors, and unaccounted payload", () => {
  expect(() => validatePayloadSlices([{ offset: 0, length: 2 }, { offset: 1, length: 2 }], 3))
    .toThrow("offset");
  expect(() => validatePayloadSlices([{ offset: 0, length: 1 }, { offset: 2, length: 1 }], 3))
    .toThrow("offset");
  expect(() => validatePayloadSlices([{ offset: 0, length: 0 }], 0))
    .toThrow("empty slice");
  expect(() => validatePayloadSlices([{ offset: 0, length: 4 }], 3))
    .toThrow("bounds");
  expect(() => validatePayloadSlices([{ offset: 0, length: 2 }], 3))
    .toThrow("unaccounted");
  expect(() => validatePayloadSlices([], 1)).toThrow("unaccounted");

  expect(validatePayloadSlices([], 0)).toBeUndefined();
  expect(
    validatePayloadSlices(
      [{ offset: 0, length: 1 }, { offset: 1, length: 2 }],
      3,
    ),
  ).toBeUndefined();
});

test("write block fixtures reject duplicate logical blocks independently of slice layout", () => {
  const valid: BlockSlice[] = [
    { contentId: "1:2", blockIndex: 0, offset: 0, length: 2 },
    { contentId: "1:2", blockIndex: 1, offset: 2, length: 1 },
  ];
  expect(validateBlockSlices(valid, 3)).toBeUndefined();
  expect(() =>
    validateBlockSlices(
      [
        { contentId: "1:2", blockIndex: 0, offset: 0, length: 2 },
        { contentId: "1:2", blockIndex: 0, offset: 2, length: 1 },
      ],
      3,
    )
  ).toThrow("duplicate logical block");
});

function frameClass(
  id: string,
  method: string,
  direction: "input" | "output",
  control_type: string,
  frame_max_bytes: number,
  control_max_bytes: number | null,
): FrameContract["classes"][number] {
  return {
    id,
    method,
    direction,
    control_type,
    frame_max_bytes,
    control_max_bytes,
  };
}

function didcEncode(type: string, value: string): string {
  const result = spawnSync(
    "didc",
    [
      "encode",
      "--defs",
      fileURLToPath(framesDidUrl),
      "--types",
      `(${type})`,
      `(${value})`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      [result.stdout, result.stderr]
        .map(processText)
        .filter(Boolean)
        .join("\n"),
    );
  }
  return processText(result.stdout).trim();
}

function encodeFilesFrame(
  control: Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  if (control.byteLength > 0xffff_ffff) {
    throw new Error("control is not representable as u32");
  }
  const frame = new Uint8Array(4 + control.byteLength + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, control.byteLength, false);
  frame.set(control, 4);
  frame.set(payload, 4 + control.byteLength);
  return frame;
}

function decodeFilesFrame(
  received: Uint8Array,
  frameMaximum: number,
  controlMaximum = frameMaximum - 4,
): {
  received: Uint8Array;
  control: Uint8Array;
  payload: Uint8Array;
} {
  if (received.byteLength > frameMaximum) {
    throw new Error("FilesFrameV2 exceeds its frame maximum");
  }
  if (received.byteLength < 4) {
    throw new Error("FilesFrameV2 is missing its four-byte prefix");
  }
  const controlLength = new DataView(
    received.buffer,
    received.byteOffset,
    received.byteLength,
  ).getUint32(0, false);
  if (controlLength === 0) {
    throw new Error("FilesFrameV2 has an empty control");
  }
  if (controlLength > received.byteLength - 4) {
    throw new Error("FilesFrameV2 has a truncated control");
  }
  if (controlLength > controlMaximum) {
    throw new Error("FilesFrameV2 exceeds its control maximum");
  }
  const control = received.subarray(4, 4 + controlLength);
  if (candidArgumentCount(control) !== 1) {
    throw new Error("FilesFrameV2 control must contain exactly one Candid value");
  }
  return {
    received,
    control,
    payload: received.subarray(4 + controlLength),
  };
}

function candidArgumentCount(bytes: Uint8Array): number {
  if (
    bytes.byteLength < 5 ||
    bytes[0] !== 0x44 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x44 ||
    bytes[3] !== 0x4c
  ) {
    throw new Error("inner control is not a DIDL message");
  }
  const cursor = { offset: 4 };
  const tableLength = readUleb(bytes, cursor);
  for (let index = 0; index < tableLength; index += 1) {
    const opcode = readSleb(bytes, cursor);
    if (opcode === -18 || opcode === -19) {
      readSleb(bytes, cursor);
      continue;
    }
    if (opcode === -20 || opcode === -21) {
      const fields = readUleb(bytes, cursor);
      for (let field = 0; field < fields; field += 1) {
        readUleb(bytes, cursor);
        readSleb(bytes, cursor);
      }
      continue;
    }
    throw new Error(`unsupported inner Candid type-table opcode ${opcode}`);
  }
  return readUleb(bytes, cursor);
}

function readUleb(bytes: Uint8Array, cursor: { offset: number }): number {
  let value = 0n;
  let shift = 0n;
  while (true) {
    const byte = bytes[cursor.offset];
    if (byte === undefined) throw new Error("truncated unsigned LEB128");
    cursor.offset += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error("oversized unsigned LEB128");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error("unsigned LEB128 exceeds the fixture integer bound");
  }
  return number;
}

function readSleb(bytes: Uint8Array, cursor: { offset: number }): number {
  let value = 0n;
  let shift = 0n;
  let byte = 0;
  while (true) {
    const next = bytes[cursor.offset];
    if (next === undefined) throw new Error("truncated signed LEB128");
    cursor.offset += 1;
    byte = next;
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) break;
    if (shift > 63n) throw new Error("oversized signed LEB128");
  }
  if ((byte & 0x40) !== 0) value |= -1n << shift;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error("signed LEB128 exceeds the fixture integer bound");
  }
  return number;
}

function validatePayloadSlices(
  slices: readonly PayloadSlice[],
  payloadBytes: number,
): void {
  let cursor = 0;
  for (const slice of slices) {
    if (slice.length <= 0) throw new Error("FilesFrameV2 has an empty slice");
    if (slice.offset !== cursor) {
      throw new Error("FilesFrameV2 slice offset is overlapping or gapped");
    }
    const end = slice.offset + slice.length;
    if (!Number.isSafeInteger(end) || end > payloadBytes) {
      throw new Error("FilesFrameV2 slice exceeds payload bounds");
    }
    cursor = end;
  }
  if (cursor !== payloadBytes) {
    throw new Error("FilesFrameV2 has unaccounted payload bytes");
  }
}

function validateBlockSlices(
  blocks: readonly BlockSlice[],
  payloadBytes: number,
): void {
  const logical = new Set<string>();
  for (const block of blocks) {
    const key = `${block.contentId}:${block.blockIndex}`;
    if (logical.has(key)) throw new Error("duplicate logical block");
    logical.add(key);
  }
  validatePayloadSlices(blocks, payloadBytes);
}

function assertCorrelatedBound(
  controlBytes: number,
  payloadBytes: number,
  frameMaximum: number,
  controlMaximum: number,
): void {
  if (controlBytes > controlMaximum) throw new Error("control maximum");
  if (4 + controlBytes + payloadBytes > frameMaximum) {
    throw new Error("frame maximum");
  }
}

function hexBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error("invalid lowercase hex fixture");
  }
  return Uint8Array.from(
    { length: hex.length / 2 },
    (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

function bytesHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function compactCandid(source: string): string {
  return source
    .replace(/\/\/[^\n\r]*/g, "")
    .replace(/\s+/g, "");
}

function processText(value: string | Buffer | null): string {
  return value === null ? "" : value.toString();
}
