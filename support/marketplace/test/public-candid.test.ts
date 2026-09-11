// All rights reserved. See ../LICENSE.
import { expect, test } from "bun:test";
import { assertPublicCandidService, withPublicCandidService } from "../scripts/public-candid.ts";

const PRIVATE_SERVICE = "icp:private candid:service";
const PUBLIC_SERVICE = "icp:public candid:service";
const header = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
const utf8 = new TextEncoder();
const text = new TextDecoder();
const concat = (...values: Uint8Array[]) => {
  const result = new Uint8Array(values.reduce((size, value) => size + value.length, 0));
  let offset = 0;
  for (const value of values) { result.set(value, offset); offset += value.length; }
  return result;
};
const leb = (value: number) => {
  const bytes: number[] = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    bytes.push(byte | (value > 0 ? 128 : 0));
  } while (value > 0);
  return Uint8Array.from(bytes);
};
const section = (id: number, body: Uint8Array) => concat(Uint8Array.of(id), leb(body.length), body);
const custom = (name: string, body: Uint8Array) => {
  const encoded = utf8.encode(name);
  return section(0, concat(leb(encoded.length), encoded, body));
};
const moduleBytes = (...sections: Uint8Array[]) => concat(header, ...sections);

// Decode raw sections independently of the production helper. No compiler,
// Wasm engine or Memory64 support is needed for these artifact assertions.
function sections(wasm: Uint8Array) {
  const records: Array<{ id: number; name?: string; payload: Uint8Array; raw: Uint8Array }> = [];
  let offset = header.length;
  const readLeb = () => {
    let value = 0;
    let scale = 1;
    while (true) {
      const byte = wasm[offset++];
      if (byte === undefined) throw new Error("Truncated fixture section");
      value += (byte & 127) * scale;
      if (!(byte & 128)) return value;
      scale *= 128;
    }
  };
  while (offset < wasm.length) {
    const start = offset;
    const id = wasm[offset++];
    const size = readLeb();
    const end = offset + size;
    if (end > wasm.length) throw new Error("Fixture section exceeds module");
    let name: string | undefined;
    if (id === 0) {
      const nameSize = readLeb();
      name = text.decode(wasm.slice(offset, offset + nameSize));
      offset += nameSize;
    }
    records.push({ id, name, payload: wasm.slice(offset, end), raw: wasm.slice(start, end) });
    offset = end;
  }
  return records;
}

// A small ordinary Wasm function returning 42. Its bytes must survive exactly,
// regardless of metadata placement before, between, or after these sections.
const executable = [
  section(1, Uint8Array.of(1, 0x60, 0, 1, 0x7f)),
  section(3, Uint8Array.of(1, 0)),
  section(7, concat(Uint8Array.of(1, 6), utf8.encode("answer"), Uint8Array.of(0, 0))),
  section(10, Uint8Array.of(1, 4, 0, 0x41, 42, 0x0b)),
];
const service = utf8.encode("// Metadata π: preserve these exact UTF-8 bytes.\nservice : { answer : () -> (nat32) query };\n");

test("only the service visibility changes; executable and private metadata sections remain byte-identical", () => {
  const input = moduleBytes(
    custom("name", Uint8Array.of(0, 1, 0)),
    executable[0],
    custom("icp:private candid:args", utf8.encode("(record { admin : principal })")),
    executable[1],
    custom(PRIVATE_SERVICE, service),
    executable[2],
    custom("icp:private motoko:stable-types", utf8.encode("// stable state\nactor { stable memory : Nat }")),
    custom("icp:private motoko:compiler", utf8.encode("retained compiler metadata")),
    custom("icp:private enhanced-orthogonal-persistence", Uint8Array.of(1, 0, 255)),
    executable[3],
    custom(`${PRIVATE_SERVICE}.extra`, utf8.encode(PRIVATE_SERVICE)),
    custom("other", Uint8Array.of(255, 0, 128, 1)),
  );
  const unchangedInput = input.slice();
  const output = withPublicCandidService(input);
  expect(input).toEqual(unchangedInput);
  expect(output.slice(0, 8)).toEqual(header);
  const before = sections(input);
  const after = sections(output);
  expect(after.length).toBe(before.length);
  for (let i = 0; i < before.length; i++) {
    if (before[i].name === PRIVATE_SERVICE) {
      expect(after[i].name).toBe(PUBLIC_SERVICE);
      expect(after[i].payload).toEqual(service);
    } else {
      expect(after[i].raw).toEqual(before[i].raw);
    }
  }
  expect(after.filter(value => value.name === PRIVATE_SERVICE)).toHaveLength(0);
  expect(after.filter(value => value.name === PUBLIC_SERVICE)).toHaveLength(1);
  expect(() => assertPublicCandidService(output)).not.toThrow();
  expect(() => assertPublicCandidService(input)).toThrow();
});

test("an already-public service is byte-identical and repeated conversion is idempotent", () => {
  const input = moduleBytes(executable[0], custom(PUBLIC_SERVICE, service), ...executable.slice(1));
  expect(() => assertPublicCandidService(input)).not.toThrow();
  const once = withPublicCandidService(input);
  expect(once).toEqual(input);
  expect(withPublicCandidService(once)).toEqual(input);
  const converted = withPublicCandidService(moduleBytes(custom(PRIVATE_SERVICE, service)));
  expect(withPublicCandidService(converted)).toEqual(converted);
});

test("visibility rename correctly changes the section length across a LEB128 boundary", () => {
  const payload = new Uint8Array(128 - 1 - utf8.encode(PRIVATE_SERVICE).length).fill(0x61);
  const following = custom("following", Uint8Array.of(0, 255, 3));
  const output = withPublicCandidService(moduleBytes(custom(PRIVATE_SERVICE, payload), following));
  const [renamed, retained] = sections(output);
  expect(renamed.name).toBe(PUBLIC_SERVICE);
  expect(renamed.payload).toEqual(payload);
  expect(renamed.raw).toEqual(custom(PUBLIC_SERVICE, payload));
  expect(retained.raw).toEqual(following);
  expect(() => assertPublicCandidService(output)).not.toThrow();
});

test("missing exact service metadata is rejected rather than inferred from another section", () => {
  for (const input of [
    moduleBytes(),
    moduleBytes(...executable),
    moduleBytes(custom("icp:private candid:args", service), custom(`${PRIVATE_SERVICE}.extra`, service)),
  ]) {
    expect(() => withPublicCandidService(input)).toThrow();
    expect(() => assertPublicCandidService(input)).toThrow();
  }
});

for (const [first, second] of [
  [PRIVATE_SERVICE, PRIVATE_SERVICE],
  [PUBLIC_SERVICE, PUBLIC_SERVICE],
  [PRIVATE_SERVICE, PUBLIC_SERVICE],
  [PUBLIC_SERVICE, PRIVATE_SERVICE],
]) {
  test(`duplicate service sections are rejected: ${first} plus ${second}`, () => {
    const input = moduleBytes(custom(first, service), executable[0], custom(second, service));
    expect(() => withPublicCandidService(input)).toThrow();
    expect(() => assertPublicCandidService(input)).toThrow();
  });
}

for (const name of [PRIVATE_SERVICE, PUBLIC_SERVICE]) {
  test(`empty service payload is rejected: ${name}`, () => {
    const input = moduleBytes(custom(name, new Uint8Array()), ...executable);
    expect(() => withPublicCandidService(input)).toThrow();
    expect(() => assertPublicCandidService(input)).toThrow();
  });
}
