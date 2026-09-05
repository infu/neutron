import * as disallowed from "./disallowed.ts";
import type { AstPattern } from "./disallowed.ts";
import {
  DANGER_RULE_ORDER,
  type DangerRule,
  findingsFromPolicyFacts,
} from "./policy.ts";
import { inspectMotokoSource } from "./source.ts";
import type { MotokoSourceSyntaxFacts } from "./source.ts";

type SourceFactsInput = string | MotokoSourceSyntaxFacts;

const sourceFactsOf = (source: SourceFactsInput): MotokoSourceSyntaxFacts =>
  typeof source === "string" ? inspectMotokoSource(source) : source;

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
  source: SourceFactsInput = "",
): DangerRule[] {
  const findings = new Set<DangerRule>();
  for (const [name, pattern] of Object.entries(disallowed) as [
    DangerRule,
    AstPattern,
  ][]) {
    if (matchTraverseTree(contents, pattern)) findings.add(name);
  }

  const sourceFacts = sourceFactsOf(source);
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
  /** Present when the compiler reports all ValPF/object-pattern acquisitions. */
  patternFields?: readonly string[];
};

export function checkForDangerousSyntaxFacts(
  { hasActorUrl, dotMembers, patternFields }: DangerousSyntaxFacts,
  source: SourceFactsInput = "",
): DangerRule[] {
  const sourceFacts = sourceFactsOf(source);
  const identifiers = new Set(dotMembers);
  for (const field of patternFields ?? []) identifiers.add(field);
  return findingsFromPolicyFacts({
    hasActorReference: sourceFacts.hasActorReference,
    hasActorUrl,
    hasCallContextTransfer: sourceFacts.hasCallContextTransfer,
    hasSystemCapability: sourceFacts.hasSystemCapability,
    hasWithCycles: sourceFacts.hasWithCycles,
    identifiers,
  });
}

/**
 * Older compiler assets omit ValPF/object-pattern acquisitions. Keep their
 * precise full-AST fallback when a privileged spelling is not already explained
 * by dotted members. New assets report patternFields, even when empty, so no
 * full AST needs to cross the compiler/worker boundary for security inspection.
 */
export function needsDangerousASTFallback(
  { dotMembers, patternFields }: DangerousSyntaxFacts,
  source: SourceFactsInput,
): boolean {
  if (patternFields !== undefined) return false;
  const sourceFacts = sourceFactsOf(source);
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
export type { MotokoSourceSyntaxFacts } from "./source.ts";
export { checkForDangerousTextCode } from "./text.ts";
