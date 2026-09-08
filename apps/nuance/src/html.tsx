// Allowlist renderer for Nuance article bodies.
//
// Article HTML is third-party content stored by other people's posts, and the
// tile runs on this installation's own origin. Nothing here uses
// `dangerouslySetInnerHTML`: the markup is parsed inert with `DOMParser`, walked,
// and re-emitted as React elements from a closed tag and attribute allowlist.
// Anything not on the list is dropped while keeping its text, so an unknown or
// hostile element degrades to plain prose rather than disappearing or executing.
//
// Two deliberate restrictions on top of sanitising:
//
//   * Links do not navigate. The tile sandbox is `allow-scripts
//     allow-same-origin` with no `allow-popups`, so `target="_blank"` and
//     `window.open` are inert anyway. A link renders as its text plus a copy
//     button, which is an honest affordance instead of a dead one.
//
//   * Images load only from the IC gateway hosts Nuance itself stores media on.
//     A third-party `<img>` would otherwise report every reader's IP to an
//     arbitrary host on open; those render as a captioned placeholder instead.
//     Nuance stores its own media on one asset canister served from `.icp0.io`,
//     so in practice every real article image loads -- covers included.

import { Fragment, useMemo, useState, type ReactNode } from "react";

export const ALLOWED_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr",
  "ul", "ol", "li",
  "blockquote", "pre", "code",
  "strong", "b", "em", "i", "u", "s",
  "a", "img",
  "div", "span",
]);

const HEADING_LEVEL: Record<string, "h2" | "h3"> = {
  h1: "h2",
  h2: "h2",
  h3: "h3",
  h4: "h3",
  h5: "h3",
  h6: "h3",
};

/// Hosts whose images are loaded directly. Nuance stores article media on its
/// own asset canisters, which are served from the IC gateway.
const IMAGE_HOST_SUFFIXES = [".icp0.io", ".ic0.app", ".icp-api.io"];

/// Exported for unit tests: this is the attribute filter that decides whether a
/// third-party href or image source is allowed anywhere near the DOM.
export function safeHref(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, "https://nuance.xyz");
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function loadableImage(value: string | null): string | null {
  const href = safeHref(value);
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    return IMAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
      ? href
      : null;
  } catch {
    return null;
  }
}

/// A whole image from an article -- a cover or a feed thumbnail -- under the same
/// host policy as one inside the body.
///
/// Unlike a body `<img>`, there is no surrounding prose to preserve, so a source
/// that fails the policy renders nothing rather than a placeholder. The same
/// applies once the request itself fails: an IC asset canister can return 404 for
/// media an author has since deleted, and a broken-image glyph is worse than no
/// image at all. Callers that need the layout slot to survive that should size a
/// wrapper rather than this element.
export function ArticleImage({
  src,
  alt = "",
  className,
}: {
  src: string;
  alt?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const href = loadableImage(src);
  if (!href || failed) return null;
  return (
    <img
      alt={alt}
      className={className}
      decoding="async"
      loading="lazy"
      onError={() => setFailed(true)}
      src={href}
    />
  );
}

export type RenderOptions = {
  onCopyLink: (href: string) => void;
};

function renderChildren(
  node: Node,
  options: RenderOptions,
  depth: number,
): ReactNode[] {
  const out: ReactNode[] = [];
  node.childNodes.forEach((child, index) => {
    const rendered = renderNode(child, options, depth + 1, index);
    if (rendered !== null) out.push(rendered);
  });
  return out;
}

function renderNode(
  node: Node,
  options: RenderOptions,
  depth: number,
  key: number,
): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  // Guard against a pathologically nested document rather than recursing until
  // the stack gives out.
  if (depth > 40) return node.textContent ?? "";

  const element = node as Element;
  const tag = element.tagName.toLowerCase();

  if (tag === "script" || tag === "style" || tag === "iframe" || tag === "object") {
    return null;
  }

  if (!ALLOWED_TAGS.has(tag)) {
    // Unknown element: keep the words, drop the wrapper.
    return <Fragment key={key}>{renderChildren(element, options, depth)}</Fragment>;
  }

  const children = renderChildren(element, options, depth);

  switch (tag) {
    case "br":
      return <br key={key} />;
    case "hr":
      return <hr key={key} className="nuance-rule" />;
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      // Article headings are demoted so the tile's own <h1> stays the document
      // title; anything deeper than h3 collapses to h3.
      const Heading = HEADING_LEVEL[tag] ?? "h3";
      return (
        <Heading key={key} className="nuance-heading">
          {children}
        </Heading>
      );
    }
    case "p":
    case "div":
      return <p key={key} className="nt-text nuance-para">{children}</p>;
    case "ul":
      return <ul key={key} className="nuance-list">{children}</ul>;
    case "ol":
      return <ol key={key} className="nuance-list">{children}</ol>;
    case "li":
      return <li key={key}>{children}</li>;
    case "blockquote":
      return <blockquote key={key} className="nuance-quote">{children}</blockquote>;
    case "pre":
      return <pre key={key} className="nt-pre nt-pre--wrap">{children}</pre>;
    case "code":
      return <code key={key} className="nt-code">{children}</code>;
    case "strong":
    case "b":
      return <strong key={key}>{children}</strong>;
    case "em":
    case "i":
      return <em key={key}>{children}</em>;
    case "u":
      return <u key={key}>{children}</u>;
    case "s":
      return <s key={key}>{children}</s>;
    case "span":
      return <Fragment key={key}>{children}</Fragment>;
    case "img": {
      const raw = element.getAttribute("src");
      const alt = element.getAttribute("alt") ?? "";
      if (raw && loadableImage(raw)) {
        // Shared with covers and thumbnails, so a body image that 404s also
        // disappears instead of leaving a broken-image glyph mid-paragraph.
        return <ArticleImage key={key} src={raw} alt={alt} className="nuance-image" />;
      }
      const external = safeHref(raw);
      return (
        <span key={key} className="nuance-image-blocked">
          {alt || "Image"} — not loaded from an external host
          {external ? (
            <button
              aria-label="Copy image address"
              className="nt-icon-button nuance-inline-button"
              onClick={() => options.onCopyLink(external)}
              title="Copy image address"
              type="button"
            >
              ⧉
            </button>
          ) : null}
        </span>
      );
    }
    case "a": {
      const href = safeHref(element.getAttribute("href"));
      if (!href) return <Fragment key={key}>{children}</Fragment>;
      return (
        <span key={key} className="nuance-link">
          {children}
          <button
            aria-label="Copy link address"
            className="nt-icon-button nuance-inline-button"
            onClick={() => options.onCopyLink(href)}
            title="Copy link address"
            type="button"
          >
            ⧉
          </button>
        </span>
      );
    }
    default:
      return <Fragment key={key}>{children}</Fragment>;
  }
}

/// Parse and render stored article markup. Returns `null` for empty input so the
/// caller can show its own empty state.
export function ArticleBody({
  html,
  onCopyLink,
}: {
  html: string;
  onCopyLink: (href: string) => void;
}) {
  const content = useMemo(() => {
    if (!html.trim()) return null;
    const doc = new DOMParser().parseFromString(html, "text/html");
    return renderChildren(doc.body, { onCopyLink }, 0);
  }, [html, onCopyLink]);

  if (content === null) return null;
  return <div className="nuance-body">{content}</div>;
}

/// Plain-text projection, used for previews and character counts in the tile.
/// The backend has its own Motoko implementation for agent output; this one is
/// for display only.
export function htmlToPlainText(html: string): string {
  if (!html.trim()) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}
