import { expect, test } from "bun:test";
import type { StaticFileOperation } from "neutron-compiler/src/install.js";
import { starterFileCommitment } from "../starter_file_commitment.ts";

function operation(
  key: string,
  first: number[],
  rest: number[][] = [],
): StaticFileOperation {
  return {
    key,
    val: {
      content: new Uint8Array(first),
      content_type: "text/plain",
      content_encoding: "identity",
      chunks: rest.length + 1,
    },
    chunks: rest.map((content, index) => ({
      chunk_id: index + 1,
      content: new Uint8Array(content),
    })),
  };
}

test("starter file commitment is canonical across upload order", () => {
  const left = operation("/a", [1], [[2], [3]]);
  const right = operation("/b", [4]);
  const expected = starterFileCommitment([left, right]);

  expect(starterFileCommitment([right, left])).toBe(expected);
  expect(
    starterFileCommitment([
      { ...left, chunks: [...left.chunks].reverse() },
      right,
    ]),
  ).toBe(expected);
});

test("starter file commitment covers bytes and HTTP metadata", () => {
  const original = operation("/a", [1], [[2]]);
  const expected = starterFileCommitment([original]);
  const changedContent = operation("/a", [1], [[3]]);
  const changedType = {
    ...original,
    val: { ...original.val, content_type: "application/octet-stream" },
  };

  expect(starterFileCommitment([changedContent])).not.toBe(expected);
  expect(starterFileCommitment([changedType])).not.toBe(expected);
  expect(starterFileCommitment([operation("/b", [1], [[2]])])).not.toBe(
    expected,
  );
});

test("starter file commitment rejects ambiguous payloads", () => {
  const file = operation("/a", [1], [[2]]);
  expect(() => starterFileCommitment([file, file])).toThrow(
    "Duplicate starter file",
  );
  expect(() =>
    starterFileCommitment([
      { ...file, chunks: [{ ...file.chunks[0]!, chunk_id: 2 }] },
    ]),
  ).toThrow("invalid chunk IDs");
});
