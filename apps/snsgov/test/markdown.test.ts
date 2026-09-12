import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProposalMarkdown } from "../src/ui/ProposalMarkdown";

const render = (text: string) => renderToStaticMarkup(createElement(ProposalMarkdown, { text }));

describe("untrusted proposal Markdown", () => {
  test("formats headings, emphasis, lists, code and GFM tables without author-sized titles", () => {
    const html = render("# Budget\n\n**Vote** for *maintenance*.\n\n- Item\n\n`code`\n\n| Cost | Amount |\n| --- | --- |\n| Dev | 10 |\n\n~~old~~");
    for (const fragment of ["<h4>Budget</h4>", "<strong>Vote</strong>", "<em>maintenance</em>", "<li>Item</li>", "<code>code</code>", "<table>", "<del>old</del>"]) expect(html).toContain(fragment);
    expect(html).not.toMatch(/<h[123][ >]/);
  });

  test("raw HTML cannot introduce scripts, forms, styles, frames or event handlers", () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n<iframe src="https://example.com"></iframe>\n\n<form><input autofocus onfocus="alert(3)"></form>\n\n<style>body{display:none}</style>\n\nNormal **text**');
    expect(html).toContain("<strong>text</strong>");
    expect(html).not.toMatch(/<(script|iframe|form|style|img|input)\b|onerror=|onfocus=/);
  });

  test("rejects script, data, relative and escaped unsafe destinations", () => {
    for (const url of ["javascript:alert%281%29", "jav&#x61;script:alert%281%29", "data:text/html,evil", "vbscript:evil", "/inside-the-app", "//example.com"]) {
      expect(render(`[visible label](${url})`)).not.toContain("href=");
      expect(render(`![visible alt](${url})`)).not.toContain("src=");
    }
  });

  test("external links isolate their opener and images omit referrers", () => {
    const html = render('[Read source](https://example.com/path)\n\n![Chart](https://example.com/chart.png)');
    expect(html).toContain('href="https://example.com/path"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('loading="lazy"');
  });

  test("task lists cannot become actionable forms and code remains escaped", () => {
    const html = render('- [x] Approved\n\n```html\n<img onerror="alert(1)">\n```');
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).toContain('&lt;img onerror=');
    expect(html).not.toContain('<img onerror=');
  });
});
