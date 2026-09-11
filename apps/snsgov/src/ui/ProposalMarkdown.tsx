import { useId, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];
const elements = ["p", "br", "hr", "em", "strong", "del", "blockquote", "ul", "ol", "li", "a", "img", "code", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td", "input", "section", "sup"];

// Proposal text is untrusted. Render syntax to React nodes, never executable
// HTML. Relative links cannot navigate the app's sandbox to arbitrary pages.
function markdownUrl(value: string, key: string): string | undefined {
  if (key === "href" && value.startsWith("#")) return value;
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) || (key === "href" && url.protocol === "mailto:")) return url.href;
  } catch { /* Invalid and relative URLs remain readable text. */ }
  return undefined;
}

export function ProposalMarkdown({ text, collapsed = false }: { text: string; collapsed?: boolean }) {
  const id = useId().replace(/:/g, "");
  const footnoteLabel = `sns-${id}-footnote-label`;
  const heading: Components["h4"] = ({ children, id }) => <h4 id={id === "footnote-label" ? footnoteLabel : id}>{children}</h4>;
  const components: Components = {
    h1: heading, h2: heading, h3: heading, h4: heading, h5: heading, h6: heading,
    a: ({ children, href, id, ...props }) => href
      ? <a href={href} id={id} tabIndex={collapsed ? -1 : undefined} {...(href.startsWith("#") ? {} : { target: "_blank", rel: "noopener noreferrer" })} aria-describedby={props["aria-describedby"] === "footnote-label" ? footnoteLabel : props["aria-describedby"]}>{children}</a>
      : <span>{children}</span>,
    img: ({ src, alt, title }) => src ? <img src={src} alt={alt ?? ""} title={title} loading="lazy" referrerPolicy="no-referrer" /> : <span>{alt}</span>,
    input: ({ checked }) => <input type="checkbox" checked={!!checked} disabled readOnly tabIndex={-1} />,
    table: ({ children }) => <div className="snsgov-markdown-table"><table>{children}</table></div>,
  };
  return <div className="snsgov-markdown"><ReactMarkdown remarkPlugins={plugins} skipHtml allowedElements={elements} urlTransform={markdownUrl} components={components} remarkRehypeOptions={{ clobberPrefix: `sns-${id}-` }}>{text}</ReactMarkdown></div>;
}

export function ProposalExcerpt({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [text, expanded]);
  return <>
    <div ref={container} id={id} className={`snsgov-proposal-body${expanded ? "" : " snsgov-post-excerpt"}${overflows && !expanded ? " snsgov-post-excerpt--clipped" : ""}`}><ProposalMarkdown text={text} collapsed={overflows && !expanded} /></div>
    {(overflows || expanded) && <button type="button" className="nt-button nt-button--ghost snsgov-show-more" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>{expanded ? "Show less" : "Show more"}</button>}
  </>;
}
