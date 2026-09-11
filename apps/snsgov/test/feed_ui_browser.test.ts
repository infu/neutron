import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { proposalBrowser, show } from "./proposal_ui_fixture";

test("feed renders healthy communities while another is slow, reports failures and retains duplicate SNS-local IDs", async () => {
  await proposalBrowser(async ui => {
    await ui.getByRole("button", { name: "Readable proposal title 3", exact: true }).waitFor();
    await ui.getByText("Checking 1 of 2 communities…", { exact: true }).waitFor();
    await ui.evaluate(() => { (globalThis as any).__failB = true; (globalThis as any).__pending.feedB(); });
    await ui.getByText("Feed coverage is incomplete:", { exact: false }).waitFor();
    expect(await ui.getByRole("button", { name: "Readable proposal title 3", exact: true }).count()).toBe(1);
    await ui.evaluate(() => { (globalThis as any).__failB = false; (globalThis as any).__slowB = false; });
    await ui.getByRole("button", { name: "Retry failed communities", exact: true }).click();
    await ui.getByRole("button", { name: "Second community proposal", exact: true }).waitFor();
    expect(await ui.getByRole("article").count()).toBe(6);
    expect(await ui.getByText("Feed coverage is incomplete:", { exact: false }).count()).toBe(0);
    await ui.evaluate(() => { (globalThis as any).__failRead = true; });
    await ui.getByRole("button", { name: "Refresh", exact: true }).click();
    await ui.getByText("Feed coverage is incomplete:", { exact: false }).waitFor();
    expect(await ui.getByRole("article").count()).toBe(6);
  }, { flags: { __slowB: true } });
}, 120_000);

test("accepting-votes filter retains continuation through empty pages and includes decided proposals whose window is open", async () => {
  await proposalBrowser(async ui => {
    await ui.getByText("No matching proposals in the pages loaded so far.", { exact: false }).waitFor();
    await ui.getByRole("button", { name: "Load more", exact: true }).click();
    if (await ui.getByRole("button", { name: "Older proposal accepting votes", exact: true }).count() === 0) await ui.getByRole("button", { name: "Load more", exact: true }).click();
    await ui.getByRole("button", { name: "Older proposal accepting votes", exact: true }).first().waitFor();
    expect(await ui.getByText("Voting still available", { exact: true }).count()).toBeGreaterThan(0);
  }, { flags: { __olderOnly: true } });
}, 120_000);

test("one explicit vote freezes the selected neuron set and reports accepted, opposite existing, rejected and unattempted ballots", async () => {
  await proposalBrowser(async ui => {
    const post = ui.getByRole("article").first();
    await post.getByRole("button", { name: "Vote Yes with 5 neurons", exact: true }).waitFor();
    await post.getByText("All 5 eligible neurons", { exact: true }).click();
    await post.getByRole("checkbox").last().uncheck();
    await post.getByRole("button", { name: "Vote Yes with 4 neurons", exact: true }).click();
    await post.locator(".snsgov-vote-result").getByText("Already voted No", { exact: true }).waitFor();
    await post.getByText("Could not vote", { exact: true }).waitFor();
    await post.getByText("Not sent", { exact: true }).waitFor();
    await post.getByText("Yes recorded", { exact: true }).waitFor();
    const calls = await ui.evaluate(() => (globalThis as any).__calls.filter((call: any) => call.kind === "invoke"));
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("sns_vote");
    expect(calls[0].args.neuronIds).toEqual(["11", "22", "33", "44"].map(value => value.repeat(32)));
    expect(calls[0].args.adopt).toBe(true);
    expect(calls[0].args.operationId).toMatch(/^[0-9a-f]{32}$/);
  });
}, 120_000);

test("sandbox proposal screens keep wrapping text and controls visible at narrow and wide widths", async () => {
  await proposalBrowser(async (ui, page) => {
    for (const width of [320, 480, 960]) {
      await page.setViewportSize({ width, height: 850 });
      await show(ui, { kind: "feed" });
      await ui.getByRole("article").first().waitFor();
      const dimensions = await ui.evaluate(() => ({
        width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth,
        clippedTitles: [...document.querySelectorAll(".snsgov-post-title button")].filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.textContent),
        forms: document.querySelectorAll("form").length,
      }));
      expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
      expect(dimensions.clippedTitles).toEqual([]);
      expect(dimensions.forms).toBe(0);
      if (process.env.SNSGOV_UI_EVIDENCE_DIR) { await mkdir(process.env.SNSGOV_UI_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.SNSGOV_UI_EVIDENCE_DIR, `feed-${width}.png`), fullPage: true }); }
      await ui.getByRole("button", { name: "Readable proposal title 3", exact: true }).click();
      await ui.getByRole("heading", { name: "Readable proposal title 3" }).waitFor();
      if (process.env.SNSGOV_UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.SNSGOV_UI_EVIDENCE_DIR, `proposal-${width}.png`), fullPage: true });
      await ui.getByRole("button", { name: "Back to the proposal list" }).click();
      await ui.getByRole("button", { name: "Create proposal", exact: true }).click();
      await ui.getByRole("dialog").getByRole("button", { name: "Continue", exact: true }).click();
      const dialog = ui.getByRole("dialog");
      await dialog.getByLabel("Title", { exact: true }).fill("A useful community motion");
      await dialog.getByLabel("Summary for voters").fill("Explain the change in clear terms.");
      await dialog.getByLabel("Motion text", { exact: true }).fill("The community adopts this proposal.");
      if (process.env.SNSGOV_UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.SNSGOV_UI_EVIDENCE_DIR, `proposal-builder-${width}.png`), fullPage: true });
      const overflow = await dialog.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
      expect(overflow.content).toBeLessThanOrEqual(overflow.width + 1);
      if (width === 320 || width === 960) {
        await dialog.getByText("Advanced: full action schema and Candid input", { exact: true }).click();
        await dialog.getByRole("checkbox", { name: "Use the full action editor" }).check();
        await dialog.getByLabel("Action fields (JSON)", { exact: false }).fill('{"motion_text":"The community adopts this exact advanced action."}');
        await dialog.getByText("Full field schema", { exact: true }).click();
        await dialog.locator(".snsgov-dialog-body").evaluate(element => {
          const advanced = [...element.querySelectorAll("details")].find(details => details.querySelector("summary")?.textContent?.includes("Advanced: full action schema"));
          if (advanced) element.scrollTop += advanced.getBoundingClientRect().top - element.getBoundingClientRect().top;
        });
        if (process.env.SNSGOV_UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.SNSGOV_UI_EVIDENCE_DIR, `proposal-builder-advanced-${width}.png`), fullPage: true });
        const advancedOverflow = await dialog.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
        expect(advancedOverflow.content).toBeLessThanOrEqual(advancedOverflow.width + 1);
        expect(await dialog.getByRole("button", { name: "Review proposal", exact: true }).isVisible()).toBe(true);
      }
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
    }
  });
}, 120_000);
