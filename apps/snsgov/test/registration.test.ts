/**
 * Classifying what this app may do with a neuron, and what only the owner can.
 *
 * The distinction is the whole point of the SNS-page button: "5 found · 5
 * ready" has to be true, and the one-click repair must fire only for neurons
 * where the SNS will actually accept our call.
 */

import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { idlFactory as governanceIdl } from "../src/candid/sns_governance.did.js";
import { classify, describeRegistration } from "../src/data/registration";
import {
  encodeAddVotingPermissions,
  PERMISSION_MANAGE_VOTING,
  PERMISSION_SUBMIT_PROPOSAL,
  PERMISSION_VOTE,
} from "../src/data/manage_neuron";
import type { NeuronSummary } from "../src/data/types";

const US = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const THEM = "aaaaa-aa";

function neuron(permissions: { principal: string; permissions: number[] }[]): NeuronSummary {
  return {
    id: "00".repeat(31) + "07",
    permissions,
    stakeE8s: 0n,
    maturityE8s: 0n,
    stakedMaturityE8s: 0n,
    votingPowerMultiplier: 100n,
    createdAtSeconds: 0n,
    agingSinceSeconds: 0n,
  } as unknown as NeuronSummary;
}

test("a neuron holding both voting permissions is ready", () => {
  const entry = classify(
    neuron([{ principal: US, permissions: [PERMISSION_SUBMIT_PROPOSAL, PERMISSION_VOTE] }]),
    US,
  );
  expect(entry.readiness).toBe("ready");
  expect(entry.missing).toEqual([]);
});

// The one case we can fix ourselves. `ManageVotingPermission` authorises a
// grant made up purely of voting permissions, so this neuron is one call away.
test("a neuron holding ManageVotingPermission is repairable by us", () => {
  const entry = classify(
    neuron([{ principal: US, permissions: [PERMISSION_MANAGE_VOTING] }]),
    US,
  );
  expect(entry.readiness).toBe("repairable");
  expect(entry.missing).toEqual([PERMISSION_SUBMIT_PROPOSAL, PERMISSION_VOTE]);
});

test("a neuron that named us without voting rights needs the owner", () => {
  const entry = classify(neuron([{ principal: US, permissions: [PERMISSION_VOTE] }]), US);
  expect(entry.readiness).toBe("partial");
  expect(entry.missing).toEqual([PERMISSION_SUBMIT_PROPOSAL]);
});

// Another principal's permissions must never be counted as ours: doing so
// would report a neuron ready and then fail at the moment of voting.
test("permissions belonging to another principal are not ours", () => {
  const entry = classify(
    neuron([
      { principal: THEM, permissions: [PERMISSION_SUBMIT_PROPOSAL, PERMISSION_VOTE] },
      { principal: US, permissions: [] },
    ]),
    US,
  );
  expect(entry.readiness).toBe("partial");
  expect(entry.missing).toEqual([PERMISSION_SUBMIT_PROPOSAL, PERMISSION_VOTE]);
});

test("permissions split across entries for the same principal are merged", () => {
  const entry = classify(
    neuron([
      { principal: US, permissions: [PERMISSION_VOTE] },
      { principal: US, permissions: [PERMISSION_SUBMIT_PROPOSAL] },
    ]),
    US,
  );
  expect(entry.readiness).toBe("ready");
});

test("the button label names the counts and the next action", () => {
  const found = [
    classify(
      neuron([{ principal: US, permissions: [PERMISSION_SUBMIT_PROPOSAL, PERMISSION_VOTE] }]),
      US,
    ),
  ];
  const status = { found, ready: 1, repairable: [], blocked: [], truncated: false };
  expect(describeRegistration(status, false)).toContain("click to allow voting");
  expect(describeRegistration(status, true)).toContain("voting enabled");
  expect(describeRegistration(status, true)).toContain("1 neuron found");
  expect(describeRegistration(null, false)).toContain("Checking");
});

// The grant must satisfy the canister's own decoder, exactly like the vote
// encoding does — a malformed grant would only surface at the click.
test("the permission grant is accepted by the SNS's own decoder", () => {
  const bytes = encodeAddVotingPermissions({ neuronId: "00".repeat(31) + "07", principal: US });
  const service = governanceIdl({ IDL }) as unknown as {
    _fields: [string, { argTypes: IDL.Type[] }][];
  };
  const argType = service._fields.find(([name]) => name === "manage_neuron")![1].argTypes[0]!;
  const [decoded] = IDL.decode([argType], bytes) as unknown as [
    {
      command: [
        {
          AddNeuronPermissions: {
            principal_id: [Principal];
            permissions_to_add: [{ permissions: Int32Array }];
          };
        },
      ];
    },
  ];
  const grant = decoded.command[0].AddNeuronPermissions;
  expect(grant.principal_id[0]!.toText()).toBe(US);
  expect([...grant.permissions_to_add[0]!.permissions]).toEqual([
    PERMISSION_SUBMIT_PROPOSAL,
    PERMISSION_VOTE,
  ]);
});
