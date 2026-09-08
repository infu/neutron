// Candid interfaces for the Nuance canisters, as used from the browser.
//
// These mirror `backend/nuance/Types.mo` field for field. Same discipline: the
// records we receive are minimal projections and rely on Candid record-width
// subtyping to ignore everything else, so Nuance can add fields without breaking
// the tile.
//
// Only the *read* surface lives here. Anything that needs an identity goes
// through the app's backend, because the browser has no Nuance credential and
// must not have one.

import { IDL } from "@icp-sdk/core/candid";

export const PostTagModel = IDL.Record({
  tagId: IDL.Text,
  tagName: IDL.Text,
});

export const PostKeyProperties = IDL.Record({
  postId: IDL.Text,
  bucketCanisterId: IDL.Text,
  handle: IDL.Text,
  claps: IDL.Text,
  views: IDL.Text,
  created: IDL.Text,
  modified: IDL.Text,
  publishedDate: IDL.Text,
  isDraft: IDL.Bool,
  tags: IDL.Vec(PostTagModel),
});

export const GetPostsByFollowers = IDL.Record({
  posts: IDL.Vec(PostKeyProperties),
  totalCount: IDL.Text,
});

export const PostBucketType = IDL.Record({
  postId: IDL.Text,
  bucketCanisterId: IDL.Text,
  title: IDL.Text,
  subtitle: IDL.Text,
  content: IDL.Text,
  handle: IDL.Text,
  creatorHandle: IDL.Text,
  headerImage: IDL.Text,
  url: IDL.Text,
  wordCount: IDL.Text,
  publishedDate: IDL.Text,
  created: IDL.Text,
  modified: IDL.Text,
  isDraft: IDL.Bool,
  isPremium: IDL.Bool,
  isMembersOnly: IDL.Bool,
  isPublication: IDL.Bool,
  postOwnerPrincipal: IDL.Text,
});

export const Comment = IDL.Rec();
Comment.fill(
  IDL.Record({
    commentId: IDL.Text,
    postId: IDL.Text,
    bucketCanisterId: IDL.Text,
    content: IDL.Text,
    creator: IDL.Text,
    handle: IDL.Text,
    avatar: IDL.Text,
    createdAt: IDL.Text,
    editedAt: IDL.Opt(IDL.Text),
    isCensored: IDL.Bool,
    isVerified: IDL.Bool,
    upVotes: IDL.Vec(IDL.Text),
    downVotes: IDL.Vec(IDL.Text),
    repliedCommentId: IDL.Opt(IDL.Text),
    replies: IDL.Vec(Comment),
  }),
);

export const CommentsReturnType = IDL.Record({
  comments: IDL.Vec(Comment),
  totalNumberOfComments: IDL.Text,
});

export const UserListItem = IDL.Record({
  principal: IDL.Text,
  handle: IDL.Text,
  displayName: IDL.Text,
  avatar: IDL.Text,
  isVerified: IDL.Bool,
});

export const UserProfile = IDL.Record({
  handle: IDL.Text,
  displayName: IDL.Text,
  avatar: IDL.Text,
});

export const TagModel = IDL.Record({
  id: IDL.Text,
  value: IDL.Text,
  createdDate: IDL.Text,
});

const result = <T>(ok: T) => IDL.Variant({ ok: ok as never, err: IDL.Text });

export const postCoreIdl = ({ IDL: I }: { IDL: typeof IDL }) =>
  I.Service({
    getLatestPosts: I.Func([I.Nat32, I.Nat32], [GetPostsByFollowers], ["query"]),
    getPopular: I.Func([I.Nat32, I.Nat32], [GetPostsByFollowers], ["query"]),
    getPopularToday: I.Func([I.Nat32, I.Nat32], [GetPostsByFollowers], ["query"]),
    getPopularThisWeek: I.Func([I.Nat32, I.Nat32], [GetPostsByFollowers], ["query"]),
    getPopularThisMonth: I.Func([I.Nat32, I.Nat32], [GetPostsByFollowers], ["query"]),
    getPostsByPostIds: I.Func([I.Vec(I.Text)], [I.Vec(PostKeyProperties)], ["query"]),
    getPostKeyProperties: I.Func([I.Text], [result(PostKeyProperties)], ["query"]),
    getUserPosts: I.Func([I.Text], [I.Vec(PostKeyProperties)], ["query"]),
    getAllTags: I.Func([], [I.Vec(TagModel)], ["query"]),
    getBucketCanisters: I.Func([], [I.Vec(I.Tuple(I.Text, I.Text))], ["query"]),
    getUserDailyAllowedPostNumber: I.Func([], [I.Nat], ["query"]),
  });

export const postBucketIdl = ({ IDL: I }: { IDL: typeof IDL }) =>
  I.Service({
    getPostsByPostIds: I.Func(
      [I.Vec(I.Text), I.Bool],
      [I.Vec(PostBucketType)],
      ["query"],
    ),
    getPost: I.Func([I.Text], [result(PostBucketType)], ["query"]),
    getPostComments: I.Func([I.Text], [result(CommentsReturnType)], ["query"]),
  });

export const userIdl = ({ IDL: I }: { IDL: typeof IDL }) =>
  I.Service({
    getUsersByPrincipals: I.Func([I.Vec(I.Text)], [I.Vec(UserListItem)], ["query"]),
    getUserByPrincipalId: I.Func([I.Text], [result(UserProfile)], ["query"]),
  });

export const postRelationsIdl = ({ IDL: I }: { IDL: typeof IDL }) =>
  I.Service({
    searchPost: I.Func([I.Text], [I.Vec(I.Text)], ["query"]),
    searchByTag: I.Func([I.Text], [I.Vec(I.Text)], ["query"]),
    getRelatedPosts: I.Func([I.Text], [I.Vec(I.Text)], ["query"]),
  });

/// Nuance runs on IC mainnet only, so these ids are the same whether this
/// Neutron is local or on the IC. That also means the tile can read live Nuance
/// from a local PocketIC deployment, which the backend route could never do.
export const NUANCE_HOST = "https://icp-api.io";
export const POST_CORE_ID = "322sd-3iaaa-aaaaf-qakgq-cai";
export const USER_ID = "rtqeo-eyaaa-aaaaf-qaana-cai";
export const POST_RELATIONS_ID = "qyi2m-xaaaa-aaaaf-qal3a-cai";
