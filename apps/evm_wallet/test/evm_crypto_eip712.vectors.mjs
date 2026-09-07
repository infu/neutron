// Reproduce the Motoko digest vectors with viem, independently of the Motoko
// implementation. Run `node test/evm_crypto_eip712.vectors.mjs --write`
// from apps/evm_wallet to regenerate, or omit --write to check the committed file.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hashTypedData } from "viem";

const field = (name, type) => ({ name, type });
const domainTypes = [field("name", "string"), field("chainId", "uint256")];
const domain = { name: "Neutron EIP-712 vectors", chainId: 42161 };
const envelope = (types, primaryType, message, requestedDomain = domain) => ({
  types: { EIP712Domain: domainTypes, ...types },
  primaryType,
  domain: requestedDomain,
  message,
});
const single = (type, value) => envelope({ Value: [field("value", type)] }, "Value", { value });
const vectors = [];
const positive = (label, data, json = JSON.stringify(data)) => {
  vectors.push({ label, json, digest: hashTypedData(data) });
};

// Official Ether Mail example: https://eips.ethereum.org/EIPS/eip-712
const mail = {
  types: {
    EIP712Domain: [field("name", "string"), field("version", "string"), field("chainId", "uint256"), field("verifyingContract", "address")],
    Person: [field("name", "string"), field("wallet", "address")],
    Mail: [field("from", "Person"), field("to", "Person"), field("contents", "string")],
  },
  primaryType: "Mail",
  domain: { name: "Ether Mail", version: "1", chainId: 1, verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" },
  message: {
    from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
    contents: "Hello, Bob!",
  },
};
positive("Published Ether Mail", mail);
if (vectors[0].digest !== "0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2") {
  throw new Error("The independent Ether Mail digest changed");
}

positive("Nested structs and dependency sorting", envelope({
  Transfer: [field("owner", "Person"), field("asset", "Asset"), field("delegates", "Person[]")],
  Person: [field("name", "string"), field("wallet", "address")],
  Asset: [field("token", "address"), field("amount", "uint256"), field("metadata", "Metadata")],
  Metadata: [field("ticker", "string"), field("flags", "bool[2]")],
}, "Transfer", {
  owner: { name: "Alice", wallet: "0x1111111111111111111111111111111111111111" },
  asset: { token: "0x2222222222222222222222222222222222222222", amount: "123456789012345678901234567890", metadata: { ticker: "USDC", flags: [true, false] } },
  delegates: [{ name: "Bob", wallet: "0x3333333333333333333333333333333333333333" }, { name: "Carol", wallet: "0x4444444444444444444444444444444444444444" }],
}));

positive("Nested fixed and dynamic arrays", envelope({ Arrays: [
  field("matrix", "uint16[2][3]"), field("signed", "int8[][2]"),
  field("names", "string[]"), field("bytesValues", "bytes[]"), field("empty", "address[]"),
] }, "Arrays", {
  matrix: [[1, 2], [255, 256], [65535, 0]], signed: [[-128, -1, 127], []],
  names: ["", "café", "東京"], bytesValues: ["0x", "0x00", "0x123456"], empty: [],
}));

positive("Recursive schema with finite array-terminated data", envelope({
  Node: [field("value", "uint256"), field("children", "Node[]")],
}, "Node", { value: "1", children: [{ value: "2", children: [] }, { value: "3", children: [{ value: "4", children: [] }] }] }));

positive("Mutually recursive schemas with finite data", envelope({
  Alpha: [field("label", "string"), field("children", "Beta[]")],
  Beta: [field("enabled", "bool"), field("children", "Alpha[]")],
}, "Alpha", { label: "root", children: [{ enabled: true, children: [{ label: "leaf", children: [] }] }] }));

positive("Signed and unsigned integer boundaries", envelope({ Integers: [
  field("smallMin", "int8"), field("smallMax", "int8"), field("min", "int256"),
  field("max", "int256"), field("unsigned", "uint256"), field("byte", "uint8"), field("zero", "uint256"),
] }, "Integers", {
  smallMin: -128, smallMax: 127, min: (-(1n << 255n)).toString(),
  max: ((1n << 255n) - 1n).toString(), unsigned: ((1n << 256n) - 1n).toString(), byte: 255, zero: 0,
}));

positive("Fixed bytes right padding and dynamic bytes hashing", envelope({ Bytes: [
  field("one", "bytes1"), field("two", "bytes2"), field("full", "bytes32"),
  field("dynamic", "bytes"), field("empty", "bytes"),
] }, "Bytes", {
  one: "0xff", two: "0x0123", full: "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  dynamic: "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122", empty: "0x",
}));

const unicode = single("string", "café 東京 😀\n\"quote\"\\slash\t");
positive("Unicode UTF-8, whitespace and JSON escapes", unicode);
const escapedUnicode = JSON.stringify(unicode).replace("café 東京 😀", "caf\\u00e9 \\u6771\\u4eac \\ud83d\\ude00");
positive("Escaped Unicode and a valid surrogate pair have identical bytes", JSON.parse(escapedUnicode), escapedUnicode);
positive("JSON member order and insignificant whitespace do not change digest", mail, JSON.stringify({ message: mail.message, domain: mail.domain, primaryType: mail.primaryType, types: mail.types }, null, 2));
positive("Decimal integer strings", single("int256", "-1000"));
positive("Decimal JSON integer numbers", single("int256", -1000));

const exactNumber = (label, type, expected, lexeme) => {
  const data = single(type, expected);
  positive(label, data, JSON.stringify(data).replace(`"value":${JSON.stringify(expected)}`, `"value":${lexeme}`));
};
exactNumber("Full-width uint256 JSON integer preserves every digit", "uint256", ((1n << 256n) - 1n).toString(), ((1n << 256n) - 1n).toString());
exactNumber("Full-width int256 JSON integer preserves every digit", "int256", (-(1n << 255n)).toString(), (-(1n << 255n)).toString());
exactNumber("An integral decimal and exponent are encoded exactly", "uint256", "125", "1.25e2");
exactNumber("An integral decimal without exponent is encoded exactly", "uint256", "125", "125.000");
exactNumber("A negative exponent can still represent an integer", "int256", "-125", "-1250e-1");
exactNumber("Zero with an enormous positive exponent is still zero", "uint256", "0", "0e999999999999999999999999999999999999999999999999999999999999");
exactNumber("Zero with an enormous negative exponent is still zero", "uint256", "0", "-0.000e-999999999999999999999999999999999999999999999999999999999999");

positive("Domain-only typed data", {
  types: { EIP712Domain: domainTypes }, primaryType: "EIP712Domain", domain, message: {},
});

const noChain = {
  types: { EIP712Domain: [field("name", "string")], Value: [field("value", "uint256")] },
  primaryType: "Value", domain: { name: "Chain-neutral protocol" }, message: { value: "1" },
};
positive("A chain-neutral EIP-712 domain hashes without inventing a chain", noChain);

// Hyperliquid's official signing helper uses this qualified primary type:
// https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/2fdb18f9517675ea03695a0962bd19eece9c83f0/hyperliquid/utils/signing.py#L383
// signatureChainId is a signing-wallet context; hyperliquidChain binds the venue.
const hyperliquidDomain = {
  name: "HyperliquidSignTransaction", version: "1", chainId: 42161,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};
const hyperliquid = (primaryType, fields, message) => ({
  types: { EIP712Domain: mail.types.EIP712Domain, [primaryType]: fields },
  primaryType, domain: hyperliquidDomain, message,
});
const approveAgent = hyperliquid("HyperliquidTransaction:ApproveAgent", [
  field("hyperliquidChain", "string"), field("agentAddress", "address"),
  field("agentName", "string"), field("nonce", "uint64"),
], {
  hyperliquidChain: "Testnet", agentAddress: "0x1111111111111111111111111111111111111111",
  agentName: "neutron-research", nonce: 1788820000000,
});
positive("Hyperliquid approved trading signer with exact qualified primary type", approveAgent);
if (hashTypedData(approveAgent) !== "0x80742b882ad5ba923c11dc9c2b320213d317ee149e25cf8959178dfecece9bd9") {
  throw new Error("The Hyperliquid approval regression digest changed");
}
positive("Hyperliquid mainnet approval has a different environment digest", {
  ...approveAgent, message: { ...approveAgent.message, hyperliquidChain: "Mainnet" },
});
// Circle's HyperCore withdrawal specification, with Ethereum destination domain
// zero (distinct from the selected EVM signing network 42161):
// https://developers.circle.com/cctp/howtos/withdraw-usdc-from-hypercore-to-evm
const withdraw = hyperliquid("HyperliquidTransaction:SendToEvmWithData", [
  field("hyperliquidChain", "string"), field("token", "string"), field("amount", "string"),
  field("sourceDex", "string"), field("destinationRecipient", "string"),
  field("addressEncoding", "string"), field("destinationChainId", "uint32"),
  field("gasLimit", "uint64"), field("data", "bytes"), field("nonce", "uint64"),
], {
  hyperliquidChain: "Mainnet", token: "USDC", amount: "12.345678", sourceDex: "",
  destinationRecipient: "0x1234567890123456789012345678901234567890", addressEncoding: "hex",
  destinationChainId: 0, gasLimit: "200000", data: "0x", nonce: "1788820000001",
});
positive("HyperCore perps USDC withdrawal to Ethereum", withdraw);

const negatives = [];
const negative = (label, data) => negatives.push({ label, json: typeof data === "string" ? data : JSON.stringify(data) });
const copy = (data) => JSON.parse(JSON.stringify(data));
const modify = (label, mutator) => {
  const data = copy(single("uint8", 1));
  mutator(data);
  negative(label, data);
};

negative("Duplicate top-level JSON key", JSON.stringify(single("uint8", 1)).replace('"primaryType":"Value"', '"primaryType":"Value","primaryType":"Value"'));
negative("Duplicate struct JSON member", JSON.stringify(single("uint8", 1)).replace('"message":{"value":1}', '"message":{"value":1,"value":2}'));
negative("Duplicate type declaration JSON key", JSON.stringify(single("uint8", 1)).replace('"types":{', '"types":{"Value":[], '));
negative("Duplicate declaration field JSON key", JSON.stringify(single("uint8", 1)).replace('"name":"value"', '"name":"value","name":"other"'));
modify("Duplicate struct member declaration", (data) => data.types.Value.push(field("value", "uint8")));
modify("An unknown message member must not be silently unsigned", (data) => data.message.extra = "this text would not be signed");
modify("An unknown domain member must not be silently unsigned", (data) => data.domain.extra = "this text would not be signed");
for (const type of ["uint", "int", "uint0", "uint7", "uint264", "int9", "bytes0", "bytes33", "UnknownStruct", "uint8[", "uint8]", "uint8[-1]", "uint8[1]junk", "uint8[][]junk"]) {
  negative(`Invalid or unresolved type ${type}`, single(type, 1));
}
modify("Missing referenced type", (data) => { data.types.Value[0].type = "Missing[]"; data.message.value = []; });
modify("An invalid type identifier", (data) => { data.types["Bad-Name"] = data.types.Value; delete data.types.Value; data.primaryType = "Bad-Name"; });
modify("An invalid member identifier", (data) => { data.types.Value[0].name = "bad-name"; data.message = { "bad-name": 1 }; });
modify("Qualified names are not accepted as field names", (data) => { data.types.Value[0].name = "scope:value"; data.message = { "scope:value": 1 }; });
for (const name of [":Value", "Value:", "Protocol::Value", "Protocol:9Value", "Protocol:Bad-Name", "Protocol:Value(uint256)", "Protocol:Value,Other", "Protocol: Value"]) {
  modify(`Invalid qualified struct name ${name}`, (data) => { data.types[name] = data.types.Value; delete data.types.Value; data.primaryType = name; });
}
for (const [type, value] of [
  ["uint8", -1], ["uint8", 256], ["int8", -129], ["int8", 128],
  ["uint256", (1n << 256n).toString()], ["int256", (1n << 255n).toString()], ["int256", (-(1n << 255n) - 1n).toString()],
  ["uint256", "1.5"], ["uint256", "NaN"], ["uint256", 1.5],
  ["bool", "true"], ["bool", 1], ["address", "0x1234"], ["address", "0xgg11111111111111111111111111111111111111"],
  ["bytes1", "0x"], ["bytes1", "0x1234"], ["bytes2", "0x12"], ["bytes", "0x1"], ["bytes", "0xzz"], ["string", 123],
]) negative(`Invalid ${type} value ${JSON.stringify(value)}`, single(type, value));
negative("Fixed array is too short", single("uint8[2]", [1]));
negative("Fixed array is too long", single("uint8[2]", [1, 2, 3]));
negative("A nested fixed array has a wrong inner dimension", single("uint8[2][2]", [[1, 2], [3]]));
negative("An array value must be an array", single("uint8[]", 1));
negative("An array integer still enforces its width", single("uint8[]", [1, 256]));
for (const lexeme of ["1e999999999999999999999999999999999999999999999999999999999999", "1e-999999999999999999999999999999999999999999999999999999999999", "1.25e1", "1250e-2", "0.00001"]) {
  negative(`Nonzero huge exponent or fractional JSON integer ${lexeme}`, JSON.stringify(single("uint256", 1)).replace('"value":1', `"value":${lexeme}`));
}
negative("A required field may not be null", single("uint8", null));
modify("Missing required message field", (data) => delete data.message.value);
modify("Message cannot be null", (data) => data.message = null);
modify("Domain cannot be null", (data) => data.domain = null);
modify("Missing message", (data) => delete data.message);
modify("Missing domain", (data) => delete data.domain);
modify("Missing types", (data) => delete data.types);
modify("Missing domain type", (data) => delete data.types.EIP712Domain);
modify("Missing primary type", (data) => delete data.primaryType);
modify("Unknown primary type", (data) => data.primaryType = "Unknown");
negative("Malformed JSON: trailing comma", JSON.stringify(single("uint8", 1)).replace('"value":1}', '"value":1,}'));
negative("Malformed JSON: trailing text", JSON.stringify(single("uint8", 1)) + " false");
negative("Malformed JSON: truncated document", JSON.stringify(single("uint8", 1)).slice(0, -1));
negative("Malformed JSON: unescaped control character", JSON.stringify(single("string", "x")).replace('"value":"x"', '"value":"\u0001"'));
for (const escaped of ["\\ud800", "\\udfff", "\\ud800\\u0041", "\\ud800\\ud800", "\\uqqqq", "\\u123"]) {
  negative(`Malformed Unicode escape ${escaped}`, JSON.stringify(single("string", "x")).replace('"value":"x"', `"value":"${escaped}"`));
}

// Motoko uses \u{...} for raw control code points; JSON uses \u.... Escape the
// outer Motoko string without changing any of the inner JSON bytes under test.
const moText = (value) => '"' + [...value].map((character) => {
  if (character === "\\") return "\\\\";
  if (character === '"') return '\\"';
  if (character === "\n") return "\\n";
  if (character === "\r") return "\\r";
  if (character === "\t") return "\\t";
  const point = character.codePointAt(0);
  return point < 32 ? `\\u{${point.toString(16)}}` : character;
}).join("") + '"';
const output = [
  '// Generated by evm_crypto_eip712.vectors.mjs using viem hashTypedData.',
  '// EIP-712 reference vector: https://eips.ethereum.org/EIPS/eip-712',
  '// Digest values are independent of the Motoko encoder under test.',
  'import Runtime "mo:core/Runtime";',
  'import Eip712 "../backend/evm/Eip712";',
  'import Hex "../backend/evm/Hex";',
  '',
  'func valid(testName : Text, json : Text, digest : Text) {',
  '    switch (Eip712.hash(json)) {',
  '        case (#ok(actual)) {',
  '            if (Hex.encode(actual) != digest) Runtime.trap(testName # ": unexpected digest " # Hex.encode(actual));',
  '        };',
  '        case (#err(reason)) Runtime.trap(testName # ": rejected valid input: " # reason);',
  '    };',
  '};',
  '',
  'func invalid(testName : Text, json : Text) {',
  '    switch (Eip712.hash(json)) {',
  '        case (#err(_)) {};',
  '        case (#ok(_)) Runtime.trap(testName # ": accepted invalid input");',
  '    };',
  '};',
  '',
  ...vectors.flatMap(({ label, json, digest }) => [`valid(${moText(label)},`, `    ${moText(json)},`, `    ${moText(digest)},`, ');', '']),
  ...negatives.flatMap(({ label, json }) => [`invalid(${moText(label)},`, `    ${moText(json)},`, ');', '']),
  '// The wallet-selected chain must agree with the chain actually signed.',
  ...[approveAgent, withdraw].flatMap((data) => [
    `switch (Eip712.hashForChain(${moText(JSON.stringify(data))}, 42161)) {`,
    `    case (#ok(value)) assert (Hex.encode(value) == "${hashTypedData(data)}");`,
    '    case (#err(reason)) Runtime.trap("Rejected Hyperliquid signing on supported Arbitrum context: " # reason);',
    '};',
    `switch (Eip712.hashForChain(${moText(JSON.stringify(data))}, 1)) {`,
    '    case (#err(_)) {};',
    '    case (#ok(_)) Runtime.trap("Qualified types bypassed selected-chain binding");',
    '};',
  ]),
  `let mail = ${moText(JSON.stringify(mail))};`,
  'switch (Eip712.hashForChain(mail, 1)) {',
  `    case (#ok(value)) assert (Hex.encode(value) == ${moText(vectors[0].digest)});`,
  '    case (#err(reason)) Runtime.trap("Expected matching chain: " # reason);',
  '};',
  'switch (Eip712.hashForChain(mail, 42161)) {',
  '    case (#err(_)) {};',
  '    case (#ok(_)) Runtime.trap("Accepted mismatched EIP-712 chain");',
  '};',
  `switch (Eip712.hashForChain(${moText(JSON.stringify(noChain))}, 1)) {`,
  `    case (#ok(value)) assert (Hex.encode(value) == "${hashTypedData(noChain)}");`,
  '    case (#err(reason)) Runtime.trap("Rejected valid chain-neutral typed data: " # reason);',
  '};',
  '',
].join("\n");
const testPath = fileURLToPath(new URL("evm_crypto_eip712_test.mo", import.meta.url));
if (process.argv.includes("--write")) await writeFile(testPath, output);
else if (await readFile(testPath, "utf8") !== output) throw new Error("Motoko EIP-712 test vectors differ; run this script with --write and inspect the change");
console.log(`Verified ${vectors.length} independent EIP-712 digest vectors and ${negatives.length} rejection cases.`);
