/**
 * The send path.
 *
 * `buildProposalArgs` is the last thing that happens before a proposal becomes
 * permanent, so it is checked against the SNS's own decoder rather than against
 * our idea of the shape. A malformed action here would surface only as a
 * rejected submission with the reject fee already charged.
 */

import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { idlFactory as governanceIdl } from "../src/candid/sns_governance.did.js";
import { buildProposalArgs, type DraftRow } from "../src/data/drafts";
import { decodeManageNeuronResponse } from "../src/data/manage_neuron";
import { encodeProposalAction } from "../src/data/proposal_actions";

const NEURON = "00".repeat(31) + "07";

function manageNeuronArgType(): IDL.Type {
  const service = governanceIdl({ IDL }) as unknown as {
    _fields: [string, { argTypes: IDL.Type[]; retTypes: IDL.Type[] }][];
  };
  return service._fields.find(([name]) => name === "manage_neuron")![1].argTypes[0]!;
}

function manageNeuronRetType(): IDL.Type {
  const service = governanceIdl({ IDL }) as unknown as {
    _fields: [string, { argTypes: IDL.Type[]; retTypes: IDL.Type[] }][];
  };
  return service._fields.find(([name]) => name === "manage_neuron")![1].retTypes[0]!;
}

function motionDraft(
  overrides: Partial<Record<keyof DraftRow, unknown>> = {},
): DraftRow {
  const base = {
    id: "1",
    sns: "extk7-gaaaa-aaaaq-aacda-cai",
    governance: "eqsml-lyaaa-aaaaq-aacdq-cai",
    title: "Adopt the thing",
    summary: "Because it is worth adopting.",
    url: "https://example.org/rationale",
    actionKind: "Motion",
    motionText: "The DAO resolves to adopt the thing.",
    createdBy: "agent",
    updatedAtSeconds: 0n,
    ...overrides,
  } as Record<string, unknown>;
  // An explicitly-undefined key is not the same as an absent one under
  // `exactOptionalPropertyTypes`; the drafts these model simply lack the field.
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) delete base[key];
  }
  return base as unknown as DraftRow;
}

test("a Motion draft encodes to a MakeProposal the SNS can decode", () => {
  const bytes = buildProposalArgs(motionDraft(), NEURON);
  const [decoded] = IDL.decode([manageNeuronArgType()], bytes) as unknown as [
    {
      subaccount: Uint8Array;
      command: [{ MakeProposal: { title: string; summary: string; url: string; action: [unknown] } }];
    },
  ];
  const proposal = decoded.command[0].MakeProposal;
  expect(proposal.title).toBe("Adopt the thing");
  expect(proposal.summary).toBe("Because it is worth adopting.");
  expect(proposal.url).toBe("https://example.org/rationale");
  expect(proposal.action[0]).toEqual({
    Motion: { motion_text: "The DAO resolves to adopt the thing." },
  });
  expect([...decoded.subaccount]).toEqual([...Buffer.from(NEURON, "hex")]);
});

test("a custom-function draft carries its function id and exact payload", () => {
  const payload = Uint8Array.from([0x44, 0x49, 0x44, 0x4c, 0x00, 0x00]);
  const bytes = buildProposalArgs(
    motionDraft({ actionKind: "custom", motionText: undefined, functionId: 1107n, payload }),
    NEURON,
  );
  const [decoded] = IDL.decode([manageNeuronArgType()], bytes) as unknown as [
    {
      command: [
        {
          MakeProposal: {
            action: [{ ExecuteGenericNervousSystemFunction: { function_id: bigint; payload: Uint8Array } }];
          };
        },
      ];
    },
  ];
  const action = decoded.command[0].MakeProposal.action[0].ExecuteGenericNervousSystemFunction;
  expect(action.function_id).toBe(1107n);
  expect([...action.payload]).toEqual([...payload]);
});

test("an explicit native draft preserves its action and large integer through submission", () => {
  const payload = encodeProposalAction("RemoveGenericNervousSystemFunction", "9007199254740993");
  const bytes = buildProposalArgs(motionDraft({ actionKind: "NativeActionV1", motionText: undefined, payload }), NEURON);
  const [decoded] = IDL.decode([manageNeuronArgType()], bytes) as unknown as [{
    command: [{ MakeProposal: { action: [unknown] } }];
  }];
  expect(decoded.command[0].MakeProposal.action[0]).toEqual({ RemoveGenericNervousSystemFunction: 9007199254740993n });
  expect(() => buildProposalArgs(motionDraft({ actionKind: "NativeActionV1", payload: new Uint8Array([1]), functionId: 1107n }), NEURON)).toThrow();
});

// A Motion is only its text. Encoding an empty one would spend the reject fee
// to submit nothing.
test("a Motion with no text is refused before anything is sent", () => {
  expect(() => buildProposalArgs(motionDraft({ motionText: "" }), NEURON)).toThrow(
    /no motion text/,
  );
  expect(() => buildProposalArgs(motionDraft({ motionText: undefined }), NEURON)).toThrow(
    /no motion text/,
  );
});

test("a custom draft missing its function id or payload is refused", () => {
  expect(() =>
    buildProposalArgs(
      motionDraft({ actionKind: "custom", motionText: undefined, payload: new Uint8Array([1]) }),
      NEURON,
    ),
  ).toThrow(/function id and a payload/);
  expect(() =>
    buildProposalArgs(
      motionDraft({ actionKind: "custom", motionText: undefined, functionId: 3n }),
      NEURON,
    ),
  ).toThrow(/function id and a payload/);
});

test("an untitled draft is refused", () => {
  expect(() => buildProposalArgs(motionDraft({ title: "   " }), NEURON)).toThrow(/needs a title/);
});

// The id is the only thing a reviewer gets back, and it was being discarded.
test("the new proposal id is decoded from a MakeProposal response", () => {
  const reply = new Uint8Array(
    IDL.encode([manageNeuronRetType()], [{ command: [{ MakeProposal: { proposal_id: [{ id: 1234n }] } }] }]),
  );
  const outcome = decodeManageNeuronResponse(reply);
  expect(outcome.ok).toBe(true);
  expect(outcome.command).toBe("MakeProposal");
  expect(outcome.proposalId).toBe(1234n);
});
