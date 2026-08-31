import { memo, useId, type ComponentProps } from "react";
import ReactMarkdown, {
  type Components,
  type ExtraProps,
} from "react-markdown";
import { IoCopyOutline } from "react-icons/io5";
import katex from "katex";
import type { Paragraph, Root } from "mdast";
import { mathFromMarkdown, type Math } from "mdast-util-math";
import { math } from "micromark-extension-math";
import remarkGfm from "remark-gfm";
import type { Parent } from "unist";
import type { Data, Plugin } from "unified";
import { copyToClipboard } from "neutron-tools/app";

const DISALLOWED_ELEMENTS = ["img"];
const UNSAFE_LINK_TEXT =
  /[\u0000-\u0020\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const MAX_LINK_LENGTH = 2_048;

type MathParserData = Data & {
  micromarkExtensions?: Array<ReturnType<typeof math>>;
  fromMarkdownExtensions?: Array<ReturnType<typeof mathFromMarkdown>>;
};

const remarkLocalMath: Plugin<[], Root> = function () {
  const data = this.data() as MathParserData;
  const micromarkExtensions =
    data.micromarkExtensions ?? (data.micromarkExtensions = []);
  const fromMarkdownExtensions =
    data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = []);
  micromarkExtensions.push(math());
  fromMarkdownExtensions.push(mathFromMarkdown());
};

const remarkStandaloneDisplayMath: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file.value);
  promote(tree);

  function promote(parent: Parent): void {
    for (let index = 0; index < parent.children.length; index += 1) {
      const node = parent.children[index];
      if (!node) continue;
      if (node.type === "paragraph") {
        const paragraph = node as Paragraph;
        const child = paragraph.children[0];
        const start = paragraph.position?.start.offset;
        const end = paragraph.position?.end.offset;
        const original =
          start === undefined || end === undefined
            ? ""
            : source.slice(start, end);
        if (
          paragraph.children.length === 1 &&
          child?.type === "inlineMath" &&
          original.startsWith("$$") &&
          original.endsWith("$$") &&
          !original.startsWith("$$$") &&
          !original.endsWith("$$$")
        ) {
          const math: Math = {
            type: "math",
            value: child.value,
            position: paragraph.position,
            data: {
              hName: "pre",
              hChildren: [
                {
                  type: "element",
                  tagName: "code",
                  properties: {
                    className: ["language-math", "math-display"],
                  },
                  children: [{ type: "text", value: child.value }],
                },
              ],
            },
          };
          parent.children[index] = math;
          continue;
        }
      }
      if ("children" in node && Array.isArray(node.children)) {
        promote(node as Parent);
      }
    }
  }
};

const REMARK_PLUGINS = [remarkGfm, remarkLocalMath, remarkStandaloneDisplayMath];

function MarkdownCode({
  node: _node,
  className,
  children,
  ...props
}: ComponentProps<"code"> & ExtraProps) {
  if (classNames(className).includes("math-inline")) {
    return <MathMarkup display={false} tex={String(children)} />;
  }
  return <code {...props} className={className}>{children}</code>;
}

function MarkdownPre({
  node,
  children,
  ...props
}: ComponentProps<"pre"> & ExtraProps) {
  const source = blockMathSource(node);
  return source === null ? (
    <pre {...props}>{children}</pre>
  ) : (
    <MathMarkup display tex={source} />
  );
}

function MathMarkup({ display, tex }: { display: boolean; tex: string }) {
  const markup = katex.renderToString(tex.replace(/\n$/u, ""), {
    displayMode: display,
    output: "mathml",
    strict: "ignore",
    throwOnError: false,
    trust: false,
  });
  return (
    <span
      className={display ? "ora-math-block" : "ora-math-inline"}
      // KaTeX escapes untrusted TeX and is the only source of this markup.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

function MarkdownLink({
  node: _node,
  href,
  children,
  footnoteLabelId,
  ...props
}: ComponentProps<"a"> & ExtraProps & { footnoteLabelId: string }) {
  const externalUrlId = `${useId().replaceAll(":", "")}-external-url`;
  if (href?.startsWith("#")) {
    return (
      <a
        {...props}
        aria-describedby={
          props["aria-describedby"] === "footnote-label"
            ? footnoteLabelId
            : props["aria-describedby"]
        }
        href={href}
      >
        {children}
      </a>
    );
  }

  if (!isHttpUrl(href)) return <span>{children}</span>;
  return (
    <span className="ora-markdown-external" role="group">
      <span>{children}</span>
      <bdi dir="ltr" id={externalUrlId}>{href}</bdi>
      <button
        aria-describedby={externalUrlId}
        aria-label="Copy link"
        onClick={() => void copyToClipboard(href).catch(() => undefined)}
        title={href}
        type="button"
      >
        <IoCopyOutline aria-hidden="true" />
      </button>
    </span>
  );
}

export const MarkdownMessage = memo(function MarkdownMessage({
  messageId,
  text,
}: {
  messageId: string;
  text: string;
}) {
  const prefix = footnotePrefix(messageId);
  const footnoteLabelId = `${prefix}footnote-label`;
  const components: Components = {
    a: (props) => (
      <MarkdownLink {...props} footnoteLabelId={footnoteLabelId} />
    ),
    h2: ({ node: _node, ...props }) => (
      <h2
        {...props}
        id={
          props.id === "footnote-label" ? footnoteLabelId : props.id
        }
      />
    ),
    code: MarkdownCode,
    pre: MarkdownPre,
  };
  return (
    <div className="ora-markdown">
      <ReactMarkdown
        components={components}
        disallowedElements={DISALLOWED_ELEMENTS}
        remarkPlugins={REMARK_PLUGINS}
        remarkRehypeOptions={{ clobberPrefix: prefix }}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

function blockMathSource(node: ExtraProps["node"]): string | null {
  if (node?.children.length !== 1) return null;
  const child = node.children[0];
  if (
    child?.type !== "element" ||
    child.tagName !== "code" ||
    !classNames(child.properties.className).some(
      (name) => name === "language-math" || name === "math-display",
    )
  ) {
    return null;
  }
  return hastText(child);
}

function hastText(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  if (
    "type" in node &&
    node.type === "text" &&
    "value" in node &&
    typeof node.value === "string"
  ) {
    return node.value;
  }
  if ("children" in node && Array.isArray(node.children)) {
    return node.children.map(hastText).join("");
  }
  return "";
}

function classNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? value.split(/\s+/u).filter(Boolean) : [];
}

function footnotePrefix(messageId: string): string {
  const segment = messageId.replace(/[^a-zA-Z0-9_-]/g, "-") || "message";
  return `agent-${segment}-`;
}

function isHttpUrl(value: string | undefined): value is string {
  if (
    !value ||
    value.length > MAX_LINK_LENGTH ||
    UNSAFE_LINK_TEXT.test(value) ||
    value.includes("\\") ||
    value.startsWith("//")
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
