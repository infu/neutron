import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const markdownComponents: Components = {
  a({ node: _node, href, ...props }) {
    const opensNewTab = Boolean(href && !href.startsWith("#"));
    return (
      <a
        {...props}
        href={href}
        rel={opensNewTab ? "noreferrer noopener" : undefined}
        target={opensNewTab ? "_blank" : undefined}
      />
    );
  },
  img({ node: _node, ...props }) {
    return <img {...props} loading="lazy" referrerPolicy="no-referrer" />;
  },
  table({ node: _node, ...props }) {
    return (
      <div className="files-markdown-table" tabIndex={0}>
        <table {...props} />
      </div>
    );
  },
};

const markdownPlugins = [remarkGfm];

export function isMarkdownPath(path: string | null): boolean {
  return Boolean(path && path.toLowerCase().endsWith(".md"));
}

export function MarkdownPreview({
  path,
  source,
}: {
  path: string;
  source: string;
}) {
  return (
    <div
      aria-label={`Rendered ${path}`}
      className="files-markdown-preview"
      data-testid="markdown-preview"
      tabIndex={0}
    >
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={markdownPlugins}
        skipHtml
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
