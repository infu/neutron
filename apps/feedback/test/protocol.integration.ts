import assert from "node:assert/strict";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import type { Principal } from "@dfinity/principal";
import { session, success, type Neutron } from "../../../support/feedback/test/runtime.ts";
import { protocolClient, ProtocolError, type ClientDependencies } from "../src/client.ts";
import { kernelBoundary, stateType, stateResultType, draftType, draftPageType, textResultType, blobResultType } from "./kernel_boundary.ts";
import { CONTRACT } from "../src/protocol.ts";
import type { Kernel } from "../src/store_state.ts";
import type { QueryAgent } from "../src/transport.ts";

const env = await session();
try {
  const wireMethods = new Map<string, IDL.FuncClass>(env.compiled.idlFactory({ IDL })._fields);
  for (const [name, contract] of Object.entries(CONTRACT)) {
    const actual = wireMethods.get(name);
    assert.ok(actual, `${name} must exist in the compiled protocol`);
    assert.equal(actual.annotations.includes("query"), !contract.update, `${name} query/update mode`);
    assert.equal(actual.argTypes.map(type => type.display()).join("\n"), contract.args.map(type => type.display()).join("\n"), `${name} complete input ABI`);
    assert.equal(actual.retTypes.map(type => type.display()).join("\n"), contract.returns.map(type => type.display()).join("\n"), `${name} complete output ABI`);
  }
  console.log("PASS complete client Candid contract matches the compiled protocol");

  async function fixture(neutron: Neutron) {
    let seed: Uint8Array | null = null;
    const intents = new Map<string, Uint8Array>();
    let loseNextSubmission = false;
    const kernel = {
      querySelf: async (method: string, args: unknown[]) => {
        if (method === "feedback_state") return kernelBoundary(stateType, { owner: neutron.canisterId, seed: seed ? [seed] : [] });
        if (method === "feedback_draft") { const value = intents.get(args[0] as string); return kernelBoundary(draftType, value ? [value] : []); }
        if (method === "feedback_drafts") return kernelBoundary(draftPageType, { items: [...intents].map(([id, value]) => ({ id, value })), nextCursor: [] });
        throw new Error(`Unexpected self query ${method}`);
      },
      updateSelf: async (method: string, args: unknown[]) => {
        if (method === "feedback_initialize") { seed ??= new Uint8Array(args[0] as Uint8Array); return kernelBoundary(stateResultType, { ok: { owner: neutron.canisterId, seed: [seed] } }); }
        const input = args[0] as { id: string; value: Uint8Array; method: string; args: Uint8Array };
        if (method === "feedback_save_draft") {
          if (intents.has(input.id) && !Buffer.from(intents.get(input.id)!).equals(Buffer.from(input.value))) return { err: "Saved request differs" };
          intents.set(input.id, input.value); return kernelBoundary(textResultType, { ok: input.id });
        }
        if (method === "feedback_complete_draft") { intents.delete(input.id); return kernelBoundary(textResultType, { ok: input.id }); }
        if (method !== "feedback_call") throw new Error(`Unexpected self update ${method}`);
        const compiled = wireMethods.get(input.method)!;
        const decoded = IDL.decode(compiled.argTypes, input.args);
        const result = await neutron.call(input.method, decoded);
        if (loseNextSubmission && input.method !== "read_delegate_set") { loseNextSubmission = false; throw new Error("Simulated lost submission response"); }
        return kernelBoundary(blobResultType, { ok: new Uint8Array(IDL.encode(compiled.retTypes, [result])) });
      },
    } as unknown as Kernel;
    const dependencies: ClientDependencies = {
      makeAgent: async identity => ({
        query: async (_canister: Principal, input: { methodName: string; arg: ArrayBuffer }) => {
          const compiled = wireMethods.get(input.methodName)!;
          const decoded = IDL.decode(compiled.argTypes, input.arg);
          const result = await env.as(identity.getPrincipal())[input.methodName](...decoded);
          return { status: "replied", reply: { arg: IDL.encode(compiled.retTypes, [result]) } };
        },
      }) as QueryAgent,
    };
    return { client: () => protocolClient({ kernel }, dependencies), loseReply: () => { loseNextSubmission = true; }, intents, seed: () => seed };
  }
  const ownerNeutron = await env.neutron();
  const moderatorNeutron = await env.neutron();
  const ownerFixture = await fixture(ownerNeutron);
  const moderatorFixture = await fixture(moderatorNeutron);
  const owner = await ownerFixture.client();
  assert.equal((await owner.session()).neutron, ownerNeutron.canisterId.toText());
  assert.equal((await owner.session()).unreadReplies, 0);
  assert.equal(ownerFixture.seed()?.length, 32);
  const initialReadPrincipal = Ed25519KeyIdentity.generate(ownerFixture.seed()!).getPrincipal().toText();
  const opened = await owner.create({ requestId: "app-integration-create", kind: "issue", title: "App will not open", body: "Here is the error and https://example.com/shared.png", appId: "wallet" });
  assert.equal(opened.kind, "issue"); assert.equal(opened.appId, "wallet"); assert.equal(opened.messageCount, 1);
  assert.equal(ownerFixture.intents.size, 0);
  console.log("PASS automatic first-use read access and owner ticket creation through a Neutron");

  success(await env.admin.moderator_set({ neutron: moderatorNeutron.canisterId, active: true }));
  const moderator = await moderatorFixture.client();
  assert.equal((await moderator.session()).moderator, true);
  const inbox = await moderator.moderationList({ needsReply: true });
  assert.equal(inbox.items[0]?.id, opened.id);
  const answer = await moderator.moderationReply({ requestId: "app-integration-answer", threadId: opened.id, body: "Please restart the app and send the error text." });
  assert.equal(answer.role, "moderator");
  assert.equal((await owner.session()).unreadReplies, 1);
  const discussion = await owner.get(opened.id);
  assert.equal(discussion.messages.items.length, 2);
  assert.equal((await owner.session()).unreadReplies, 1, "Discussion reads never acknowledge replies");
  await owner.markRead(opened.id, discussion.messages.items.at(-1)!.id);
  assert.equal((await owner.session()).unreadReplies, 0);
  assert.equal((await owner.setResolved(opened.id, true)).resolved, true);
  console.log("PASS moderator inbox/reply, owner unread receipt, explicit read acknowledgement and resolution");

  ownerFixture.loseReply();
  await assert.rejects(owner.create({ requestId: "app-integration-lost", kind: "feedback", title: "A small thank-you", body: "This does not require a response." }), /lost submission response/);
  assert.equal(ownerFixture.intents.size, 1);
  const restoredOwner = await ownerFixture.client();
  assert.equal(Ed25519KeyIdentity.generate(ownerFixture.seed()!).getPrincipal().toText(), initialReadPrincipal);
  const pending = await restoredOwner.pending!();
  assert.equal(pending.items[0]?.requestId, "app-integration-lost");
  const reconciled = await restoredOwner.resume!("app-integration-lost");
  assert.equal((await restoredOwner.list()).items.filter(thread => thread.id === reconciled.id).length, 1);
  assert.equal(ownerFixture.intents.size, 0);
  console.log("PASS lost-response recovery after client reload returns the original ticket without duplication");

  success(await env.admin.moderator_set({ neutron: moderatorNeutron.canisterId, active: false }));
  await assert.rejects(moderator.moderationGet(opened.id), error => error instanceof ProtocolError && error.code === "moderator_required");
  const ordinary = await moderatorFixture.client();
  await assert.rejects(ordinary.moderationReply({ requestId: "after-revocation", threadId: opened.id, body: "Cannot send" }), /assigned moderators/);
  console.log("PASS protocol checks role revocation for existing and restored clients");
} finally {
  await env.shutdown();
}
