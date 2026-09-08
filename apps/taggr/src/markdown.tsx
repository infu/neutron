// React rendering for Taggr post bodies.
//
// A tile frame is sandboxed `allow-scripts allow-same-origin` with no
// `allow-popups`, so a real `<a href>` would either do nothing or navigate the
// tile away from the app. External links are therefore rendered as marked text
// carrying the destination in a tooltip, which is honest about what a click can
// and cannot do here. Taggr's own `@handle` and `#tag` become in-app navigation
// instead.
//
// Only React elements are produced — no HTML string ever reaches the DOM.

import { Fragment, type ReactNode } from "react";
import { parseBlocks, parseInline } from "./markdown_source.ts";

export type MarkdownActions = {
  onUser?: (handle: string) => void;
  onTag?: (tag: string) => void;
  /**
   * Turns a Markdown image source into something an `<img>` can load. Taggr
   * writes `/blob/<id>` for its own attachments, which only the post that owns
   * them can resolve; returning null renders a placeholder instead of a broken
   * image.
   */
  resolveImage?: (src: string) => string | null;
};

export {
  parseBlocks,
  parseInline,
  toPlainText,
  type Block,
  type InlineToken,
} from "./markdown_source.ts";

const renderInline = (
  text: string,
  actions: MarkdownActions | undefined,
  keyPrefix: string,
): ReactNode[] =>
  parseInline(text).map((token, index) => {
    const key = `${keyPrefix}-i${index}`;
    switch (token.kind) {
      case "code":
        return (
          <code className="nt-code" key={key}>
            {token.value}
          </code>
        );
      case "image": {
        const resolved = actions?.resolveImage
          ? actions.resolveImage(token.src)
          : token.src;
        if (resolved === null) {
          return (
            <span className="nt-tag taggr-missing-image" key={key} title={token.src}>
              {token.alt.trim().length > 0 ? token.alt : "image unavailable"}
            </span>
          );
        }
        return (
          <img
            alt={token.alt}
            className="taggr-image"
            key={key}
            loading="lazy"
            referrerPolicy="no-referrer"
            src={resolved}
            title={token.alt || undefined}
          />
        );
      }
      case "link":
        return (
          <span className="taggr-link" key={key} title={token.href}>
            {token.label.length > 0 ? token.label : token.href}
          </span>
        );
      case "strong":
        return <strong key={key}>{renderInline(token.value, actions, key)}</strong>;
      case "strike":
        return <s key={key}>{renderInline(token.value, actions, key)}</s>;
      case "emphasis":
        return <em key={key}>{renderInline(token.value, actions, key)}</em>;
      case "user": {
        const handler = actions?.onUser;
        if (!handler) return `@${token.handle}`;
        return (
          <button
            className="taggr-token"
            key={key}
            onClick={() => handler(token.handle)}
            title={`Open @${token.handle}`}
            type="button"
          >
            @{token.handle}
          </button>
        );
      }
      case "tag": {
        const handler = actions?.onTag;
        if (!handler) return `${token.sigil}${token.tag}`;
        return (
          <button
            className="taggr-token"
            key={key}
            onClick={() => handler(token.tag)}
            title={`Posts tagged ${token.sigil}${token.tag}`}
            type="button"
          >
            {token.sigil}
            {token.tag}
          </button>
        );
      }
      case "text":
      default:
        return token.value;
    }
  });

const joinLines = (lines: string[]): string => lines.join("\n");

/** Renders one block's inline content, keeping single newlines as line breaks. */
const InlineText = ({
  text,
  actions,
  keyPrefix,
}: {
  text: string;
  actions: MarkdownActions | undefined;
  keyPrefix: string;
}) => (
  <>
    {text.split("\n").map((line, index, all) => (
      <Fragment key={`${keyPrefix}-l${index}`}>
        {renderInline(line, actions, `${keyPrefix}-l${index}`)}
        {index < all.length - 1 ? <br /> : null}
      </Fragment>
    ))}
  </>
);

export const Markdown = ({
  text,
  actions,
}: {
  text: string;
  actions?: MarkdownActions;
}) => {
  const blocks = parseBlocks(text);
  return (
    <div className="taggr-markdown">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case "code":
            return (
              <pre className="nt-pre taggr-code" key={key}>
                <code>{joinLines(block.lines)}</code>
              </pre>
            );
          case "heading": {
            // Post headings are content, not document structure: render them at
            // a fixed level so a post cannot outrank the tile's own headings.
            return (
              <p className={`taggr-heading taggr-heading--${Math.min(block.level, 3)}`} key={key}>
                <InlineText actions={actions} keyPrefix={key} text={block.text} />
              </p>
            );
          }
          case "quote":
            return (
              <blockquote className="taggr-quote" key={key}>
                <InlineText actions={actions} keyPrefix={key} text={joinLines(block.lines)} />
              </blockquote>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag className="taggr-list" key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-i${itemIndex}`}>
                    <InlineText
                      actions={actions}
                      keyPrefix={`${key}-i${itemIndex}`}
                      text={item}
                    />
                  </li>
                ))}
              </Tag>
            );
          }
          case "rule":
            return <hr className="nt-divider" key={key} />;
          case "paragraph":
          default:
            return (
              <p className="taggr-paragraph" key={key}>
                <InlineText actions={actions} keyPrefix={key} text={joinLines(block.lines)} />
              </p>
            );
        }
      })}
    </div>
  );
};
