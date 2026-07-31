import { describe, expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { preflightSingleCandidArgument } from "../src/protocol/candid_preflight.ts";
import {
  WAGYU_IDL,
  decodeWagyuPackage,
} from "../src/protocol/index.ts";
import { buildGoldenPackageValues } from "../candid/fixtures/v1-values.ts";

const DIDL = [0x44, 0x49, 0x44, 0x4c] as const;

describe("raw Candid envelope preflight", () => {
  test("closes @dfinity/candid's compatible extra-argument behavior", () => {
    const post = buildGoldenPackageValues().PostBodyV1;
    const bytes = IDL.encode(
      [WAGYU_IDL.PostBodyV1, IDL.Nat],
      [post, 7n],
    );

    expect(IDL.decode([WAGYU_IDL.PostBodyV1], bytes)).toHaveLength(1);
    expect(() => decodeWagyuPackage("PostBodyV1", bytes)).toThrow(
      "expected exactly one top-level argument, received 2",
    );
    expect(() =>
      preflightSingleCandidArgument(new Uint8Array([...DIDL, 0, 0]))
    ).toThrow("expected exactly one top-level argument, received 0");
  });

  test("rejects wrong magic, out-of-range refs, and compound opcodes as refs", () => {
    expect(() =>
      preflightSingleCandidArgument(new Uint8Array([0, ...DIDL.slice(1)]))
    ).toThrow("wrong DIDL magic");

    expect(() =>
      preflightSingleCandidArgument(
        new Uint8Array([...DIDL, 1, 0x6e, 1, 1, 0]),
      )
    ).toThrow("invalid type reference 1");

    expect(() =>
      preflightSingleCandidArgument(
        new Uint8Array([...DIDL, 1, 0x6e, 0x6e, 1, 0]),
      )
    ).toThrow("invalid type reference -18");
  });

  test("bounds table entries, fields, and aggregate members before allocation", () => {
    expect(() =>
      preflightSingleCandidArgument(
        new Uint8Array([...DIDL, ...uleb(257)]),
      )
    ).toThrow("type-table length exceeds 256");

    expect(() =>
      preflightSingleCandidArgument(
        new Uint8Array([...DIDL, 1, 0x6c, ...uleb(513)]),
      )
    ).toThrow("field count exceeds 512");

    const aggregate = [...DIDL, 9];
    for (let type = 0; type < 8; type += 1) {
      aggregate.push(0x6c, ...uleb(512));
      for (let field = 0; field < 512; field += 1) {
        aggregate.push(...uleb(field), 0x7f);
      }
    }
    aggregate.push(0x6c, ...uleb(1));
    expect(() =>
      preflightSingleCandidArgument(new Uint8Array(aggregate))
    ).toThrow("type table exceeds 4096 total members");
  });

  test("bounds graph depth while permitting a finite recursive table", () => {
    const deep = [...DIDL, ...uleb(65)];
    for (let type = 0; type < 65; type += 1) {
      deep.push(0x6e, ...(type === 64 ? [0x7b] : sleb(type + 1)));
    }
    deep.push(1, 0);
    expect(() =>
      preflightSingleCandidArgument(new Uint8Array(deep))
    ).toThrow("type nesting exceeds 64");

    expect(() =>
      preflightSingleCandidArgument(
        new Uint8Array([...DIDL, 1, 0x6e, 0, 1, 0]),
      )
    ).not.toThrow();

    const boundaryCycle = [...DIDL, ...uleb(64)];
    for (let type = 0; type < 64; type += 1) {
      boundaryCycle.push(0x6e, ...sleb((type + 1) % 64));
    }
    boundaryCycle.push(1, 0);
    expect(() =>
      preflightSingleCandidArgument(new Uint8Array(boundaryCycle))
    ).not.toThrow();
  });

  test("does not undercount depth across a cross-linked cycle", () => {
    const crossLinked = [...DIDL, ...uleb(65)];
    crossLinked.push(0x6e, ...sleb(4));
    crossLinked.push(0x6e, ...sleb(0));
    crossLinked.push(0x6c, 2, 0, ...sleb(1), 1, ...sleb(3));
    crossLinked.push(0x6c, 2, 0, ...sleb(0), 1, ...sleb(2));
    for (let type = 4; type < 65; type += 1) {
      crossLinked.push(
        0x6e,
        ...(type === 64 ? [0x7b] : sleb(type + 1)),
      );
    }
    crossLinked.push(1, 3);
    expect(() =>
      preflightSingleCandidArgument(new Uint8Array(crossLinked))
    ).toThrow("type nesting exceeds 64");
  });

  test("rejects non-canonical and unterminated envelope integers", () => {
    expect(() =>
      preflightSingleCandidArgument(
        new Uint8Array([...DIDL, 0x80, 0, 1, 0x7f]),
      )
    ).toThrow("not canonical ULEB128");
    expect(() =>
      preflightSingleCandidArgument(
        new Uint8Array([...DIDL, 0x80, 0x80, 0x80, 0x80, 0x80]),
      )
    ).toThrow("oversized ULEB128");
  });
});

function uleb(value: number): number[] {
  const bytes: number[] = [];
  do {
    const payload = value & 0x7f;
    value >>>= 7;
    bytes.push(value === 0 ? payload : payload | 0x80);
  } while (value !== 0);
  return bytes;
}

function sleb(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (true) {
    const payload = remaining & 0x7f;
    remaining >>= 7;
    const done =
      (remaining === 0 && (payload & 0x40) === 0) ||
      (remaining === -1 && (payload & 0x40) !== 0);
    bytes.push(done ? payload : payload | 0x80);
    if (done) return bytes;
  }
}
