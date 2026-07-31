import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { SampleRuntime } from "./cases.ts";
import {
  CERTIFIED_ASSETS_QUALIFICATION_FIXTURES,
} from "./fixture_manifests.ts";
import { assertQualificationFixtureSetAdmission } from "./fixture_admission.ts";
import {
  executeMultiscopeQualificationCase,
  type QualificationScopeRuntime,
} from "./multiscope_cases.ts";

type Dict = Record<string, unknown>;
type Stage = {
  owner: string;
  id: bigint;
  body?: Uint8Array;
};
type Identity = {
  target: Dict;
  kernel_revision: bigint;
  content_tag: Uint8Array;
};

class FakeWorld {
  readonly stages = new Map<bigint, Stage>();
  readonly records = new Map<string, Identity>();
  nextStage = 1n;

  constructor(readonly stageLimit = 4) {}
}

class FakeRuntime implements SampleRuntime {
  readonly canisterId = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  readonly gatewayOrigin = "http://127.0.0.1:19000";
  readonly observations = { candid: [], http: [] } as const;

  constructor(
    private readonly world: FakeWorld,
    private readonly appId: string,
    private readonly generationValue: bigint,
  ) {}

  async generation(_collection: string): Promise<bigint> {
    return this.generationValue;
  }

  deterministicBytes(step: number, length: number): Uint8Array {
    return Uint8Array.from(
      { length },
      (_, index) => (step + index * 17) & 0xff,
    );
  }

  async verifyHttp(): Promise<never> {
    throw new Error("HTTP is not used by multiscope cases");
  }

  async call(method: string, args: readonly unknown[]): Promise<unknown> {
    if (method === "kernel_diagnostics") {
      return {
        allocator: {
          active_stage_count: BigInt(this.world.stages.size),
        },
        authenticated_forest: {
          record_count: BigInt(this.world.records.size),
        },
      };
    }
    if (method === "qualification_usage") {
      return {
        ok: {
          current: {
            active_stages: BigInt(
              [...this.world.stages.values()].filter(
                ({ owner }) => owner === this.appId,
              ).length,
            ),
          },
        },
      };
    }
    if (method === "qualification_begin_stage") {
      if (
        this.world.stages.size >= this.world.stageLimit ||
        [...this.world.stages.values()].some(
          ({ owner }) => owner === this.appId,
        )
      ) {
        return { err: { quota: null } };
      }
      const input = args[0] as Dict;
      const id = this.world.nextStage++;
      this.world.stages.set(id, { owner: this.appId, id });
      return {
        ok: {
          stage_id: id,
          geometry: {
            expected_bytes: input.expected_bytes,
            block_count: 1,
            block_bytes: 1n,
          },
        },
      };
    }
    if (method === "qualification_abort_stage") {
      const id = args[0] as bigint;
      const stage = this.world.stages.get(id);
      if (stage?.owner !== this.appId) {
        return { err: { not_found: null } };
      }
      this.world.stages.delete(id);
      return { ok: null };
    }
    if (method === "qualification_stage_status") {
      const stage = this.world.stages.get(args[0] as bigint);
      return stage?.owner === this.appId
        ? { ok: { active: {} } }
        : { ok: { unknown: null } };
    }
    if (method === "qualification_put_chunk") {
      const input = args[0] as Dict;
      const stage = this.world.stages.get(input.stage_id as bigint);
      if (stage?.owner !== this.appId) {
        return { err: { not_found: null } };
      }
      stage.body = Uint8Array.from(input.body as Uint8Array);
      return {
        ok: {
          complete: true,
          accepted: { new: null },
          stage_id: stage.id,
          index: 0,
          block_sha256: sha256(stage.body),
          raw_sha256: [sha256(stage.body)],
          computed_target: [],
        },
      };
    }
    if (method === "qualification_record_status") {
      const target = args[0] as Dict;
      const identity = this.world.records.get(recordKey(this.appId, target));
      return identity === undefined
        ? {
            ok: {
              absent: {
                collection_generation: target.collection_generation,
              },
            },
          }
        : {
            ok: {
              present: {
                ...identity,
                body_bytes: 1n,
                geometry: {},
                block_hashes: [],
              },
            },
          };
    }
    if (method === "qualification_commit_batch") {
      const input = args[0] as Dict;
      const operation = (input.operations as Dict[])[0]!;
      if ("put" in operation) {
        const put = operation.put as Dict;
        const stageId = (put.body as Dict).stage as bigint;
        const stage = this.world.stages.get(stageId);
        if (stage?.owner !== this.appId || stage.body === undefined) {
          return { err: { not_found: null } };
        }
        const identity = {
          target: put.target as Dict,
          kernel_revision: 1n,
          content_tag: sha256(stage.body),
        };
        this.world.records.set(
          recordKey(this.appId, identity.target),
          identity,
        );
        this.world.stages.delete(stageId);
        return {
          ok: {
            operations: [{
              put: {
                request_index: 0,
                lifecycle: {
                  committed: {
                    ...identity,
                    body_bytes: 1n,
                    geometry: {},
                    block_hashes: [],
                  },
                },
              },
            }],
          },
        };
      }
      const deletion = operation.delete as Dict;
      const target = deletion.target as Dict;
      const key = recordKey(this.appId, target);
      if (!this.world.records.has(key)) {
        return { err: { not_found: null } };
      }
      this.world.records.delete(key);
      return { ok: { operations: [] } };
    }
    throw new Error(`Unexpected fake method ${method}`);
  }
}

describe("Certified Assets multiscope qualification", () => {
  test("the exact five-scope suite passes physical admission", () => {
    const admission = assertQualificationFixtureSetAdmission();

    expect(admission.scopes.map(({ app_id }) => app_id)).toEqual(
      CERTIFIED_ASSETS_QUALIFICATION_FIXTURES.map(({ app_id }) => app_id),
    );
    expect(admission.charged_bytes_with_allocator_metadata).toBeLessThanOrEqual(
      2_617_245_696n,
    );
    expect(admission.arena_bytes).toBeLessThanOrEqual(1_879_048_192n);
    expect(admission.arena_descriptors).toBeLessThanOrEqual(250_000n);
  });

  test("proves the four-of-five global stage boundary", async () => {
    const scopes = fakeScopes(new FakeWorld());

    await expect(
      executeMultiscopeQualificationCase(
        scopes,
        "global_stage_admission",
      ),
    ).resolves.toEqual([
      "four_scopes_admitted",
      "fifth_scope_quota_rejected",
      "rejected_scope_unchanged",
      "released_slot_reused",
    ]);
  });

  test("fails if the runtime admits a fifth active stage", async () => {
    const scopes = fakeScopes(new FakeWorld(5));

    await expect(
      executeMultiscopeQualificationCase(
        scopes,
        "global_stage_admission",
      ),
    ).rejects.toThrow("unexpectedly succeeded");
  });

  test("proves stage and record isolation between exact scopes", async () => {
    const scopes = fakeScopes(new FakeWorld());

    await expect(
      executeMultiscopeQualificationCase(scopes, "scope_isolation"),
    ).resolves.toEqual([
      "foreign_stage_hidden",
      "foreign_stage_mutation_rejected",
      "owning_scope_record_present",
      "same_locator_absent_in_other_scope",
      "foreign_identity_delete_rejected",
    ]);
  });

  test("rejects a reordered or cross-canister fixture set", async () => {
    const reordered = fakeScopes(new FakeWorld());
    [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
    await expect(
      executeMultiscopeQualificationCase(
        reordered,
        "global_stage_admission",
      ),
    ).rejects.toThrow("scope 0 must be");

    const crossCanister = fakeScopes(new FakeWorld());
    Object.defineProperty(crossCanister[4]!.runtime, "canisterId", {
      value: "ryjl3-tyaaa-aaaaa-aaaba-cai",
    });
    await expect(
      executeMultiscopeQualificationCase(
        crossCanister,
        "global_stage_admission",
      ),
    ).rejects.toThrow("must share one Kernel canister");
  });
});

function fakeScopes(world: FakeWorld): QualificationScopeRuntime[] {
  return CERTIFIED_ASSETS_QUALIFICATION_FIXTURES.map((fixture, index) => ({
    appId: fixture.app_id,
    runtime: new FakeRuntime(world, fixture.app_id, BigInt(index + 1)),
  }));
}

function sha256(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

function recordKey(appId: string, target: Dict): string {
  const locator = target.locator as {
    body_sha256: { digest: Uint8Array };
  };
  return [
    appId,
    String(target.collection),
    String(target.collection_generation),
    Buffer.from(locator.body_sha256.digest).toString("hex"),
  ].join(":");
}
