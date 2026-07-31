import { expect, test } from "bun:test";
import {
  assertSupportedCertificateVersions,
  assertSupportedCertificateVersionsMetadata,
  SUPPORTED_CERTIFICATE_VERSIONS_SECTION_NAME,
  SUPPORTED_CERTIFICATE_VERSIONS_VALUE,
  withSupportedCertificateVersions,
} from "../src/wasm_metadata.ts";

const emptyWasm = (): Uint8Array =>
  new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const customSections = (wasm: Uint8Array): Uint8Array[] => {
  const owned = new Uint8Array(wasm.byteLength);
  owned.set(wasm);
  const module = new WebAssembly.Module(owned.buffer);
  return WebAssembly.Module.customSections(
    module,
    SUPPORTED_CERTIFICATE_VERSIONS_SECTION_NAME,
  ).map((section) => new Uint8Array(section));
};

test("appends exact public supported-certificate metadata", () => {
  const wasm = withSupportedCertificateVersions(emptyWasm());

  expect(customSections(wasm)).toEqual([new TextEncoder().encode("2")]);
  expect(assertSupportedCertificateVersions(wasm)).toEqual({
    sectionName: SUPPORTED_CERTIFICATE_VERSIONS_SECTION_NAME,
    sectionCount: 1,
    value: SUPPORTED_CERTIFICATE_VERSIONS_VALUE,
  });
});

test("accepts one exact section without appending another", () => {
  const stamped = withSupportedCertificateVersions(emptyWasm());

  expect(withSupportedCertificateVersions(stamped)).toBe(stamped);
  expect(customSections(stamped)).toHaveLength(1);
});

test("rejects duplicate public supported-certificate metadata", () => {
  const stamped = withSupportedCertificateVersions(emptyWasm());
  const customSection = stamped.subarray(emptyWasm().length);
  const duplicate = new Uint8Array(stamped.length + customSection.length);
  duplicate.set(stamped);
  duplicate.set(customSection, stamped.length);

  expect(() => withSupportedCertificateVersions(duplicate)).toThrow(
    /Duplicate Wasm custom section/,
  );
});

test("rejects a conflicting supported-certificate value", () => {
  const conflicting = withSupportedCertificateVersions(emptyWasm()).slice();
  conflicting[conflicting.length - 1] = new TextEncoder().encode("1")[0]!;

  expect(() => withSupportedCertificateVersions(conflicting)).toThrow(
    /must contain exact UTF-8 "2"/,
  );
});

test("rejects malformed Wasm instead of producing deployable-looking bytes", () => {
  expect(() =>
    withSupportedCertificateVersions(new Uint8Array([0x00, 0x61, 0x73, 0x6d])),
  ).toThrow(/Malformed Wasm/);
});

test("deployment assertion never repairs missing or ambiguous metadata", () => {
  expect(() => assertSupportedCertificateVersions(emptyWasm())).toThrow(
    /Missing Wasm custom section/,
  );

  const stamped = withSupportedCertificateVersions(emptyWasm());
  const customSection = stamped.subarray(emptyWasm().length);
  const duplicate = new Uint8Array(stamped.length + customSection.length);
  duplicate.set(stamped);
  duplicate.set(customSection, stamped.length);
  expect(() => assertSupportedCertificateVersions(duplicate)).toThrow(
    /Duplicate Wasm custom section/,
  );

  const conflicting = stamped.slice();
  conflicting[conflicting.length - 1] = new TextEncoder().encode("1")[0]!;
  expect(() => assertSupportedCertificateVersions(conflicting)).toThrow(
    /must contain exact UTF-8 "2"/,
  );
});

test("receipt metadata is closed and exact", () => {
  const metadata = assertSupportedCertificateVersions(
    withSupportedCertificateVersions(emptyWasm()),
  );
  expect(assertSupportedCertificateVersionsMetadata(metadata)).toEqual(metadata);
  for (const invalid of [
    null,
    { ...metadata, sectionName: "supported_certificate_versions" },
    { ...metadata, sectionCount: 2 },
    { ...metadata, value: "2,1" },
    { ...metadata, extra: true },
  ]) {
    expect(() => assertSupportedCertificateVersionsMetadata(invalid)).toThrow();
  }
});
