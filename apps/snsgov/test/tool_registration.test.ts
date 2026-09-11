import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("the resident registers every tool through the production schema validator", async () => {
  // Other suites replace neutron-tools/app to inspect calls. Use a fresh process
  // so no module mock can hide the actual startup failure seen in service.js.
  const child = Bun.spawn([process.execPath, "--eval", `
    import { strict as assert } from "node:assert";
    import { exposeTool, listExposedTools } from "neutron-tools/app";
    import { validateToolArguments } from "neutron-tools/protocol";
    await import("./src/service.ts");
    const tools = listExposedTools();
    assert.equal(tools.length, 17);
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
