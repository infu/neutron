import type { ReactNode } from "react";
import type { Nodes, Root } from "mdast";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import { copyToClipboard } from "neutron-tools/app";
import { validateBodyMarkdown } from "./model.ts";

const UNSAFE_URL_TEXT =
  /[\u0000-\u0020\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const MAX_LINK_TEXT_BYTES = 2_048;
const utf8 = new TextEncoder();

/**
 * Limits are applied to the parsed MDAST before react-markdown can construct a
 * React tree. The 32 KiB source limit bounds parsing work; these tighter limits
 * bound tree construction and rendering work, including reference-link fanout.
 */
export const MAIL_MARKDOWN_RENDER_LIMITS = Object.freeze({
  nodes: 2_048,
  depth: 20,
  renderedTextBytes: 32 * 1_024,
  linkDestinationBytes: 32 * 1_024,
  links: 64,
  images: 32,
  listItems: 512,
  codeNodes: 128,
  codeBytes: 24 * 1_024,
  codeLines: 500,
  tables: 8,
  tableRows: 64,
  tableColumns: 20,
  tableCells: 512,
});

export const MAIL_MARKDOWN_TOO_COMPLEX =
  "This message is too complex to display safely.";

type ComplexityViolation =
  | "unsupported-node"
  | "nodes"
  | "depth"
  | "rendered-text"
  | "link-destinations"
  | "links"
  | "images"
  | "list-items"
  | "code-nodes"
  | "code-bytes"
  | "code-lines"
  | "tables"
  | "table-rows"
  | "table-columns"
  | "table-cells";

const ALLOWED_NODE_TYPES = new Set<Nodes["type"]>([
  "root",
  "blockquote",
  "break",
  "code",
  "definition",
  "delete",
  "emphasis",
  "heading",
  "html",
  "image",
  "imageReference",
  "inlineCode",
  "link",
  "linkReference",
  "list",
  "listItem",
  "paragraph",
  "strong",
  "table",
  "tableCell",
  "tableRow",
  "text",
  "thematicBreak",
]);

/** Fail closed before mdast-util-to-hast/React can expand a hostile tree. */
export const remarkBoundedMailMarkdown: Plugin<[], Root> = () => (tree) => {
  if (findComplexityViolation(tree) !== null) {
    tree.children = [
      {
        type: "paragraph",
        children: [{ type: "text", value: MAIL_MARKDOWN_TOO_COMPLEX }],
      },
    ];
  }
};

export type SafeMailMarkdownProps = {
  source: string;
  label?: string;
  onCopyLink?: (destination: string) => void | Promise<void>;
};

export function normalizeSafeMailLink(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8.encode(value).byteLength > MAX_LINK_TEXT_BYTES ||
    UNSAFE_URL_TEXT.test(value) ||
    value.includes("\\") ||
    value.startsWith("//") ||
    !/^https?:\/\//iu.test(value)
  ) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function findComplexityViolation(root: Root): ComplexityViolation | null {
  const pending: Array<{ node: Nodes; depth: number }> = [
    { node: root, depth: 0 },
  ];
  const definitions = new Map<string, string>();
  const references: string[] = [];
  let nodes = 0;
  let renderedTextBytes = 0;
  let linkDestinationBytes = 0;
  let links = 0;
  let images = 0;
  let listItems = 0;
  let codeNodes = 0;
  let codeBytes = 0;
  let codeLines = 0;
  let tables = 0;
  let tableCells = 0;

  while (pending.length > 0) {
    const entry = pending.pop()!;
    const { node, depth } = entry;
    nodes += 1;
    if (nodes > MAIL_MARKDOWN_RENDER_LIMITS.nodes) return "nodes";
    if (depth > MAIL_MARKDOWN_RENDER_LIMITS.depth) return "depth";
    if (!ALLOWED_NODE_TYPES.has(node.type)) return "unsupported-node";

    if ("value" in node && typeof node.value === "string") {
      const bytes = utf8.encode(node.value).byteLength;
      renderedTextBytes += bytes;
      if (renderedTextBytes > MAIL_MARKDOWN_RENDER_LIMITS.renderedTextBytes) {
        return "rendered-text";
      }
      if (node.type === "code" || node.type === "inlineCode") {
        codeNodes += 1;
        codeBytes += bytes;
        codeLines += countTextLines(node.value);
        if (codeNodes > MAIL_MARKDOWN_RENDER_LIMITS.codeNodes) {
          return "code-nodes";
        }
        if (codeBytes > MAIL_MARKDOWN_RENDER_LIMITS.codeBytes) {
          return "code-bytes";
        }
        if (codeLines > MAIL_MARKDOWN_RENDER_LIMITS.codeLines) {
          return "code-lines";
        }
      }
    }

    if (
      (node.type === "image" || node.type === "imageReference") &&
      typeof node.alt === "string"
    ) {
      renderedTextBytes += utf8.encode(node.alt).byteLength;
      if (renderedTextBytes > MAIL_MARKDOWN_RENDER_LIMITS.renderedTextBytes) {
        return "rendered-text";
      }
    }

    switch (node.type) {
      case "definition": {
        // CommonMark resolves the first matching definition.
        const identifier = canonicalReferenceId(node.identifier);
        if (!definitions.has(identifier)) {
          definitions.set(identifier, node.url);
        }
        break;
      }
      case "link":
        links += 1;
        linkDestinationBytes += utf8.encode(node.url).byteLength;
        break;
      case "linkReference":
        links += 1;
        references.push(canonicalReferenceId(node.identifier));
        break;
      case "image":
        images += 1;
        linkDestinationBytes += utf8.encode(node.url).byteLength;
        break;
      case "imageReference":
        images += 1;
        references.push(canonicalReferenceId(node.identifier));
        break;
      case "listItem":
        listItems += 1;
        if (listItems > MAIL_MARKDOWN_RENDER_LIMITS.listItems) {
          return "list-items";
        }
        break;
      case "table": {
        tables += 1;
        if (tables > MAIL_MARKDOWN_RENDER_LIMITS.tables) return "tables";
        if (node.children.length > MAIL_MARKDOWN_RENDER_LIMITS.tableRows) {
          return "table-rows";
        }
        for (const row of node.children) {
          if (
            row.type !== "tableRow" ||
            row.children.length > MAIL_MARKDOWN_RENDER_LIMITS.tableColumns
          ) {
            return "table-columns";
          }
          tableCells += row.children.length;
          if (tableCells > MAIL_MARKDOWN_RENDER_LIMITS.tableCells) {
            return "table-cells";
          }
        }
        break;
      }
    }

    if (links > MAIL_MARKDOWN_RENDER_LIMITS.links) return "links";
    if (images > MAIL_MARKDOWN_RENDER_LIMITS.images) return "images";
    if (
      linkDestinationBytes > MAIL_MARKDOWN_RENDER_LIMITS.linkDestinationBytes
    ) {
      return "link-destinations";
    }

    const children = "children" in node ? node.children : undefined;
    if (Array.isArray(children)) {
      if (children.length > MAIL_MARKDOWN_RENDER_LIMITS.nodes) return "nodes";
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push({ node: children[index] as Nodes, depth: depth + 1 });
      }
    }
  }

  // Definitions are stored once but can be expanded by every reference. Count
  // the resolved destination per use to prevent a compact source from creating
  // a disproportionately large React/DOM projection.
  for (const identifier of references) {
    const destination = definitions.get(identifier);
    if (destination !== undefined) {
      linkDestinationBytes += utf8.encode(destination).byteLength;
      if (
        linkDestinationBytes > MAIL_MARKDOWN_RENDER_LIMITS.linkDestinationBytes
      ) {
        return "link-destinations";
      }
    }
  }
  return null;
}

function canonicalReferenceId(identifier: string): string {
  // Match mdast-util-to-hast's definition lookup exactly.
  return identifier.toUpperCase();
}

function countTextLines(value: string): number {
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 0x0a) lines += 1;
  }
  return lines;
}

export function SafeMailMarkdown({
  source,
  label = "Message body",
  onCopyLink = copyToClipboard,
}: SafeMailMarkdownProps) {
  const checkedSource = validateBodyMarkdown(source);
  const components: Components = {
    a({ node: _node, href, children }) {
      return (
        <MailLink
          destination={normalizeSafeMailLink(href)}
          original={href}
          onCopyLink={onCopyLink}
        >
          {children}
        </MailLink>
      );
    },
    img({ node: _node, src, alt }) {
      const destination = normalizeSafeMailLink(src);
      return (
        <span className="mail-remote-image" role="note">
          <span>
            Remote image not loaded{alt ? `: ${alt}` : ""}
          </span>
          {destination ? (
            <MailCopyButton
              destination={destination}
              label={`Copy remote image link: ${destination}`}
              onCopyLink={onCopyLink}
            />
          ) : null}
        </span>
      );
    },
    table({ node: _node, ...props }) {
      return (
        <div className="mail-markdown-table" tabIndex={0}>
          <table {...props} />
        </div>
      );
    },
    pre({ node: _node, ...props }) {
      return (
        <div className="mail-markdown-code" tabIndex={0}>
          <pre {...props} />
        </div>
      );
    },
  };

  return (
    <section className="mail-markdown" aria-label={label}>
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkGfm, remarkBoundedMailMarkdown]}
        skipHtml
        urlTransform={(url) => url}
      >
        {checkedSource}
      </ReactMarkdown>
    </section>
  );
}

function MailLink({
  destination,
  original,
  onCopyLink,
  children,
}: {
  destination: string | null;
  original: string | undefined;
  onCopyLink: (destination: string) => void | Promise<void>;
  children: ReactNode;
}) {
  if (!destination) {
    return (
      <span className="mail-unsafe-link" title="This link is not a safe HTTP(S) destination">
        {children || original || "Unsafe link"}
      </span>
    );
  }
  return (
    <span className="mail-safe-link">
      <span className="mail-link-label">{children || destination}</span>
      <details className="mail-link-disclosure">
        <summary title="Show full link destination" aria-label="Show full link destination">
          <span className="mail-copy-link-destination">Show destination</span>
        </summary>
        <span
          className="mail-link-disclosure-panel"
          role="group"
          aria-label="Full link destination"
        >
          <bdi dir="ltr">{destination}</bdi>
          <MailCopyButton
            destination={destination}
            label={`Copy link: ${destination}`}
            onCopyLink={onCopyLink}
          />
        </span>
      </details>
    </span>
  );
}

function MailCopyButton({
  destination,
  label,
  onCopyLink,
}: {
  destination: string;
  label: string;
  onCopyLink: (destination: string) => void | Promise<void>;
}) {
  return (
    <button
      type="button"
      className="mail-copy-link"
      aria-label={label}
      title={destination}
      onClick={() => void onCopyLink(destination)}
    >
      Copy link
    </button>
  );
}
