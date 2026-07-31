import {
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  IoCheckmarkCircleOutline,
  IoChevronDown,
  IoCloseOutline,
  IoInformationCircleOutline,
  IoPaperPlaneOutline,
  IoPulseOutline,
  IoWarningOutline,
} from "react-icons/io5";
import type {
  FeedItem,
  PublishResult,
  PublishStage,
  SendQuote,
  WagyuProfile,
  WagyuService,
} from "../model.ts";
import {
  markdownByteLength,
  publishStageIsDurableHandoff,
  publishStageRequiresOpenTile,
  quoteRows,
  shortenNodeId,
} from "../presentation.ts";
import { Avatar } from "./Avatar.tsx";
import { useDialogFocus } from "./dialog_focus.ts";

const MAX_MARKDOWN_BYTES = 8 * 1_024;

export function Composer({
  profile,
  service,
  disabled,
  disabledReason,
  markdown,
  onMarkdownChange,
  onPublished,
  onClose,
  replyTarget,
  onClearReply,
  variant = "dialog",
}: {
  profile: WagyuProfile;
  service: WagyuService;
  disabled: boolean;
  disabledReason?: string;
  markdown: string;
  onMarkdownChange: (markdown: string) => void;
  onPublished: (replyTarget: FeedItem | null) => void;
  onClose: () => void;
  replyTarget: FeedItem | null;
  onClearReply: () => void;
  variant?: "dialog" | "inline";
}) {
  const fieldId = useId();
  const dialog = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [restoredDraft, setRestoredDraft] = useState(markdown.length > 0);
  const [quote, setQuote] = useState<SendQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [stage, setStage] = useState<PublishStage>("draft");
  const [result, setResult] = useState<PublishResult | null>(null);
  const [authorNoticeExpected, setAuthorNoticeExpected] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const quoteRequest = useRef(0);
  const byteLength = markdownByteLength(markdown);
  const withinBounds = byteLength > 0 && byteLength <= MAX_MARKDOWN_BYTES;
  const publishing = publishStageRequiresOpenTile(stage);

  useEffect(() => {
    const request = ++quoteRequest.current;
    if (disabled || !withinBounds || publishing) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void service
        .getSendQuote(byteLength, replyTarget?.author.nodeId)
        .then((next) => {
          if (request !== quoteRequest.current) return;
          setQuote(next);
          setQuoteError(null);
        })
        .catch((reason: unknown) => {
          if (request !== quoteRequest.current) return;
          setQuote(null);
          setQuoteError(errorMessage(reason));
        });
    }, 240);
    return () => window.clearTimeout(timer);
  }, [
    byteLength,
    disabled,
    publishing,
    replyTarget,
    service,
    withinBounds,
  ]);

  const close = () => {
    if (publishing) return;
    onClose();
  };
  useDialogFocus(dialog, textarea, close);

  const returnToDraft = () => {
    if (publishing) return;
    setStage("draft");
    setResult(null);
    setAuthorNoticeExpected(false);
    setPublishError(null);
  };

  const publish = async () => {
    if (disabled || !withinBounds || !quote || publishing) return;
    setResult(null);
    setAuthorNoticeExpected(quote.authorNoticeFloorCycles > 0n);
    setPublishError(null);
    try {
      const next = await service.publishPost(markdown, setStage, replyTarget);
      if (publishStageIsDurableHandoff(next.stage)) {
        const publishedReplyTarget = replyTarget;
        onMarkdownChange("");
        onClearReply();
        if (variant === "inline") {
          setStage("draft");
          setResult(null);
          setAuthorNoticeExpected(false);
        }
        onClose();
        onPublished(publishedReplyTarget);
        return;
      }
      setStage(next.stage);
      setResult(next);
    } catch (reason) {
      setStage("failed");
      setPublishError(errorMessage(reason));
    }
  };

  if (variant === "inline") {
    return (
      <section
        aria-label="Reply to post"
        className="wg-inline-reply"
      >
        <div className="wg-inline-reply__heading">
          <Avatar
            imageUrl={profile.avatarUrl}
            nodeId={profile.nodeId}
            size="sm"
          />
          <label htmlFor={fieldId}>Reply to</label>
        </div>
        <textarea
          className="nt-textarea wg-inline-reply__textarea"
          disabled={disabled || publishing}
          id={fieldId}
          maxLength={MAX_MARKDOWN_BYTES}
          onChange={(event) => {
            onMarkdownChange(event.target.value);
            setRestoredDraft(false);
            setResult(null);
            setStage("draft");
            setPublishError(null);
          }}
          placeholder="Type your reply…"
          rows={3}
          value={markdown}
        />
        {disabled ? (
          <div className="nt-alert nt-alert--warning" role="status">
            {disabledReason ?? "Replying is currently unavailable."}
          </div>
        ) : publishError || quoteError ? (
          <div className="nt-alert nt-alert--warning" role="status">
            Wagyu couldn't send this reply. Try again.
          </div>
        ) : null}
        <footer className="wg-inline-reply__footer">
          <span className={byteLength > MAX_MARKDOWN_BYTES ? "is-danger" : ""}>
            {byteLength.toLocaleString()} /{" "}
            {MAX_MARKDOWN_BYTES.toLocaleString()} bytes
          </span>
          <button
            className="nt-button wg-primary-button"
            disabled={disabled || !withinBounds || !quote || publishing}
            onClick={() => void publish()}
            title={disabled ? disabledReason : undefined}
            type="button"
          >
            <IoPaperPlaneOutline aria-hidden="true" />
            {publishing ? "Replying…" : "Reply"}
          </button>
        </footer>
      </section>
    );
  }

  return (
    <div
      className="wg-composer-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) close();
      }}
    >
      <section
        aria-labelledby="composer-title"
        aria-modal="true"
        className="wg-composer"
        ref={dialog}
        role="dialog"
        tabIndex={-1}
      >
        <header className="wg-composer__header">
          <Avatar
            imageUrl={profile.avatarUrl}
            nodeId={profile.nodeId}
            size="md"
          />
          <h2 id="composer-title">
            {replyTarget ? "Reply" : "Create post"}
          </h2>
          <button
            aria-label={
              markdown.length > 0 || replyTarget
                ? "Keep draft for later and close composer"
                : "Close composer"
            }
            className="wg-icon-button"
            disabled={publishing}
            onClick={close}
            type="button"
          >
            <IoCloseOutline aria-hidden="true" />
          </button>
        </header>

        {disabled ? (
          <div className="nt-alert nt-alert--warning" role="status">
            <IoWarningOutline aria-hidden="true" />
            <span>{disabledReason ?? "Posting is currently unavailable."}</span>
          </div>
        ) : null}

        {restoredDraft ? (
          <div
            aria-live="polite"
            className="wg-composer__hint"
            role="status"
          >
            <IoInformationCircleOutline aria-hidden="true" />
            <span>
              Restored your in-memory {replyTarget ? "reply" : "post"} draft.
              It stays only while Wagyu remains open.
            </span>
          </div>
        ) : null}

        {replyTarget ? (
          <div className="wg-composer__reply-target">
            <IoInformationCircleOutline aria-hidden="true" />
            <span>
              Replying to{" "}
              <strong>
                {replyTarget.author.displayName ??
                  shortenNodeId(replyTarget.author.nodeId)}
              </strong>
            </span>
            <button
              aria-label="Cancel reply target"
              disabled={disabled || publishing}
              onClick={onClearReply}
              type="button"
            >
              <IoCloseOutline aria-hidden="true" />
            </button>
          </div>
        ) : null}

        <label className="nt-sr-only" htmlFor={fieldId}>
          {replyTarget ? "Reply" : "Post"}
        </label>
        <textarea
          className="nt-textarea wg-composer__textarea"
          disabled={disabled || publishing}
          id={fieldId}
          maxLength={MAX_MARKDOWN_BYTES}
          onChange={(event) => {
            onMarkdownChange(event.target.value);
            setRestoredDraft(false);
            setResult(null);
            setStage("draft");
          }}
          placeholder="What's happening?"
          ref={textarea}
          rows={6}
          value={markdown}
        />
        <div className="wg-composer__meta">
          <span className={byteLength > MAX_MARKDOWN_BYTES ? "is-danger" : ""}>
            {byteLength.toLocaleString()} / {MAX_MARKDOWN_BYTES.toLocaleString()} bytes
          </span>
        </div>

        {publishing || result || publishError ? (
          <>
            <PublishProgress
              authorNoticeExpected={authorNoticeExpected}
              error={publishError}
              result={result}
              stage={stage}
            />
            {!publishing ? (
              <div className="wg-composer__actions">
                {publishError ? (
                  <button
                    className="nt-button wg-primary-button"
                    onClick={returnToDraft}
                    type="button"
                  >
                    Return to draft
                  </button>
                ) : (
                  <button
                    className="nt-button nt-button--ghost"
                    onClick={close}
                    type="button"
                  >
                    Done
                  </button>
                )}
              </div>
            ) : null}
          </>
        ) : (
          <>
            {quoteError ? (
              <div className="nt-alert nt-alert--warning" role="status">
                <span>Wagyu couldn't prepare this post. Try again.</span>
              </div>
            ) : null}
            <div className="wg-composer__actions">
              <button
                className="nt-button nt-button--ghost"
                onClick={close}
                type="button"
              >
                {markdown.length > 0 || replyTarget
                  ? "Keep draft for later"
                  : "Close composer"}
              </button>
              <button
                className="nt-button wg-primary-button"
                disabled={disabled || !withinBounds || !quote}
                onClick={() => void publish()}
                title={disabled ? disabledReason : undefined}
                type="button"
              >
                <IoPaperPlaneOutline aria-hidden="true" />
                Send
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export function SendQuotePanel({
  quote,
  loading,
  error,
}: {
  quote: SendQuote | null;
  loading: boolean;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="nt-alert nt-alert--warning" role="status">
        <strong>Send estimate unavailable</strong>
        <span>{error}</span>
      </div>
    );
  }
  if (!quote) {
    return loading ? (
      <div className="wg-quote wg-quote--loading" aria-live="polite">
        <IoPulseOutline aria-hidden="true" />
        <span>Reading your local follower ledger…</span>
      </div>
    ) : (
      <div className="wg-composer__hint">
        <IoInformationCircleOutline aria-hidden="true" />
        <span>Write a post to calculate its receiver floors and publication cost.</span>
      </div>
    );
  }
  return (
    <div className="wg-quote">
      <div className="wg-quote__heading">
        <div>
          <span>Send estimate</span>
          <small>Local ledger revision {quote.followerRevision}</small>
        </div>
        <span className="nt-badge nt-badge--success">
          {quote.eligibleRecipients} eligible
        </span>
      </div>
      <dl className="wg-quote__grid">
        {quoteRows(quote).map((row) => (
          <div className={row.emphasis ? "is-total" : ""} key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {quote.recipientPreview && quote.recipientPreview.length > 0 ? (
        <div className="wg-quote__recipients">
          <span>Currently eligible · authoritative backend preview (max 8)</span>
          <div>
            {quote.recipientPreview.map((nodeId) => (
              <code key={nodeId} title={nodeId}>
                {shortenNodeId(nodeId)}
              </code>
            ))}
            {quote.eligibleRecipients > quote.recipientPreview.length ? (
              <small>
                +{quote.eligibleRecipients - quote.recipientPreview.length} not
                shown
              </small>
            ) : null}
          </div>
        </div>
      ) : null}
      {quote.ineligibleFollowers > 0 || quote.limitWarning ? (
        <div className="wg-quote__warning">
          <IoWarningOutline aria-hidden="true" />
          <span>
            {quote.limitWarning ??
              `${quote.ineligibleFollowers} follower rows are not currently eligible.`}
          </span>
        </div>
      ) : null}
      <p className="wg-quote__disclosure">
        Counts, preview IDs, and preview order come from the backend's
        authoritative follower ledger. Every eligible follower at commit is
        queued, but this estimate is not a reservation; local certification can
        succeed when remote delivery fails.
      </p>
    </div>
  );
}

export function PublishProgress({
  stage,
  result,
  error,
  authorNoticeExpected = false,
}: {
  stage: PublishStage;
  result: PublishResult | null;
  error: string | null;
  authorNoticeExpected?: boolean;
}) {
  const failed = Boolean(error) || stage === "failed";
  const uncertain = stage === "uncertain";
  const sent = publishStageIsDurableHandoff(stage);
  const finishingInBackground =
    stage === "partial" ||
    Boolean(
      result &&
        (result.failedRecipients > 0 ||
          (authorNoticeExpected && result.queuedNotices === 0)),
    );
  const title = failed
    ? "Post couldn't be sent"
    : uncertain
      ? "Still sending…"
      : sent
        ? "Sent"
        : "Sending…";
  const detail = failed
    ? "Please return to your draft and try again."
    : uncertain
      ? "Wagyu is checking the result."
      : finishingInBackground
        ? "Some people may see it a little later."
        : sent
          ? "Your post is live."
          : "This usually takes a few seconds.";
  return (
    <div className="wg-publish" aria-live="polite">
      <div className="wg-publish__title">
        {failed ? (
          <IoWarningOutline aria-hidden="true" />
        ) : sent ? (
          <IoCheckmarkCircleOutline aria-hidden="true" />
        ) : (
          <IoPulseOutline aria-hidden="true" />
        )}
        <div>
          <strong>{title}</strong>
          <span>{detail}</span>
        </div>
      </div>
    </div>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
