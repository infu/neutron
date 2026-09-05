import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMotoko } from "neutron-motoko-wasm";
import {
  checkForDangerousASTCode,
  checkForDangerousSyntaxFacts,
  needsDangerousASTFallback,
  DANGER_RULE_ORDER,
  type DangerRule,
} from "../src/lib.ts";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("complete compact inspection preserves all AST reports without fallback", async () => {
  const mo = await loadMotoko();
  for (const directory of ["allowed", "disallowed"]) {
    const fixtureDirectory = path.join(packageRoot, directory);
    for (const file of (await fs.readdir(fixtureDirectory)).sort()) {
      const source = await fs.readFile(path.join(fixtureDirectory, file), "utf8");
      const [astResult, inspectionResult] = await Promise.allSettled([
        mo.parseMotoko(source),
        mo.inspectMotoko(file, source),
      ]);

      expect(inspectionResult.status).toBe(astResult.status);
      if (astResult.status === "rejected") {
        expect(inspectionResult.status).toBe("rejected");
        if (inspectionResult.status === "rejected") {
          const message = (reason: unknown): string =>
            reason instanceof Error ? reason.message : String(reason);
          expect(message(inspectionResult.reason)).toBe(
            message(astResult.reason),
          );
        }
        continue;
      }
      if (inspectionResult.status === "rejected") {
        throw inspectionResult.reason;
      }
      const ast = astResult.value;
      const inspection = inspectionResult.value;
      const fullFindings = checkForDangerousASTCode(ast, source);
      expect(needsDangerousASTFallback(inspection, source)).toBe(false);
      const compilerFindings = checkForDangerousSyntaxFacts(inspection, source);
      expect(compilerFindings).toEqual(fullFindings);
      expect(inspection).toEqual({
        immediateImports: expect.any(Array),
        hasActorUrl: expect.any(Boolean),
        dotMembers: expect.any(Array),
        patternFields: expect.any(Array),
      });
    }
  }
});

test("compact and full AST reports retain legacy order for combined findings", async () => {
  const source = `
    import Prim "mo:prim";
    module {
      public func inspect(target : Text) : actor {} {
        Prim.cyclesAdd(1);
        ignore Prim.createActor;
        ignore Prim.stableMemoryStoreBlob;
        ignore Prim.stableMemoryLoadNat64;
        ignore Prim.stableVarQuery;
        ignore Prim.getCertificate;
        ignore Prim.setCertifiedData;
        ignore Prim.call_raw;
        actor (target)
      };
    }
  `;
  const mo = await loadMotoko();
  const [ast, inspection] = await Promise.all([
    mo.parseMotoko(source),
    mo.inspectMotoko("combined.mo", source),
  ]);

  expect(checkForDangerousSyntaxFacts(inspection, source)).toEqual(
    checkForDangerousASTCode(ast, source),
  );
});

test("compact and full AST acquisition truth tables agree for every danger rule", async () => {
  const members: Array<[string, DangerRule]> = [
    ["actorOfPrincipal", "actorOfPrincipal"],
    ["call_raw", "call_raw"],
    ["createActor", "createActor"],
    ["cyclesAdd", "cyclesAdd"],
    ["cyclesBurn", "cyclesSystem"],
    ["getCertificate", "getCertificate"],
    ["regionNew", "regionMemory"],
    ["setCertifiedData", "setCertifiedData"],
    ["stableMemoryGrow", "stableMemoryGrow"],
    ["stableMemoryLoadNat64", "stableMemoryLoad"],
    ["stableMemorySize", "stableMemorySize"],
    ["stableMemoryStoreBlob", "stableMemoryStore"],
    ["rts_stable_memory_size", "stableRuntimeMemory"],
    ["stableVarQuery", "stableVarQuery"],
    ["getCandidLimits", "systemCandidLimits"],
    ["callerInfoData", "systemCallerInfo"],
    ["envVar", "systemEnvironment"],
    ["setTimer", "systemTimer"],
    ["toActor", "toActor"],
  ];
  const cases: Array<[string, DangerRule[]]> = [
    ['module { let remote = actor "aaaaa-aa" }', ["actor"]],
    ["module { func f() { ignore (with cycles = 1) async {} } }", ["cyclesTransfer"]],
    ["module { func f<system>() {} }", ["systemCapability"]],
  ];
  for (const [member, rule] of members) {
    cases.push(
      [`import Prim "mo:prim"; module { let use = Prim.${member} }`, [rule]],
      [`import { ${member} = use } "mo:prim"; module {}`, [rule]],
      [`module { let { ${member} = use } = value }`, [rule]],
      [`module { func f({ ${member} = use }) {} }`, [rule]],
      [`module { let ${member} = 1; let record = { ${member} = 2 }; type Fields = { ${member} : Nat } }`, []],
    );
  }
  const covered = new Set<DangerRule>();
  const mo = await loadMotoko();
  for (const [source, expected] of cases) {
    const inspection = await mo.inspectMotoko("truth-table.mo", source);
    const ast = await mo.parseMotoko(source);
    expect(needsDangerousASTFallback(inspection, source), source).toBe(false);
    expect(checkForDangerousASTCode(ast, source), source).toEqual(expected);
    expect(checkForDangerousSyntaxFacts(inspection, source), source).toEqual(expected);
    for (const rule of expected) covered.add(rule);
  }
  expect(DANGER_RULE_ORDER.filter((rule) => covered.has(rule))).toEqual([...DANGER_RULE_ORDER]);
});
