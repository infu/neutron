import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const UNICODE_VERSION = "16.0.0";
const UCD_BASE_URL =
  `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd`;
const UNICODE_LICENSE_NOTICE = `UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.`;
const SOURCES = {
  "DerivedNormalizationProps.txt":
    "4d4c03892dea9146d674b686e495df2d55a28d071ac474041d73518f887abddc",
  "NormalizationTest.txt":
    "d811971453e7075e1ad56fb1b301eece5aa80757b81f6156e74a1bfb3ae5ceb1",
  "UnicodeData.txt":
    "ff58e5823bd095166564a006e47d111130813dcf8bf234ef79fa51a870edb48f",
} as const;
const MOTOKO_OUTPUT = path.resolve(
  import.meta.dir,
  "../backend/files/UnicodeNfcData.mo",
);
const TYPESCRIPT_OUTPUT = path.resolve(
  import.meta.dir,
  "../src/protocol/unicode_nfc_data.generated.ts",
);
const VENDORED_SOURCE_DIRECTORY = path.resolve(
  import.meta.dir,
  "unicode/16.0.0",
);
const arguments_ = process.argv.slice(2);
const checkOnly = arguments_.includes("--check");
const refreshSources = arguments_.includes("--refresh");
const unknownArguments = arguments_.filter(
  (argument) => argument !== "--check" && argument !== "--refresh",
);
if (unknownArguments.length > 0) {
  throw new Error(`Unknown arguments: ${unknownArguments.join(" ")}`);
}
const S_BASE = 0xac00;
const S_COUNT = 11_172;

type Range = {
  readonly first: number;
  readonly last: number;
};

type QuickCheckRange = Range & {
  readonly status: "M" | "N";
};

const inputs = new Map<string, string>();
const inputBytes = new Map<keyof typeof SOURCES, Uint8Array>();
for (
  const name of Object.keys(SOURCES) as Array<keyof typeof SOURCES>
) {
  const expectedSha256 = SOURCES[name];
  const bytes = await loadSource(name);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `${name} SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }
  inputBytes.set(name, bytes);
  inputs.set(name, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
if (refreshSources) {
  await fs.mkdir(VENDORED_SOURCE_DIRECTORY, { recursive: true });
  for (
    const name of Object.keys(SOURCES) as Array<keyof typeof SOURCES>
  ) {
    await fs.writeFile(
      path.join(VENDORED_SOURCE_DIRECTORY, `${name}.gz`),
      gzipSync(requiredBytes(inputBytes, name), { level: 9 }),
    );
  }
}

const combiningClasses = new Map<number, number>();
const canonicalDecompositions = new Map<number, readonly number[]>();
const assignedSourceRanges: Range[] = [];
let pendingAssignedRange:
  | {
      readonly first: number;
      readonly stem: string;
      readonly category: string;
    }
  | undefined;
for (
  const line of required(inputs, "UnicodeData.txt").split(/\r?\n/u)
) {
  if (!line) continue;
  const fields = line.split(";");
  if (fields.length !== 15) {
    throw new Error(`Malformed UnicodeData.txt row: ${line}`);
  }
  const scalar = parseCodePoint(fields[0]!);
  const name = fields[1]!;
  const category = fields[2]!;
  if (name.endsWith(", First>")) {
    if (pendingAssignedRange) {
      throw new Error(`Nested UnicodeData.txt range at U+${hex(scalar)}`);
    }
    pendingAssignedRange = {
      first: scalar,
      stem: name.slice(0, -", First>".length),
      category,
    };
  } else if (name.endsWith(", Last>")) {
    if (
      !pendingAssignedRange ||
      pendingAssignedRange.stem !==
        name.slice(0, -", Last>".length) ||
      pendingAssignedRange.category !== category
    ) {
      throw new Error(`Mismatched UnicodeData.txt range at U+${hex(scalar)}`);
    }
    if (category !== "Cs") {
      assignedSourceRanges.push({
        first: pendingAssignedRange.first,
        last: scalar,
      });
    }
    pendingAssignedRange = undefined;
  } else {
    if (pendingAssignedRange) {
      throw new Error(`Unclosed UnicodeData.txt range at U+${hex(scalar)}`);
    }
    if (category !== "Cs") {
      assignedSourceRanges.push({ first: scalar, last: scalar });
    }
  }
  if (scalar >= 0xd800 && scalar <= 0xdfff) continue;
  const combiningClass = Number(fields[3]);
  if (
    !Number.isSafeInteger(combiningClass) ||
    combiningClass < 0 ||
    combiningClass > 255
  ) {
    throw new Error(`Invalid combining class for U+${hex(scalar)}`);
  }
  if (combiningClass !== 0) {
    combiningClasses.set(scalar, combiningClass);
  }
  const decomposition = fields[5]!;
  if (decomposition && !decomposition.startsWith("<")) {
    canonicalDecompositions.set(
      scalar,
      decomposition.split(" ").map(parseHex),
    );
  }
}
if (pendingAssignedRange) {
  throw new Error(
    `Unclosed UnicodeData.txt range from U+${hex(pendingAssignedRange.first)}`,
  );
}

const fullCompositionExclusions: Range[] = [];
const nfcQuickCheck: QuickCheckRange[] = [];
for (
  const rawLine of required(
    inputs,
    "DerivedNormalizationProps.txt",
  ).split(/\r?\n/u)
) {
  const line = rawLine.split("#", 1)[0]!.trim();
  if (!line) continue;
  const fields = line.split(";").map((field) => field.trim());
  if (fields.length < 2 || fields.length > 3) {
    throw new Error(`Malformed DerivedNormalizationProps.txt row: ${rawLine}`);
  }
  const range = parseRange(fields[0]!);
  if (fields[1] === "Full_Composition_Exclusion") {
    fullCompositionExclusions.push(range);
  } else if (fields[1] === "NFC_QC") {
    const status = fields[2];
    if (status !== "M" && status !== "N") {
      throw new Error(`Invalid NFC_QC status: ${rawLine}`);
    }
    nfcQuickCheck.push({ ...range, status });
  }
}

const fullyDecomposed = new Map<number, readonly number[]>();
const decompositionMemo = new Map<number, readonly number[]>();
const decompositionStack = new Set<number>();
for (const scalar of canonicalDecompositions.keys()) {
  if (isHangulSyllable(scalar)) continue;
  const decomposition = fullCanonicalDecomposition(scalar);
  if (decomposition.length !== 1 || decomposition[0] !== scalar) {
    fullyDecomposed.set(scalar, decomposition);
  }
}

const compositions: Array<readonly [number, number, number]> = [];
for (const [composite, decomposition] of canonicalDecompositions) {
  if (inRanges(fullCompositionExclusions, composite)) continue;
  if (decomposition.length !== 2) {
    throw new Error(
      `Non-excluded U+${hex(composite)} decomposition is not a pair`,
    );
  }
  compositions.push([decomposition[0]!, decomposition[1]!, composite]);
}

const combiningClassRanges = compressCombiningClasses(combiningClasses);
const assignedRanges = mergeRanges(assignedSourceRanges);
const sortedDecompositions = [...fullyDecomposed.entries()].sort(
  ([left], [right]) => left - right,
);
compositions.sort(
  ([leftFirst, leftSecond], [rightFirst, rightSecond]) =>
    leftFirst - rightFirst || leftSecond - rightSecond,
);
nfcQuickCheck.sort(
  (left, right) => left.first - right.first || left.last - right.last,
);
assertDisjoint(combiningClassRanges);
assertDisjoint(assignedRanges);
assertDisjoint(nfcQuickCheck);
const normalizationChecks = verifyNormalizationTest(
  required(inputs, "NormalizationTest.txt"),
);

const assignedBytes: number[] = [];
for (const { first, last } of assignedRanges) {
  pushU24(assignedBytes, first);
  pushU24(assignedBytes, last);
}

const combiningClassBytes: number[] = [];
for (const { first, last, value } of combiningClassRanges) {
  pushU24(combiningClassBytes, first);
  pushU24(combiningClassBytes, last);
  combiningClassBytes.push(value);
}

const decompositionIndexBytes: number[] = [];
const decompositionScalars: number[] = [];
let maximumCanonicalDecomposition = 1;
for (const [scalar, decomposition] of sortedDecompositions) {
  if (decompositionScalars.length > 0xffff) {
    throw new Error("Canonical decomposition pool exceeds u16 offsets");
  }
  if (decomposition.length > 0xff) {
    throw new Error(`U+${hex(scalar)} decomposition exceeds u8 length`);
  }
  pushU24(decompositionIndexBytes, scalar);
  pushU16(decompositionIndexBytes, decompositionScalars.length);
  decompositionIndexBytes.push(decomposition.length);
  decompositionScalars.push(...decomposition);
  maximumCanonicalDecomposition = Math.max(
    maximumCanonicalDecomposition,
    decomposition.length,
  );
}
const decompositionPoolBytes: number[] = [];
for (const scalar of decompositionScalars) {
  pushU24(decompositionPoolBytes, scalar);
}

const compositionBytes: number[] = [];
for (const [first, second, composite] of compositions) {
  pushU24(compositionBytes, first);
  pushU24(compositionBytes, second);
  pushU24(compositionBytes, composite);
}

const quickCheckBytes: number[] = [];
for (const { first, last, status } of nfcQuickCheck) {
  pushU24(quickCheckBytes, first);
  pushU24(quickCheckBytes, last);
  quickCheckBytes.push(status === "N" ? 1 : 2);
}

const motokoOutput = `// Generated by scripts/generate_unicode_nfc.ts. Do not edit.
// Unicode Character Database ${UNICODE_VERSION}, Unicode License v3.
// ${UCD_BASE_URL}/UnicodeData.txt
// SHA-256 ${SOURCES["UnicodeData.txt"]}
// ${UCD_BASE_URL}/DerivedNormalizationProps.txt
// SHA-256 ${SOURCES["DerivedNormalizationProps.txt"]}
// ${UCD_BASE_URL}/NormalizationTest.txt
// SHA-256 ${SOURCES["NormalizationTest.txt"]}

module {
    public let unicodeVersion : Text = "${UNICODE_VERSION}";
    public let unicodeLicenseNotice : Text = ${JSON.stringify(UNICODE_LICENSE_NOTICE)};
    public let maximumCanonicalDecomposition : Nat = ${maximumCanonicalDecomposition};

    // NPSS assigned set. Sorted records: first:u24, last:u24.
    public let assignedRangeCount : Nat = ${assignedRanges.length};
    public let assignedRanges : Blob = ${blobLiteral(assignedBytes)};

    // Sorted records: first:u24, last:u24, canonical_combining_class:u8.
    public let combiningClassRangeCount : Nat = ${combiningClassRanges.length};
    public let combiningClassRanges : Blob = ${blobLiteral(combiningClassBytes)};

    // Sorted records: scalar:u24, pool_offset:u16, pool_length:u8.
    public let decompositionCount : Nat = ${sortedDecompositions.length};
    public let decompositionIndex : Blob = ${blobLiteral(decompositionIndexBytes)};
    public let decompositionPool : Blob = ${blobLiteral(decompositionPoolBytes)};

    // Sorted records: first:u24, second:u24, composite:u24.
    public let compositionCount : Nat = ${compositions.length};
    public let compositions : Blob = ${blobLiteral(compositionBytes)};

    // Sorted records: first:u24, last:u24, status:u8 (1 = No, 2 = Maybe).
    public let quickCheckRangeCount : Nat = ${nfcQuickCheck.length};
    public let quickCheckRanges : Blob = ${blobLiteral(quickCheckBytes)};
};
`;

const typescriptOutput = `// Generated by scripts/generate_unicode_nfc.ts. Do not edit.
// Unicode Character Database ${UNICODE_VERSION}, Unicode License v3.
// ${UCD_BASE_URL}/UnicodeData.txt
// SHA-256 ${SOURCES["UnicodeData.txt"]}
// ${UCD_BASE_URL}/DerivedNormalizationProps.txt
// SHA-256 ${SOURCES["DerivedNormalizationProps.txt"]}
// ${UCD_BASE_URL}/NormalizationTest.txt
// SHA-256 ${SOURCES["NormalizationTest.txt"]}

export const UNICODE_NFC_VERSION = "${UNICODE_VERSION}";
export const UNICODE_LICENSE_NOTICE =
  ${JSON.stringify(UNICODE_LICENSE_NOTICE)};
export const UNICODE_MAX_CANONICAL_DECOMPOSITION = ${maximumCanonicalDecomposition};

export const UNICODE_ASSIGNED_RANGE_COUNT = ${assignedRanges.length};
export const UNICODE_ASSIGNED_RANGES_BASE64 =
  "${base64(assignedBytes)}";

export const UNICODE_COMBINING_CLASS_RANGE_COUNT = ${combiningClassRanges.length};
export const UNICODE_COMBINING_CLASS_RANGES_BASE64 =
  "${base64(combiningClassBytes)}";

export const UNICODE_DECOMPOSITION_COUNT = ${sortedDecompositions.length};
export const UNICODE_DECOMPOSITION_INDEX_BASE64 =
  "${base64(decompositionIndexBytes)}";
export const UNICODE_DECOMPOSITION_POOL_BASE64 =
  "${base64(decompositionPoolBytes)}";

export const UNICODE_COMPOSITION_COUNT = ${compositions.length};
export const UNICODE_COMPOSITIONS_BASE64 =
  "${base64(compositionBytes)}";

export const UNICODE_QUICK_CHECK_RANGE_COUNT = ${nfcQuickCheck.length};
export const UNICODE_QUICK_CHECK_RANGES_BASE64 =
  "${base64(quickCheckBytes)}";
`;

if (checkOnly) {
  const existingMotoko = await fs.readFile(MOTOKO_OUTPUT, "utf8");
  const existingTypescript = await fs.readFile(TYPESCRIPT_OUTPUT, "utf8");
  if (existingMotoko !== motokoOutput) {
    throw new Error(
      `${MOTOKO_OUTPUT} is not reproducible from pinned UCD inputs`,
    );
  }
  if (existingTypescript !== typescriptOutput) {
    throw new Error(
      `${TYPESCRIPT_OUTPUT} is not reproducible from pinned UCD inputs`,
    );
  }
  console.log(
    `Verified ${MOTOKO_OUTPUT} and ${TYPESCRIPT_OUTPUT}; ` +
      `${normalizationChecks.toLocaleString("en-US")} NFC conformance checks`,
  );
} else {
  await fs.writeFile(MOTOKO_OUTPUT, motokoOutput, "utf8");
  await fs.writeFile(TYPESCRIPT_OUTPUT, typescriptOutput, "utf8");
  console.log(
    `Generated ${MOTOKO_OUTPUT} and ${TYPESCRIPT_OUTPUT}: ` +
      `${assignedRanges.length} assigned ranges, ` +
      `${combiningClassRanges.length} CCC ranges, ` +
      `${sortedDecompositions.length} decompositions, ` +
      `${compositions.length} compositions, ` +
      `${nfcQuickCheck.length} NFC_QC ranges; ` +
      `${normalizationChecks.toLocaleString("en-US")} NFC conformance checks`,
  );
}

function verifyNormalizationTest(source: string): number {
  let checks = 0;
  let row = 0;
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.split("#", 1)[0]!.trim();
    if (!line || line.startsWith("@")) continue;
    row += 1;
    const fields = line.split(";").map((field) => field.trim());
    if (fields.length < 5) {
      throw new Error(`Malformed NormalizationTest.txt row: ${rawLine}`);
    }
    const [c1, c2, c3, c4, c5] = fields
      .slice(0, 5)
      .map(parseCodePointSequence) as [
        number[],
        number[],
        number[],
        number[],
        number[],
      ];
    const relations: ReadonlyArray<
      readonly [readonly number[], readonly number[], string]
    > = [
      [c1, c2, "NFC(c1)=c2"],
      [c2, c2, "NFC(c2)=c2"],
      [c3, c2, "NFC(c3)=c2"],
      [c4, c4, "NFC(c4)=c4"],
      [c5, c4, "NFC(c5)=c4"],
    ];
    for (const [input, expected, relation] of relations) {
      const actual = normalizeNfcScalars(input);
      if (!scalarsEqual(actual, expected)) {
        throw new Error(
          `NormalizationTest.txt row ${row} failed ${relation}: ` +
            `${formatScalars(input)} -> ${formatScalars(actual)}, ` +
            `expected ${formatScalars(expected)}`,
        );
      }
      checks += 1;
    }
  }
  if (row !== 19_965 || checks !== 99_825) {
    throw new Error(
      `Unexpected NormalizationTest.txt coverage: ${row} rows, ` +
        `${checks} NFC checks`,
    );
  }
  return checks;
}

function normalizeNfcScalars(
  input: readonly number[],
): readonly number[] {
  const decomposed: number[] = [];
  for (const scalar of input) {
    if (isHangulSyllable(scalar)) {
      const syllableIndex = scalar - S_BASE;
      appendCanonicalOrdered(
        decomposed,
        0x1100 + Math.floor(syllableIndex / 588),
      );
      appendCanonicalOrdered(
        decomposed,
        0x1161 + Math.floor((syllableIndex % 588) / 28),
      );
      const trailingIndex = syllableIndex % 28;
      if (trailingIndex !== 0) {
        appendCanonicalOrdered(decomposed, 0x11a7 + trailingIndex);
      }
      continue;
    }
    const decomposition = fullyDecomposed.get(scalar) ?? [scalar];
    for (const part of decomposition) {
      appendCanonicalOrdered(decomposed, part);
    }
  }

  const composed: number[] = [];
  let starterIndex: number | undefined;
  let lastCombiningClass = 0;
  for (const scalar of decomposed) {
    const combiningClass = combiningClasses.get(scalar) ?? 0;
    let consumed = false;
    if (
      starterIndex !== undefined &&
      (lastCombiningClass === 0 || lastCombiningClass < combiningClass)
    ) {
      const combined = composeScalars(composed[starterIndex]!, scalar);
      if (combined !== undefined) {
        composed[starterIndex] = combined;
        consumed = true;
      }
    }
    if (!consumed) {
      composed.push(scalar);
      if (combiningClass === 0) {
        starterIndex = composed.length - 1;
        lastCombiningClass = 0;
      } else {
        lastCombiningClass = combiningClass;
      }
    }
  }
  return composed;
}

function appendCanonicalOrdered(output: number[], scalar: number): void {
  const combiningClass = combiningClasses.get(scalar) ?? 0;
  let insertion = output.length;
  while (combiningClass !== 0 && insertion > 0) {
    const previousClass = combiningClasses.get(output[insertion - 1]!) ?? 0;
    if (
      previousClass === 0 ||
      previousClass <= combiningClass
    ) {
      break;
    }
    insertion -= 1;
  }
  output.splice(insertion, 0, scalar);
}

function composeScalars(
  first: number,
  second: number,
): number | undefined {
  if (
    first >= 0x1100 && first < 0x1100 + 19 &&
    second >= 0x1161 && second < 0x1161 + 21
  ) {
    return (
      S_BASE +
      (first - 0x1100) * 588 +
      (second - 0x1161) * 28
    );
  }
  if (
    isHangulSyllable(first) &&
    (first - S_BASE) % 28 === 0 &&
    second > 0x11a7 &&
    second < 0x11a7 + 28
  ) {
    return first + second - 0x11a7;
  }
  let low = 0;
  let high = compositions.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const [candidateFirst, candidateSecond, composite] =
      compositions[middle]!;
    if (
      first < candidateFirst ||
      (first === candidateFirst && second < candidateSecond)
    ) {
      high = middle;
    } else if (
      first > candidateFirst ||
      (first === candidateFirst && second > candidateSecond)
    ) {
      low = middle + 1;
    } else {
      return composite;
    }
  }
  return undefined;
}

function parseCodePointSequence(value: string): number[] {
  return value === ""
    ? []
    : value.split(" ").map(parseHex);
}

function scalarsEqual(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((scalar, index) => scalar === right[index])
  );
}

function formatScalars(values: readonly number[]): string {
  return values.map((scalar) => `U+${hex(scalar)}`).join(" ");
}

async function loadSource(name: keyof typeof SOURCES): Promise<Uint8Array> {
  const localDirectory = process.env.NEUTRON_UNICODE_UCD16_DIR;
  if (localDirectory) {
    return fs.readFile(path.join(localDirectory, name));
  }
  if (!refreshSources) {
    return new Uint8Array(
      gunzipSync(
        await fs.readFile(
          path.join(VENDORED_SOURCE_DIRECTORY, `${name}.gz`),
        ),
      ),
    );
  }
  const response = await fetch(`${UCD_BASE_URL}/${name}`);
  if (!response.ok) {
    throw new Error(
      `Unable to fetch ${name}: HTTP ${response.status} ${response.statusText}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) {
    throw new Error(`Missing source ${key}`);
  }
  return value;
}

function requiredBytes<K>(
  values: ReadonlyMap<K, Uint8Array>,
  key: K,
): Uint8Array {
  const value = values.get(key);
  if (value === undefined) {
    throw new Error(`Missing binary source ${String(key)}`);
  }
  return value;
}

function parseHex(value: string): number {
  const scalar = parseCodePoint(value);
  if (scalar >= 0xd800 && scalar <= 0xdfff) {
    throw new Error(`Invalid Unicode scalar: U+${value}`);
  }
  return scalar;
}

function parseCodePoint(value: string): number {
  if (!/^[0-9A-F]{4,6}$/u.test(value)) {
    throw new Error(`Invalid Unicode code point encoding: ${value}`);
  }
  const scalar = Number.parseInt(value, 16);
  if (scalar > 0x10ffff) {
    throw new Error(`Invalid Unicode code point: U+${value}`);
  }
  return scalar;
}

function parseRange(value: string): Range {
  const [firstText, lastText = firstText] = value.split("..");
  const first = parseHex(firstText!);
  const last = parseHex(lastText!);
  if (first > last) {
    throw new Error(`Descending Unicode range: ${value}`);
  }
  return { first, last };
}

function fullCanonicalDecomposition(
  scalar: number,
): readonly number[] {
  const existing = decompositionMemo.get(scalar);
  if (existing) return existing;
  if (decompositionStack.has(scalar)) {
    throw new Error(`Canonical decomposition cycle at U+${hex(scalar)}`);
  }
  const direct = canonicalDecompositions.get(scalar);
  if (!direct) return [scalar];
  decompositionStack.add(scalar);
  const result = direct.flatMap((part) => {
    if (isHangulSyllable(part)) {
      throw new Error(
        `Unexpected explicit Hangul decomposition from U+${hex(scalar)}`,
      );
    }
    return fullCanonicalDecomposition(part);
  });
  decompositionStack.delete(scalar);
  decompositionMemo.set(scalar, result);
  return result;
}

function isHangulSyllable(scalar: number): boolean {
  return scalar >= S_BASE && scalar < S_BASE + S_COUNT;
}

function inRanges(ranges: readonly Range[], scalar: number): boolean {
  return ranges.some(
    ({ first, last }) => scalar >= first && scalar <= last,
  );
}

function compressCombiningClasses(
  values: ReadonlyMap<number, number>,
): Array<Range & { readonly value: number }> {
  const result: Array<{
    first: number;
    last: number;
    value: number;
  }> = [];
  for (
    const [scalar, value] of [...values.entries()].sort(
      ([left], [right]) => left - right,
    )
  ) {
    const previous = result.at(-1);
    if (
      previous &&
      previous.last + 1 === scalar &&
      previous.value === value
    ) {
      previous.last = scalar;
    } else {
      result.push({ first: scalar, last: scalar, value });
    }
  }
  return result;
}

function mergeRanges(values: readonly Range[]): Range[] {
  const result: Array<{ first: number; last: number }> = [];
  for (
    const { first, last } of [...values].sort(
      (left, right) => left.first - right.first || left.last - right.last,
    )
  ) {
    const previous = result.at(-1);
    if (previous && first <= previous.last + 1) {
      previous.last = Math.max(previous.last, last);
    } else {
      result.push({ first, last });
    }
  }
  return result;
}

function assertDisjoint(ranges: readonly Range[]): void {
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1]!.last >= ranges[index]!.first) {
      throw new Error(
        `Overlapping ranges U+${hex(ranges[index - 1]!.first)}..` +
          `U+${hex(ranges[index]!.last)}`,
      );
    }
  }
}

function pushU16(output: number[], value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`Value does not fit u16: ${value}`);
  }
  output.push((value >>> 8) & 0xff, value & 0xff);
}

function pushU24(output: number[], value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffff) {
    throw new Error(`Value does not fit u24: ${value}`);
  }
  output.push(
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function blobLiteral(bytes: readonly number[]): string {
  return `"${bytes
    .map((byte) => `\\${byte.toString(16).padStart(2, "0").toUpperCase()}`)
    .join("")}"`;
}

function base64(bytes: readonly number[]): string {
  return Buffer.from(bytes).toString("base64");
}

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}
