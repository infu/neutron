import { useCallback, useEffect, useRef, useState } from "react";
import { cx, nt } from "neutron-design-system";
import {
  IoRefresh,
  IoLogOutOutline,
  IoArrowBack,
  IoSend,
  IoChatbubblesOutline,
  IoPersonOutline,
  IoPeopleOutline,
  IoChatbubbleEllipsesOutline,
  IoChevronDown,
  IoChevronForward,
  IoHomeOutline,
  IoCameraOutline,
  IoClose,
  IoCheckmarkDoneOutline,
} from "react-icons/io5";
import type { ChatVM, MessageImageVM, MessageVM, WhoAmIVM } from "../shared/protocol.ts";
import { oc } from "../shared/rpc.ts";
import { useChats, useMessages } from "./hooks.ts";
import { AsyncIconButton, Avatar, EmptyState, IconButton, MiniSpinner, Nav, TopProgress, relativeTime, submitOnEnter, type TileView } from "./ui.tsx";
import { Markdown, stripMarkdown } from "./markdown.tsx";

const KIND_ICON = { direct: IoPersonOutline, group: IoPeopleOutline, channel: IoChatbubblesOutline } as const;

type ListTab = "direct" | "spaces";

// OpenChat caps avatars at 800KB. Center-crop to a square and downscale to a
// modest size, then encode JPEG at descending quality until it fits — the
// canvas does the "fit whatever comes in" resizing the user asked for.
async function resizeAvatarToDataUrl(file: File, size = 256, maxBytes = 780 * 1024): Promise<string> {
  const { source, width, height, close } = await decodeImage(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable in this view");
    const side = Math.min(width, height) || 1;
    const sx = (width - side) / 2;
    const sy = (height - side) / 2;
    ctx.drawImage(source, sx, sy, side, side, 0, 0, size, size);
    for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]) {
      const url = canvas.toDataURL("image/jpeg", quality);
      // data URL length overshoots byte size by ~4/3 (base64); good enough guard.
      if (url.length * 0.75 <= maxBytes) return url;
    }
    return canvas.toDataURL("image/jpeg", 0.4);
  } finally {
    close();
  }
}

type DecodedImage = { source: CanvasImageSource; width: number; height: number; close: () => void };

// Decode an uploaded image to something drawable on a canvas WITHOUT using a
// blob: object URL — some sandboxed iframe origins refuse to load blob: URLs in
// an <img>, which surfaced as "can't read that image". createImageBitmap decodes
// the File bytes directly; if it's unavailable we fall back to a FileReader data
// URL fed to an <img> (a data: URL, not blob:).
async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      /* fall through to the FileReader path */
    }
  }
  const dataUrl = await readAsDataUrl(file);
  const img = await loadImageFromUrl(dataUrl);
  return {
    source: img,
    width: img.naturalWidth || img.width,
    height: img.naturalHeight || img.height,
    close: () => undefined,
  };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.readAsDataURL(file);
  });
}

function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That file isn't a supported image"));
    img.src = url;
  });
}

export function ClearUnreadButton(): React.ReactNode {
  return <AsyncIconButton icon={IoCheckmarkDoneOutline} label="Mark all as read" tid="oc-mark-read" action={async () => {
    const result = await oc.markAllRead();
    if (!result.ok) throw new Error(result.message ?? "Could not mark chats as read");
  }} />;
}

export function SignOutButton({ onSignedOut }: { onSignedOut: () => void }): React.ReactNode {
  return <AsyncIconButton icon={IoLogOutOutline} label="Sign out" tone="danger" tid="oc-signout" action={async () => {
    await oc.signOut();
    onSignedOut();
  }} />;
}

export function ProfileButton({ who, onChanged }: { who: WhoAmIVM; onChanged: () => void }): React.ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="oc-me" title="Edit your profile" onClick={() => setOpen(true)} data-tid="oc-profile-open">
        <span className="oc-me__avatar">
          <Avatar seed={who.userId ?? "me"} label={who.username ?? "me"} url={who.avatarUrl} size={22} />
        </span>
        <span className={cx(nt.muted, "oc-me__name")}>{who.username || "signed in"}</span>
      </button>
      {open ? (
        <ProfileModal
          who={who}
          onClose={() => setOpen(false)}
          onSaved={() => {
            onChanged();
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function ProfileModal({
  who,
  onClose,
  onSaved,
}: {
  who: WhoAmIVM;
  onClose: () => void;
  onSaved: () => void;
}): React.ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null); // pending upload (data URL)
  const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    oc.getProfile()
      .then((p) => {
        if (!alive) return;
        setUsername(p.username);
        setDisplayName(p.displayName ?? "");
        setBio(p.bio);
        setLoaded(true);
      })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [loadAttempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickAvatar = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const dataUrl = await resizeAvatarToDataUrl(file);
      setPendingAvatar(dataUrl);
      setAvatarPreview(dataUrl);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const save = useCallback(async () => {
    if (saving || !loaded) return;
    setSaving(true);
    setError(null);
    try {
      if (pendingAvatar) {
        const r = await oc.setAvatar(pendingAvatar);
        if (!r.ok) {
          setError(r.message ?? "Couldn't set avatar");
          setSaving(false);
          return;
        }
      }
      const res = await oc.saveProfile({ username: username.trim(), displayName: displayName.trim(), bio });
      if (!res.ok) {
        setError(res.message ?? "Couldn't save profile");
        setSaving(false);
        return;
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }, [saving, loaded, pendingAvatar, username, displayName, bio, onSaved]);

  return (
    <div className="oc-modal" role="dialog" aria-modal="true" aria-label="Edit profile" onClick={onClose}>
      <div className="oc-modal__card" onClick={(e) => e.stopPropagation()}>
        <header className="oc-modal__head">
          <h2 className="oc-modal__title">Edit profile</h2>
          <IconButton icon={IoClose} label="Close" onClick={onClose} />
        </header>

        {loading ? (
          <div className="oc-modal__loading">
            <MiniSpinner label="Loading profile" />
          </div>
        ) : !loaded ? (
          <div className="oc-modal__body">
            <div className="oc-modal__error" role="alert">{error || "Could not load your profile"}</div>
            <button type="button" className={nt.buttonGhost} onClick={() => setLoadAttempt((n) => n + 1)}>Retry profile</button>
          </div>
        ) : (
          <div className="oc-modal__body">
            <div className="oc-profile__avatar">
              <Avatar seed={who.userId ?? "me"} label={username || "me"} url={avatarPreview ?? who.avatarUrl} size={64} />
              <button type="button" className="oc-profile__photo" onClick={() => inputRef.current?.click()}>
                <IoCameraOutline size={13} aria-hidden /> Change photo
              </button>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  void pickAvatar(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>

            <label className="oc-field">
              <span className="oc-field__label">Username</span>
              <input
                className={cx(nt.input)}
                value={username}
                maxLength={20}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="5–20 characters"
              />
            </label>
            <label className="oc-field">
              <span className="oc-field__label">Display name</span>
              <input
                className={cx(nt.input)}
                value={displayName}
                maxLength={25}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Optional (3–25 characters)"
              />
            </label>
            <label className="oc-field">
              <span className="oc-field__label">Bio</span>
              <textarea
                className={cx(nt.input, "oc-field__area")}
                value={bio}
                maxLength={2000}
                rows={3}
                onChange={(e) => setBio(e.target.value)}
                placeholder="A short bio (optional)"
              />
            </label>

            {error ? <div className="oc-modal__error">{error}</div> : null}

            <div className="oc-modal__actions">
              <button type="button" className="oc-rules__btn oc-rules__btn--ghost" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button type="button" className="oc-rules__btn oc-rules__btn--accept" onClick={() => void save()} disabled={saving} data-tid="oc-profile-save">
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Chats({
  who,
  view,
  filter,
  onNav,
  onReload,
  selectedId,
  onSelect,
}: {
  who: WhoAmIVM;
  view: TileView;
  filter: ListTab;
  onNav: (v: TileView) => void;
  onReload: () => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}): React.ReactNode {
  const { chats, busy, error, refresh } = useChats(true);
  // Fall back to a synthesized summary so agent-driven navigation to a chat
  // still renders even if the list hasn't caught up with it yet.
  const selected =
    selectedId === null ? null : (chats.find((c) => c.id === selectedId) ?? synthChat(selectedId));

  // People (DMs) and Servers (groups + community channels) are separate top-nav
  // views now; show only the one for the active view.
  const shown = chats.filter((c) => (filter === "direct" ? c.kind === "direct" : c.kind !== "direct"));

  return (
    <div className={cx("oc-app", { "oc-app--reading": selectedId !== null })}>
      <header className="oc-topbar">
        <div className="oc-topbar__left">
          <Nav view={view} onNav={onNav} />
          <ClearUnreadButton />
        </div>
        <div className="oc-topbar__actions">
          <ProfileButton who={who} onChanged={onReload} />
          <IconButton icon={IoRefresh} label="Refresh" onClick={refresh} tid="oc-refresh" />
          <SignOutButton onSignedOut={onReload} />
        </div>
      </header>

      <div className="oc-body">
        <aside className="oc-list">
          <TopProgress show={busy} />
          {error && chats.length === 0 ? (
            <EmptyState title="Couldn't load chats" hint={error} />
          ) : shown.length === 0 ? (
            busy && chats.length === 0 ? null : (
              <EmptyState
                icon={filter === "direct" ? IoPersonOutline : IoPeopleOutline}
                title={filter === "direct" ? "No direct messages" : "No servers yet"}
                hint={filter === "direct" ? "DM someone from Browse." : "Find groups and communities in Browse."}
              />
            )
          ) : (
            <ChatTree chats={shown} selectedId={selectedId} onSelect={onSelect} />
          )}
        </aside>

        <section className="oc-conv">
          {selected ? (
            <Conversation
              key={selected.id}
              chat={selected}
              myUserId={who.userId}
              onBack={() => onSelect(null)}
            />
          ) : (
            <div className="oc-conv__placeholder">
              <EmptyState icon={IoChatbubbleEllipsesOutline} title="Select a chat" hint="Pick a conversation on the left." />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ChatRow({ chat, active, onSelect }: { chat: ChatVM; active: boolean; onSelect: () => void }): React.ReactNode {
  const Kind = KIND_ICON[chat.kind];
  return (
    <li>
      <button
        type="button"
        className={cx("oc-row", { "oc-row--active": active })}
        onClick={onSelect}
        data-tid="oc-chat-row"
      >
        <Avatar seed={chat.id} label={chat.title} url={chat.avatarUrl} />
        <span className="oc-row__main">
          <span className="oc-row__top">
            <span className="oc-row__title">
              <Kind size={12} aria-hidden className="oc-row__kind" />
              {chat.title}
            </span>
            <span className="oc-row__time">{relativeTime(chat.lastMessage?.timestampMs ?? chat.lastUpdatedMs)}</span>
          </span>
          <span className="oc-row__preview">
            {chat.lastMessage?.text ? stripMarkdown(chat.lastMessage.text) : chat.subtitle || "No messages yet"}
          </span>
        </span>
        {chat.unread > 0 ? <span className="oc-unread">{chat.unread > 99 ? "99+" : chat.unread}</span> : null}
      </button>
    </li>
  );
}

// A community and its channels — a folder in the tree.
type Folder = {
  communityId: string;
  name: string;
  avatarUrl: string | null;
  channels: ChatVM[]; // primary first, then most-recent
  primaryId: string | null;
  unread: number;
  lastUpdatedMs: number;
};
type TreeNode = { kind: "leaf"; chat: ChatVM } | { kind: "folder"; folder: Folder };

function buildTree(chats: ChatVM[]): TreeNode[] {
  const folders = new Map<string, Folder>();
  const nodes: TreeNode[] = [];
  for (const c of chats) {
    if (c.kind === "channel" && c.communityId) {
      let f = folders.get(c.communityId);
      if (!f) {
        f = {
          communityId: c.communityId,
          name: c.communityName || c.title,
          avatarUrl: c.avatarUrl ?? null,
          channels: [],
          primaryId: null,
          unread: 0,
          lastUpdatedMs: 0,
        };
        folders.set(c.communityId, f);
        nodes.push({ kind: "folder", folder: f });
      }
      f.channels.push(c);
      f.unread += c.unread;
      f.lastUpdatedMs = Math.max(f.lastUpdatedMs, c.lastUpdatedMs);
      if (c.primaryChannel) f.primaryId = c.id;
    } else {
      nodes.push({ kind: "leaf", chat: c });
    }
  }
  for (const f of folders.values()) {
    f.channels.sort((a, b) => {
      if (a.id === f.primaryId) return -1;
      if (b.id === f.primaryId) return 1;
      return b.lastUpdatedMs - a.lastUpdatedMs;
    });
    if (!f.primaryId && f.channels[0]) f.primaryId = f.channels[0].id;
  }
  const sortKey = (n: TreeNode): number => (n.kind === "leaf" ? n.chat.lastUpdatedMs : n.folder.lastUpdatedMs);
  return nodes.sort((a, b) => sortKey(b) - sortKey(a));
}

function ChatTree({
  chats,
  selectedId,
  onSelect,
}: {
  chats: ChatVM[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): React.ReactNode {
  const tree = buildTree(chats);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Keep the folder that holds the open channel expanded, so navigating to a
  // channel (including agent-driven) always reveals it in the tree.
  const selectedCommunity = chats.find((c) => c.id === selectedId)?.communityId ?? null;
  useEffect(() => {
    if (selectedCommunity) setExpanded((prev) => (prev.has(selectedCommunity) ? prev : new Set(prev).add(selectedCommunity)));
  }, [selectedCommunity]);

  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ul className="oc-list__scroll" role="tree">
      {tree.map((n) =>
        n.kind === "leaf" ? (
          <ChatRow key={n.chat.id} chat={n.chat} active={n.chat.id === selectedId} onSelect={() => onSelect(n.chat.id)} />
        ) : (
          <CommunityFolder
            key={n.folder.communityId}
            folder={n.folder}
            open={expanded.has(n.folder.communityId)}
            selectedId={selectedId}
            onToggle={() => toggle(n.folder.communityId)}
            onOpenPrimary={() => {
              setExpanded((prev) => new Set(prev).add(n.folder.communityId));
              if (n.folder.primaryId) onSelect(n.folder.primaryId);
            }}
            onSelectChannel={onSelect}
          />
        ),
      )}
    </ul>
  );
}

function CommunityFolder({
  folder,
  open,
  selectedId,
  onToggle,
  onOpenPrimary,
  onSelectChannel,
}: {
  folder: Folder;
  open: boolean;
  selectedId: string | null;
  onToggle: () => void;
  onOpenPrimary: () => void;
  onSelectChannel: (id: string) => void;
}): React.ReactNode {
  const Chevron = open ? IoChevronDown : IoChevronForward;
  return (
    <li className="oc-folder">
      <div className={cx("oc-row oc-folder__head", { "oc-folder__head--open": open })}>
        <button
          type="button"
          className="oc-folder__toggle"
          onClick={onToggle}
          aria-label={open ? "Collapse community" : "Expand community"}
          aria-expanded={open}
        >
          <Chevron size={13} aria-hidden />
        </button>
        <button type="button" className="oc-folder__main" onClick={onOpenPrimary} data-tid="oc-community" title={folder.name}>
          <Avatar seed={folder.communityId} label={folder.name} url={folder.avatarUrl} />
          <span className="oc-row__title">
            <IoPeopleOutline size={12} aria-hidden className="oc-row__kind" />
            {folder.name}
          </span>
        </button>
        {folder.unread > 0 && !open ? <span className="oc-unread">{folder.unread > 99 ? "99+" : folder.unread}</span> : null}
      </div>
      {open ? (
        <ul className="oc-folder__children" role="group">
          {folder.channels.map((ch) => (
            <ChannelRow
              key={ch.id}
              chat={ch}
              active={ch.id === selectedId}
              primary={ch.id === folder.primaryId}
              onSelect={() => onSelectChannel(ch.id)}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ChannelRow({
  chat,
  active,
  primary,
  onSelect,
}: {
  chat: ChatVM;
  active: boolean;
  primary: boolean;
  onSelect: () => void;
}): React.ReactNode {
  return (
    <li>
      <button
        type="button"
        className={cx("oc-row oc-chan", { "oc-row--active": active })}
        onClick={onSelect}
        data-tid="oc-channel-row"
        title={primary ? `${chat.channelName ?? ""} · main channel` : (chat.channelName ?? undefined)}
      >
        {primary ? <IoHomeOutline size={12} className="oc-chan__icon" aria-hidden /> : <span className="oc-chan__hash">#</span>}
        <span className="oc-chan__name">{chat.channelName || chat.title}</span>
        {chat.unread > 0 ? <span className="oc-unread">{chat.unread > 99 ? "99+" : chat.unread}</span> : null}
      </button>
    </li>
  );
}

function Conversation({
  chat,
  myUserId,
  onBack,
}: {
  chat: ChatVM;
  myUserId: string | null;
  onBack: () => void;
}): React.ReactNode {
  const { messages, busy, error, reload } = useMessages(chat.id);
  const Kind = KIND_ICON[chat.kind];
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Whether the view is pinned to the bottom. A background refresh should only
  // auto-scroll when the user is already at the bottom — never yank them down
  // while they're reading history further up.
  const stick = useRef(true);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // New chat: start pinned to the bottom.
  useEffect(() => {
    stick.current = true;
  }, [chat.id]);

  // After messages change, stay at the bottom only if we were already there.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="oc-conv__inner">
      <header className="oc-conv__head">
        <span className="oc-conv__back">
          <IconButton icon={IoArrowBack} label="Back to chats" onClick={onBack} />
        </span>
        <Avatar seed={chat.id} label={chat.title} url={chat.avatarUrl} size={26} />
        <span className="oc-conv__title">
          <Kind size={13} aria-hidden />
          {chat.title}
        </span>
      </header>

      <div className="oc-messages" aria-live="polite" ref={scrollerRef} onScroll={onScroll}>
        <TopProgress show={busy} />
        {error ? (
          <div role="alert" className="oc-read-error">
            <EmptyState title="Couldn't load messages" hint={error} />
            <button type="button" className={nt.buttonGhost} onClick={reload}>Retry messages</button>
          </div>
        ) : null}
        {messages.length === 0 ? (
          busy || error ? null : <EmptyState title="No messages" hint="Say hello 👋" />
        ) : (
          <MessageList messages={messages} myUserId={myUserId} />
        )}
      </div>

      <Composer chatId={chat.id} onSent={reload} />
    </div>
  );
}

const GROUP_WINDOW_MS = 5 * 60 * 1000;

type PostGroup = { key: string; senderId: string; name: string; avatarUrl: string | null; timestampMs: number; messages: MessageVM[] };

// Collapse consecutive messages from the same author (within a few minutes) into
// one "post" — a Discord-style column of avatar + name/time header + lines, with
// no per-message boxes.
function groupMessages(messages: MessageVM[]): PostGroup[] {
  const groups: PostGroup[] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (last && last.senderId === m.senderId && m.timestampMs - last.messages[last.messages.length - 1]!.timestampMs < GROUP_WINDOW_MS) {
      last.messages.push(m);
    } else {
      groups.push({
        key: m.messageId,
        senderId: m.senderId,
        name: m.senderName || short(m.senderId),
        avatarUrl: m.senderAvatarUrl,
        timestampMs: m.timestampMs,
        messages: [m],
      });
    }
  }
  return groups;
}

function MessageList({ messages, myUserId }: { messages: MessageVM[]; myUserId: string | null }): React.ReactNode {
  const [zoom, setZoom] = useState<string | null>(null);
  const groups = groupMessages(messages);
  return (
    <div className="oc-feed">
      {groups.map((g) => {
        const mine = myUserId !== null && g.senderId === myUserId;
        return (
          <div className="oc-post" key={g.key}>
            <div className="oc-post__gutter">
              <Avatar seed={g.senderId} label={g.name} url={g.avatarUrl} size={34} />
            </div>
            <div className="oc-post__body">
              <div className="oc-post__head">
                <span className={cx("oc-post__name", { "oc-post__name--me": mine })}>{g.name}</span>
                <span className="oc-post__time">{relativeTime(g.timestampMs)}</span>
              </div>
              {g.messages.map((m) => {
                const showText = m.text && !(m.image && /^\[[a-z]+\]$/.test(m.text));
                return (
                  <div className="oc-line" key={m.messageId}>
                    {m.image ? <MessageImage image={m.image} onZoom={setZoom} /> : null}
                    {showText ? (
                      <span className="oc-line__text">
                        <Markdown text={m.text} />
                        {m.edited ? <span className="oc-line__edited"> (edited)</span> : null}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {zoom ? <Lightbox src={zoom} onClose={() => setZoom(null)} /> : null}
    </div>
  );
}

function MessageImage({ image, onZoom }: { image: MessageImageVM; onZoom: (src: string) => void }): React.ReactNode {
  // Prefer the full-resolution image (loads from the IC gateway — the frame's
  // CSP allows it); fall back to the inline data-URL thumbnail if it fails or is
  // all we have. Click opens a full-size lightbox.
  const full = image.fullUrl ?? image.thumbnailDataUrl;
  const [src, setSrc] = useState<string | null>(image.fullUrl ?? image.thumbnailDataUrl);
  if (!src || !full) return null;
  const ratio = image.width > 0 && image.height > 0 ? image.width / image.height : undefined;
  return (
    <button type="button" className="oc-img" onClick={() => onZoom(full)} title="View image">
      <img
        className="oc-img__thumb"
        src={src}
        alt=""
        loading="lazy"
        style={ratio ? { aspectRatio: String(ratio) } : undefined}
        onError={() => {
          // full-res failed to load → fall back to the inline thumbnail
          if (image.thumbnailDataUrl && src !== image.thumbnailDataUrl) setSrc(image.thumbnailDataUrl);
        }}
      />
    </button>
  );
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }): React.ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="oc-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <button type="button" className="oc-lightbox__close" onClick={onClose} aria-label="Close">
        <IoClose size={22} />
      </button>
      <img className="oc-lightbox__img" src={src} alt="" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

function Composer({ chatId, onSent }: { chatId: string; onSent: () => void }): React.ReactNode {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the chat gates posting on rules acceptance; carries the rules text
  // to show before the user accepts and the message is (re)sent.
  const [rules, setRules] = useState<string | null>(null);

  const send = useCallback(
    async (acceptRules: boolean) => {
      const body = text.trim();
      if (!body || sending) return;
      setSending(true);
      setError(null);
      try {
        const res = await oc.sendMessage(chatId, body, acceptRules);
        if (res.kind === "rules_required") {
          setRules(res.rulesText || "This chat has rules you must accept before posting.");
        } else if (res.kind === "error") {
          setError(res.message ?? "Failed to send");
        } else {
          setText("");
          setRules(null);
          onSent();
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSending(false);
      }
    },
    [text, sending, chatId, onSent],
  );

  return (
    <div className="oc-composer">
      {error ? <div className="oc-composer__error">{error}</div> : null}
      {rules !== null ? (
        <div className="oc-rules" role="group" aria-label="Chat rules">
          <div className="oc-rules__title">Please accept this chat's rules to post</div>
          <div className="oc-rules__text">{rules}</div>
          <div className="oc-rules__actions">
            <button type="button" className="oc-rules__btn oc-rules__btn--ghost" onClick={() => setRules(null)} disabled={sending}>
              Cancel
            </button>
            <button
              type="button"
              className="oc-rules__btn oc-rules__btn--accept"
              onClick={() => void send(true)}
              disabled={sending}
              data-tid="oc-accept-rules"
            >
              Accept &amp; send
            </button>
          </div>
        </div>
      ) : null}
      <div className="oc-composer__row">
        <input
          className={cx(nt.input, "oc-composer__input")}
          placeholder="Message"
          value={text}
          maxLength={10000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={submitOnEnter(() => void send(false))}
          disabled={sending}
          data-tid="oc-composer-input"
        />
        <IconButton icon={IoSend} label="Send message" onClick={() => void send(false)} disabled={sending || !text.trim()} tid="oc-send" />
      </div>
    </div>
  );
}

function short(id: string): string {
  return id.length > 15 ? `${id.slice(0, 12)}…` : id;
}

// Minimal placeholder summary for a chat the list hasn't surfaced yet, so
// agent-driven navigation renders immediately; the poll refresh fills in the
// real title/preview shortly after.
function synthChat(id: string): ChatVM {
  const kind: ChatVM["kind"] = id.startsWith("group:")
    ? "group"
    : id.startsWith("channel:")
      ? "channel"
      : "direct";
  const ref = id.split(":").slice(1).join(":");
  return {
    id,
    kind,
    title: short(ref || id),
    subtitle: null,
    lastMessage: null,
    unread: 0,
    lastUpdatedMs: 0,
  };
}
