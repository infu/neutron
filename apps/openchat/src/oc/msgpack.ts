import { Decoder, Encoder } from "@msgpack/msgpack";

// OpenChat's canisters serialize with rmp_serde configured as
// `.with_struct_map().with_large_ints_as_strings()` (backend/libraries/msgpack).
// The byte-compatible client shape is therefore:
//   * structs as msgpack maps keyed by field name  (plain JS objects)
//   * serde `Option::None` as an omitted field or msgpack nil (we send nil)
//   * `serde_bytes` fields as msgpack bin           (Uint8Array)
//   * u64 ids as 64-bit ints                         (bigint, via useBigInt64)
//
// We use @msgpack/msgpack (pure JS, no native deps) rather than msgpackr; the
// wire bytes are the same for this contract. `useBigInt64` preserves u64
// message ids exactly. Any large integers OpenChat stringifies in replies come
// back as strings and are normalized by the view helpers.
const encoder = new Encoder({ useBigInt64: true });
const decoder = new Decoder({ useBigInt64: true });

export function encodeMsgpack(value: unknown): Uint8Array {
  // Copy out of the encoder's shared scratch buffer.
  return encoder.encode(value).slice();
}

export function decodeMsgpack<T = unknown>(bytes: Uint8Array): T {
  return decoder.decode(bytes) as T;
}
