import { describe, expect, test } from "bun:test";
import { spawnSync, which } from "bun";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { IDL } from "@dfinity/candid";
import type { IDL as CandidIDL } from "@dfinity/candid";
import {
  extractPublicTypeAliases,
  motokoTypeToIdl,
} from "neutron-scripts/src/method_schema.js";
import {
  WAGYU_IDL,
  WAGYU_OWNER_METHODS,
  WAGYU_PUBLIC_INGRESS_METHOD,
  createWagyuIdlTypes,
  wagyuOwnerSelfCallIdlFactory,
  wagyuServiceIdlFactory,
} from "../src/protocol/index.ts";

const OWNER_SELF_CALL_MODES = Object.freeze({
  wagyu_feed_page_self_v1: "query",
  wagyu_notification_page_self_v1: "query",
  wagyu_notification_evidence_self_v1: "query",
  wagyu_block_statuses_self_v1: "query",
  wagyu_profile_edit_v1: "update",
  wagyu_follow_self_v1: "update",
  wagyu_auto_renew_self_v1: "update",
  wagyu_post_prepare_self_v1: "update",
  wagyu_share_prepare_self_v1: "update",
  wagyu_like_prepare_self_v1: "update",
  wagyu_tombstone_prepare_self_v1: "update",
  wagyu_post_finalize_self_v1: "update",
  wagyu_share_finalize_self_v1: "update",
  wagyu_like_finalize_self_v1: "update",
  wagyu_tombstone_finalize_self_v1: "update",
  wagyu_feed_promote_self_v1: "update",
  wagyu_feed_reject_self_v1: "update",
  wagyu_notification_promote_self_v1: "update",
  wagyu_like_seal_self_v1: "update",
  wagyu_withdrawal_advance_self_v1: "update",
} as const);

interface ReleaseCorpusV1 {
  readonly schema: "wagyu-release-corpus-v1";
  readonly app_id: "wagyu";
  readonly baseline_version: number;
  readonly supported_predecessor_versions: readonly number[];
  readonly files: Readonly<
    Record<string, { readonly bytes: number; readonly sha256: string }>
  >;
}

describe("Wagyu V1 checked Candid contracts", () => {
  test("the current release retains the exact production v101 V1 Candid corpus", () => {
    const corpus = JSON.parse(
      readFileSync(
        new URL(
          "../candid/releases/v101-v1-corpus.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as ReleaseCorpusV1;
    const manifest = JSON.parse(
      readFileSync(new URL("../neutron.json", import.meta.url), "utf8"),
    ) as { id: string; version: number };

    expect(corpus).toMatchObject({
      schema: "wagyu-release-corpus-v1",
      app_id: "wagyu",
      baseline_version: 101,
      supported_predecessor_versions: [],
    });
    expect(manifest).toMatchObject({
      id: corpus.app_id,
      version: 303,
    });
    expect(manifest.version).toBeGreaterThanOrEqual(corpus.baseline_version);

    expect(Object.keys(corpus.files).sort()).toEqual([
      "fixtures/golden-v1.json",
      "fixtures/v1-values.ts",
      "generated/wagyu-owner-self-calls-v1.did.d.ts",
      "generated/wagyu-owner-self-calls-v1.did.js",
      "generated/wagyu-v1.did.d.ts",
      "generated/wagyu-v1.did.js",
      "nested/action-objects-v1.did",
      "nested/ingress-v1.did",
      "nested/local-pages-v1.did",
      "nested/portable-refs-v1.did",
      "wagyu-owner-self-calls-v1.did",
      "wagyu-v1.did",
    ]);

    for (const [path, expected] of Object.entries(corpus.files)) {
      const bytes = readFileSync(
        new URL(`../candid/${path}`, import.meta.url),
      );
      expect(bytes.byteLength, `${path} byte length`).toBe(expected.bytes);
      expect(
        createHash("sha256").update(bytes).digest("hex"),
        `${path} SHA-256`,
      ).toBe(expected.sha256);
    }
  });

  test("canonical core service exposes the six frozen physical methods", () => {
    const source = readFileSync(
      new URL("../candid/wagyu-v1.did", import.meta.url),
      "utf8",
    );
    const expected = [
      WAGYU_PUBLIC_INGRESS_METHOD,
      ...Object.values(WAGYU_OWNER_METHODS),
    ];
    for (const method of expected) expect(source).toContain(method);

    const service = wagyuServiceIdlFactory({ IDL }).display();
    for (const method of expected) expect(service).toContain(method);
  });

  test("generated core service and runtime codec types remain structurally identical", () => {
    const types = createWagyuIdlTypes(IDL);
    const expected = IDL.Service({
      [WAGYU_PUBLIC_INGRESS_METHOD]: IDL.Func(
        [types.PublicIngressRequestV1],
        [types.PublicIngressResultV1],
        [],
      ),
      [WAGYU_OWNER_METHODS.getFeedPage]: IDL.Func(
        [types.FeedPageRequestV1],
        [types.FeedPageV1],
        ["query"],
      ),
      [WAGYU_OWNER_METHODS.getNotificationPage]: IDL.Func(
        [types.NotificationPageRequestV1],
        [types.NotificationPageV1],
        ["query"],
      ),
      [WAGYU_OWNER_METHODS.getNotificationEvidence]: IDL.Func(
        [types.NotificationEvidenceRequestV1],
        [types.NotificationEvidenceV1],
        ["query"],
      ),
      [WAGYU_OWNER_METHODS.getSendQuote]: IDL.Func(
        [types.SendQuoteRequestV1],
        [types.SendQuoteV1],
        ["query"],
      ),
      [WAGYU_OWNER_METHODS.profileEdit]: IDL.Func(
        [types.ProfileEditRequestV1],
        [types.ProfileEditResultV1],
        [],
      ),
    });

    expect(wagyuServiceIdlFactory({ IDL }).display()).toBe(
      expected.display(),
    );
  });

  test("owner API-1 binding is structurally identical to live backend aliases", () => {
    const mainSource = readFileSync(
      new URL("../backend/main.mo", import.meta.url),
      "utf8",
    );
    const aliases = extractPublicTypeAliases(mainSource);
    const methods: Record<string, CandidIDL.FuncClass> = {};

    for (const [method, mode] of Object.entries(OWNER_SELF_CALL_MODES)) {
      const input = aliases[`${method}_Input`];
      const output = aliases[`${method}_Output`];
      expect(input, `${method} input alias`).toBeDefined();
      expect(output, `${method} output alias`).toBeDefined();
      methods[method] = IDL.Func(
        [motokoTypeToIdl(input!, IDL, aliases)],
        [motokoTypeToIdl(output!, IDL, aliases)],
        mode === "query" ? ["query"] : [],
      );
    }

    expect(wagyuOwnerSelfCallIdlFactory({ IDL }).display()).toBe(
      IDL.Service(methods).display(),
    );

    for (const typeName of [
      "ProfileEditRequestV1",
      "RelationshipSummaryV1",
      "SendQuoteV1",
    ] as const) {
      expect(WAGYU_IDL[typeName].display()).toBe(
        motokoTypeToIdl(typeName, IDL, aliases).display(),
      );
    }
  });

  test("all canonical DIDs parse with didc when it is available", () => {
    if (which("didc") === null) {
      if (process.env.CI) {
        throw new Error("didc is required for Wagyu release CI");
      }
      return;
    }
    const candidDirectory = new URL("../candid/", import.meta.url);
    const nestedDirectory = new URL("../candid/nested/", import.meta.url);
    const files = [
      ...readdirSync(candidDirectory)
        .filter((name) => name.endsWith(".did"))
        .map((name) => new URL(name, candidDirectory)),
      ...readdirSync(nestedDirectory)
        .filter((name) => name.endsWith(".did"))
        .map((name) => new URL(name, nestedDirectory)),
    ];
    for (const file of files) {
      const result = spawnSync(["didc", "check", file.pathname]);
      expect(
        result.exitCode,
        `${file.pathname}: ${result.stderr.toString()}`,
      ).toBe(0);
    }
  });

  test("checked generated bindings are byte-for-byte didc output", () => {
    if (which("didc") === null) return;
    for (const sourceName of [
      "wagyu-v1.did",
      "wagyu-owner-self-calls-v1.did",
    ]) {
      const source = new URL(`../candid/${sourceName}`, import.meta.url);
      for (const target of ["js", "ts"] as const) {
        const generatedName =
          target === "js" ? `${sourceName}.js` : `${sourceName}.d.ts`;
        const result = spawnSync([
          "didc",
          "bind",
          "-t",
          target,
          source.pathname,
        ]);
        expect(
          result.exitCode,
          `${source.pathname}: ${result.stderr.toString()}`,
        ).toBe(0);
        expect(result.stdout.toString()).toBe(
          readFileSync(
            new URL(
              `../candid/generated/${generatedName}`,
              import.meta.url,
            ),
            "utf8",
          ),
        );
      }
    }
  });

  test("API-1 binary values are nested record fields, not trailing arguments", () => {
    const owner = readFileSync(
      new URL(
        "../candid/wagyu-owner-self-calls-v1.did",
        import.meta.url,
      ),
      "utf8",
    );
    expect(owner).toMatch(
      /ProfileEditAvatarV1\s*=\s*record\s*\{[^}]*bytes\s*:\s*blob/su,
    );
    expect(owner).toMatch(
      /SharePrepareSelfRequestV1\s*=\s*record\s*\{[^}]*exact_original_post_ref_candid\s*:\s*blob/su,
    );
    expect(owner).toMatch(
      /FinalizeSelfRequestV1\s*=\s*record\s*\{[^}]*exact_proof_candid\s*:\s*blob/su,
    );
    expect(owner).toMatch(
      /wagyu_profile_edit_v1\s*:\s*\(ProfileEditRequestV1\)\s*->/u,
    );
    expect(owner).not.toMatch(
      /wagyu_profile_edit_v1\s*:\s*\(ProfileEditRequestV1\s*,/u,
    );
  });

  test("extensible variants are optional at their exact record fields", () => {
    const source = readFileSync(
      new URL("../candid/wagyu-v1.did", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/action_kind\s*:\s*opt ActionKindV1/u);
    expect(source).toMatch(/event\s*:\s*opt DeliveryEventV1/u);
    expect(source).toMatch(/relation\s*:\s*opt NoticeRelationV1/u);
    expect(source).toMatch(/outcome\s*:\s*opt WagyuRouteOutcomeV1/u);
    expect(source).toMatch(/state\s*:\s*opt FollowerStateV1/u);
    expect(source).not.toMatch(/action_kind\s*:\s*ActionKindV1/u);
  });
});
