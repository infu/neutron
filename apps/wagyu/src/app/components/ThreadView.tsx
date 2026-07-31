import {
  type ReactNode,
  useEffect,
  useRef,
} from "react";
import { IoArrowBackOutline } from "react-icons/io5";
import type { FeedItem } from "../model.ts";

export type ThreadReplyNode = {
  item: FeedItem;
  depth: number;
};

export function ThreadView({
  ancestors = [],
  item,
  onBack,
  replyComposer,
  replies = [],
  renderPost,
}: {
  ancestors?: readonly FeedItem[];
  item: FeedItem;
  onBack: () => void;
  replyComposer?: ReactNode;
  replies?: readonly ThreadReplyNode[];
  renderPost: (item: FeedItem, nestedUnderParent: boolean) => ReactNode;
}) {
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backButton.current?.focus();
  }, []);

  return (
    <section aria-labelledby="wg-thread-title" className="wg-thread-page">
      <header>
        <button
          className="wg-thread-page__back"
          onClick={onBack}
          ref={backButton}
          type="button"
        >
          <IoArrowBackOutline aria-hidden="true" />
          Back
        </button>
        <h1 id="wg-thread-title">Post</h1>
      </header>
      <div className="wg-thread">
        <div className="wg-thread__chain">
          {ancestors.map((ancestor, index) => (
            <div
              className={
                index === 0
                  ? "wg-thread__parent"
                  : "wg-thread__ancestor"
              }
              key={ancestor.id}
            >
              {renderPost(ancestor, index > 0)}
            </div>
          ))}
          <div
            className={
              ancestors.length === 0
                ? "wg-thread__parent wg-thread__target"
                : "wg-thread__selected wg-thread__target"
            }
          >
            {renderPost(item, ancestors.length > 0)}
          </div>
        </div>
        {replyComposer ? (
          <div className="wg-thread__composer">{replyComposer}</div>
        ) : null}
        <div className="wg-thread__replies">
          {replies.map((reply) => (
            <div
              className="wg-thread__reply"
              data-depth={reply.depth}
              key={reply.item.id}
            >
              {renderPost(reply.item, true)}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
