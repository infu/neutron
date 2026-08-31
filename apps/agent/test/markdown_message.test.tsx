import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownMessage } from "../src/markdown_message.tsx";

function render(messageId: string, text: string): string {
  return renderToStaticMarkup(
    <MarkdownMessage messageId={messageId} text={text} />,
  );
}

test("assistant Markdown renders CommonMark and GFM structures", () => {
  const markup = render(
    "answer-1",
    [
      "## Result",
      "",
      "A **strong** answer with `inline code`.",
      "",
      "- first",
      "- second",
      "",
      "```js",
      "console.log('ok')",
      "```",
      "",
      "| App | Ready |",
      "| --- | --- |",
      "| Agent | yes |",
      "",
      "~~old~~",
      "",
      "- [x] checked",
    ].join("\n"),
  );

  expect(markup).toContain("<h2>Result</h2>");
  expect(markup).toContain("<strong>strong</strong>");
  expect(markup).toContain("<code>inline code</code>");
  expect(markup).toContain('<code class="language-js">');
  expect(markup).toContain("<ul>");
  expect(markup).toContain("<table>");
  expect(markup).toContain("<del>old</del>");
  expect(markup).toContain('type="checkbox"');
  expect(markup).toContain("checked");
});

test("assistant Markdown renders inline and block math locally", () => {
  const markup = render(
    "answer-math",
    [
      "Inline math: $E = mc^2$.",
      "",
      "Block math:",
      "",
      "$$ \\int_0^\\infty e^{-x},dx = 1 $$",
    ].join("\n"),
  );

  expect(markup).toContain('<span class="ora-math-block">');
  expect(markup).toContain('<span class="katex">');
  expect(markup).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">');
  expect(markup).not.toContain("katex-display");
  expect(markup).toContain("∞");
  expect(markup).toContain("∫");
  expect(markup).not.toContain("$$");
});

test("assistant math cannot create trusted links or remote assets", () => {
  const markup = render(
    "answer-untrusted-math",
    "$\\href{https://tracker.example/collect}{remote}$",
  );

  expect(markup).toContain('<span class="katex">');
  expect(markup).not.toContain("<a ");
  expect(markup).not.toContain("<a>");
  expect(markup).not.toContain("<img");
  expect(markup).not.toContain("href=");
  expect(markup).not.toContain("src=");
});

test("assistant Markdown drops HTML and images and restricts links", () => {
  const markup = render(
    "answer-2",
    [
      '<script>alert("no")</script>',
      '<img src="https://tracker.example/pixel" onerror="alert(1)">',
      "![remote](https://tracker.example/image.png)",
      "[web](https://example.com/docs)",
      "[local](#details)",
      "[relative](/private)",
      "[unsafe](javascript:alert(1))",
      "[credentials](https://user:password@example.com/private)",
    ].join("\n\n"),
  );

  expect(markup).not.toContain("<script");
  expect(markup).not.toContain("<img");
  expect(markup).not.toContain("onerror");
  expect(markup).not.toContain("node=");
  expect(markup).not.toContain("javascript:");
  expect(markup).not.toContain('href="/private"');
  expect(markup).not.toContain('href="https://example.com/docs"');
  expect(markup).toContain("https://example.com/docs");
  expect(markup).toContain('aria-label="Copy link"');
  expect(markup).toContain('aria-describedby=');
  expect(markup).not.toContain(">Copy link<");
  expect(markup).toContain('href="#details">local</a>');
  expect(markup).toContain("<span>relative</span>");
  expect(markup).toContain("<span>unsafe</span>");
  expect(markup).toContain("<span>credentials</span>");
});

test("footnote ids are isolated by the stable message id", () => {
  const markup = renderToStaticMarkup(
    <div>
      <MarkdownMessage
        messageId="first/answer"
        text={"First note[^detail].\n\n[^detail]: First detail."}
      />
      <MarkdownMessage
        messageId="second-answer"
        text={"Second note[^detail].\n\n[^detail]: Second detail."}
      />
    </div>,
  );

  expect(markup).toContain('id="agent-first-answer-fn-detail"');
  expect(markup).toContain('href="#agent-first-answer-fn-detail"');
  expect(markup).toContain('id="agent-second-answer-fn-detail"');
  expect(markup).toContain('href="#agent-second-answer-fn-detail"');
  expect(markup).toContain('id="agent-first-answer-footnote-label"');
  expect(markup).toContain(
    'aria-describedby="agent-first-answer-footnote-label"',
  );
  expect(markup).toContain('id="agent-second-answer-footnote-label"');
  expect(markup).toContain(
    'aria-describedby="agent-second-answer-footnote-label"',
  );
  expect(markup.match(/id="footnote-label"/g)).toBeNull();
});
