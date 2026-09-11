import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { idlFactory as governanceIdl } from "../src/candid/sns_governance.did.js";
import {
  candidArgsFromJson,
  candidArgsToJson,
  candidTypeSchema,
  candidValueFromJson,
  candidValueToJson,
} from "../src/data/candid_codec";

function roundtrip(types: IDL.Type[], json: unknown[]): unknown[] {
  const native = candidArgsFromJson(types, json);
  return candidArgsToJson(types, IDL.decode(types, IDL.encode(types, native)));
}

test("zero and multiple arguments preserve their exact arity", () => {
  expect(roundtrip([], [])).toEqual([]);
  expect(roundtrip([IDL.Nat, IDL.Text, IDL.Bool], ["9007199254740993", "hello", false]))
    .toEqual(["9007199254740993", "hello", false]);
  expect(() => candidArgsFromJson([], [null])).toThrow(/Expected 0/);
  expect(() => candidArgsFromJson([IDL.Nat8], [])).toThrow(/Expected 1/);
  expect(() => candidArgsToJson([IDL.Nat8], [1, 2])).toThrow(/Expected 1/);
});

test("records preserve principals, wide integers, variants, and absent options", () => {
  const type = IDL.Record({
    owner: IDL.Principal, amount: IDL.Nat64,
    note: IDL.Opt(IDL.Text), action: IDL.Variant({ Send: IDL.Null, Amount: IDL.Int }),
  });
  expect(roundtrip([type], [{ owner: "aaaaa-aa", amount: "18446744073709551615", action: { Send: null } }]))
    .toEqual([{ owner: "aaaaa-aa", amount: "18446744073709551615", note: null, action: { Send: null } }]);
  const native = candidValueFromJson(type, { owner: "aaaaa-aa", amount: "0", note: "", action: { Amount: "-10000000000000000000000000000" } }) as Record<string, unknown>;
  expect(Principal.isPrincipal(native.owner)).toBe(true);
  expect(native.note).toEqual([""]);
});

test("integers enforce every fixed width and use compatible native representations", () => {
  for (const [bits, nat, int] of [
    [8, IDL.Nat8, IDL.Int8], [16, IDL.Nat16, IDL.Int16],
    [32, IDL.Nat32, IDL.Int32], [64, IDL.Nat64, IDL.Int64],
  ] as const) {
    const natMax = (1n << BigInt(bits)) - 1n;
    const intMax = (1n << BigInt(bits - 1)) - 1n;
    const intMin = -(1n << BigInt(bits - 1));
    expect(roundtrip([nat, int, int], [natMax.toString(), intMax.toString(), intMin.toString()]))
      .toEqual([natMax.toString(), intMax.toString(), intMin.toString()]);
    expect(typeof candidValueFromJson(nat, "1")).toBe(bits <= 32 ? "number" : "bigint");
    expect(() => candidValueFromJson(nat, (natMax + 1n).toString())).toThrow(/range/);
    expect(() => candidValueFromJson(nat, "-1")).toThrow(/range/);
    expect(() => candidValueFromJson(int, (intMax + 1n).toString())).toThrow(/range/);
    expect(() => candidValueFromJson(int, (intMin - 1n).toString())).toThrow(/range/);
  }
  expect(roundtrip([IDL.Int, IDL.Nat], [-(1n << 200n), 1n << 200n]))
    .toEqual([(-(1n << 200n)).toString(), (1n << 200n).toString()]);
});

test("unsafe, fractional and malformed integers cannot silently truncate", () => {
  for (const invalid of [Number.MAX_SAFE_INTEGER + 1, 1.5, NaN, Infinity, "1e3", "1.0", " 2", "", "0x10", true, null]) {
    expect(() => candidValueFromJson(IDL.Int, invalid, "amount")).toThrow(/amount:/);
  }
  expect(() => candidValueToJson(IDL.Nat64, Number.MAX_SAFE_INTEGER + 1)).toThrow(/lossless/);
});

test("blobs accept exact hex and byte arrays, and serialize as hex", () => {
  const blob = IDL.Vec(IDL.Nat8);
  expect(roundtrip([blob, blob, blob], [{ hex: "00aBff" }, [0, 171, "255"], { hex: "" }]))
    .toEqual([{ hex: "00abff" }, { hex: "00abff" }, { hex: "" }]);
  expect(candidValueFromJson(blob, new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]));
  for (const value of [{ hex: "a" }, { hex: "xx" }, { hex: "0x01" }, { hex: "00", other: true }, [256], [-1], [1.5], new Int8Array([-1])]) {
    expect(() => candidValueFromJson(blob, value)).toThrow();
  }
});

test("numeric typed vectors decode losslessly, preserving signedness", () => {
  expect(roundtrip([IDL.Vec(IDL.Int16), IDL.Vec(IDL.Nat64)], [["-32768", "32767"], ["18446744073709551615"]]))
    .toEqual([["-32768", "32767"], ["18446744073709551615"]]);
  expect(() => candidValueToJson(IDL.Vec(IDL.Nat8), new Int8Array([-1]))).toThrow(/range/);
});

test("natural options never confuse vectors with native option wrappers", () => {
  const option = IDL.Opt(IDL.Vec(IDL.Nat8));
  expect(candidValueFromJson(option, null)).toEqual([]);
  expect(candidValueFromJson(option, [])).toEqual([new Uint8Array()]);
  expect(candidValueFromJson(option, [7])).toEqual([new Uint8Array([7])]);
  expect(roundtrip([option, option], [[], [7]])).toEqual([{ hex: "" }, { hex: "07" }]);
  expect(() => candidValueFromJson(IDL.Opt(IDL.Nat64), ["7"])).toThrow();
});

test("explicit options distinguish null, some null and nested options", () => {
  const opt = IDL.Opt(IDL.Null);
  expect(roundtrip([opt, opt], [null, { $some: null }])).toEqual([null, { $some: null }]);
  const nested = IDL.Opt(opt);
  const values = [null, { $some: null }, { $some: { $some: null } }];
  expect(roundtrip([nested, nested, nested], values)).toEqual(values);
  expect(candidValueFromJson(nested, values[1])).toEqual([[]]);
  expect(candidValueFromJson(nested, values[2])).toEqual([[null]]);
  expect(roundtrip([IDL.Opt(IDL.Opt(IDL.Nat))], ["1"])).toEqual(["1"]);
});

test("the option escape can itself occur in record and variant payloads", () => {
  for (const inner of [IDL.Record({ $some: IDL.Nat8 }), IDL.Variant({ $some: IDL.Nat8 })]) {
    const type = IDL.Opt(inner);
    expect(roundtrip([type], [{ $some: { $some: "7" } }])).toEqual([{ $some: { $some: "7" } }]);
  }
  expect(roundtrip([IDL.Record({ $some: IDL.Text })], [{ $some: "literal" }])).toEqual([{ $some: "literal" }]);
});

test("unknown fields, missing required fields and invalid variants fail with paths", () => {
  const type = IDL.Record({ required: IDL.Nat8, optional: IDL.Opt(IDL.Text) });
  expect(() => candidValueFromJson(type, { required: 1, extra: 2 })).toThrow(/\$\.extra: unknown/);
  expect(() => candidValueFromJson(type, {})).toThrow(/required: missing/);
  expect(() => candidValueFromJson(type, [])).toThrow(/record/);
  expect(() => candidValueToJson(type, { required: 1, optional: [], extra: 2 })).toThrow(/unknown/);
  const variant = IDL.Variant({ Known: IDL.Null, Other: IDL.Text });
  for (const value of [{}, { Unknown: null }, { Known: null, Other: "x" }, "Known", { Known: undefined }]) {
    expect(() => candidValueFromJson(variant, value)).toThrow();
  }
});

test("omitted optional record fields never read inherited JavaScript properties", () => {
  const names = ["constructor", "toString", "hasOwnProperty", "__proto__"];
  const type = IDL.Record(Object.fromEntries(names.map((name) => [name, IDL.Opt(IDL.Record({}))])));
  const value = candidValueFromJson(type, {}) as Record<string, unknown>;
  for (const name of names) {
    expect(Object.hasOwn(value, name)).toBe(true);
    expect(value[name]).toEqual([]);
  }
});

test("tuples preserve numeric labels and reject dropped elements", () => {
  const tuple = IDL.Tuple(IDL.Text, IDL.Nat64, IDL.Opt(IDL.Text));
  expect(roundtrip([tuple], [["key", "9007199254740993", null]])).toEqual([["key", "9007199254740993", null]]);
  expect(() => candidValueFromJson(tuple, ["key", 1])).toThrow(/3 elements/);
  expect(() => candidValueFromJson(tuple, ["key", 1, null, "lost"])).toThrow(/3 elements/);
  const record = IDL.Record({ _0_: IDL.Text, _1_: IDL.Nat8 });
  expect(roundtrip([record], [{ _0_: "key", _1_: "2" }])).toEqual([{ _0_: "key", _1_: "2" }]);
});

test("recursive precise values preserve arbitrary maps and variants", () => {
  const precise = IDL.Rec();
  precise.fill(IDL.Variant({
    Nat: IDL.Nat64, Int: IDL.Int64, Text: IDL.Text,
    Blob: IDL.Vec(IDL.Nat8), Bool: IDL.Bool,
    Array: IDL.Vec(precise), Map: IDL.Vec(IDL.Tuple(IDL.Text, precise)),
  }));
  const value = { Map: [
    ["arbitrary new field", { Array: [{ Nat: "18446744073709551615" }, { Map: [["nested", { Text: "preserved" }]] }] }],
    ["bytes", { Blob: { hex: "00ff" } }],
    ["same key", { Int: "-9223372036854775808" }],
    ["same key", { Bool: false }],
  ] };
  expect(roundtrip([precise], [value])).toEqual([value]);
  const schema = candidTypeSchema(precise);
  const printed = JSON.stringify(schema);
  expect(schema.$ref).toBe("#/$defs/rec0");
  expect(printed).toContain('"$defs"');
  expect(printed).toContain('"$ref":"#/$defs/rec0"');
  expect(printed).toContain("18446744073709551615");
  expect(printed).toContain("Map");
});

test("finite linked lists work while cyclic JavaScript values and unfilled types reject", () => {
  const list = IDL.Rec();
  list.fill(IDL.Opt(IDL.Record({ value: IDL.Nat8, next: list })));
  const value = { value: "1", next: { value: "1", next: null } };
  expect(roundtrip([list], [value])).toEqual([value]);
  const cyclic: Record<string, unknown> = { value: "1" };
  cyclic.next = cyclic;
  expect(() => candidValueFromJson(list, cyclic)).toThrow(/cyclic/);
  const unfinished = IDL.Rec();
  expect(() => candidTypeSchema(unfinished)).toThrow(/not been filled/);
  expect(() => candidValueFromJson(unfinished, null)).toThrow(/not been filled/);
  const unproductive = IDL.Rec();
  unproductive.fill(IDL.Opt(unproductive));
  expect(() => candidValueFromJson(unproductive, "1")).toThrow(/recursive option/);
});

test("booleans, text, finite floats, null, reserved and empty validate precisely", () => {
  expect(roundtrip([IDL.Bool, IDL.Text, IDL.Float32, IDL.Float64, IDL.Null, IDL.Reserved], [true, "", 1.5, 0.1, null, null]))
    .toEqual([true, "", 1.5, 0.1, null, null]);
  for (const [type, value] of [[IDL.Bool, 1], [IDL.Text, false], [IDL.Float64, NaN], [IDL.Float64, Infinity], [IDL.Float32, 0.1], [IDL.Null, undefined], [IDL.Reserved, "discarded"], [IDL.Empty, null]] as const) {
    expect(() => candidValueFromJson(type, value)).toThrow();
  }
  expect(candidTypeSchema(IDL.Empty).not).toEqual({});
});

test("JSON serialization retains floating negative zero and rejects invalid Unicode", () => {
  for (const type of [IDL.Float32, IDL.Float64]) {
    const json = JSON.parse(JSON.stringify(roundtrip([type], [-0]))) as unknown[];
    expect(json).toEqual(["-0"]);
    expect(Object.is(candidArgsFromJson([type], json)[0], -0)).toBe(true);
  }
  for (const value of ["\ud800", "\udc00", "\ud800x", "x\udc00"]) {
    expect(() => candidValueFromJson(IDL.Text, value)).toThrow(/surrogate/);
  }
  expect(roundtrip([IDL.Text], ["valid 🌍 text"])).toEqual(["valid 🌍 text"]);
});

test("function and service references preserve principals and signatures", () => {
  const func = IDL.Func([IDL.Nat64], [IDL.Text], ["query"]);
  const service = IDL.Service({ lookup: func });
  expect(roundtrip([func, service], [["aaaaa-aa", "lookup"], "aaaaa-aa"]))
    .toEqual([["aaaaa-aa", "lookup"], "aaaaa-aa"]);
  const schema = candidTypeSchema(service);
  expect(JSON.stringify(schema)).toContain("candidArguments");
  expect(JSON.stringify(schema)).toContain("query");
  expect(() => candidValueFromJson(func, ["aaaaa-aa"])).toThrow(/function reference/);
  expect(() => candidValueFromJson(IDL.Principal, "not-a-principal")).toThrow(/principal/);
  expect(() => candidValueFromJson(service, 5)).toThrow(/principal/);
});

test("schemas describe optional fields, escaping, exact object keys and bounds", () => {
  const schema = candidTypeSchema(IDL.Record({ amount: IDL.Nat64, note: IDL.Opt(IDL.Text), bytes: IDL.Vec(IDL.Nat8) }));
  expect(schema.required).toEqual(expect.arrayContaining(["amount", "bytes"]));
  expect(schema.required).not.toContain("note");
  expect(schema.additionalProperties).toBe(false);
  const printed = JSON.stringify(schema);
  expect(printed).toContain("$some");
  expect(printed).toContain("18446744073709551615");
  expect(printed).toContain("hex");
  expect(() => JSON.parse(printed)).not.toThrow();
});

test("schemas cover the complete generated Governance service and empty constructions", () => {
  const service = governanceIdl({ IDL });
  const printed = JSON.stringify(candidTypeSchema(service));
  expect(printed).toContain("manage_neuron");
  expect(printed).toContain("MakeProposal");
  expect(printed).toContain("RegisterExtension");
  expect(printed).toContain("$defs");
  expect(roundtrip([IDL.Tuple()], [[]])).toEqual([[]]);
  expect(candidTypeSchema(IDL.Tuple()).prefixItems).toBeUndefined();
  expect(candidTypeSchema(IDL.Variant({}))).toMatchObject({ not: {} });
  expect(candidTypeSchema(IDL.Variant({})).oneOf).toBeUndefined();
});
