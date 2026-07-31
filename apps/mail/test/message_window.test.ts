import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("Mail list keeps the React tree bounded to one backend page", async () => {
  const [app, ui, css] = await Promise.all([
    readFile(new URL("../src/mail_app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/mail_ui.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/mail_ui.scss", import.meta.url), "utf8"),
  ]);
  expect(app).toContain("loadRevisionBoundMailPage(api, current, targetOffset, 50)");
  expect(app).toContain("if (stopped || polling || document.hidden) return");
  expect(app).toContain('document.addEventListener("visibilitychange", wake)');
  expect(ui).not.toContain("computeMailMessageWindow");
  expect(ui).toContain('className="mail-pagination"');
  expect(ui).toContain("{pageStart}–{pageEnd} of {pageTotal}");
  expect(ui).toContain("list.querySelector<HTMLElement>('.mail-message-row')");
  expect(ui).toContain("props.loading || props.pageLoading || undefined");
  expect(ui).toContain("aria-posinset={rowIndex + 1}");
  expect(ui).toContain("aria-setsize={totalRows}");
  expect(css).toContain(".mail-pagination");
  expect(css).not.toContain(".mail-load-more");
});
