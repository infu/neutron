import { expect, test } from "bun:test";
import { loadMotoko } from "neutron-motoko-wasm";
import {
  checkForDangerousASTCode,
  checkForDangerousSyntaxFacts,
  needsDangerousASTFallback,
  type DangerRule,
} from "../src/lib.ts";

const cases: Array<{
  name: string;
  source: string;
  findings: DangerRule[];
}> = [
  {
    name: "named primitive actor conversion import",
    source:
      'import { actorOfPrincipal = convert } "mo:prim"; module { public let use = convert }',
    findings: ["actorOfPrincipal"],
  },
  {
    name: "whitelisted Principal conversion import",
    source:
      'import { toActor = convert } "mo:core/Principal"; module { public let use = convert }',
    findings: ["toActor"],
  },
  {
    name: "caller supplied actor and shared reference",
    source:
      "module { public func use(value : actor { run : shared () -> async () }) : async () { await value.run() } }",
    findings: ["actor"],
  },
  {
    name: "explicit cycles call context",
    source:
      "module { func run() : async () {}; public func use() : async () { await (with cycles = 1) run() } }",
    findings: ["cyclesTransfer"],
  },
  {
    name: "inherited cycles call context",
    source:
      "module { func run() : async () {}; public func use() : async () { let context = { cycles = 1 }; await (context with timeout = 5) run() } }",
    findings: ["cyclesTransfer"],
  },
  {
    name: "named cycles primitive import",
    source:
      'import { cyclesBurn = burn } "mo:prim"; module { public let use = burn }',
    findings: ["cyclesSystem"],
  },
  {
    name: "named stable grow import",
    source:
      'import { stableMemoryGrow = grow } "mo:prim"; module { public let use = grow }',
    findings: ["stableMemoryGrow"],
  },
  {
    name: "named region allocation import",
    source:
      'import { regionNew = allocate } "mo:prim"; module { public let use = allocate }',
    findings: ["regionMemory"],
  },
  {
    name: "destructured region allocation",
    source:
      'import Prim "mo:prim"; module { let { regionNew = allocate } = Prim; public let use = allocate }',
    findings: ["regionMemory"],
  },
  {
    name: "reserved local object-pattern acquisition",
    source:
      "module { let record = { regionNew = 1 }; let { regionNew = allocate } = record; public let use = allocate }",
    findings: ["regionMemory"],
  },
  {
    name: "stable runtime accounting",
    source:
      'import Prim "mo:prim"; module { public let use = Prim.rts_logical_stable_memory_size }',
    findings: ["stableRuntimeMemory"],
  },
  {
    name: "system capability and timer primitive",
    source:
      'import { setTimer = schedule } "mo:prim"; module { public func use<system>() { ignore schedule } }',
    findings: ["systemCapability", "systemTimer"],
  },
  {
    name: "implicit system environment call through Runtime",
    source:
      'import Runtime "mo:core/Runtime"; module { public func use() : ?Text { Runtime.envVar("NAME") } }',
    findings: ["systemEnvironment"],
  },
  {
    name: "implicit caller information system call",
    source:
      'import Prim "mo:prim"; module { public func leak() : async* Blob { Prim.callerInfoData() } }',
    findings: ["systemCallerInfo"],
  },
  {
    name: "implicit Candid limit system calls",
    source:
      'import Prim "mo:prim"; module { public func configure() : async* () { Prim.setCandidTypeLimits({ scalar = 1; bias = 0 }); ignore Prim.getCandidLimits() } }',
    findings: ["systemCandidLimits"],
  },
  {
    name: "system capability followed by a type parameter",
    source:
      "module { public func use<system, Value>(value : Value) : Value { value } }",
    findings: ["systemCapability"],
  },
];

test("compact and full checks reject source-level policy escapes", async () => {
  const mo = await loadMotoko();
  for (const fixture of cases) {
    const [ast, inspection] = await Promise.all([
      mo.parseMotoko(fixture.source),
      mo.inspectMotoko(`${fixture.name}.mo`, fixture.source),
    ]);
    const fullFindings = checkForDangerousASTCode(ast, fixture.source);
    expect(fullFindings, fixture.name).toEqual(fixture.findings);
    const compilerFindings = needsDangerousASTFallback(
      inspection,
      fixture.source,
    )
      ? fullFindings
      : checkForDangerousSyntaxFacts(inspection, fixture.source);
    expect(compilerFindings, fixture.name).toEqual(fixture.findings);
  }
});

test("full AST policy allows exact privileged spellings without acquisition", async () => {
  const source = [
    "module {",
    "  type Metrics = { cyclesBalance : Nat; regionSize : Nat };",
    "  let toActor = 1;",
    '  let sample = { call_raw = false; envVar = "local" };',
    "  func createActor(setTimer : Text) : Text { setTimer };",
    "  func setCandidLimits(value : Nat) : Nat { value };",
    "}",
  ].join("\n");
  const mo = await loadMotoko();
  expect(checkForDangerousASTCode(await mo.parseMotoko(source), source)).toEqual(
    [],
  );
});
