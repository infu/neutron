import { expect, test } from "bun:test";
import {
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAIL_MARKDOWN_RENDER_LIMITS,
  MAIL_MARKDOWN_TOO_COMPLEX,
  SafeMailMarkdown,
  normalizeSafeMailLink,
} from "../src/safe_markdown.tsx";

test("normalizes only absolute credential-free HTTP(S) destinations", () => {
  expect(normalizeSafeMailLink("https://example.com/path?q=1")).toBe(
    "https://example.com/path?q=1",
  );
  expect(normalizeSafeMailLink("http://example.com")).toBe("http://example.com/");
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///tmp/a",
    "//example.com/a",
    "/relative",
    "https://user:pass@example.com/",
    "https:\\example.com",
    "https://example.com/\u202eevil",
  ]) {
    expect(normalizeSafeMailLink(value)).toBeNull();
  }
});

test("safe links are copy-only buttons without navigation or fetch attributes", () => {
  const markup = renderToStaticMarkup(
    <SafeMailMarkdown source="Read [the plan](https://example.com/plan)." />,
  );
  expect(markup).toContain("Copy link: https://example.com/plan");
  expect(markup).toContain("mail-copy-link-destination");
  expect(markup).toContain("mail-link-disclosure");
  expect(markup).toContain('aria-label="Full link destination"');
  expect(markup).toContain('aria-label="Show full link destination"');
  expect(markup).toContain(">Show destination</span>");
  expect(markup.indexOf("https://example.com/plan")).toBeGreaterThan(
    markup.indexOf("mail-link-disclosure-panel"),
  );
  expect(markup).not.toContain("<a");
  expect(markup).not.toContain("href=");
  expect(markup).not.toContain("target=");
});

test("unsafe links and raw HTML remain inert", () => {
  const markup = renderToStaticMarkup(
    <SafeMailMarkdown
      source={'[bad](javascript:alert(1))\n\n<script src="https://evil.invalid/x.js"></script>'}
    />,
  );
  expect(markup).toContain("mail-unsafe-link");
  expect(markup).not.toContain("javascript:");
  expect(markup).not.toContain("<script");
  expect(markup).not.toContain("evil.invalid");
});

test("image syntax never creates an image request and tables remain bounded", () => {
  const markup = renderToStaticMarkup(
    <SafeMailMarkdown
      source={'![diagram](https://example.com/image.png)\n\n| A | B |\n| - | - |\n| 1 | 2 |'}
    />,
  );
  expect(markup).toContain("Remote image not loaded: diagram");
  expect(markup).toContain("Copy remote image link");
  expect(markup).not.toContain("<img");
  expect(markup).not.toContain("src=");
  expect(markup).toContain("mail-markdown-table");
  expect(markup).toContain("<table>");
});

test("a linked image has sibling copy actions without nested buttons", () => {
  const inner = "https://inner.example/image.png";
  const outer = "https://outer.example/message";
  const source = `[![inner](${inner})](${outer})`;
  const markup = renderToStaticMarkup(<SafeMailMarkdown source={source} />);

  expect(markup.match(/<button\b/gu)).toHaveLength(2);
  expect(maxButtonDepth(markup)).toBe(1);
  expect(markup).toContain(`Copy remote image link: ${inner}`);
  expect(markup).toContain(`Copy link: ${outer}`);
  expect(markup).not.toContain("<a");
  expect(markup).not.toContain("<img");
  expect(markup).not.toContain("href=");
  expect(markup).not.toContain("src=");

  const copied: string[] = [];
  const buttons = collectHostElements(
    SafeMailMarkdown({
      source,
      onCopyLink(destination) {
        copied.push(destination);
      },
    }),
    "button",
  );
  const innerButton = buttons.find(
    (button) =>
      button.props["aria-label"] === `Copy remote image link: ${inner}`,
  );
  const outerButton = buttons.find(
    (button) => button.props["aria-label"] === `Copy link: ${outer}`,
  );
  expect(buttons).toHaveLength(2);
  expect(innerButton).toBeDefined();
  expect(outerButton).toBeDefined();

  innerButton!.props.onClick!();
  expect(copied).toEqual([inner]);
  outerButton!.props.onClick!();
  expect(copied).toEqual([inner, outer]);
});

test("excessive nesting, table width, links, and code fail closed", () => {
  const wideTableColumns = MAIL_MARKDOWN_RENDER_LIMITS.tableColumns + 1;
  const wideTable = [
    `| ${Array.from({ length: wideTableColumns }, (_, index) => `secret-h${index}`).join(" | ")} |`,
    `| ${Array.from({ length: wideTableColumns }, () => "---").join(" | ")} |`,
    `| ${Array.from({ length: wideTableColumns }, () => "value").join(" | ")} |`,
  ].join("\n");
  const tooManyLinks = Array.from(
    { length: MAIL_MARKDOWN_RENDER_LIMITS.links + 1 },
    (_, index) => `[secret-link-${index}](https://example.com/${index})`,
  ).join(" ");
  const tooManyCodeNodes = Array.from(
    { length: MAIL_MARKDOWN_RENDER_LIMITS.codeNodes + 1 },
    (_, index) => `~~~\nsecret-code-${index}\n~~~`,
  ).join("\n\n");
  const tooMuchCode = `~~~\nsecret-long-code${"x".repeat(MAIL_MARKDOWN_RENDER_LIMITS.codeBytes)}\n~~~`;
  const tooManyCodeLines = `~~~\n${"secret-lines\n".repeat(MAIL_MARKDOWN_RENDER_LIMITS.codeLines + 1)}~~~`;

  for (const source of [
    `${"> ".repeat(MAIL_MARKDOWN_RENDER_LIMITS.depth + 1)}secret-depth`,
    wideTable,
    tooManyLinks,
    tooManyCodeNodes,
    tooMuchCode,
    tooManyCodeLines,
  ]) {
    const markup = renderToStaticMarkup(<SafeMailMarkdown source={source} />);
    expect(markup).toContain(MAIL_MARKDOWN_TOO_COMPLEX);
    expect(markup).not.toContain("secret-");
    expect(markup).not.toContain("<table>");
    expect(markup).not.toContain("<pre>");
    expect(markup).not.toContain("mail-copy-link");
  }
});

test("reference links cannot amplify one definition into an oversized projection", () => {
  const destination = `https://example.com/${"a".repeat(1_800)}`;
  const references = Array.from({ length: 20 }, () => "[secret-ref][shared]").join(
    " ",
  );
  const markup = renderToStaticMarkup(
    <SafeMailMarkdown source={`${references}\n\n[shared]: ${destination}`} />,
  );
  expect(markup).toContain(MAIL_MARKDOWN_TOO_COMPLEX);
  expect(markup).not.toContain("secret-ref");
  expect(markup).not.toContain(destination);
});

test("a large node bomb produces one bounded fallback promptly", () => {
  const paragraphs = Math.floor(MAIL_MARKDOWN_RENDER_LIMITS.nodes / 2) + 1;
  const source = Array.from({ length: paragraphs }, () => "HOSTILE_NODE").join(
    "\n\n",
  );
  const started = performance.now();
  const markup = renderToStaticMarkup(<SafeMailMarkdown source={source} />);
  const elapsedMs = performance.now() - started;

  expect(markup).toContain(MAIL_MARKDOWN_TOO_COMPLEX);
  expect(markup).not.toContain("HOSTILE_NODE");
  expect(markup.length).toBeLessThan(256);
  expect(elapsedMs).toBeLessThan(2_000);
});

type TestHostProps = {
  children?: ReactNode;
  onClick?: () => void;
  "aria-label"?: string;
};

function collectHostElements(
  root: ReactNode,
  tagName: string,
): Array<ReactElement<TestHostProps>> {
  const found: Array<ReactElement<TestHostProps>> = [];
  visit(root);
  return found;

  function visit(node: ReactNode): void {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isValidElement(node)) return;
    const element = node as ReactElement<TestHostProps>;
    if (typeof element.type === "function") {
      const Component = element.type as unknown as (
        props: TestHostProps,
      ) => ReactNode;
      visit(Component(element.props));
      return;
    }
    if (element.type === tagName) found.push(element);
    visit(element.props.children);
  }
}

function maxButtonDepth(markup: string): number {
  let depth = 0;
  let maximum = 0;
  for (const match of markup.matchAll(/<\/?button\b[^>]*>/gu)) {
    if (match[0].startsWith("</")) {
      depth -= 1;
    } else {
      depth += 1;
      maximum = Math.max(maximum, depth);
    }
  }
  expect(depth).toBe(0);
  return maximum;
}
