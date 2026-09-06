import type { Transaction } from "./swap.ts";

/** Exact, serializable transaction plan. The last step performs the requested
 * swap or position action; prerequisite approvals are never completion. */
export type ActionStep = {
  label: string;
  kind: "approval" | "transaction";
  transaction: Transaction;
};
export type ActionPlan = {
  chainId: string;
  accountId: string;
  accountAddress: string;
  deadline: string;
  summary: string;
  steps: ActionStep[];
  details: Record<string, unknown>;
};
