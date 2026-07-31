import { WagyuProtocolError } from "./bytes.ts";

const MAGIC = [0x44, 0x49, 0x44, 0x4c] as const;
const MAX_TABLE_ENTRIES = 256;
const MAX_MEMBERS_PER_TYPE = 512;
const MAX_TOTAL_MEMBERS = 4_096;
const MAX_TYPE_DEPTH = 64;
const MAX_SERVICE_NAME_BYTES = 512;

/**
 * Bounds the untrusted Candid type graph before @dfinity/candid constructs it.
 * This parses only the DIDL envelope and type table; value decoding remains
 * owned by the frozen package codec.
 */
export function preflightSingleCandidArgument(bytes: Uint8Array): void {
  const cursor = new Cursor(bytes);
  for (const expected of MAGIC) {
    if (cursor.byte("magic") !== expected) fail("wrong DIDL magic");
  }

  const tableLength = cursor.uleb(MAX_TABLE_ENTRIES, "type-table length");
  const edges: number[][] = Array.from({ length: tableLength }, () => []);
  let totalMembers = 0;

  const members = (label: string): number => {
    const count = cursor.uleb(MAX_MEMBERS_PER_TYPE, `${label} count`);
    totalMembers += count;
    if (totalMembers > MAX_TOTAL_MEMBERS) {
      fail(`type table exceeds ${MAX_TOTAL_MEMBERS} total members`);
    }
    return count;
  };
  const reference = (owner: number, label: string): void => {
    const type = cursor.sleb(label);
    assertTypeReference(type, tableLength, label);
    if (type >= 0) edges[owner]!.push(type);
  };

  for (let owner = 0; owner < tableLength; owner += 1) {
    const constructor = cursor.sleb(`type ${owner} constructor`);
    switch (constructor) {
      case -18:
      case -19:
        reference(owner, `type ${owner} element`);
        break;
      case -20:
      case -21: {
        const count = members(`type ${owner} field`);
        let previous = -1;
        for (let field = 0; field < count; field += 1) {
          const id = cursor.uleb(0xffff_ffff, `type ${owner} field id`);
          if (id <= previous) fail(`type ${owner} field ids are not ascending`);
          previous = id;
          reference(owner, `type ${owner} field type`);
        }
        break;
      }
      case -22: {
        for (const section of ["argument", "result"] as const) {
          const count = members(`function ${owner} ${section}`);
          for (let index = 0; index < count; index += 1) {
            reference(owner, `function ${owner} ${section} type`);
          }
        }
        const annotations = cursor.uleb(3, `function ${owner} annotation count`);
        for (let index = 0; index < annotations; index += 1) {
          const annotation = cursor.uleb(3, `function ${owner} annotation`);
          if (annotation < 1) fail(`function ${owner} has an unknown annotation`);
        }
        break;
      }
      case -23: {
        const count = members(`service ${owner} method`);
        for (let method = 0; method < count; method += 1) {
          const length = cursor.uleb(
            MAX_SERVICE_NAME_BYTES,
            `service ${owner} method-name length`,
          );
          cursor.utf8(length, `service ${owner} method name`);
          reference(owner, `service ${owner} method type`);
        }
        break;
      }
      default:
        fail(`type ${owner} has unsupported constructor ${constructor}`);
    }
  }

  const argumentCount = cursor.uleb(
    MAX_MEMBERS_PER_TYPE,
    "top-level argument count",
  );
  if (argumentCount !== 1) {
    fail(`expected exactly one top-level argument, received ${argumentCount}`);
  }
  assertTypeReference(
    cursor.sleb("top-level argument type"),
    tableLength,
    "top-level argument",
  );
  assertBoundedDepth(edges);
}

function assertTypeReference(
  type: number,
  tableLength: number,
  label: string,
): void {
  if (
    (type >= 0 && type < tableLength) ||
    (type >= -17 && type <= -1) ||
    type === -24
  ) {
    return;
  }
  fail(`${label} has invalid type reference ${type}`);
}

function assertBoundedDepth(edges: readonly (readonly number[])[]): void {
  const index = new Int16Array(edges.length).fill(-1);
  const low = new Int16Array(edges.length);
  const component = new Int16Array(edges.length).fill(-1);
  const onStack = new Uint8Array(edges.length);
  const stack: number[] = [];
  const componentSize: number[] = [];
  let nextIndex = 0;

  const connect = (type: number): void => {
    index[type] = nextIndex;
    low[type] = nextIndex;
    nextIndex += 1;
    stack.push(type);
    onStack[type] = 1;
    for (const child of edges[type]!) {
      if (index[child] === -1) {
        connect(child);
        low[type] = Math.min(low[type]!, low[child]!);
      } else if (onStack[child] === 1) {
        low[type] = Math.min(low[type]!, index[child]!);
      }
    }
    if (low[type] !== index[type]) return;
    const id = componentSize.length;
    let size = 0;
    while (true) {
      const member = stack.pop()!;
      onStack[member] = 0;
      component[member] = id;
      size += 1;
      if (member === type) break;
    }
    componentSize.push(size);
  };
  for (let type = 0; type < edges.length; type += 1) {
    if (index[type] === -1) connect(type);
  }

  const graph = componentSize.map(() => new Set<number>());
  for (let type = 0; type < edges.length; type += 1) {
    for (const child of edges[type]!) {
      if (component[type] !== component[child]) {
        graph[component[type]!]!.add(component[child]!);
      }
    }
  }
  const memo = new Uint16Array(componentSize.length);
  const depth = (id: number): number => {
    if (memo[id] !== 0) return memo[id]!;
    let result = componentSize[id]!;
    for (const child of graph[id]!) {
      result = Math.max(result, componentSize[id]! + depth(child));
    }
    if (result > MAX_TYPE_DEPTH) {
      fail(`type nesting exceeds ${MAX_TYPE_DEPTH}`);
    }
    memo[id] = result;
    return result;
  };
  for (let id = 0; id < componentSize.length; id += 1) depth(id);
}

class Cursor {
  #offset = 0;
  readonly #utf8 = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly bytes: Uint8Array) {}

  byte(label: string): number {
    const value = this.bytes[this.#offset];
    if (value === undefined) fail(`${label} is truncated`);
    this.#offset += 1;
    return value;
  }

  uleb(maximum: number, label: string): number {
    let value = 0n;
    let last = 0;
    for (let index = 0; index < 5; index += 1) {
      const byte = this.byte(label);
      last = byte & 0x7f;
      value |= BigInt(last) << BigInt(index * 7);
      if ((byte & 0x80) === 0) {
        if (index > 0 && last === 0) fail(`${label} is not canonical ULEB128`);
        if (value > BigInt(maximum)) fail(`${label} exceeds ${maximum}`);
        return Number(value);
      }
    }
    fail(`${label} is an oversized ULEB128`);
  }

  sleb(label: string): number {
    let value = 0n;
    let byte = 0;
    let previous = 0;
    let width = 0n;
    for (let index = 0; index < 5; index += 1) {
      previous = byte;
      byte = this.byte(label);
      value |= BigInt(byte & 0x7f) << width;
      width += 7n;
      if ((byte & 0x80) === 0) {
        if (
          index > 0 &&
          ((byte === 0 && (previous & 0x40) === 0) ||
            (byte === 0x7f && (previous & 0x40) !== 0))
        ) {
          fail(`${label} is not canonical SLEB128`);
        }
        if ((byte & 0x40) !== 0) value |= -1n << width;
        if (value < -0x8000_0000n || value > 0x7fff_ffffn) {
          fail(`${label} exceeds the signed 32-bit type range`);
        }
        return Number(value);
      }
    }
    fail(`${label} is an oversized SLEB128`);
  }

  utf8(length: number, label: string): void {
    const end = this.#offset + length;
    if (end > this.bytes.byteLength) fail(`${label} is truncated`);
    try {
      this.#utf8.decode(this.bytes.subarray(this.#offset, end));
    } catch {
      fail(`${label} is not valid UTF-8`);
    }
    this.#offset = end;
  }
}

function fail(message: string): never {
  throw new WagyuProtocolError(
    "WAGYU_INVALID_CANDID_ENVELOPE",
    `Invalid Candid envelope: ${message}`,
  );
}
