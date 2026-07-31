import * as disallowed from "./disallowed.ts";
import type { AstPattern } from "./disallowed.ts";
import {
  DANGER_RULE_ORDER,
  type DangerRule,
  findingsFromPolicyFacts,
} from "./policy.ts";
import { inspectMotokoSource } from "./source.ts";

type AstNode = {
  args: unknown[];
};

const hasArgs = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as { args?: unknown }).args);

export function matchTraverseTree(tree: unknown, pattern: AstPattern): boolean {
  if (pattern(tree)) return true;
  if (!hasArgs(tree)) return false;
  for (const node of tree.args) {
    if (typeof node !== "string") {
      if (matchTraverseTree(node, pattern)) return true;
    }
  }
  return false;
}

export function checkForDangerousASTCode(
  contents: unknown,
  source = "",
): DangerRule[] {
  const findings = new Set<DangerRule>();
  for (const [name, pattern] of Object.entries(disallowed) as [
    DangerRule,
    AstPattern,
  ][]) {
    if (matchTraverseTree(contents, pattern)) findings.add(name);
  }

  const sourceFacts = inspectMotokoSource(source);
  for (const finding of
    findingsFromPolicyFacts({
      hasActorReference: sourceFacts.hasActorReference,
      hasActorUrl: false,
      hasCallContextTransfer: sourceFacts.hasCallContextTransfer,
      hasSystemCapability: sourceFacts.hasSystemCapability,
      hasWithCycles: sourceFacts.hasWithCycles,
      // The full AST recognizes actual DotE/ValPF acquisitions. Source
      // identifiers are only a trigger for the compact compiler fallback;
      // treating every local name as authority would create false positives.
      identifiers: new Set(),
    })) {
    findings.add(finding);
  }

  return DANGER_RULE_ORDER.filter((rule) => findings.has(rule));
}

export type DangerousSyntaxFacts = {
  hasActorUrl: boolean;
  dotMembers: readonly string[];
};

export function checkForDangerousSyntaxFacts(
  { hasActorUrl, dotMembers }: DangerousSyntaxFacts,
  source = "",
): DangerRule[] {
  const sourceFacts = inspectMotokoSource(source);
  return findingsFromPolicyFacts({
    hasActorReference: sourceFacts.hasActorReference,
    hasActorUrl,
    hasCallContextTransfer: sourceFacts.hasCallContextTransfer,
    hasSystemCapability: sourceFacts.hasSystemCapability,
    hasWithCycles: sourceFacts.hasWithCycles,
    identifiers: new Set(dotMembers),
  });
}

/**
 * The compact browser inspection omits ValPF/object-pattern acquisitions.
 * Parse a full AST only when a privileged spelling exists that its dotted
 * member facts do not already explain. This keeps the common path compact
 * while making named imports and destructuring precise.
 */
export function needsDangerousASTFallback(
  { dotMembers }: DangerousSyntaxFacts,
  source: string,
): boolean {
  const sourceFacts = inspectMotokoSource(source);
  const acquisitionFacts = (identifiers: ReadonlySet<string>): DangerRule[] =>
    findingsFromPolicyFacts({
      hasActorReference: false,
      hasActorUrl: false,
      hasCallContextTransfer: false,
      hasSystemCapability: false,
      hasWithCycles: false,
      identifiers,
    });
  const compactFindings = new Set(acquisitionFacts(new Set(dotMembers)));
  return acquisitionFacts(new Set(sourceFacts.identifiers)).some(
    (finding) => !compactFindings.has(finding),
  );
}

export { DANGER_RULE_ORDER } from "./policy.ts";
export type { DangerRule } from "./policy.ts";
export { inspectMotokoSource } from "./source.ts";
export { checkForDangerousTextCode } from "./text.ts";
