import assert from "node:assert/strict";
import {
  getAddress,
  getBytes,
  hashMessage as ethersHashMessage,
  keccak256,
  recoverAddress as ethersRecoverAddress,
  toUtf8Bytes,
  TypedDataEncoder,
  verifyMessage as ethersVerifyMessage,
  verifyTypedData as ethersVerifyTypedData,
} from "ethers";
import {
  hashMessage as viemHashMessage,
  hashTypedData as viemHashTypedData,
  recoverMessageAddress,
  recoverTypedDataAddress,
  stringToHex,
  verifyMessage as viemVerifyMessage,
  verifyTypedData as viemVerifyTypedData,
  type Address,
  type Hex,
} from "viem";
import {
  parseEvmOperationResult,
  parseEvmSignMessageRequest,
  parseEvmSignTypedDataRequest,
  type EvmAccountId,
  type EvmOperationResult,
  type EvmSignMessageRequest,
  type EvmSignTypedDataRequest,
} from "neutron-tools/evm_wallet";

const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const LARGE_AMOUNT = ((1n << 255n) + 9007199254740993n).toString();
const FIXTURE_CONTRACT = "0x1111111111111111111111111111111111111111";
const FIXTURE_RECIPIENT = "0x2222222222222222222222222222222222222222";

export type EvmSignatureChainId = "1" | "42161";
type TypeFields = Record<string, Array<{ name: string; type: string }>>;
export type EvmSignatureTypedData = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: TypeFields;
  primaryType: string;
  message: Record<string, unknown>;
};
type SignatureCaseBase = {
  name: string;
  expectedAddress: Address;
  chainId: EvmSignatureChainId;
};
export type EvmPersonalSignatureCase = SignatureCaseBase & {
  kind: "message";
  request: EvmSignMessageRequest;
  message: string;
};
export type EvmTypedSignatureCase = SignatureCaseBase & {
  kind: "typed_data";
  request: EvmSignTypedDataRequest;
  /** Independent semantic values; full-width integers remain decimal strings.
   * The rich fixture's actual request deliberately carries one JSON number.
   */
  typedData: EvmSignatureTypedData;
};
export type EvmSignatureCase = EvmPersonalSignatureCase | EvmTypedSignatureCase;
export type EvmSignatureEvidence = {
  digest: Hex;
  signature: Hex;
  address: Address;
  r: Hex;
  s: Hex;
  v: 27 | 28;
  wrongChainId?: EvmSignatureChainId;
  wrongChainRecoveredAddress?: Address;
};

/** Pure fixtures: no node access, wallet calls, deployments, or signing.
 * A fresh invocationId makes a rerun exercise chain-key signing again instead
 * of recovering the signature stored for an earlier request ID.
 */
export function createEvmSignatureFixtures(options: {
  address: string;
  accountId?: EvmAccountId;
  chainId: EvmSignatureChainId;
  invocationId: string;
}): {
  personal: EvmPersonalSignatureCase;
  typedData: EvmTypedSignatureCase;
  permit: EvmTypedSignatureCase;
} {
  assert.ok(options.invocationId.length > 0, "Signature fixtures need a per-run invocation ID");
  assert.ok(options.chainId === "1" || options.chainId === "42161", "Unexpected qualification chain");
  const expectedAddress = getAddress(options.address) as Address;
  const accountId = options.accountId ?? "main";
  const { chainId, invocationId } = options;
  const identity = (name: string) => ({
    accountId,
    chainId,
    requestId: keccak256(toUtf8Bytes(JSON.stringify([
      "Neutron EVM signature qualification v1",
      invocationId,
      expectedAddress,
      chainId,
      name,
    ]))).slice(2, 34),
  });
  const message = [
    "Neutron local EVM signature qualification.",
    `Account: ${expectedAddress}`,
    `Network: ${chainId}`,
    "UTF-8 bytes: café · 東京 · 😀",
    "This message does not authorize a transaction.",
  ].join("\n");
  const personal: EvmPersonalSignatureCase = {
    name: "personal UTF-8 message",
    kind: "message",
    expectedAddress,
    chainId,
    message,
    request: parseEvmSignMessageRequest({
      ...identity("personal"),
      messageHex: stringToHex(message),
    }),
  };
  const domainFields = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ];
  const richData: EvmSignatureTypedData = {
    domain: {
      name: "Neutron local signature qualification",
      version: "1",
      chainId: Number(chainId),
      verifyingContract: FIXTURE_CONTRACT,
    },
    types: {
      EIP712Domain: domainFields,
      TransferBatch: [
        { name: "owner", type: "address" },
        { name: "memo", type: "string" },
        { name: "amount", type: "uint256" },
        { name: "deltas", type: "int128[2]" },
        { name: "items", type: "Item[]" },
        { name: "metadata", type: "bytes" },
        { name: "flags", type: "bool[2]" },
      ],
      Item: [
        { name: "beneficiary", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "note", type: "string" },
      ],
    },
    primaryType: "TransferBatch",
    message: {
      owner: expectedAddress,
      memo: "Review exact values: café · 東京 · 😀\n\"quoted\" \\ path",
      amount: LARGE_AMOUNT,
      deltas: [(-(1n << 127n)).toString(), ((1n << 127n) - 1n).toString()],
      items: [
        { beneficiary: expectedAddress, amount: "9007199254740993", note: "first" },
        { beneficiary: FIXTURE_RECIPIENT, amount: "0", note: "第二 😀" },
      ],
      metadata: "0x00010280ff",
      flags: [true, false],
    },
  };
  // Keep the literal exact through the playground and Wallet review. Parsing
  // this request with JSON.parse then stringifying would round the amount.
  const richJson = JSON.stringify(richData, null, 2).replace(
    `"amount": "${LARGE_AMOUNT}"`,
    `"amount": ${LARGE_AMOUNT}`,
  );
  assert.ok(richJson.includes(`"amount": ${LARGE_AMOUNT}`));
  const typedData: EvmTypedSignatureCase = {
    name: "typed arrays, Unicode, and exact uint256 JSON number",
    kind: "typed_data",
    expectedAddress,
    chainId,
    typedData: richData,
    request: parseEvmSignTypedDataRequest({
      ...identity("typed-data"),
      typedDataJson: richJson,
    }),
  };
  // Standard ERC-2612 shape, using a fixture domain and an already-expired
  // deadline. Verification checks the same payload that the Wallet receives.
  const permitData: EvmSignatureTypedData = {
    domain: {
      name: "Neutron local qualification token",
      version: "1",
      chainId: Number(chainId),
      verifyingContract: FIXTURE_CONTRACT,
    },
    types: {
      EIP712Domain: domainFields.map((field) => ({ ...field })),
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: {
      owner: expectedAddress,
      spender: FIXTURE_RECIPIENT,
      value: LARGE_AMOUNT,
      nonce: "9007199254740993",
      deadline: "0",
    },
  };
  const permit: EvmTypedSignatureCase = {
    name: "ERC-2612 permit",
    kind: "typed_data",
    expectedAddress,
    chainId,
    typedData: permitData,
    request: parseEvmSignTypedDataRequest({
      ...identity("permit"),
      typedDataJson: JSON.stringify(permitData, null, 2),
    }),
  };
  return { personal, typedData, permit };
}

/** Change only the domain's chain ID while retaining the requested wallet
 * network and every original JSON numeric lexeme. A wallet must reject this.
 */
export function withWrongEvmSignatureChain(fixture: EvmTypedSignatureCase): EvmSignTypedDataRequest {
  const wrongChainId = otherChain(fixture.chainId);
  const expected = `"chainId": ${fixture.chainId},`;
  const replacement = `"chainId": ${wrongChainId},`;
  assert.equal(fixture.request.typedDataJson.split(expected).length, 2, "Expected one fixture domain chain ID");
  return {
    ...fixture.request,
    // Distinct from the successful request so rejection exercises validation,
    // without triggering the existing request's idempotency conflict instead.
    requestId: keccak256(toUtf8Bytes(`wrong-chain:${fixture.request.requestId}`)).slice(2, 34),
    typedDataJson: fixture.request.typedDataJson.replace(expected, replacement),
  };
}

/** Independently prove the returned signature signs the exact fixture under
 * both ethers and viem, including scalar bounds and canonical low-S encoding.
 */
export async function verifyEvmSignature(
  fixture: EvmSignatureCase,
  returned: string | EvmOperationResult,
): Promise<EvmSignatureEvidence> {
  let signatureText: string;
  if (typeof returned === "string") signatureText = returned;
  else {
    const operation = parseEvmOperationResult(returned, fixture.request, fixture.kind);
    assert.equal(operation.status, "signed", "Signature operation must finish signed");
    assert.equal(getAddress(operation.address), fixture.expectedAddress, "Operation account differs from the chain-key account");
    assert.equal(operation.transactionHash, null, "Message signing must not return a transaction hash");
    assert.equal(operation.receipt, null, "Message signing must not return a transaction receipt");
    assert.equal(typeof operation.signature, "string", "Signature operation omitted its signature");
    signatureText = operation.signature!;
  }
  assert.match(signatureText, /^0x[0-9a-fA-F]{130}$/u, "Expected a 65-byte Ethereum signature");
  const signature = signatureText.toLowerCase() as Hex;
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const v = Number.parseInt(signature.slice(130, 132), 16);
  assert.ok(BigInt(r) > 0n && BigInt(r) < SECP256K1_ORDER, "Signature r is outside the secp256k1 range");
  assert.ok(BigInt(s) > 0n && BigInt(s) <= SECP256K1_ORDER / 2n, "Signature is not canonical low-S");
  assert.ok(v === 27 || v === 28, "Message signature v must be 27 or 28");
  const expectedAddress = getAddress(fixture.expectedAddress) as Address;
  let digest: Hex;
  let wrongChainId: EvmSignatureChainId | undefined;
  let wrongChainRecoveredAddress: Address | undefined;
  if (fixture.kind === "message") {
    const raw = fixture.request.messageHex as Hex;
    assert.equal(stringToHex(fixture.message), raw, "Personal fixture text and bytes differ");
    const ethersDigest = ethersHashMessage(getBytes(raw));
    digest = viemHashMessage({ raw });
    assert.equal(ethersDigest, digest, "ethers and viem disagree on the personal-sign digest");
    assert.equal(ethersVerifyMessage(getBytes(raw), signature), expectedAddress);
    assert.equal(getAddress(await recoverMessageAddress({ message: { raw }, signature })), expectedAddress);
    assert.ok(await viemVerifyMessage({ address: expectedAddress, message: { raw }, signature }));
    // EIP-191 carries raw bytes, not the printable hexadecimal representation.
    assert.notEqual(ethersVerifyMessage(raw, signature), expectedAddress, "Signature unexpectedly signs the hex string as text");
    const changed = `${fixture.message}\nChanged payload.`;
    assert.notEqual(ethersVerifyMessage(changed, signature), expectedAddress);
    assert.equal(await viemVerifyMessage({ address: expectedAddress, message: changed, signature }), false);
  } else {
    const data = fixture.typedData;
    assert.equal(data.domain.chainId.toString(), fixture.chainId);
    const types = messageTypes(data.types);
    const ethersDigest = TypedDataEncoder.hash(data.domain, types, data.message);
    digest = viemHashTypedData(data);
    assert.equal(ethersDigest, digest, "ethers and viem disagree on the EIP-712 digest");
    assert.equal(ethersVerifyTypedData(data.domain, types, data.message, signature), expectedAddress);
    assert.equal(getAddress(await recoverTypedDataAddress({ ...data, signature })), expectedAddress);
    assert.ok(await viemVerifyTypedData({ ...data, address: expectedAddress, signature }));
    wrongChainId = otherChain(fixture.chainId);
    const wrongData = { ...data, domain: { ...data.domain, chainId: Number(wrongChainId) } };
    const wrongEthersDigest = TypedDataEncoder.hash(wrongData.domain, types, data.message);
    const wrongViemDigest = viemHashTypedData(wrongData);
    assert.equal(wrongEthersDigest, wrongViemDigest);
    assert.notEqual(wrongViemDigest, digest, "Changing domain.chainId must change the digest");
    wrongChainRecoveredAddress = getAddress(ethersVerifyTypedData(wrongData.domain, types, data.message, signature)) as Address;
    assert.notEqual(wrongChainRecoveredAddress, expectedAddress, "Signature incorrectly verifies on the other network");
    assert.equal(getAddress(await recoverTypedDataAddress({ ...wrongData, signature })), wrongChainRecoveredAddress);
    assert.equal(await viemVerifyTypedData({ ...wrongData, address: expectedAddress, signature }), false);
  }
  assert.equal(ethersRecoverAddress(digest, signature), expectedAddress, "Digest recovery differs from message recovery");
  return {
    digest,
    signature,
    address: expectedAddress,
    r,
    s,
    v,
    ...(wrongChainId && wrongChainRecoveredAddress ? { wrongChainId, wrongChainRecoveredAddress } : {}),
  };
}

function otherChain(chainId: EvmSignatureChainId): EvmSignatureChainId {
  return chainId === "1" ? "42161" : "1";
}

function messageTypes(types: TypeFields): TypeFields {
  // ethers constructs EIP712Domain from domain values. Passing it as a message
  // struct would create a second primary type. viem takes the complete schema.
  return Object.fromEntries(Object.entries(types).filter(([name]) => name !== "EIP712Domain"));
}
