import { expect, test } from "bun:test";
import { encodeFunctionData, getAddress, parseAbi, toFunctionSelector, type Hex } from "viem";
import { decodeDescriptorPack, descriptorTokens, parseDecoderPack, type DecoderPack } from "../src/decoders/descriptor.ts";
import type { Asset, Network, Operation } from "../src/data.ts";

const vault = "0x1111111111111111111111111111111111111111";
const token = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const sender = "0x2222222222222222222222222222222222222222";
const beneficiary = "0x3333333333333333333333333333333333333333";
const asset: Asset = { chainId: "1", address: token, symbol: "USDC", decimals: 6 };
const network: Network = { chainId: "1", name: "Ethereum", nativeSymbol: "ETH", explorerUrl: "https://etherscan.io", testnet: false, finalityDescription: "" };
const abi = parseAbi(["function deposit(address asset,uint256 amount,address receiver)"]);
function example(): DecoderPack {
  return {
    format: 1, id: "example-vault", version: "1", name: "Example vault", description: "Vault calls decoded from their exact transaction bytes.",
    source: "https://example.test/decoder.json",
    deployments: [{ chainId: "1", address: vault }],
    functions: [{ signature: "deposit(address asset,uint256 amount,address receiver)", title: "Deposit into vault", description: "Deposit tokens and issue shares to the recipient.", value: "zero", fields: [
      { path: "args.1", label: "You deposit", format: "tokenAmount", tokenPath: "args.0", role: "amount" },
      { path: "args.2", label: "Share recipient", format: "address", role: "party" },
      { path: "transaction.from", label: "Paid by", format: "address", role: "party" },
    ] }],
  };
}
function operation(data: Hex = encodeFunctionData({ abi, functionName: "deposit", args: [token, 1234567n, beneficiary] })): Operation {
  return { kind: "transaction", address: sender, chainId: "1", caller: { appId: "unrelated-app", installationUid: "app-instance", endpoint: "service" }, intent: {}, preparedTransaction: { to: vault, value: "0", data, chainId: "1", nonce: "8" } } as Operation;
}
const detail = (shown: NonNullable<ReturnType<typeof decodeDescriptorPack>>, label: string) => [...shown.parties, ...(shown.advancedDetails ?? [])].find((field) => field.label === label)?.value;

test("a user-installed new protocol explains the exact amount, beneficiary and sender without trusting its caller", () => {
  const pack = parseDecoderPack(example());
  const shown = decodeDescriptorPack(pack, operation(), [asset], network)!;
  expect(shown.title).toBe("Deposit into vault");
  expect(shown.amount).toBe("1.234567 USDC");
  expect(shown.amountLabel).toBe("You deposit");
  expect(shown.amountAtoms).toBe("1234567");
  expect(shown.tokenAddress).toBe(getAddress(token));
  expect(shown.tokenSymbol).toBe("USDC");
  expect(shown.contract).toBe(vault);
  expect(detail(shown, "Share recipient")).toBe(beneficiary);
  expect(detail(shown, "Paid by")).toBe(sender);
  expect(detail(shown, "You deposit (atomic units)")).toBe("1234567");
  expect(shown.unlimitedApproval).toBe(false);
  expect(descriptorTokens(pack, operation())).toEqual([getAddress(token)]);
});

test("the prepared transaction takes precedence over an earlier intent", () => {
  const op = operation();
  op.intent.transaction = { ...op.preparedTransaction!, data: encodeFunctionData({ abi, functionName: "deposit", args: [token, 999000000n, sender] }) };
  const shown = decodeDescriptorPack(parseDecoderPack(example()), op, [asset])!;
  expect(shown.amount).toBe("1.234567 USDC");
  expect(detail(shown, "Share recipient")).toBe(beneficiary);
  const historical = { ...op, preparedTransaction: null };
  expect(decodeDescriptorPack(parseDecoderPack(example()), historical, [asset])!.amount).toBe("999 USDC");
});

test("wrong deployments, networks, selectors, kinds and nonzero value fail closed", () => {
  const pack = parseDecoderPack(example());
  const variants = [
    { ...operation(), chainId: "42161" },
    { ...operation(), kind: "typed_data" },
    { ...operation(), preparedTransaction: { ...operation().preparedTransaction!, chainId: "42161" } },
    { ...operation(), preparedTransaction: { ...operation().preparedTransaction!, to: beneficiary } },
    { ...operation(), preparedTransaction: { ...operation().preparedTransaction!, value: "1" } },
    { ...operation(), preparedTransaction: { ...operation().preparedTransaction!, value: "00" } },
    { ...operation(), preparedTransaction: { ...operation().preparedTransaction!, value: (1n << 256n).toString() } },
    operation("0x12345678"),
  ];
  for (const op of variants) {
    expect(decodeDescriptorPack(pack, op, [asset])).toBeNull();
    expect(descriptorTokens(pack, op)).toEqual([]);
  }
});

test("trailing bytes, truncated ABI and noncanonical address padding are never summarized", () => {
  const data = operation().preparedTransaction!.data;
  const dirtyPadding = `${data.slice(0, 10)}01${data.slice(12)}` as Hex;
  for (const bytes of [`${data}00`, data.slice(0, -2), dirtyPadding, `${data}f`]) {
    expect(decodeDescriptorPack(parseDecoderPack(example()), operation(bytes as Hex), [asset])).toBeNull();
  }
});

test("canonical checks also apply to functions with no arguments", () => {
  const raw = example();
  raw.functions = [{ signature: "harvest()", title: "Harvest vault yield", value: "zero", fields: [] }];
  const pack = parseDecoderPack(raw);
  const data = encodeFunctionData({ abi: parseAbi(["function harvest()"]), functionName: "harvest" });
  expect(decodeDescriptorPack(pack, operation(data), [])!.title).toBe("Harvest vault yield");
  expect(decodeDescriptorPack(pack, operation(`${data}00`), [])).toBeNull();
});

test("uint256-sized amounts stay exact and missing metadata is raw atomic units", () => {
  const huge = (1n << 256n) - 1n;
  const op = operation(encodeFunctionData({ abi, functionName: "deposit", args: [token, huge, beneficiary] }));
  const pack = parseDecoderPack(example());
  const unknown = decodeDescriptorPack(pack, op, [])!;
  expect(unknown.amount).toBe(`${huge} atomic units`);
  expect(unknown.amountAtoms).toBe(huge.toString());
  expect(unknown.tokenSymbol).toBeNull();
  expect(unknown.tokenAddress).toBe(getAddress(token));
  const known = decodeDescriptorPack(pack, op, [asset])!;
  expect(known.amount).toBe("115792089237316195423570985008687907853269984665640564039457584007913129.639935 USDC");
});

test("wrong-chain, conflicting or invalid decimal metadata never implies 18 decimals", () => {
  const pack = parseDecoderPack(example());
  for (const assets of [
    [{ ...asset, chainId: "42161" }],
    [{ ...asset, decimals: 18.5 }],
    [{ ...asset, decimals: -1 }],
    [{ ...asset, decimals: 256 }],
    [{ ...asset, symbol: "" }],
    [asset, { ...asset, decimals: 18 }],
  ]) expect(decodeDescriptorPack(pack, operation(), assets)!.amount).toBe("1234567 atomic units");
});

test("fixed token addresses and transaction.to token paths use independent metadata", () => {
  for (const select of [{ tokenAddress: token }, { tokenPath: "transaction.to" }]) {
    const raw = example();
    raw.functions[0]!.fields[0] = { path: "args.1", label: "Deposit", format: "tokenAmount", role: "amount", ...select };
    const op = operation();
    if ("tokenPath" in select) { raw.deployments[0]!.address = token; op.preparedTransaction!.to = token; }
    const pack = parseDecoderPack(raw);
    expect(decodeDescriptorPack(pack, op, [asset])!.amount).toBe("1.234567 USDC");
    expect(descriptorTokens(pack, op)).toEqual([getAddress(token)]);
  }
});

test("named nested tuples and tuple arrays resolve from positional ABI data", () => {
  const signature = "supply((address asset,(uint256 amount,address receiver) position)[] orders)";
  const raw = example();
  raw.functions = [{ signature, title: "Supply first order", value: "zero", fields: [
    { path: "args.0.0.position.amount", label: "Amount", format: "tokenAmount", tokenPath: "args.0.0.asset", role: "amount" },
    { path: "args.0.0.1.1", label: "Beneficiary", format: "address", role: "party" },
  ] }];
  const data = encodeFunctionData({ abi: parseAbi([`function ${signature}`]), functionName: "supply", args: [[{ asset: token, position: { amount: 999123456n, receiver: beneficiary } }]] });
  const pack = parseDecoderPack(raw);
  const shown = decodeDescriptorPack(pack, operation(data), [asset])!;
  expect(shown.amount).toBe("999.123456 USDC");
  expect(detail(shown, "Beneficiary")).toBe(beneficiary);
  expect(descriptorTokens(pack, operation(data))).toEqual([getAddress(token)]);
});

test("mixed named and unnamed tuples and fixed arrays use positional paths", () => {
  const signature = "configure((address asset,uint256) config,uint256[2] limits)";
  const raw = example();
  raw.functions = [{ signature, title: "Configure", value: "zero", fields: [
    { path: "args.0.1", label: "Amount", format: "tokenAmount", tokenPath: "args.0.asset", role: "amount" },
    { path: "args.1.1", label: "Limit", format: "integer" },
  ] }];
  const data = encodeFunctionData({ abi: parseAbi([`function ${signature}`]), functionName: "configure", args: [[token, 1000000n], [4n, 9n]] });
  const shown = decodeDescriptorPack(parseDecoderPack(raw), operation(data), [asset])!;
  expect(shown.amount).toBe("1 USDC");
  expect(detail(shown, "Limit")).toBe("9");
});

test("duplicate tuple member names remain available positionally without overwriting data", () => {
  const raw = example();
  raw.functions = [{ signature: "set((uint256 value,uint256 value) config)", title: "Set", value: "zero", fields: [
    { path: "args.0.0", label: "First", format: "integer" }, { path: "args.0.1", label: "Second", format: "integer" },
  ] }];
  const data = encodeFunctionData({ abi: parseAbi(["function set((uint256,uint256))"]), functionName: "set", args: [[1n, 2n]] });
  const shown = decodeDescriptorPack(parseDecoderPack(raw), operation(data), [])!;
  expect(detail(shown, "First")).toBe("1");
  expect(detail(shown, "Second")).toBe("2");
  raw.functions[0]!.fields[0]!.path = "args.0.value";
  expect(() => parseDecoderPack(raw)).toThrow("ambiguous tuple");
});

test("prototype-named ABI members cannot change decoded object prototypes", () => {
  const raw = example();
  raw.functions = [{ signature: "set(((uint256 x) __proto__,uint256 y) config)", title: "Set", value: "zero", fields: [
    { path: "args.0.0.0", label: "First", format: "integer" }, { path: "args.0.1", label: "Second", format: "integer" },
  ] }];
  const data = encodeFunctionData({ abi: parseAbi(["function set(((uint256),uint256))"]), functionName: "set", args: [[[7n], 8n]] });
  const shown = decodeDescriptorPack(parseDecoderPack(raw), operation(data), [])!;
  expect(detail(shown, "First")).toBe("7");
  expect(detail(shown, "Second")).toBe("8");
  expect(({} as { x?: unknown }).x).toBeUndefined();
  raw.functions[0]!.fields[0]!.path = "args.0.__proto__.x";
  expect(() => parseDecoderPack(raw)).toThrow("forbidden property");
});

test("missing dynamic array members cause nullable fallback instead of invented values", () => {
  const raw = example();
  raw.functions = [{ signature: "deposit(uint256[] amounts)", title: "Deposit", value: "zero", fields: [{ path: "args.0.1", label: "Second amount", format: "tokenAmount", tokenAddress: token, role: "amount" }] }];
  const data = encodeFunctionData({ abi: parseAbi(["function deposit(uint256[] amounts)"]), functionName: "deposit", args: [[1n]] });
  expect(decodeDescriptorPack(parseDecoderPack(raw), operation(data), [asset])).toBeNull();
});

test("native values remain visible even if a custom pack does not select them", () => {
  const raw = example();
  raw.functions[0]!.value = "payable";
  const op = operation();
  op.preparedTransaction!.value = "1230000000000000000";
  const shown = decodeDescriptorPack(parseDecoderPack(raw), op, [asset], network)!;
  expect(shown.nativeValue).toBe("1.23 ETH");
  expect(shown.amount).toBe("1.234567 USDC");
  raw.functions[0]!.fields = [{ path: "transaction.value", label: "Native deposit", format: "nativeAmount", role: "amount" }];
  const native = decodeDescriptorPack(parseDecoderPack(raw), op, [], network)!;
  expect(native.amount).toBe("1.23 ETH");
  expect(native.amountAtoms).toBe("1230000000000000000");
  expect(native.tokenAddress).toBeNull();
  expect(native.tokenSymbol).toBe("ETH");
  expect(decodeDescriptorPack(parseDecoderPack(raw), op, [], { ...network, chainId: "42161", nativeSymbol: "WRONG" })!.amount).toBe("1.23 native token");
});

test("boolean, signed integer, bytes and timestamp formats preserve their exact values", () => {
  const raw = example();
  raw.functions = [{ signature: "set(bool enabled,int8 delta,bytes proof,uint256 deadline)", title: "Set terms", value: "zero", fields: [
    { path: "args.0", label: "Enabled", format: "boolean" }, { path: "args.1", label: "Delta", format: "integer" },
    { path: "args.2", label: "Proof", format: "bytes" }, { path: "args.3", label: "Deadline", format: "timestamp" },
  ] }];
  const contractAbi = parseAbi(["function set(bool enabled,int8 delta,bytes proof,uint256 deadline)"]);
  const pack = parseDecoderPack(raw);
  const data = encodeFunctionData({ abi: contractAbi, functionName: "set", args: [true, -7, "0x00abcd", 1_700_000_000n] });
  const shown = decodeDescriptorPack(pack, operation(data), [])!;
  expect(detail(shown, "Enabled")).toBe("Yes");
  expect(detail(shown, "Delta")).toBe("-7");
  expect(detail(shown, "Proof")).toBe("0x00abcd");
  expect(detail(shown, "Deadline")).toBe("2023-11-14T22:13:20.000Z (1700000000 Unix seconds)");
  const maximum = (1n << 256n) - 1n;
  const large = encodeFunctionData({ abi: contractAbi, functionName: "set", args: [false, 0, "0x", maximum] });
  expect(detail(decodeDescriptorPack(pack, operation(large), [])!, "Deadline")).toBe(`${maximum} Unix seconds`);
});

test("selectors remain unambiguous even for actual different-signature collisions", () => {
  expect(toFunctionSelector("burn(uint256)")).toBe(toFunctionSelector("collate_propagate_storage(bytes16)"));
  const raw = example();
  raw.functions = ["burn(uint256)", "collate_propagate_storage(bytes16)"].map((signature) => ({ signature, title: "Call", value: "zero", fields: [] }));
  expect(() => parseDecoderPack(raw)).toThrow("ambiguous function selector");
  raw.functions = [raw.functions[0]!, raw.functions[0]!];
  expect(() => parseDecoderPack(raw)).toThrow("ambiguous function selector");
});

test("import rejects unknown keys, unsupported versions and noncanonical identifiers", () => {
  for (const patch of [
    { script: "alert(1)" }, { format: 2 }, { version: "0" }, { version: "01" }, { version: 1 },
    { id: "Example Vault" }, { source: { url: "https://example.test" } },
    { deployments: [] }, { functions: [] },
    { deployments: [{ chainId: "01", address: vault }] },
    { deployments: [{ chainId: "1", address: "0x1234" }] },
    { deployments: [{ chainId: "1", address: vault, wildcard: true }] },
    { deployments: [{ chainId: "1", address: vault }, { chainId: "1", address: vault }] },
  ]) expect(() => parseDecoderPack({ ...example(), ...patch })).toThrow("Invalid decoder pack");
});

test("import rejects impossible fields, executable paths and mismatched token selectors", () => {
  for (const patch of [
    { path: "args.99" }, { path: "args.01" }, { path: "args.0.constructor" }, { path: "args.0.__proto__" },
    { path: "args.0.prototype" }, { path: "args[1]" }, { path: "transaction.data" },
    { path: "args.1.toString()" }, { path: "args.0", format: "integer" },
    { tokenPath: "args.1" }, { tokenAddress: token }, { tokenPath: undefined },
    { format: "javascript" }, { expression: "args[1]" }, { role: "html" },
  ]) {
    const raw = example();
    raw.functions[0]!.fields[0] = { ...raw.functions[0]!.fields[0]!, ...patch } as typeof raw.functions[0]["fields"][number];
    expect(() => parseDecoderPack(raw)).toThrow("Invalid decoder pack");
  }
  const raw = example();
  raw.functions[0]!.fields.push({ ...raw.functions[0]!.fields[0]! });
  expect(() => parseDecoderPack(raw)).toThrow("one primary amount");
});

test("unsupported ABI types and invalid Solidity integer widths fail at import", () => {
  for (const signature of ["set(function callback)", "set(fixed128x18 value)", "set(uint7 value)", "event Deposit(uint256 value)"]) {
    const raw = example();
    raw.functions = [{ signature, title: "Set", value: "zero", fields: [] }];
    expect(() => parseDecoderPack(raw)).toThrow("Invalid decoder pack");
  }
  const raw = example();
  raw.functions = [{ signature: "set(uint value)", title: "Set", value: "zero", fields: [{ path: "args.0", label: "Value", format: "integer" }] }];
  const data = encodeFunctionData({ abi: parseAbi(["function set(uint256)"]), functionName: "set", args: [12n] });
  expect(detail(decodeDescriptorPack(parseDecoderPack(raw), operation(data), [])!, "Value")).toBe("12");
});

test("accessor properties are rejected without being called, and imported packs cannot be altered", () => {
  let calls = 0;
  const raw = example();
  Object.defineProperty(raw, "name", { enumerable: true, get() { calls++; return "unsafe"; } });
  expect(() => parseDecoderPack(raw)).toThrow("data properties");
  expect(calls).toBe(0);
  const arrayPack = example();
  Object.defineProperty(arrayPack.functions, "0", { enumerable: true, get() { calls++; return {}; } });
  expect(() => parseDecoderPack(arrayPack)).toThrow("data items");
  expect(calls).toBe(0);
  const original = example();
  const parsed = parseDecoderPack(original);
  original.functions[0]!.title = "Changed after import";
  expect(decodeDescriptorPack(parsed, operation(), [asset])!.title).toBe("Deposit into vault");
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.functions[0]!.fields[0])).toBe(true);
});

test("static labels and source stay inert text with no template expansion", () => {
  const raw = example();
  raw.name = "<script>example</script>";
  raw.source = "javascript:throw new Error('not executed')";
  raw.functions[0]!.title = "${transaction.value} <img src=x>";
  const pack = parseDecoderPack(raw);
  expect(decodeDescriptorPack(pack, operation(), [asset])!.title).toBe(raw.functions[0]!.title);
  expect(pack.source).toBe(raw.source);
});

test("a library-lossy string decode falls back instead of describing different calldata", () => {
  const raw = example();
  raw.functions = [{ signature: "set(string note)", title: "Set note", value: "zero", fields: [] }];
  const data = encodeFunctionData({ abi: parseAbi(["function set(string note)"]), functionName: "set", args: ["\u0000test"] });
  expect(decodeDescriptorPack(parseDecoderPack(raw), operation(data), [])).toBeNull();
});
