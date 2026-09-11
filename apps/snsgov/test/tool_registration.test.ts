import { expect, test } from "bun:test";
import { spawn } from "bun";
import { fileURLToPath } from "node:url";

test("the resident registers every tool through the production schema validator", async () => {
  // Other suites replace neutron-tools/app to inspect calls. Use a fresh process
  // so no module mock can hide the actual startup failure seen in service.js.
  const child = spawn([process.execPath, "--eval", `
    import { strict as assert } from "node:assert";
    import { exposeTool, listExposedTools } from "neutron-tools/app";
    import { validateToolArguments } from "neutron-tools/protocol";
    await import("./src/service.ts");
    const tools = listExposedTools();
    const expected = [
      "sns_list", "sns_get", "sns_proposals", "sns_proposal", "sns_proposal_types",
      "sns_neurons", "sns_compare", "sns_my_neurons", "sns_vote_plan", "sns_vote",
      "sns_vote_history", "sns_canisters", "sns_show", "sns_draft_proposal", "sns_drafts",
      "sns_proposal_type_schema", "sns_validate_payload", "sns_neuron_v1",
      "sns_proposal_schema_v1", "sns_topics_v1", "sns_version_v1", "sns_upgrade_journal_v1",
      "sns_delete_draft_v1", "sns_preview_neuron_v1", "sns_manage_neuron_v1",
      "sns_preview_proposal_v1", "sns_submit_proposal_v1", "sns_submit_draft_v1",
      "sns_transfer_control_v1", "sns_stake_preview_v1", "sns_stake_v1", "sns_stake_root_v1",
      "sns_top_up_v1", "sns_top_up_root_v1", "sns_operation_status_v1", "sns_continue_v1",
      "sns_operation_history_v1", "sns_feed_v1", "sns_governance_query_v1",
      "sns_governance_recovery_v1",
    ];
    assert.deepEqual(tools.map(tool => tool.name).sort(), expected.sort());
    assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length);
    // These registrations follow the previously crashing draft declaration.
    for (const name of ["sns_draft_proposal", "sns_drafts", "sns_proposal_type_schema", "sns_validate_payload"]) {
      assert.ok(tools.some(tool => tool.name === name), name);
    }
    const draft = tools.find(tool => tool.name === "sns_draft_proposal");
    const input = {
      rootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai", title: "Custom", summary: "Review",
      actionKind: "custom", functionId: "3"
    };
    for (const payloadHex of ["4449444c0000", "4449444C0000"]) {
      assert.doesNotThrow(() => validateToolArguments(draft, { ...input, payloadHex }));
    }
    for (const payloadHex of ["", "g0", "0x4449444c0000", "44 49444c0000"]) {
      assert.throws(() => validateToolArguments(draft, { ...input, payloadHex }));
    }
    const find = name => {
      const tool = tools.find(tool => tool.name === name);
      assert.ok(tool, name + " is registered");
      return tool;
    };
    const valid = (name, args) => assert.doesNotThrow(() => validateToolArguments(find(name), args), name);
    const invalid = (name, args) => assert.throws(() => validateToolArguments(find(name), args), name);
    const rootCanisterId = "extk7-gaaaa-aaaaq-aacda-cai";
    const neuronId = "01".repeat(32);
    const operationId = "ab".repeat(16);
    const command = { Configure: { operation: { SetDissolveTimestamp: { dissolve_timestamp_seconds: "1893456000" } } } };
    const proposal = { rootCanisterId, neuronId, title: "A motion", summary: "Review", action: { Motion: { motion_text: "Adopt this." } } };
    valid("sns_manage_neuron_v1", { rootCanisterId, neuronId, operationId, command });
    valid("sns_preview_neuron_v1", { rootCanisterId, neuronId, command });
    valid("sns_submit_proposal_v1", { ...proposal, operationId });
    valid("sns_preview_proposal_v1", proposal);
    valid("sns_draft_proposal", { rootCanisterId, title: "Native draft", summary: "Review", action: proposal.action });
    valid("sns_draft_proposal", { rootCanisterId, title: "Custom draft", summary: "Review", action: { ExecuteGenericNervousSystemFunction: { function_id: "1000", payload: { hex: "4449444c0000" } } } });
    // A custom Candid method can have zero, one scalar, or several arguments.
    // Shape conversion is performed by its inspected Candid types, not forced
    // into an object by this outer tool descriptor.
    for (const value of [null, [], ["123", true], "literal", { field: "123" }]) {
      valid("sns_validate_payload", { rootCanisterId, functionId: "1000", value });
    }
    for (const badOperationId of ["", "ab", "A".repeat(32), "g".repeat(32)]) {
      invalid("sns_manage_neuron_v1", { rootCanisterId, neuronId, operationId: badOperationId, command });
    }
    invalid("sns_manage_neuron_v1", { rootCanisterId, neuronId, command });
    invalid("sns_manage_neuron_v1", { rootCanisterId, neuronId: "01", operationId, command });
    valid("sns_stake_v1", { rootCanisterId, operationId, amountAtoms: "9007199254740993" });
    invalid("sns_stake_v1", { rootCanisterId, operationId, amountAtoms: 9007199254740992 });
    invalid("sns_stake_v1", { rootCanisterId, operationId, amountAtoms: "1.5" });
    valid("sns_continue_v1", { operationId, fundingResults: [{ requestId: operationId, result: { blockIndex: "9007199254740993" } }] });
    valid("sns_operation_status_v1", { operationId, includeRaw: true });
    valid("sns_submit_draft_v1", { draftId: "42", neuronId });
    valid("sns_submit_draft_v1", { draftId: "42", neuronId, operationId });
    for (const name of ["sns_manage_neuron_v1", "sns_submit_proposal_v1", "sns_submit_draft_v1", "sns_transfer_control_v1", "sns_continue_v1", "sns_governance_recovery_v1", "sns_vote"]) {
      const annotations = find(name).annotations;
      assert.equal(annotations["neutron:consent"], "provider_once", name);
      assert.ok(annotations["neutron:effects"].includes("write"), name);
      assert.notEqual(annotations["neutron:audience"], "agent_root", name + " must also support Normal and owner actions");
    }
    for (const name of ["sns_stake_root_v1", "sns_top_up_root_v1"]) {
      const annotations = find(name).annotations;
      assert.equal(annotations["neutron:audience"], "agent_root", name);
      assert.equal(annotations["neutron:visibility"], "same_app", name);
      assert.equal(annotations["neutron:consent"], undefined, name);
    }
    for (const name of ["sns_preview_neuron_v1", "sns_preview_proposal_v1", "sns_stake_preview_v1", "sns_operation_status_v1", "sns_operation_history_v1", "sns_governance_query_v1", "sns_feed_v1"]) {
      assert.ok(!find(name).annotations["neutron:effects"].includes("write"), name + " must not execute an update");
    }
    // Prove the harness has not bypassed or loosened the registration guard.
    assert.throws(() => exposeTool("bad_schema_regression", {
      inputSchema: { type: "object", properties: {
        payloadHex: { type: "string", pattern: "^(?:[0-9a-fA-F]{2})+$" }
      }}
    }, async () => ({})), /unsafe pattern/);
    console.log(JSON.stringify({ registered: tools.map(tool => tool.name) }));
  `], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  expect(JSON.parse(stdout).registered).toContain("sns_validate_payload");
}, 30_000);
