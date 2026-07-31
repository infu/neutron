import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "../src/app/components/Composer.tsx";
import {
  AuthoredPostsPanel,
  FeedView,
} from "../src/app/components/FeedView.tsx";
import {
  ProfileView,
  UserProfileView,
} from "../src/app/components/ProfileView.tsx";
import { PostCard } from "../src/app/components/PostCard.tsx";
import { ThreadView } from "../src/app/components/ThreadView.tsx";
import { createPreviewWagyuService } from "../src/app/demo_data.ts";
import type { FeedItem } from "../src/app/model.ts";

test("Home keeps replies collapsed until a post is opened", async () => {
  const service = createPreviewWagyuService();
  const snapshot = await service.loadSnapshot();
  const authoredPost = snapshot.authored.items.find(
    (item) => item.kind === "post",
  );
  if (!authoredPost || authoredPost.kind !== "post") {
    throw new Error("Preview fixture omitted its authored post");
  }
  const parent = snapshot.feed.items.find(
    (item) => item.verification === "verified",
  );
  if (!parent) {
    throw new Error("Preview fixture omitted its verified parent post");
  }
  const authored = {
    ...snapshot.authored,
    items: [{
      ...authoredPost,
      bodyMarkdown: "A post shown on your Home profile.",
      bodyLength: 256,
      replyTo: {
        authorNodeId: parent.author.nodeId,
        postId: parent.postId,
      },
      localLikeView: {
        postBodyHash: "11".repeat(32),
        revision: snapshot.authored.revision,
        unsealedReceiptCount: 1,
        unsealedLikerIds: ["rrkah-fqaaa-aaaaa-aaaaq-cai"],
      },
    }],
  };
  const pendingReply = snapshot.notifications.items.find(
    (item) => item.kind === "reply",
  );
  if (!pendingReply) {
    throw new Error("Preview fixture omitted its reply notification");
  }
  const verifiedReply = {
    ...pendingReply,
    actorDisplayName: "Replying User",
    actorProfileProof: "fresh" as const,
    verification: "verified" as const,
    targetPostId: authoredPost.postId,
    actionId: "22".repeat(32),
    objectDigest: "44".repeat(32),
    objectLength: 192,
    verifiedReply: {
      authorNodeId: pendingReply.actorNodeId,
      postId: "22".repeat(32),
      bodyMarkdown: "A verified reply shown under its parent.",
      bodyHash: "33".repeat(32),
      bodyLength: 192,
      objectDigest: "44".repeat(32),
      createdAt: "2026-07-23T12:30:00.000Z",
      replyTo: {
        authorNodeId: snapshot.profile.nodeId,
        postId: authoredPost.postId,
        bodyHash: pendingReply.targetBodyHash ?? "11".repeat(32),
        bodyLength: 256,
        objectDigest: authoredPost.objectDigest ?? "55".repeat(32),
      },
    },
  };
  const pendingForgedReply = {
    ...verifiedReply,
    id: "pending-forged-reply",
    verification: "pending" as const,
    verifiedReply: {
      ...verifiedReply.verifiedReply,
      bodyMarkdown: "Forged reply text must stay hidden.",
    },
  };
  const feedHtml = renderToStaticMarkup(
    createElement(FeedView, {
      actionStages: new Map(),
      authored,
      likingIds: new Set<string>(),
      loadingMore: false,
      onLike: () => undefined,
      onLoadMore: () => undefined,
      onOpenLikes: () => undefined,
      onAdvanceWithdrawal: () => undefined,
      onReply: () => undefined,
      onResumePost: () => undefined,
      onShare: () => undefined,
      onVerify: () => undefined,
      onWithdraw: () => undefined,
      page: snapshot.feed,
      profile: snapshot.profile,
      replies: [verifiedReply, pendingForgedReply],
      showRootPostsOnly: true,
      verifyingIds: new Set<string>(),
    }),
  );
  const authoredReplyItem: FeedItem = {
    ...parent,
    id: `authored:${authoredPost.postId}`,
    author: {
      nodeId: snapshot.profile.nodeId,
      displayName: snapshot.profile.displayName,
      avatarUrl: snapshot.profile.avatarUrl,
      profileProof: snapshot.profile.proofState,
    },
    body: "A post shown on your Home profile.",
    bodyDigest: "11".repeat(32),
    bodyLength: 256,
    kind: "original",
    localOrigin: true,
    objectDigest: authoredPost.objectDigest,
    postId: authoredPost.postId,
    replyTo: {
      authorNodeId: parent.author.nodeId,
      author: parent.author,
      postId: parent.postId,
      body: parent.body,
      verified: true,
    },
  };
  const lowerReply: FeedItem = {
    ...parent,
    id: "lower-level-reply",
    body: "A lower-level reply.",
    postId: "55".repeat(32),
    replyTo: {
      authorNodeId: verifiedReply.actorNodeId,
      author: {
        nodeId: verifiedReply.actorNodeId,
        displayName: verifiedReply.actorDisplayName,
        avatarUrl: verifiedReply.actorAvatarUrl,
        profileProof: verifiedReply.actorProfileProof,
      },
      postId: verifiedReply.actionId,
      body: verifiedReply.verifiedReply.bodyMarkdown,
      verified: true,
    },
  };
  const receivedReplyItem: FeedItem = {
    ...parent,
    id: `notification-reply:${verifiedReply.id}`,
    author: {
      nodeId: verifiedReply.actorNodeId,
      displayName: verifiedReply.actorDisplayName,
      avatarUrl: verifiedReply.actorAvatarUrl,
      profileProof: verifiedReply.actorProfileProof,
    },
    body: verifiedReply.verifiedReply.bodyMarkdown,
    bodyDigest: verifiedReply.verifiedReply.bodyHash,
    bodyLength: verifiedReply.objectLength,
    kind: "original",
    objectDigest: verifiedReply.objectDigest,
    postId: verifiedReply.actionId,
    replyTo: {
      authorNodeId: authoredReplyItem.author.nodeId,
      author: authoredReplyItem.author,
      postId: authoredReplyItem.postId,
      body: authoredReplyItem.body,
      verified: true,
    },
  };
  const threadProps = {
    actionStages: new Map(),
    authored,
    likingIds: new Set<string>(),
    loadingMore: false,
    onLike: () => undefined,
    onLoadMore: () => undefined,
    onOpenLikes: () => undefined,
    onAdvanceWithdrawal: () => undefined,
    onReply: () => undefined,
    onResumePost: () => undefined,
    onShare: () => undefined,
    onVerify: () => undefined,
    onWithdraw: () => undefined,
    page: {
      ...snapshot.feed,
      items: [...snapshot.feed.items, lowerReply],
    },
    profile: snapshot.profile,
    replies: [verifiedReply],
    verifyingIds: new Set<string>(),
  };
  const threadHtml = renderToStaticMarkup(
    createElement(FeedView, {
      ...threadProps,
      threadItem: authoredReplyItem,
    }),
  );
  const openedReplyHtml = renderToStaticMarkup(
    createElement(FeedView, {
      ...threadProps,
      threadItem: receivedReplyItem,
    }),
  );
  const homeHtml = renderToStaticMarkup(
    createElement(
      ProfileView,
      {
        error: null,
        onSave: async () => undefined,
        profile: snapshot.profile,
        saving: false,
      },
      createElement(
        "div",
        { className: "wg-profile-tabs" },
        createElement("strong", null, "Posts"),
      ),
      createElement(AuthoredPostsPanel, {
        actionStages: new Map(),
        onAdvanceWithdrawal: () => undefined,
        onOpenLikes: () => undefined,
        onReply: () => undefined,
        onResumePost: () => undefined,
        onWithdraw: () => undefined,
        page: authored,
        profile: snapshot.profile,
      }),
    ),
  );

  expect(feedHtml).toContain('aria-label="Post by Mina Seo"');
  expect(feedHtml).toContain('class="wg-feed-card"');
  expect(feedHtml).toContain(
    'aria-label="Reply to post 75d3b4…8122 by Mina Seo"',
  );
  expect(feedHtml).toContain(
    'aria-label="Share post 75d3b4…8122 by Mina Seo"',
  );
  expect(feedHtml).toContain(
    'aria-label="View 284 likes for post 75d3b4…8122 by Mina Seo"',
  );
  expect(feedHtml).toContain(
    'aria-label="Reply to post 75d3b4…8122 by Mina Seo; 1 reply"',
  );
  expect(feedHtml).not.toContain(">Like</button>");
  expect(feedHtml).not.toContain(">Reply</button>");
  expect(feedHtml).not.toContain(">Share</button>");
  expect(feedHtml).not.toContain("A post shown on your Home profile.");
  expect(feedHtml).not.toContain('aria-label="Reply by Replying User"');
  expect(feedHtml).not.toContain("A verified reply shown under its parent.");
  expect(feedHtml).not.toContain("Reply to <strong>");
  expect(feedHtml).not.toContain("Forged reply text must stay hidden.");
  expect(feedHtml).toContain('aria-label="Open Post by Mina Seo"');
  expect(threadHtml).toContain(
    `aria-label="Reply to post ${
      authoredPost.postId.slice(0, 10)
    }…${authoredPost.postId.slice(-8)} by ${
      snapshot.profile.displayName
    }; 1 reply"`,
  );
  expect(threadHtml).toContain(
    'aria-label="Reply to post 2222222222…22222222 by Replying User; 1 reply"',
  );
  expect(threadHtml).toContain('data-depth="1"');
  expect(threadHtml).not.toContain('data-depth="2"');
  expect(threadHtml).not.toContain("A lower-level reply.");
  expect(openedReplyHtml).toContain("A lower-level reply.");
  expect(openedReplyHtml).toContain('data-depth="1"');

  expect(homeHtml).toContain("<strong>Posts</strong>");
  expect(homeHtml).toContain('aria-label="Your posts"');
  expect(homeHtml).toContain('aria-label="Your reply"');
  expect(homeHtml).toContain('class="wg-feed-card has-menu"');
  expect(homeHtml).toContain("A post shown on your Home profile.");
  expect(homeHtml).toContain('aria-haspopup="menu"');
  expect(homeHtml).toContain('aria-label="Delete post"');
  expect(homeHtml).toContain('aria-label="View 1 like for post ');
  expect(homeHtml).toContain('aria-label="Reply to post ');
  expect(homeHtml).toContain('class="wg-post-action__count"');
  expect(homeHtml).not.toContain("1 recent likes");
});

test("Home keeps a shared reply as a root delivery while direct replies stay collapsed", async () => {
  const snapshot = await createPreviewWagyuService().loadSnapshot();
  const parent = snapshot.feed.items.find(
    (item) => item.verification === "verified",
  );
  if (!parent) throw new Error("Preview fixture omitted a verified post");
  const replyTo = {
    authorNodeId: parent.author.nodeId,
    author: parent.author,
    postId: parent.postId,
    body: parent.body,
    verified: true,
  };
  const directOnly: FeedItem = {
    ...parent,
    id: "direct-only-reply",
    localSequence: "100",
    postId: "10".repeat(32),
    body: "Direct reply stays collapsed.",
    bodyDigest: "11".repeat(32),
    objectDigest: "12".repeat(32),
    replyTo,
    sharedBy: null,
  };
  const directSharedReply: FeedItem = {
    ...parent,
    id: "direct-shared-reply",
    localSequence: "99",
    postId: "20".repeat(32),
    body: "Shared reply remains visible.",
    bodyDigest: "21".repeat(32),
    objectDigest: "22".repeat(32),
    replyTo,
    sharedBy: null,
  };
  const sharedDelivery: FeedItem = {
    ...directSharedReply,
    id: "shared-delivery",
    localSequence: "98",
    immediateSender: snapshot.profile.nodeId,
    kind: "share",
    sharedBy: {
      nodeId: snapshot.profile.nodeId,
      displayName: "Sharing User",
      avatarUrl: null,
      profileProof: "fresh",
    },
  };

  const html = renderToStaticMarkup(
    createElement(FeedView, {
      actionStages: new Map(),
      likingIds: new Set<string>(),
      loadingMore: false,
      onLike: () => undefined,
      onLoadMore: () => undefined,
      onOpenLikes: () => undefined,
      onReply: () => undefined,
      onShare: () => undefined,
      onVerify: () => undefined,
      page: {
        revision: snapshot.feed.revision,
        items: [directOnly, directSharedReply, sharedDelivery],
        nextCursor: null,
      },
      showRootPostsOnly: true,
      verifyingIds: new Set<string>(),
    }),
  );

  expect(html).not.toContain("Direct reply stays collapsed.");
  expect(html).toContain("Shared reply remains visible.");
  expect(html).toContain("<strong>Sharing User</strong> shared");
});

test("a controlled composer exposes a truthful in-memory draft restore state", async () => {
  const service = createPreviewWagyuService();
  const snapshot = await service.loadSnapshot();
  const html = renderToStaticMarkup(
    createElement(Composer, {
      disabled: false,
      markdown: "A retained draft",
      onClearReply: () => undefined,
      onClose: () => undefined,
      onMarkdownChange: () => undefined,
      onPublished: () => undefined,
      profile: snapshot.profile,
      replyTarget: null,
      service,
    }),
  );

  expect(html).toContain('role="dialog"');
  expect(html).toContain("Create post");
  expect(html).toContain("Restored your in-memory post draft");
  expect(html).toContain("bytes");
  expect(html).not.toContain("Certified action");
  expect(html).not.toContain("Certify");

  const app = await readFile(
    new URL("../src/app/App.tsx", import.meta.url),
    "utf8",
  );
  expect(app).toContain('const [composerDraft, setComposerDraft] = useState("")');
  expect(app).toContain("onCompose={() => setComposerOpen(true)}");
  expect(app).toContain("markdown={composerDraft}");
  expect(app).toContain("onMarkdownChange={setComposerDraft}");
  expect(app).toContain("onReply={openInlineReply}");
  expect(app).not.toContain("setReplyTarget");
  expect(app.match(/<Composer/g)?.length).toBe(2);
  expect(app).toContain('variant="inline"');
});

test("verified post authors open a user profile with locally known posts", async () => {
  const service = createPreviewWagyuService();
  const snapshot = await service.loadSnapshot();
  const post = snapshot.feed.items.find(
    (item) => item.verification === "verified",
  );
  if (!post) throw new Error("Preview fixture omitted a verified author");
  const profile = await service.loadUserProfile(post.author.nodeId);
  const authorCard = renderToStaticMarkup(
    createElement(PostCard, {
      accessibleLabel: "Post",
      author: post.author,
      body: post.body,
      onOpenAuthor: () => undefined,
    }),
  );
  const profilePage = renderToStaticMarkup(
    createElement(
      UserProfileView,
      {
        error: null,
        followBusy: false,
        followDisabledReason: null,
        followError: null,
        following: false,
        loading: false,
        onBack: () => undefined,
        onFollow: () => undefined,
        profile,
      },
      createElement("div", null, post.body),
    ),
  );

  expect(authorCard).toContain('aria-label="Open profile for Mina Seo"');
  expect(profilePage).toContain('class="wg-profile wg-user-profile"');
  expect(profilePage).toContain("A verified Wagyu profile for Mina Seo.");
  expect(profilePage).toContain(post.body ?? "");
  expect(profilePage).toContain('aria-label="Back from user profile"');
  expect(profilePage).toContain('aria-label="Follow Mina Seo"');
  expect(profilePage).toContain("wg-user-profile__follow");

  const app = await readFile(
    new URL("../src/app/App.tsx", import.meta.url),
    "utf8",
  );
  expect(app).toContain("service.loadUserProfile(author.nodeId)");
  expect(app).toContain('setView("user-profile")');
  expect(app).toContain("followRelationship(");
  expect(app).toContain(
    "item.author.nodeId === selectedUserProfile.nodeId",
  );
  expect(app).toContain('onOpenUser={openUserProfile}');
});

test("post detail places the shared inline reply composer before replies", async () => {
  const service = createPreviewWagyuService();
  const snapshot = await service.loadSnapshot();
  const parent = snapshot.feed.items.find(
    (item) => item.verification === "verified",
  );
  if (!parent) throw new Error("Preview fixture omitted a verified post");
  const inline = renderToStaticMarkup(
    createElement(Composer, {
      disabled: false,
      markdown: "",
      onClearReply: () => undefined,
      onClose: () => undefined,
      onMarkdownChange: () => undefined,
      onPublished: () => undefined,
      profile: snapshot.profile,
      replyTarget: parent,
      service,
      variant: "inline",
    }),
  );
  const thread = renderToStaticMarkup(
    createElement(ThreadView, {
      item: {
        ...parent,
        id: "reply",
        replyTo: {
          author: parent.author,
          authorNodeId: parent.author.nodeId,
          body: parent.body,
          postId: parent.postId,
          verified: true,
        },
      },
      ancestors: [parent],
      onBack: () => undefined,
      renderPost: (item) =>
        createElement(PostCard, {
          accessibleLabel: "Post",
          author: item.author,
          body: item.body,
        }),
      replyComposer: createElement("div", null, "Inline reply composer"),
    }),
  );

  expect(inline).toContain('aria-label="Reply to post"');
  expect(inline).toContain("Reply to</label>");
  expect(inline).toContain('placeholder="Type your reply…"');
  expect(inline).toContain(">Reply</button>");
  expect(inline).not.toContain('role="dialog"');
  expect(inline).not.toContain("wg-composer-backdrop");
  expect(thread.indexOf("Inline reply composer")).toBeGreaterThan(
    thread.indexOf('aria-label="Post"', thread.indexOf('aria-label="Post"') + 1),
  );
});

test("Profile separates parentless posts from replies", async () => {
  const snapshot = await createPreviewWagyuService().loadSnapshot();
  const source = snapshot.authored.items.find(
    (item) => item.kind === "post",
  );
  const parent = snapshot.feed.items.find(
    (item) => item.verification === "verified",
  );
  if (!source || source.kind !== "post" || !parent) {
    throw new Error("Preview fixture omitted profile-tab posts");
  }
  const page = {
    ...snapshot.authored,
    items: [
      {
        ...source,
        actionId: "parentless-action",
        bodyMarkdown: "Parentless profile post.",
        postId: "parentless-post",
        replyTo: null,
      },
      {
        ...source,
        actionId: "reply-action",
        bodyMarkdown: "Profile reply.",
        postId: "reply-post",
        replyTo: {
          authorNodeId: parent.author.nodeId,
          postId: parent.postId,
        },
      },
    ],
  };
  const common = {
    actionStages: new Map(),
    onAdvanceWithdrawal: () => undefined,
    onResumePost: () => undefined,
    onWithdraw: () => undefined,
    page,
    profile: snapshot.profile,
    threadParents: snapshot.feed.items,
  };
  const posts = renderToStaticMarkup(
    createElement(AuthoredPostsPanel, {
      ...common,
      contentFilter: "posts",
    }),
  );
  const replies = renderToStaticMarkup(
    createElement(AuthoredPostsPanel, {
      ...common,
      contentFilter: "replies",
    }),
  );

  expect(posts).toContain('aria-label="Your posts"');
  expect(posts).toContain("Parentless profile post.");
  expect(posts).not.toContain("Profile reply.");
  expect(replies).toContain('aria-label="Your replies"');
  expect(replies).toContain("Profile reply.");
  expect(replies).not.toContain("Parentless profile post.");

  const app = await readFile(
    new URL("../src/app/App.tsx", import.meta.url),
    "utf8",
  );
  expect(app).toContain('role="tablist"');
  expect(app).toContain('aria-selected={profileTab === "posts"}');
  expect(app).toContain('aria-selected={profileTab === "replies"}');
  expect(app).toContain("contentFilter={profileTab}");
});

test("reply cards keep the parent message inside the shared-card thread view", async () => {
  const snapshot = await createPreviewWagyuService().loadSnapshot();
  const reply: FeedItem = {
    ...snapshot.feed.items[0]!,
    id: "reply",
    body: "The reply message.",
    replyTo: {
      authorNodeId: snapshot.feed.items[0]!.author.nodeId,
      author: snapshot.feed.items[0]!.author,
      postId: snapshot.feed.items[0]!.postId,
      body: "The complete parent message.",
      verified: true,
    },
  };
  const card = renderToStaticMarkup(
    createElement(PostCard, {
      accessibleLabel: "Reply",
      author: reply.author,
      body: reply.body,
      replyTo: {
        label: "Mina Seo",
        onOpen: () => undefined,
      },
    }),
  );
  const thread = renderToStaticMarkup(
    createElement(ThreadView, {
      item: reply,
      ancestors: [{
        ...snapshot.feed.items[0]!,
        body: reply.replyTo!.body,
      }],
      onBack: () => undefined,
      replies: [{
        depth: 1,
        item: {
          ...reply,
          body: "The newest reply.",
          id: "newest-reply",
        },
      }],
      renderPost: (item, nestedUnderParent) =>
        createElement(PostCard, {
          accessibleLabel: "Thread post",
          actions: createElement(
            "div",
            null,
            "Like Likes Reply Share",
          ),
          author: item.author,
          body: item.body,
          replyTo: item.replyTo
            ? { label: "Mina Seo" }
            : null,
          showReplyContext: !nestedUnderParent,
        }),
    }),
  );

  expect(card).toContain("Reply to <strong>Mina Seo</strong>");
  expect(card).toContain('aria-label="Open thread replying to Mina Seo"');
  expect(card).toContain('class="wg-feed-card__thread-link"');
  expect(card).not.toContain("The complete parent message.");
  expect(thread).toContain("The complete parent message.");
  expect(thread).toContain("The reply message.");
  expect(thread).toContain("The newest reply.");
  expect(thread).toContain("Back</button>");
  expect(thread).toContain('class="wg-thread-page"');
  expect(thread).toContain('class="wg-thread__parent"');
  expect(thread).toContain('class="wg-thread__replies"');
  expect(thread.match(/Like Likes Reply Share/g)?.length).toBe(3);
  expect(thread).not.toContain('role="dialog"');
  expect(thread).not.toContain('aria-modal="true"');
  expect(thread.match(/class="wg-feed-card"/g)?.length).toBe(3);
  expect(thread).not.toContain("Reply to <strong>");
});

test("destructive menus and confirmations expose accessible focus behavior", async () => {
  const [feed, relationships] = await Promise.all([
    readFile(
      new URL("../src/app/components/FeedView.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../src/app/components/RelationshipsView.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  expect(feed).toContain('aria-haspopup="menu"');
  expect(feed).toContain('role="menuitem"');
  expect(feed).toContain('aria-label="Delete post"');
  expect(feed).toContain("deleteButton.current?.focus()");
  expect(feed).toContain("trigger.current?.focus()");

  expect(relationships).toContain("confirmUnfollowButton.current?.focus()");
  expect(relationships).toContain("unfollowTriggers.current.get(node)?.focus()");
  expect(relationships).toContain('aria-live="assertive"');
  expect(relationships).toContain('role="alertdialog"');
  expect(relationships).toContain("Unused credits are not refundable.");
});
