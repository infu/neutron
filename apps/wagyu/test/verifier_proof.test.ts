import { describe, expect, test } from "bun:test";
import { Cbor } from "@dfinity/agent";
import {
  assertFreshCertificate,
  boundedHashTree,
  certifiedRequestHashV2,
  certifiedResponseHashV2,
  checkLikeHeadHighWater,
  checkProfileHighWater,
  checkReplyIndexHighWater,
  decodeExpressionPath,
  DEFAULT_PROOF_LIMITS_V1,
  expectedCertifiedHeaders,
  parseCertificateHeaderV2,
  toBase64,
  toLowerHex,
  validatePortableProofShape,
  verifierProofFromProtocol,
  WAGYU_CERTIFICATION_EXPRESSION_V1,
} from "../src/verifier/index.ts";

function certificateHeader(
  certificate = Uint8Array.of(1, 2),
  tree = Uint8Array.of(3, 4),
  path = Cbor.encode(["http_expr", "app", "wagyu", "<$>"]),
): string {
  return `certificate=:${toBase64(certificate)}:, tree=:${toBase64(tree)}:, expr_path=:${toBase64(path)}:, version=2`;
}

describe("bounded proof parsing", () => {
  test("parses only the closed canonical V2 header", () => {
    const proof = parseCertificateHeaderV2(certificateHeader());
    expect(proof.certificateVersion).toBe(2);
    expect([...proof.certificateCbor]).toEqual([1, 2]);
    expect(decodeExpressionPath(proof.expressionPathCbor)).toEqual([
      "http_expr",
      "app",
      "wagyu",
      "<$>",
    ]);

    for (const hostile of [
      `${certificateHeader()}, version=2`,
      certificateHeader().replace("version=2", "version=1"),
      `${certificateHeader()}, extra=1`,
      certificateHeader().replace("certificate=:AQI=:", "certificate=:AQI=:, certificate=:AQI=:"),
      certificateHeader().replace("AQI=", "AQI"),
    ]) {
      expect(() => parseCertificateHeaderV2(hostile)).toThrow();
    }
  });

  test("fails closed at portable snapshot/component bounds", () => {
    expect(() =>
      validatePortableProofShape({
        certificateVersion: 2,
        certificateCbor: new Uint8Array(4_096),
        witnessCbor: new Uint8Array(1_400),
        expressionPathCbor: Uint8Array.of(1),
        certificateTimeNs: 1n,
      })
    ).toThrow("5500");
    expect(() =>
      validatePortableProofShape({
        certificateVersion: 2,
        certificateCbor: Uint8Array.of(1),
        witnessCbor: Uint8Array.of(1),
        expressionPathCbor: Uint8Array.of(1),
        certificateTimeNs: 0n,
      })
    ).toThrow("positive");
  });

  test("copies every nested API-1 proof Blob as an exact Uint8Array view", () => {
    const backing = Uint8Array.from(
      { length: 32 },
      (_, index) => index,
    );
    const certificate = backing.subarray(3, 8);
    const witness = backing.subarray(9, 15);
    const expressionPath = backing.subarray(17, 21);
    const proof = verifierProofFromProtocol({
      certificate_version: 2,
      certificate_cbor: certificate,
      witness_cbor: witness,
      expression_path_cbor: expressionPath,
      certificate_time_ns: 123n,
    });

    expect(proof.certificateCbor).toBeInstanceOf(Uint8Array);
    expect(proof.witnessCbor).toBeInstanceOf(Uint8Array);
    expect(proof.expressionPathCbor).toBeInstanceOf(Uint8Array);
    expect([...proof.certificateCbor]).toEqual([3, 4, 5, 6, 7]);
    expect([...proof.witnessCbor]).toEqual([9, 10, 11, 12, 13, 14]);
    expect([...proof.expressionPathCbor]).toEqual([17, 18, 19, 20]);

    backing.fill(0xff);
    expect([...proof.certificateCbor]).toEqual([3, 4, 5, 6, 7]);
    expect(validatePortableProofShape(proof).certificateTimeNs).toBe(123n);
  });

  test("bounds witness work without turning legitimate tree depth into a content quota", () => {
    const labels = Array.from(
      { length: 80 },
      (_, index) => Uint8Array.of(index),
    );
    let encodedTree: unknown = [3, new Uint8Array()];
    for (let index = labels.length - 1; index >= 0; index -= 1) {
      encodedTree = [2, labels[index], encodedTree];
    }

    const tree = boundedHashTree(
      Cbor.decode(Cbor.encode(encodedTree)),
      DEFAULT_PROOF_LIMITS_V1,
    );
    let cursor = tree;
    for (const label of labels) {
      expect(cursor[0]).toBe(2);
      if (cursor[0] !== 2) throw new Error("Expected labeled witness node");
      expect([...cursor[1]]).toEqual([...label]);
      cursor = cursor[2];
    }
    expect(cursor[0]).toBe(3);
  });

  test("retains the independent witness node budget", () => {
    const limits = {
      ...DEFAULT_PROOF_LIMITS_V1,
      maxTreeNodes: 8,
    };
    let tree: unknown = [3, new Uint8Array()];
    for (let index = 0; index < 8; index += 1) {
      tree = [2, Uint8Array.of(index), tree];
    }
    expect(() => boundedHashTree(tree, limits)).toThrow("node bound");
  });
});

test("HTTP V2 request/response hashes match the frozen Kernel vector", async () => {
  expect(toLowerHex(await certifiedRequestHashV2())).toBe(
    "6bc74eda155eb1976f8683d41bc7f8e5b6e9dd02b4b51d038dcb3fee3637ac69",
  );
  const body = new TextEncoder().encode("DIDL\\00head-v1");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", body),
  );
  const headers = expectedCertifiedHeaders(
    "mutable_blob",
    body.byteLength,
    digest,
  );
  expect(headers.at(-1)).toEqual([
    "IC-CertificateExpression",
    WAGYU_CERTIFICATION_EXPRESSION_V1,
  ]);
  expect(toLowerHex(await certifiedResponseHashV2(headers, digest))).toBe(
    "e55a07b88ff0dfeb850c5f1e68969fd4cabdecf6e489ea67894fe6489164ad24",
  );
});

describe("freshness and high-water rules", () => {
  const digestA = new Uint8Array(32).fill(1);
  const digestB = new Uint8Array(32).fill(2);

  test("enforces five-minute mutable freshness and future skew", () => {
    const nowNs = 1_000_000_000_000n;
    assertFreshCertificate(nowNs - 299_000_000_000n, { nowNs });
    expect(() =>
      assertFreshCertificate(nowNs - 301_000_000_000n, { nowNs })
    ).toThrow("stale");
    expect(() =>
      assertFreshCertificate(nowNs + 61_000_000_000n, { nowNs })
    ).toThrow("future");
  });

  test("profile rejects rollback/equivocation and checks adjacent digest", () => {
    const prior = {
      profileGeneration: 7n,
      revision: 4n,
      bodyDigest: digestA,
    };
    expect(checkProfileHighWater(prior, {
      profileGeneration: 7n,
      revision: 4n,
      bodyDigest: digestA,
      previousProfileDigest: null,
    }).state).toBe("replay");
    expect(checkProfileHighWater(prior, {
      profileGeneration: 7n,
      revision: 4n,
      bodyDigest: digestB,
      previousProfileDigest: null,
    }).state).toBe("reject");
    expect(checkProfileHighWater(prior, {
      profileGeneration: 7n,
      revision: 5n,
      bodyDigest: digestB,
      previousProfileDigest: digestB,
    }).state).toBe("reject");
    expect(checkProfileHighWater(prior, {
      profileGeneration: 8n,
      revision: 0n,
      bodyDigest: digestB,
      previousProfileDigest: null,
    }).state).toBe("advance");
  });

  test("like head uses generation/revision and adjacent raw head hash", () => {
    const prior = {
      storeGeneration: 3n,
      revision: 8n,
      bodyDigest: digestA,
    };
    expect(checkLikeHeadHighWater(prior, {
      storeGeneration: 3n,
      revision: 9n,
      bodyDigest: digestB,
      previousHeadHash: digestA,
    }).state).toBe("advance");
    expect(checkLikeHeadHighWater(prior, {
      storeGeneration: 2n,
      revision: 99n,
      bodyDigest: digestB,
      previousHeadHash: digestA,
    }).state).toBe("reject");
  });

  test("reply index uses generation/revision and adjacent raw index hash", () => {
    const prior = {
      storeGeneration: 5n,
      revision: 11n,
      bodyDigest: digestA,
    };
    expect(checkReplyIndexHighWater(prior, {
      storeGeneration: 5n,
      revision: 12n,
      bodyDigest: digestB,
      previousIndexHash: digestA,
    }).state).toBe("advance");
    expect(checkReplyIndexHighWater(prior, {
      storeGeneration: 4n,
      revision: 99n,
      bodyDigest: digestB,
      previousIndexHash: digestA,
    }).state).toBe("reject");
    expect(checkReplyIndexHighWater(prior, {
      storeGeneration: 5n,
      revision: 12n,
      bodyDigest: digestB,
      previousIndexHash: digestB,
    }).state).toBe("reject");
  });
});
