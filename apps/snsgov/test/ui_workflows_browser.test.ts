import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { proposalBrowser, show } from "./proposal_ui_fixture";

// The directory, responsive layout and neuron-filter cases that used to live
// here are covered by ui_layout_browser.test.ts and neurons_browser.test.ts.
// These regressions exercise the real replacement draft/proposal components
// across the resident public-tool boundary in the same sandbox as production.
test("draft retargeting selects only the new draft's eligible proposer and submits through the resident tool", async () => {
  await proposalBrowser(async ui => {
    await show(ui, { kind: "drafts", id: "1" });
    await ui.getByRole("heading", { name: "First draft", exact: true }).waitFor();
    await show(ui, { kind: "drafts", id: "2" });
    await ui.getByRole("heading", { name: "Second draft", exact: true }).waitFor();
    await ui.waitForFunction(() => document.querySelector<HTMLSelectElement>("#snsgov-proposer")?.value === "22".repeat(32));
    await ui.getByRole("button", { name: "Review and submit", exact: true }).click();
    await ui.getByText("Proposal 42 was submitted.", { exact: true }).waitFor();
    await ui.getByText("Draft removal failed; do not submit it again.", { exact: true }).waitFor();
    expect(await ui.getByRole("button", { name: "Review and submit", exact: true }).count()).toBe(0);
    expect(await ui.evaluate(() => (globalThis as any).__calls.filter((call: any) => call.kind === "invoke"))).toEqual([
      { kind: "invoke", name: "sns_submit_draft_v1", args: { draftId: "2", neuronId: "22".repeat(32) } },
    ]);
    await show(ui, { kind: "drafts", id: "3" });
    await ui.getByRole("heading", { name: "Ineligible preset", exact: true }).waitFor();
    expect(await ui.getByRole("button", { name: "Review and submit", exact: true }).isDisabled()).toBe(true);
    await ui.getByLabel("Neuron to propose with", { exact: true }).selectOption("22".repeat(32));
    expect(await ui.getByRole("button", { name: "Review and submit", exact: true }).isEnabled()).toBe(true);
  });
}, 120_000);

test("an unavailable proposer lookup ends loading and cannot be confused with empty access", async () => {
  await proposalBrowser(async ui => {
    await show(ui, { kind: "drafts", id: "4" });
    await ui.getByRole("alert").filter({ hasText: "Registration unavailable" }).waitFor();
    expect(await ui.getByRole("status", { name: "Finding neurons that may propose" }).count()).toBe(0);
    expect(await ui.getByText("No connected neuron grants SubmitProposal", { exact: false }).count()).toBe(0);
    expect(await ui.getByRole("button", { name: "Review and submit", exact: true }).isDisabled()).toBe(true);
  });
}, 120_000);

test("lost draft replies keep a stable saved submission and never start a random replacement operation", async () => {
  await proposalBrowser(async ui => {
    await ui.evaluate(() => { (globalThis as any).__loseDraftReply = true; });
    await show(ui, { kind: "drafts", id: "1" });
    await ui.getByRole("button", { name: "Review and submit", exact: true }).click();
    await ui.getByRole("button", { name: "Check saved submission", exact: true }).waitFor();
    expect(await ui.getByLabel("Neuron to propose with", { exact: true }).isDisabled()).toBe(true);
    await ui.evaluate(() => { (globalThis as any).__loseDraftReply = false; });
    await ui.getByRole("button", { name: "Continue saved submission", exact: true }).click();
    await ui.getByText("Proposal 42 was submitted.", { exact: true }).waitFor();
    const calls = await ui.evaluate(() => (globalThis as any).__calls.filter((call: any) => call.kind === "invoke"));
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(calls[1].args);
    expect(calls[0].args.operationId).toBeUndefined();
  });
}, 120_000);

test("proposal retargeting never displays the previous article under the next ID and failed refresh keeps readable posts", async () => {
  await proposalBrowser(async ui => {
    await show(ui, { kind: "proposals", id: "1" });
    await ui.getByRole("heading", { name: "Readable proposal title 1", exact: true }).waitFor();
    await ui.evaluate(() => { (globalThis as any).__slowDetail = true; });
    await show(ui, { kind: "proposals", id: "2" });
    await ui.getByRole("heading", { name: "Proposal 2", exact: true }).waitFor();
    expect(await ui.getByRole("heading", { name: "Readable proposal title 1", exact: true }).count()).toBe(0);
    await ui.waitForFunction(() => typeof (globalThis as any).__pending.detail === "function");
    await ui.evaluate(() => { (globalThis as any).__slowDetail = false; (globalThis as any).__pending.detail(); });
    await ui.getByRole("heading", { name: "Readable proposal title 2", exact: true }).waitFor();
    await show(ui, { kind: "proposals" });
    await ui.getByRole("heading", { name: "Proposals", exact: true }).waitFor();
    await ui.evaluate(() => { (globalThis as any).__failRead = true; });
    await ui.getByRole("button", { name: "Refresh proposals", exact: true }).click();
    await ui.getByRole("alert").filter({ hasText: "Proposal refresh unavailable" }).waitFor();
    expect(await ui.getByRole("button", { name: "Readable proposal title 3", exact: true }).count()).toBe(1);
  });
}, 120_000);

test("drafts remain readable during refresh failure and at narrow and wide sizes", async () => {
  await proposalBrowser(async (ui, page) => {
    await show(ui, { kind: "drafts" });
    await ui.getByRole("button", { name: "First draft", exact: true }).waitFor();
    await ui.evaluate(() => { (globalThis as any).__failDraftRead = true; });
    await ui.getByRole("button", { name: "Refresh drafts", exact: true }).click();
    await ui.getByRole("alert").filter({ hasText: "Draft refresh unavailable" }).waitFor();
    expect(await ui.getByRole("button", { name: "First draft", exact: true }).count()).toBe(1);
    for (const width of [320, 480, 960]) {
      await page.setViewportSize({ width, height: 850 });
      expect(await ui.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
      if (process.env.SNSGOV_UI_EVIDENCE_DIR) { await mkdir(process.env.SNSGOV_UI_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.SNSGOV_UI_EVIDENCE_DIR, `drafts-${width}.png`), fullPage: true }); }
    }
  });
}, 120_000);

test("checking an interrupted draft uses read-only journal status and never continues it", async () => {
  await proposalBrowser(async ui => {
    await ui.evaluate(() => { (globalThis as any).__loseDraftReply = true; });
    await show(ui, { kind: "drafts", id: "1" });
    await ui.getByRole("button", { name: "Review and submit", exact: true }).click();
    await ui.getByRole("button", { name: "Check saved submission", exact: true }).click();
    await ui.getByText("Submission is saved.", { exact: false }).waitFor();
    const names = await ui.evaluate(() => (globalThis as any).__calls.filter((call: any) => call.kind === "invoke").map((call: any) => call.name));
    expect(names).toEqual(["sns_submit_draft_v1", "sns_drafts", "sns_operation_status_v1"]);
  });
}, 120_000);

test("proposal composition previews exact native action fields and retains its operation ID through submission", async () => {
  await proposalBrowser(async ui => {
    await show(ui, { kind: "proposals" });
    await ui.getByRole("button", { name: "Create proposal", exact: true }).click();
    const dialog = ui.getByRole("dialog");
    await dialog.getByLabel("Title", { exact: true }).fill("Treasury community grant");
    await dialog.getByLabel("Summary for voters", { exact: true }).fill("Send exactly 1.25 AAA to this recipient.");
    await dialog.getByLabel("Proposal type", { exact: true }).selectOption("TransferSnsTreasuryFunds");
    await dialog.getByLabel("Amount (AAA)", { exact: true }).fill("1.25");
    await dialog.getByLabel("Recipient principal", { exact: true }).fill("aaaaa-aa");
    await dialog.getByRole("button", { name: "Review proposal", exact: true }).click();
    await dialog.getByRole("button", { name: "Submit proposal", exact: true }).click();
    await dialog.getByText("Proposal 99 was submitted.", { exact: true }).waitFor();
    const calls = await ui.evaluate(() => (globalThis as any).__calls.filter((call: any) => call.kind === "invoke"));
    expect(calls.map((call: any) => call.name)).toEqual(["sns_preview_proposal_v1", "sns_submit_proposal_v1"]);
    expect(calls[0].args.operationId).toBe(calls[1].args.operationId);
    expect(calls[1].args.action.TransferSnsTreasuryFunds).toMatchObject({ from_treasury: "2", amount_e8s: "125000000", to_principal: "aaaaa-aa" });
  });
}, 120_000);
