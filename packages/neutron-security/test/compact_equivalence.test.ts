import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMotoko } from "neutron-motoko-wasm";
import {
  checkForDangerousASTCode,
  checkForDangerousSyntaxFacts,
  needsDangerousASTFallback,
} from "../src/lib.ts";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("compact inspection plus precise fallback preserves all AST reports", async () => {
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
      const compilerFindings = needsDangerousASTFallback(inspection, source)
        ? fullFindings
        : checkForDangerousSyntaxFacts(inspection, source);
      expect(compilerFindings).toEqual(fullFindings);
      expect(inspection).toEqual({
        immediateImports: expect.any(Array),
        hasActorUrl: expect.any(Boolean),
        dotMembers: expect.any(Array),
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
