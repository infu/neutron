import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  executeQualificationCase,
  type SampleLogicalMethod,
  type SampleRuntime,
} from "./cases.ts";

const APP_ID = "ca_qualification_aux_1";
const CANISTER_ID = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const PUBLICATION_TARGET = {
  collection: "publication",
  collection_generation: 1n,
  locator: {
    publication: {
      publication_id: new Uint8Array(32),
      filename: "single.bin",
    },
  },
} as const;

describe("Certified Assets qualification stage assertions", () => {
  test("publication allocation must return its target at begin", async () => {
    const runtime = fakeRuntime(async (method, args) => {
      expect(method).toBe("qualification_begin_stage");
      return beginReply(args, []);
    });
    await expect(
      executeQualificationCase(
        runtime,
        "publication_certified_reads",
        APP_ID,
      ),
    ).rejects.toThrow("did not allocate its target at begin");
  });

  test("digest-derived allocation must not invent a begin target", async () => {
    const digestTarget = {
      collection: "immutable",
      collection_generation: 1n,
      locator: { body_sha256: { digest: new Uint8Array(32) } },
    };
    const runtime = fakeRuntime(async (method, args) => {
      expect(method).toBe("qualification_begin_stage");
      return beginReply(args, [digestTarget]);
    });
    await expect(
      executeQualificationCase(
        runtime,
        "immutable_staged_lifecycle",
        APP_ID,
      ),
    ).rejects.toThrow("allocated a target before upload");
  });

  test("chunk replay must preserve every computed field", async () => {
    let calls = 0;
    const runtime = fakeRuntime(async (method, args) => {
      if (method === "qualification_begin_stage") {
        return beginReply(args, [PUBLICATION_TARGET]);
      }
      expect(method).toBe("qualification_put_chunk");
      calls += 1;
      const input = args[0] as {
        stage_id: bigint;
        index: number;
        body: Uint8Array;
      };
      const changed = structuredClone(PUBLICATION_TARGET);
      changed.locator.publication.publication_id[0] = 1;
      return {
        ok: {
          stage_id: input.stage_id,
          index: input.index,
          block_sha256: sha256(input.body),
          accepted: calls === 1 ? { new: null } : { replayed: null },
          complete: true,
          raw_sha256: [sha256(input.body)],
          computed_target: [
            calls === 1 ? PUBLICATION_TARGET : changed,
          ],
        },
      };
    });
    await expect(
      executeQualificationCase(
        runtime,
        "publication_certified_reads",
        APP_ID,
      ),
    ).rejects.toThrow("Replayed stage chunk changed its result");
  });

  test("digest completion must derive the exact uploaded body target", async () => {
    let calls = 0;
    const runtime = fakeRuntime(async (method, args) => {
      calls += 1;
      if (method === "qualification_begin_stage") {
        return beginReply(args, []);
      }
      expect(method).toBe("qualification_put_chunk");
      const input = args[0] as {
        stage_id: bigint;
        index: number;
        body: Uint8Array;
      };
      const wrong = sha256(input.body);
      wrong[0] = wrong[0]! ^ 0xff;
      return {
        ok: {
          stage_id: input.stage_id,
          index: input.index,
          block_sha256: sha256(input.body),
          accepted: { new: null },
          complete: true,
          raw_sha256: [sha256(input.body)],
          computed_target: [{
            collection: "immutable",
            collection_generation: 1n,
            locator: { body_sha256: { digest: wrong } },
          }],
        },
      };
    });
    await expect(
      executeQualificationCase(
        runtime,
        "immutable_staged_lifecycle",
        APP_ID,
      ),
    ).rejects.toThrow("completed digest-derived target");
    expect(calls).toBe(2);
  });
});

function fakeRuntime(
  call: (
    method: SampleLogicalMethod,
    args: readonly unknown[],
  ) => Promise<unknown>,
): SampleRuntime {
  return {
    canisterId: CANISTER_ID,
    gatewayOrigin: `http://${CANISTER_ID}.localhost:8000`,
    observations: { candid: [], http: [] },
    call,
    generation: async () => 1n,
    deterministicBytes: (step, length) =>
      new Uint8Array(length).fill(step & 0xff),
    verifyHttp: async () => {
      throw new Error("HTTP must not run after a malformed stage");
    },
  };
}

function beginReply(
  args: readonly unknown[],
  computedTarget: readonly unknown[],
): unknown {
  const input = args[0] as {
    target:
      | { allocate_publication: { collection: string } }
      | { derive_body_sha256: { collection: string } };
    expected_bytes: bigint;
  };
  const declaration =
    "allocate_publication" in input.target
      ? input.target.allocate_publication
      : input.target.derive_body_sha256;
  return {
    ok: {
      stage_id: 1n,
      identity: {
        collection: declaration.collection,
        collection_generation: 1n,
        computed_target: computedTarget,
      },
      geometry: {
        block_bytes: 1_889_984n,
        block_count: 1,
        expected_bytes: input.expected_bytes,
      },
      expires_at_ns: 1n,
    },
  };
}

function sha256(value: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(value).digest());
}
