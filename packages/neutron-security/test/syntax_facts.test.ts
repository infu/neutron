import { expect, test } from "bun:test";
import {
  checkForDangerousSyntaxFacts,
  inspectMotokoSource,
  needsDangerousASTFallback,
} from "../src/lib.ts";

test("compact syntax facts preserve deterministic danger rule order", () => {
  expect(
    checkForDangerousSyntaxFacts(
      {
        hasActorUrl: true,
        dotMembers: [
          "toActor",
          "setTimer",
          "envVarNames",
          "callerInfoData",
          "setCandidTypeLimits",
          "stableVarQuery",
          "rts_stable_memory_size",
          "stableMemoryStoreBlob",
          "stableMemorySize",
          "stableMemoryLoadNat64",
          "stableMemoryGrow",
          "setCertifiedData",
          "regionNew",
          "getCertificate",
          "cyclesBurn",
          "cyclesAdd",
          "createActor",
          "call_raw",
          "actorOfPrincipal",
        ],
      },
      "module { public func privileged<system>() { ignore (with cycles = 1) async {} } }",
    ),
  ).toEqual([
    "actor",
    "actorOfPrincipal",
    "call_raw",
    "createActor",
    "cyclesAdd",
    "cyclesSystem",
    "cyclesTransfer",
    "getCertificate",
    "regionMemory",
    "setCertifiedData",
    "stableMemoryGrow",
    "stableMemoryLoad",
    "stableMemorySize",
    "stableMemoryStore",
    "stableRuntimeMemory",
    "stableVarQuery",
    "systemCapability",
    "systemCandidLimits",
    "systemCallerInfo",
    "systemEnvironment",
    "systemTimer",
    "toActor",
  ]);
});

test("compact syntax facts do not match unrelated member names", () => {
  expect(
    checkForDangerousSyntaxFacts({
      hasActorUrl: false,
      dotMembers: [
        "cyclesBalancer",
        "stableMemoryBudget",
        "regionalIndicator",
        "regionLoader",
        "stableMemoryLoadFactor",
        "unstableMemoryStore",
        "call_rawish",
      ],
    }),
  ).toEqual([]);
});

test("compact inspection defers exact local and record names to the full AST", () => {
  const source = [
    "module {",
    "  type Metrics = { cyclesBalance : Nat; regionSize : Nat };",
    "  let toActor = 1;",
    '  let sample = { call_raw = false; envVar = "local" };',
    "  func createActor(setTimer : Text) : Text { setTimer };",
    "  func setCandidLimits(value : Nat) : Nat { value };",
    "}",
  ].join("\n");
  const inspection = { hasActorUrl: false, dotMembers: [] };

  expect(checkForDangerousSyntaxFacts(inspection, source)).toEqual([]);
  expect(needsDangerousASTFallback(inspection, source)).toBe(true);
});

test("source inspection excludes comments, strings, chars, and record extensions", () => {
  const source = `
    module {
      // actor Prim.actorOfPrincipal (with cycles = 1)
      /* outer /* Prim.regionGrow */ <system> */
      let text = "shared Prim.call_raw (context with)";
      let character = 'w';
      let current = { cycles = 1; value = 1 };
      let updated = { current with cycles = current.cycles + 1 };
    }
  `;

  expect(inspectMotokoSource(source)).toMatchObject({
    hasActorReference: false,
    hasCallContextTransfer: false,
    hasSystemCapability: false,
    hasWithCycles: false,
  });
  expect(
    checkForDangerousSyntaxFacts(
      { hasActorUrl: false, dotMembers: [] },
      source,
    ),
  ).toEqual([]);
});

test("source inspection retains erased call-context and system syntax", () => {
  expect(
    inspectMotokoSource(`
      module {
        func local() : async () {};
        func explicit<system>() : async () {
          await (with\n cycles = 1) local();
        };
        func inherited() : async () {
          let context = { cycles = 2 };
          await (context with timeout = 10) local();
        };
      }
    `),
  ).toMatchObject({
    hasCallContextTransfer: true,
    hasSystemCapability: true,
    hasWithCycles: true,
  });
});
