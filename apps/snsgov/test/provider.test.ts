import { expect, test } from "bun:test";
import type { MsgBusToolContext } from "neutron-tools/app";
import { authorizeAction, isOwnerTile, SnsReviewDeclinedError } from "../src/provider";

function invocation(options: Partial<MsgBusToolContext> = {}) {
  const calls: { method: string; value: unknown }[] = [];
  const context = {
    caller: { appId: "agent", installationUid: "12", role: "background", endpoint: "app:agent:background" },
    agentMode: false,
    kernel: { callTool: async (value: unknown) => { calls.push({ method: "tool", value }); return { approved: true }; } },
    requestApproval: async (value: unknown) => { calls.push({ method: "root", value }); },
    presentUserInterface: async (value: unknown) => { calls.push({ method: "foreground", value }); return { approved: true }; },
    ...options,
  } as unknown as MsgBusToolContext;
  return { context, calls };
}
const owner = { appId: "snsgov", installationUid: "17", role: "tile", endpoint: "app:snsgov:tile:main:instance:owner" } as NonNullable<MsgBusToolContext["caller"]>;

test("root SNS actions use the exact invocation approval without owner UI", async () => {
  const { context, calls } = invocation({ agentMode: true });
  const review = { title: "Disburse neuron", amountAtoms: "100000000", to: "aaaaa-aa" };
  await authorizeAction(context, review);
  expect(calls).toEqual([{ method: "root", value: review }]);
});

test("normal agents get foreground review, including votes", async () => {
  const { context, calls } = invocation();
  await authorizeAction(context, { title: "Vote yes", proposalId: "42" }, { ownerVote: true });
  expect(calls).toEqual([{ method: "foreground", value: { tileId: "main", tool: "sns_review_v1", arguments: { reviewJson: '{"title":"Vote yes","proposalId":"42"}' } } }]);
});

test("explicit owner vote needs one click; other owner actions open the originating tile review", async () => {
  const { context, calls } = invocation({ caller: owner });
  expect(isOwnerTile(context)).toBe(true);
  await authorizeAction(context, { title: "Vote yes" }, { ownerVote: true });
  expect(calls).toEqual([]);
  await authorizeAction(context, { title: "Transfer control" });
  expect(calls[0]).toMatchObject({ method: "tool", value: { target: owner.endpoint, name: "sns_owner_review_v1" } });
});

test("a rejected review, missing identity, or canceled invocation never authorizes", async () => {
  const rejected = invocation({ presentUserInterface: async () => ({ approved: false }) } as unknown as Partial<MsgBusToolContext>);
  await expect(authorizeAction(rejected.context, {})).rejects.toBeInstanceOf(SnsReviewDeclinedError);
  const missing = invocation({ caller: undefined } as unknown as Partial<MsgBusToolContext>);
  await expect(authorizeAction(missing.context, {})).rejects.toThrow("authenticated");
  expect(missing.calls).toEqual([]);
  const aborted = invocation({ signal: AbortSignal.abort(new Error("Owner stopped the agent")) });
  await expect(authorizeAction(aborted.context, {})).rejects.toThrow("Owner stopped");
  expect(aborted.calls).toEqual([]);
});

test("resident and foreign tiles cannot impersonate the SNS owner's one-click vote", async () => {
  const sameAppResident = invocation({ caller: { ...owner, role: "background", endpoint: "app:snsgov:background" } });
  expect(isOwnerTile(sameAppResident.context)).toBe(false);
  await expect(authorizeAction(sameAppResident.context, {}, { ownerVote: true })).rejects.toThrow("originating tile");
  expect(sameAppResident.calls).toEqual([]);
  const foreign = invocation({ caller: { ...owner, appId: "other", endpoint: "app:other:tile:main:instance:one" } });
  await authorizeAction(foreign.context, {}, { ownerVote: true });
  expect(foreign.calls[0]?.method).toBe("foreground");
});
