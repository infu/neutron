import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Principal } from "@dfinity/principal";
// Import the implementation directly: other tests mock the public app facade.
import { encodeSelfCallValues, type ScopedKernelClient, type SelfCallValue } from "neutron-tools/src/app.js";
import { assertBoundedJson, jsonPayloadBytes, MSG_BUS_PROVIDER_APPROVAL_MAX_BYTES, SELF_CALL_METADATA_MAX_BYTES, type JsonValue } from "neutron-tools/protocol";
import type { Action } from "../src/candid/sns_governance.did";
import { decodeManageNeuronRequest, encodeManageNeuron } from "../src/data/manage_neuron";
import { prepareNeuronAction, type NeuronActionInput, type NeuronActionServices } from "../src/data/neuron_actions";
import { OPERATION_METHODS, type OperationDetail, type OperationPrepare } from "../src/data/operations";

const principal = "3rurp-vyaaa-aaaay-aacua-cai";
const governance = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const sns = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const neuronId = "17".repeat(32);
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function proposal(action: Action, summary = "Review the complete retained proposal before submitting."): NeuronActionInput {
  return {
    operationId: "large-neuron-proposal", sns, governance, neuronId,
    command: { MakeProposal: { title: "Upgrade the SNS application", summary, url: "https://example.com/proposal", action: [action] } },
  };
}

function harness() {
  let saved: OperationDetail | null = null;
  let reads = 0;
  const prepared: { input: OperationPrepare; wire: { value: JsonValue; blobs: ReturnType<typeof encodeSelfCallValues>["blobs"] } }[] = [];
  const services: NeuronActionServices = {
    principal,
    authorize: async () => { throw new Error("Preparing a proposal must not authorize execution"); },
    reads: { snapshot: async () => {
      reads++;
      return {
        mode: 1, nowSeconds: 100n,
        neuron: {
          id: neuronId, stakeE8s: 1000000000n, maturityE8s: 0n, stakedMaturityE8s: 0n,
          createdAtSeconds: 1n, agingSinceSeconds: 1n, votingPowerMultiplierPercent: 100n,
          dissolveState: { kind: "delay", value: 86400n }, permissions: [{ principal, permissions: [3] }],
        },
        parameters: { rejectCostE8s: 100000000n, neuronMinimumDissolveDelayToVoteSeconds: 3600n },
      };
    } },
    kernel: {
      async querySelf(method: string, args: unknown[]) {
        expect(method).toBe(OPERATION_METHODS.get);
        expect(args).toEqual(["large-neuron-proposal"]);
        return structuredClone(saved);
      },
      async updateSelf(method: string, args: SelfCallValue[]) {
        expect(method).toBe(OPERATION_METHODS.prepare);
        // These are the actual SDK checks at the journal and owner-review boundaries.
        const wire = encodeSelfCallValues(args);
        const input = args[0] as unknown as OperationPrepare;
        assertBoundedJson(JSON.parse(input.review_json), "Provider approval", MSG_BUS_PROVIDER_APPROVAL_MAX_BYTES);
        expect(saved).toBeNull();
        prepared.push({ input: structuredClone(input), wire });
        saved = {
          ...structuredClone(input), seq: "1", revision: "1", created_at_seconds: "100", updated_at_seconds: "100",
          steps: input.steps.map(step => ({ ...step, args: Uint8Array.from(step.args), method: step.method ?? "manage_neuron", status: "prepared" })),
        };
        return structuredClone(saved);
      },
    } as unknown as ScopedKernelClient,
  };
  return { services, prepared, get reads() { return reads; } };
}

function expectDescriptor(value: unknown, expected: { byteLength?: number; utf8Bytes?: number; sha256: string }) {
  expect(value).toMatchObject(expected);
}

async function expectPreparedWithinSdk(input: NeuronActionInput) {
  const h = harness();
  const result = await prepareNeuronAction(input, h.services);
  expect(result.status).toBe("prepared");
  expect(h.prepared).toHaveLength(1);
  const { wire, input: retained } = h.prepared[0]!;
  expect(jsonPayloadBytes(wire.value)).toBeLessThanOrEqual(SELF_CALL_METADATA_MAX_BYTES);
  expect(jsonPayloadBytes(result.review)).toBeLessThanOrEqual(MSG_BUS_PROVIDER_APPROVAL_MAX_BYTES);
  const args = retained.steps[0]!.args;
  const original = encodeManageNeuron({ subaccount: Uint8Array.from(Buffer.from(neuronId, "hex")), command: [input.command] });
  expect(args).toEqual(original);
  expect(wire.blobs).toHaveLength(1);
  expect(wire.blobs[0]!.path).toEqual([0, "steps", 0, "args"]);
  expect(new Uint8Array(wire.blobs[0]!.data)).toEqual(Uint8Array.from(original));
  expect(JSON.parse(retained.input_json).argsHex).toBeUndefined();
  expect(JSON.parse(retained.input_json).args).toEqual({ byteLength: original.length, sha256: sha256(original) });
  expect(result.review.commandEvidence).toEqual({ byteLength: original.length, sha256: sha256(original) });
  assertBoundedJson(result.review, "Provider approval", MSG_BUS_PROVIDER_APPROVAL_MAX_BYTES);
  const retry = await prepareNeuronAction(input, h.services);
  expect(retry.operation).toEqual(result.operation);
  expect(h.prepared).toHaveLength(1);
  expect(h.reads).toBe(1);
  return { h, result, retained };
}

for (const size of [10000, 30000, 100000]) {
  for (const representation of ["Uint8Array", "number[]"] as const) {
    test(`${size}-byte ${representation} inline Wasm fits real SDK metadata and approval boundaries`, async () => {
      const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 17 + 3) % 256);
      const wasm = representation === "Uint8Array" ? bytes : Array.from(bytes);
      const action = {
        UpgradeSnsControlledCanister: {
          new_canister_wasm: wasm, mode: [3], canister_id: [Principal.fromText(sns)],
          canister_upgrade_options: [], chunked_canister_wasm: [], canister_upgrade_arg: [],
        },
      } as unknown as Action;
      const input = proposal(action);
      const { h, result, retained } = await expectPreparedWithinSdk(input);
      const decoded = decodeManageNeuronRequest(retained.steps[0]!.args).command[0]!;
      if (!("MakeProposal" in decoded)) throw new Error("Retained command is not a proposal");
      const upgrade = decoded.MakeProposal.action[0]!;
      if (!("UpgradeSnsControlledCanister" in upgrade)) throw new Error("Retained action is not the reviewed upgrade");
      expect(Uint8Array.from(upgrade.UpgradeSnsControlledCanister.new_canister_wasm)).toEqual(bytes);
      const review = result.review.command as any;
      expectDescriptor(review.MakeProposal.action[0].UpgradeSnsControlledCanister.new_canister_wasm, { byteLength: size, sha256: sha256(bytes) });
      // Mutating the submitted representation cannot change the durable bytes.
      wasm[size - 1] = (wasm[size - 1]! + 1) % 256;
      await expect(prepareNeuronAction(input, h.services)).rejects.toThrow(/already bound|another SNS action/);
      expect(h.prepared).toHaveLength(1);
      expect(decodeManageNeuronRequest(h.prepared[0]!.input.steps[0]!.args).command).toEqual([decoded]);
    });
  }
}

test("large Motion text and proposal summary keep compact UTF-8 evidence and exact retained text", async () => {
  const summary = "A proposal summary. ".repeat(500);
  const motionText = "Motion detail: café and Δ.\n".repeat(300);
  expect(Buffer.byteLength(motionText)).toBeLessThanOrEqual(10000);
  expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(15000);
  expect(Buffer.byteLength(motionText) + Buffer.byteLength(summary)).toBeGreaterThan(MSG_BUS_PROVIDER_APPROVAL_MAX_BYTES);
  const input = proposal({ Motion: { motion_text: motionText } }, summary);
  const { h, result, retained } = await expectPreparedWithinSdk(input);
  const review = result.review.command as any;
  expectDescriptor(review.MakeProposal.summary, { utf8Bytes: Buffer.byteLength(summary), sha256: sha256(summary) });
  expectDescriptor(review.MakeProposal.action[0].Motion.motion_text, { utf8Bytes: Buffer.byteLength(motionText), sha256: sha256(motionText) });
  expect(summary.startsWith(review.MakeProposal.summary.preview)).toBe(true);
  expect(motionText.startsWith(review.MakeProposal.action[0].Motion.motion_text.preview)).toBe(true);
  const decoded = decodeManageNeuronRequest(retained.steps[0]!.args).command[0]!;
  if (!("MakeProposal" in decoded)) throw new Error("Retained command is not a proposal");
  expect(decoded.MakeProposal.summary).toBe(summary);
  expect(decoded.MakeProposal.action).toEqual([{ Motion: { motion_text: motionText } }]);
  await expect(prepareNeuronAction(proposal({ Motion: { motion_text: `${motionText}Changed.` } }, summary), h.services)).rejects.toThrow(/already bound|another SNS action/);
});

test("a large SNS metadata logo keeps compact review evidence and exact retained text", async () => {
  const logo = `data:image/png;base64,${"A".repeat(100000)}`;
  const input = proposal({ ManageSnsMetadata: { logo: [logo], url: [], name: [], description: [] } });
  const { h, result, retained } = await expectPreparedWithinSdk(input);
  const review = result.review.command as any;
  expectDescriptor(review.MakeProposal.action[0].ManageSnsMetadata.logo[0], { utf8Bytes: Buffer.byteLength(logo), sha256: sha256(logo) });
  expect(logo.startsWith(review.MakeProposal.action[0].ManageSnsMetadata.logo[0].preview)).toBe(true);
  const decoded = decodeManageNeuronRequest(retained.steps[0]!.args).command[0]!;
  if (!("MakeProposal" in decoded)) throw new Error("Retained command is not a proposal");
  expect(decoded.MakeProposal.action).toEqual([{ ManageSnsMetadata: { logo: [logo], url: [], name: [], description: [] } }]);
  await expect(prepareNeuronAction(proposal({ ManageSnsMetadata: { logo: [`${logo.slice(0, -1)}B`], url: [], name: [], description: [] } }), h.services)).rejects.toThrow(/already bound|another SNS action/);
});
