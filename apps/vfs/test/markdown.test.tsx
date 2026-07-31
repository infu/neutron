import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { isMarkdownPath, MarkdownPreview } from "../src/markdown.tsx";

test("recognizes Markdown files without changing other file types", () => {
  expect(isMarkdownPath("/README.md")).toBe(true);
  expect(isMarkdownPath("/notes/CHANGELOG.MD")).toBe(true);
  expect(isMarkdownPath("/notes.md.txt")).toBe(false);
  expect(isMarkdownPath(null)).toBe(false);
});

test("renders GFM safely, including tables and task lists", () => {
  const markup = renderToStaticMarkup(
    <MarkdownPreview
      path="/README.md"
      source={`# Preview

| Name | Ready |
| --- | ---: |
| Files | yes |

- [x] Render tables

<script>window.compromised = true</script>

[unsafe](javascript:alert(1))`}
    />
  );

  expect(markup).toContain("<h1>Preview</h1>");
  expect(markup).toContain('class="files-markdown-table"');
  expect(markup).toContain("<table>");
  expect(markup).toContain('type="checkbox"');
  expect(markup).not.toContain("<script>");
  expect(markup).not.toContain("javascript:alert");
});
