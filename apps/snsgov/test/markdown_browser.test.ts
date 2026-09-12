import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { proposalBrowser, show } from "./proposal_ui_fixture";

test("proposal cards render safe Markdown, bounded headings and expandable text in a narrow sandbox", async () => {
  await proposalBrowser(async (ui, page) => {
    const title = "A community budget with a long but still readable proposal title ".repeat(12);
    const summary = '# A heading supplied by the proposal author\n\n**Clear purpose**, with *useful context*.\n\n- First item\n- Second item\n\n| Item | Cost |\n| --- | --- |\n| Work | 10 |\n\n' + 'A paragraph with explanatory details. '.repeat(35) + '\n\n[Safe source](https://example.com/source)\n\n[Unsafe source](javascript:alert%281%29)\n\n<script>globalThis.__markdownExecuted=true</script>\n\n<img src=x onerror="globalThis.__markdownExecuted=true">';
    await ui.evaluate(({ title, summary }) => {
      (globalThis as any).__proposalTitle = title;
      (globalThis as any).__proposalSummary = summary;
    }, { title, summary });
    await show(ui, { kind: "proposals" });
    const card = ui.getByRole("article").first();
    await card.locator(".snsgov-markdown strong").waitFor();
    expect(await card.locator(".snsgov-markdown strong").innerText()).toBe("Clear purpose");
    expect(await card.locator(".snsgov-markdown table").count()).toBe(1);
    expect(await card.locator(".snsgov-markdown script, .snsgov-markdown img, .snsgov-markdown form, .snsgov-markdown iframe").count()).toBe(0);
    expect(await card.locator('a[href^="javascript:"]').count()).toBe(0);
    expect(await ui.evaluate(() => (globalThis as any).__markdownExecuted)).toBeUndefined();
    const geometry = await card.evaluate(element => {
      const title = element.querySelector<HTMLElement>(".snsgov-post-title button")!;
      const heading = element.querySelector<HTMLElement>(".snsgov-markdown h4")!;
      const next = element.nextElementSibling!;
      return { titleHeight: title.clientHeight, lineHeight: parseFloat(getComputedStyle(title).lineHeight), headingSize: parseFloat(getComputedStyle(heading).fontSize), gap: next.getBoundingClientRect().top - element.getBoundingClientRect().bottom, border: getComputedStyle(element).borderTopWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(geometry.titleHeight).toBeLessThanOrEqual(geometry.lineHeight * 3 + 1);
    expect(geometry.headingSize).toBeLessThanOrEqual(16);
    expect(geometry.gap).toBeGreaterThanOrEqual(12);
    expect(geometry.border).toBe("1px");
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    await card.getByRole("button", { name: "Show more", exact: true }).click();
    const safe = card.getByRole("link", { name: "Safe source", exact: true });
    expect(await safe.getAttribute("target")).toBe("_blank");
    expect(await safe.getAttribute("rel")).toBe("noopener noreferrer");
    expect(await safe.getAttribute("tabindex")).toBeNull();
    await card.getByRole("button", { name: "Show less", exact: true }).click();
    if (process.env.SNSGOV_UI_EVIDENCE_DIR) {
      await mkdir(process.env.SNSGOV_UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.SNSGOV_UI_EVIDENCE_DIR, "markdown-cards-320.png"), fullPage: true });
    }
    await card.locator(".snsgov-post-title button").click();
    await ui.locator(".snsgov-proposal-detail .snsgov-markdown strong").waitFor();
    expect(await ui.locator(".snsgov-proposal-title").innerText()).toBe(title.trim());
    expect(await ui.locator(".snsgov-proposal-title").evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeLessThanOrEqual(20);
  }, { width: 320 });
}, 120_000);
