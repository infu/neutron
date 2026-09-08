import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { idlFactory as governanceIdl } from "../src/candid/sns_governance.did.js";
import {
  decodeManageNeuronResponse,
  encodeMakeProposal,
  encodeManageNeuron,
  encodeRegisterVote,
  ERROR_PRECONDITION_FAILED,
  executeGenericAction,
  isAlreadyVoted,
  motionAction,
  REQUIRED_PERMISSIONS,
} from "../src/data/manage_neuron";
import { toHex } from "../src/data/format";

const NEURON_HEX = "00".repeat(31) + "07";

function fullManageNeuronType(): IDL.Type {
  const service = governanceIdl({ IDL }) as unknown as {
    _fields: [string, { argTypes: IDL.Type[] }][];
  };
  return service._fields.find(([name]) => name === "manage_neuron")![1].argTypes[0]!;
}

// The whole reason the minimal encoder exists: Candid ships the entire type
// graph in every message. Verified numbers, not estimates.
test("the minimal vote encoding is dramatically smaller than the full type", () => {
  const minimal = encodeRegisterVote(NEURON_HEX, 42n, true);
  const full = encodeManageNeuron({
    subaccount: Uint8Array.from(Buffer.from(NEURON_HEX, "hex")),
    command: [{ RegisterVote: { vote: 1, proposal: [{ id: 42n }] } }],
  });
  expect(minimal.length).toBeLessThan(150);
  expect(full.length).toBeGreaterThan(1000);
  expect(full.length / minimal.length).toBeGreaterThan(10);
});

// Candid variant subtyping: the SNS decodes with its own full type, so the
// narrow encoding must satisfy it. If this ever fails, the optimisation is
// silently sending garbage.
test("the SNS's full decoder accepts the minimal encoding", () => {
  const bytes = encodeRegisterVote(NEURON_HEX, 42n, true);
  const decoded = IDL.decode([fullManageNeuronType()], bytes)[0] as {
    subaccount: Uint8Array | number[];
    command: [{ RegisterVote: { vote: number; proposal: [{ id: bigint }] } }];
  };
  expect(toHex(decoded.subaccount)).toBe(NEURON_HEX);
  expect(decoded.command[0].RegisterVote.vote).toBe(1);
  expect(decoded.command[0].RegisterVote.proposal[0].id).toBe(42n);
});

test("adopt and reject encode to the SNS's Vote values", () => {
  const type = fullManageNeuronType();
  const read = (adopt: boolean) =>
    (
      IDL.decode([type], encodeRegisterVote(NEURON_HEX, 1n, adopt))[0] as {
        command: [{ RegisterVote: { vote: number } }];
      }
    ).command[0].RegisterVote.vote;
  expect(read(true)).toBe(1); // Vote::Yes
  expect(read(false)).toBe(2); // Vote::No
});

test("neuron ids must be exactly 32 bytes", () => {
  expect(() => encodeRegisterVote("00ff", 1n, true)).toThrow(/32 bytes/);
  expect(() => encodeRegisterVote(new Uint8Array(31), 1n, true)).toThrow(/32 bytes/);
  expect(() => encodeRegisterVote(new Uint8Array(32), 1n, true)).not.toThrow();
});

test("MakeProposal encodes a motion the full decoder can read", () => {
  const bytes = encodeMakeProposal({
    neuronId: NEURON_HEX,
    title: "Adopt the thing",
    summary: "A test motion.",
    url: "https://forum.dfinity.org/t/example",
    action: motionAction("Adopt the thing."),
  });
  const decoded = IDL.decode([fullManageNeuronType()], bytes)[0] as {
    command: [{ MakeProposal: { title: string; action: [Record<string, unknown>] } }];
  };
  expect(decoded.command[0].MakeProposal.title).toBe("Adopt the thing");
  expect(Object.keys(decoded.command[0].MakeProposal.action[0])[0]).toBe("Motion");
});

test("a custom proposal carries its function id and raw payload", () => {
  const payload = Uint8Array.from([68, 73, 68, 76, 0, 0]);
  const bytes = encodeMakeProposal({
    neuronId: NEURON_HEX,
    title: "Custom",
    summary: "",
    url: "",
    action: executeGenericAction(5000n, payload),
  });
  const decoded = IDL.decode([fullManageNeuronType()], bytes)[0] as {
    command: [
      {
        MakeProposal: {
          action: [{ ExecuteGenericNervousSystemFunction: { function_id: bigint; payload: Uint8Array | number[] } }];
        };
      },
    ];
  };
  const action = decoded.command[0].MakeProposal.action[0].ExecuteGenericNervousSystemFunction;
  expect(action.function_id).toBe(5000n);
  expect(Array.from(action.payload)).toEqual(Array.from(payload));
});

test("we keep error_type when decoding a response", () => {
  const service = governanceIdl({ IDL }) as unknown as {
    _fields: [string, { retTypes: IDL.Type[] }][];
  };
  const retType = service._fields.find(([name]) => name === "manage_neuron")![1].retTypes[0]!;
  const encoded = new Uint8Array(
    IDL.encode(
      [retType],
      [{ command: [{ Error: { error_type: ERROR_PRECONDITION_FAILED, error_message: "Neuron already voted on proposal." } }] }],
    ),
  );
  const outcome = decodeManageNeuronResponse(encoded);
  expect(outcome.ok).toBe(false);
  expect(outcome.errorType).toBe(ERROR_PRECONDITION_FAILED);
  expect(outcome.errorMessage).toContain("already voted");
});

// A repeat vote must read as success: follow cascades routinely fill a ballot
// before our call lands, and treating that as failure makes bulk voting look
// broken exactly when following is configured.
test("a double vote is recognised as success, not failure", () => {
  expect(
    isAlreadyVoted({
      ok: false,
      errorType: ERROR_PRECONDITION_FAILED,
      errorMessage: "Neuron already voted on proposal.",
    }),
  ).toBe(true);

  // A different precondition failure is a real failure.
  expect(
    isAlreadyVoted({
      ok: false,
      errorType: ERROR_PRECONDITION_FAILED,
      errorMessage: "Neuron is not eligible to vote.",
    }),
  ).toBe(false);
  // And success is not "already voted".
  expect(isAlreadyVoted({ ok: true, command: "RegisterVote" })).toBe(false);
});

test("the permission grant is exactly SubmitProposal and Vote", () => {
  // Anything else would let this app move or dissolve value.
  expect(REQUIRED_PERMISSIONS).toEqual([3, 4]);
  expect(REQUIRED_PERMISSIONS).not.toContain(2); // ManagePrincipals
  expect(REQUIRED_PERMISSIONS).not.toContain(5); // Disburse
});
