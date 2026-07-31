import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  IoAddOutline,
  IoBanOutline,
  IoCheckmarkCircleOutline,
  IoHourglassOutline,
  IoPeopleOutline,
  IoShieldOutline,
  IoWarningOutline,
} from "react-icons/io5";
import { Principal } from "@dfinity/principal";
import type {
  FeedAuthor,
  Relationship,
  RelationshipBusy,
  RelationshipState,
} from "../model.ts";
import {
  profileMayRenderRemoteText,
} from "../presentation.ts";
import { NodeIdentity } from "./Avatar.tsx";

const NO_HYDRATING_PROFILES: ReadonlySet<string> = new Set();

export function RelationshipsView({
  relationships,
  ownNodeId,
  busy,
  refreshing = false,
  error,
  onFollow,
  onUnfollow,
  onSetBlocked,
  hasMore,
  loadingMore,
  onLoadMore,
  onOpenUser,
  onProfileVisible,
  peerDeliveryEnabled = true,
  hydratingProfileIds = NO_HYDRATING_PROFILES,
}: {
  relationships: Relationship[];
  ownNodeId?: string;
  busy: RelationshipBusy | null;
  refreshing?: boolean;
  error: string | null;
  onFollow: (nodeId: string) => Promise<void>;
  onUnfollow: (nodeId: string) => Promise<void>;
  onSetBlocked: (nodeId: string, blocked: boolean) => Promise<void>;
  onRefresh?: () => Promise<void>;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpenUser?: ((author: FeedAuthor) => void) | undefined;
  onProfileVisible?: ((relationship: Relationship) => void) | undefined;
  peerDeliveryEnabled?: boolean;
  hydratingProfileIds?: ReadonlySet<string>;
}) {
  const [nodeId, setNodeId] = useState("");
  const [filter, setFilter] = useState<"all" | "following" | "followers" | "blocked">("all");
  const [confirmUnfollow, setConfirmUnfollow] = useState<string | null>(null);
  const confirmUnfollowButton = useRef<HTMLButtonElement | null>(null);
  const unfollowTriggers = useRef(new Map<string, HTMLButtonElement>());
  const restoreUnfollowFocus = useRef<string | null>(null);

  useEffect(() => {
    if (confirmUnfollow) {
      confirmUnfollowButton.current?.focus();
      return;
    }
    const node = restoreUnfollowFocus.current;
    restoreUnfollowFocus.current = null;
    if (node) unfollowTriggers.current.get(node)?.focus();
  }, [confirmUnfollow]);

  const knownRelationship = relationships.find(
    (relationship) => relationship.nodeId === nodeId,
  );
  const peerDeliveryReason =
    "Enable peer delivery before following a user.";
  const nodeError =
    validateNodeId(nodeId, ownNodeId) ??
    (!peerDeliveryEnabled && nodeId
      ? peerDeliveryReason
      : knownRelationship?.blocked
        ? "Unblock this user before following them."
        : knownRelationship && !knownRelationship.compatible
          ? "This user cannot connect to this version of Wagyu."
          : null);
  const controlsBusy = busy !== null || refreshing || loadingMore;
  const settle = (
    action: () => Promise<void>,
    onSuccess?: () => void,
  ) => {
    void Promise.resolve()
      .then(action)
      .then(onSuccess)
      // App owns the scoped error state. This terminal catch prevents rejected
      // row actions from becoming unhandled browser promises.
      .catch(() => undefined);
  };
  const submitFollow = () => {
    if (!nodeId || nodeError || controlsBusy) return;
    settle(() => onFollow(nodeId), () => setNodeId(""));
  };
  const filtered = useMemo(
    () =>
      relationships.filter((relationship) => {
        if (filter === "following") return relationship.youFollow;
        if (filter === "followers") return relationship.followsYou;
        if (filter === "blocked") return relationship.blocked;
        return true;
      }),
    [filter, relationships],
  );
  const relationshipList = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!onProfileVisible || filtered.length === 0) return;
    const list = relationshipList.current;
    if (!list || typeof IntersectionObserver === "undefined") {
      for (const relationship of filtered.slice(0, 6)) {
        onProfileVisible(relationship);
      }
      return;
    }
    const byNode = new Map(
      filtered.map((relationship) => [relationship.nodeId, relationship]),
    );
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const nodeId = (entry.target as HTMLElement).dataset.profileNode;
          const relationship = nodeId ? byNode.get(nodeId) : undefined;
          if (relationship) onProfileVisible(relationship);
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "160px 0px" },
    );
    for (
      const row of list.querySelectorAll<HTMLElement>("[data-profile-node]")
    ) {
      observer.observe(row);
    }
    return () => observer.disconnect();
  }, [filtered, onProfileVisible]);

  return (
    <div
      aria-busy={controlsBusy}
      className="wg-relationships"
    >
      <header className="wg-view-heading">
        <div>
          <h1>People</h1>
        </div>
      </header>
      <section className="wg-follow-box" aria-labelledby="follow-user-title">
        <div className="wg-follow-box__icon" aria-hidden="true"><IoAddOutline /></div>
        <div className="wg-follow-box__copy">
          <h2 id="follow-user-title">Follow user</h2>
          <p>
            Enter the exact user id. Registration attaches a 0.007000 TC bond
            and prepays 32 delivery credits.
          </p>
        </div>
        <div className="wg-follow-box__form">
          <label className="nt-sr-only" htmlFor="wagyu-follow-node">User id</label>
          <input
            aria-invalid={Boolean(nodeId && nodeError)}
            className="nt-input"
            id="wagyu-follow-node"
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              submitFollow();
            }}
            onChange={(event) => setNodeId(event.target.value.trim())}
            placeholder="aaaaa-aa"
            spellCheck={false}
            value={nodeId}
          />
          <button
            className="nt-button wg-primary-button"
            disabled={
              !peerDeliveryEnabled ||
              !nodeId ||
              Boolean(nodeError) ||
              controlsBusy
            }
            onClick={submitFollow}
            title={!peerDeliveryEnabled ? peerDeliveryReason : undefined}
            type="button"
          >
            {busy?.nodeId === nodeId && busy.action === "follow"
              ? "Registering…"
              : "Follow user"}
          </button>
        </div>
        {nodeId && nodeError ? <p className="nt-error">{nodeError}</p> : null}
      </section>
      {error ? <div className="nt-alert nt-alert--danger" role="alert">{error}</div> : null}

      <div className="wg-relationship-summary">
        <div><strong>{relationships.filter((item) => item.youFollow).length}</strong><span>Following (loaded)</span></div>
        <div><strong>{relationships.filter((item) => item.followsYou).length}</strong><span>Followers (loaded)</span></div>
        <div><strong>{relationships.filter((item) => item.blocked).length}</strong><span>Blocked (loaded)</span></div>
      </div>
      <div
        className="wg-filter-bar"
        role="group"
        aria-label="Filter loaded relationships"
      >
        {(["all", "following", "followers", "blocked"] as const).map((value) => (
          <button
            aria-pressed={filter === value}
            className={filter === value ? "is-active" : ""}
            key={value}
            onClick={() => setFilter(value)}
            type="button"
          >
            {value === "all" ? "All" : value[0]!.toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      <div className="wg-relationship-list" ref={relationshipList}>
        {filtered.map((relationship) => (
          <article
            aria-busy={hydratingProfileIds.has(relationship.nodeId)}
            className="wg-relationship"
            data-profile-node={relationship.nodeId}
            key={relationship.nodeId}
          >
            <NodeIdentity
              avatarUrl={
                profileMayRenderRemoteText(relationship.profileProof)
                  ? relationship.avatarUrl
                  : null
              }
              displayName={
                profileMayRenderRemoteText(relationship.profileProof)
                  ? relationship.displayName
                  : null
              }
              nodeId={relationship.nodeId}
              onOpenProfile={onOpenUser
                ? () =>
                  onOpenUser({
                    nodeId: relationship.nodeId,
                    displayName: relationship.displayName,
                    avatarUrl: relationship.avatarUrl,
                    profileProof: relationship.profileProof,
                  })
                : undefined}
              secondary={
                <span>
                  {hydratingProfileIds.has(relationship.nodeId)
                    ? "Loading profile…"
                    : relationship.profileProof === "unavailable"
                      ? "Profile unavailable"
                      : "user id"}
                </span>
              }
            />
            <div className="wg-direction">
              {relationship.youFollow ? <span className="is-outgoing">You follow</span> : <span>Not followed</span>}
              {relationship.followsYou ? <span className="is-incoming">Follows you</span> : <span>Does not follow you</span>}
            </div>
            <div className="wg-relationship-state-stack">
              {relationship.youFollow && relationship.followingState ? (
                <RelationshipStateBadge
                  direction="Following"
                  state={relationship.followingState}
                />
              ) : null}
              {relationship.followsYou && relationship.followerState ? (
                <RelationshipStateBadge
                  direction="Follower"
                  state={relationship.followerState}
                />
              ) : null}
              {relationship.blocked &&
              !relationship.followingState &&
              !relationship.followerState ? (
                <RelationshipStateBadge direction="User" state="blocked" />
              ) : null}
              {relationship.followingState &&
              relationship.followingState !== "active" ? (
                <small>
                  {relationshipStateDetail(
                    relationship.followingState,
                    "following",
                  )}
                </small>
              ) : null}
              {relationship.followerState &&
              relationship.followerState !== "active" ? (
                <small>
                  {relationshipStateDetail(
                    relationship.followerState,
                    "follower",
                  )}
                </small>
              ) : null}
            </div>
            <div className="wg-relationship__actions">
              {relationship.youFollow ? (
                <>
                  {confirmUnfollow === relationship.nodeId ? (
                    <div
                      aria-label={`Confirm unfollowing ${relationship.nodeId}. Unused credits are not refundable.`}
                      aria-live="assertive"
                      className="wg-inline-confirm"
                      role="alertdialog"
                    >
                      <p><IoWarningOutline aria-hidden="true" /> Unused credits are not refundable.</p>
                      <button
                        aria-label={`Confirm unfollowing ${relationship.nodeId}; unused credits are not refundable`}
                        className="nt-button nt-button--danger nt-button--sm"
                        disabled={controlsBusy}
                        onClick={() => {
                          settle(
                            () => onUnfollow(relationship.nodeId),
                            () => {
                              restoreUnfollowFocus.current = null;
                              setConfirmUnfollow(null);
                            },
                          );
                        }}
                        ref={confirmUnfollowButton}
                        type="button"
                      >
                        {busy?.nodeId === relationship.nodeId &&
                        busy.action === "unfollow"
                          ? "Unfollowing…"
                          : "Confirm unfollow"}
                      </button>
                      <button
                        aria-label={`Cancel unfollowing ${relationship.nodeId}`}
                        className="nt-button nt-button--ghost nt-button--sm"
                        disabled={controlsBusy}
                        onClick={() => {
                          restoreUnfollowFocus.current = relationship.nodeId;
                          setConfirmUnfollow(null);
                        }}
                        type="button"
                      >
                        Keep following
                      </button>
                    </div>
                  ) : (
                    <button
                      aria-label={`Unfollow ${relationship.nodeId}`}
                      className="nt-button nt-button--secondary nt-button--sm"
                      disabled={controlsBusy}
                      onClick={(event) => {
                        unfollowTriggers.current.set(
                          relationship.nodeId,
                          event.currentTarget,
                        );
                        restoreUnfollowFocus.current = null;
                        setConfirmUnfollow(relationship.nodeId);
                      }}
                      ref={(button) => {
                        if (button) {
                          unfollowTriggers.current.set(
                            relationship.nodeId,
                            button,
                          );
                        }
                      }}
                      type="button"
                    >
                      Unfollow
                    </button>
                  )}
                </>
              ) : (
                <button
                  className="nt-button nt-button--secondary nt-button--sm"
                  disabled={
                    !peerDeliveryEnabled ||
                    controlsBusy ||
                    relationship.blocked ||
                    !relationship.compatible
                  }
                  title={
                    !peerDeliveryEnabled
                      ? peerDeliveryReason
                      : !relationship.compatible
                        ? "This user cannot connect to this version of Wagyu"
                        : relationship.blocked
                          ? "Unblock this user before following"
                          : undefined
                  }
                  onClick={() =>
                    settle(() => onFollow(relationship.nodeId))}
                  type="button"
                >
                  {busy?.nodeId === relationship.nodeId &&
                  busy.action === "follow"
                    ? "Registering…"
                    : "Follow"}
                </button>
              )}
              <button
                aria-label={`${
                  relationship.blocked ? "Unblock" : "Block"
                } ${relationship.nodeId}`}
                className={`nt-button nt-button--sm ${relationship.blocked ? "nt-button--warning" : "nt-button--ghost"}`}
                disabled={controlsBusy}
                onClick={() =>
                  settle(() =>
                    onSetBlocked(
                      relationship.nodeId,
                      !relationship.blocked,
                    )
                  )}
                type="button"
              >
                <IoBanOutline aria-hidden="true" />
                {busy?.nodeId === relationship.nodeId &&
                (busy.action === "block" || busy.action === "unblock")
                  ? busy.action === "block"
                    ? "Blocking…"
                    : "Unblocking…"
                  : relationship.blocked
                    ? "Unblock"
                    : "Block"}
              </button>
            </div>
          </article>
        ))}
        {filtered.length === 0 ? (
          <div className="nt-state nt-state--empty wg-empty-state">
            <span className="wg-empty-state__icon"><IoPeopleOutline aria-hidden="true" /></span>
            <strong>No users in this view</strong>
            <span>Enter a user id above to follow someone.</span>
          </div>
        ) : null}
      </div>
      {hasMore ? (
        <button
          className="nt-button nt-button--secondary"
          disabled={controlsBusy}
          onClick={onLoadMore}
          type="button"
        >
          <IoPeopleOutline aria-hidden="true" />
          {loadingMore ? "Loading older relationships…" : "Load older relationships"}
        </button>
      ) : null}
    </div>
  );
}

function RelationshipStateBadge({
  direction,
  state,
}: {
  direction: "Following" | "Follower" | "User";
  state: RelationshipState;
}) {
  const icon =
    state === "active" ? (
      <IoCheckmarkCircleOutline aria-hidden="true" />
    ) : state === "registering" || state === "cleanup-pending" ? (
      <IoHourglassOutline aria-hidden="true" />
    ) : state === "blocked" ? (
      <IoBanOutline aria-hidden="true" />
    ) : state === "incompatible" ? (
      <IoShieldOutline aria-hidden="true" />
    ) : (
      <IoWarningOutline aria-hidden="true" />
    );
  return (
    <span className={`wg-relationship-state is-${state}`}>
      {icon}
      {direction}: {state.replaceAll("-", " ")}
    </span>
  );
}

function validateNodeId(value: string, ownNodeId?: string): string | null {
  if (!value) return null;
  try {
    const principal = Principal.fromText(value);
    if (principal.toText() !== value) return "Use the canonical lowercase user id.";
    if (principal.toUint8Array().at(-1) !== 0x01) {
      return "Enter a valid Wagyu user id.";
    }
    if (value === ownNodeId) {
      return "This is your id. You cannot follow yourself.";
    }
    return null;
  } catch {
    return "Enter a valid user id.";
  }
}

function relationshipStateDetail(
  state: RelationshipState,
  direction: "following" | "follower",
): string {
  switch (state) {
    case "registering":
      return direction === "following"
        ? "Finishing your follow…"
        : "This follower is still connecting.";
    case "cleanup-pending":
      return direction === "following"
        ? "The remote registration needs reconciliation before deliveries can start."
        : "Remote cleanup is queued; no new deliveries will be accepted.";
    case "credit-low":
      return direction === "following"
        ? "Keeping this follow connected…"
        : "This follower is reconnecting.";
    case "expired":
      return direction === "following"
        ? "This follow is no longer active."
        : "This follower needs to reconnect.";
    case "incompatible":
      return "This user cannot connect to this version of Wagyu.";
    case "blocked":
      return "This user is blocked.";
    case "active":
      return "Connected.";
  }
}
