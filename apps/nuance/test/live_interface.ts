// Live interface check against the production Nuance canisters.
//
// This is deliberately outside `npm test`: it needs the network, it reads
// mainnet, and its result depends on a third party we do not control.
//
// What it proves: the *minimal projections* this app decodes with survive real
// Nuance replies. Both halves declare a subset of each record's fields and rely
// on Candid record-width subtyping to ignore the rest. That is the single
// riskiest assumption in this app -- a decode failure surfaces at runtime, not at
// compile time -- so both are pointed at live data.
//
//   * The read half runs `src/nuance/client.ts` itself, unmodified. Since reads
//     moved into the browser, that module is the shipped read path, and a
//     parallel transcription of its IDL here would be the thing most likely to
//     drift out of step with it.
//   * The write half still mirrors `backend/nuance/Types.mo`, which cannot be
//     imported into TypeScript. Its outbound encodings are round-tripped against
//     Nuance's own full declared type rather than sent.
//
// It reads only. It never writes to Nuance, never registers a handle, and never
// publishes.
//
// Run with: npm --workspace neutron-nuance run verify:live

import { Actor, HttpAgent } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";

import * as client from "../src/nuance/client";

const HOST = "https://icp-api.io";
const POST_CORE = "322sd-3iaaa-aaaaf-qakgq-cai";
const USER = "rtqeo-eyaaa-aaaaf-qaana-cai";

let failures = 0;
let checks = 0;

function ok(label: string, detail = ""): void {
  checks += 1;
  console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
}

function bad(label: string, error: unknown): void {
  checks += 1;
  failures += 1;
  console.log(`  FAIL ${label} — ${error instanceof Error ? error.message : String(error)}`);
}

// ---------------------------------------------------------------------------
// Projections mirroring backend/nuance/Types.mo, field for field.
// ---------------------------------------------------------------------------

const PostTagModel = IDL.Record({ tagId: IDL.Text, tagName: IDL.Text });

// `Client.decodeKeyPropertiesList`, used by `nuance_my_posts`.
const PostKeyProperties = IDL.Record({
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

// `Client.decodeComments`, the reply shape of `saveComment` and the vote methods.
const Comment = IDL.Rec();
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

const CommentsReturnType = IDL.Record({
  comments: IDL.Vec(Comment),
  totalNumberOfComments: IDL.Text,
});

// `Client.decodeUserProfile`, the reply shape of `registerUser`.
const UserProfile = IDL.Record({
  handle: IDL.Text,
  displayName: IDL.Text,
  avatar: IDL.Text,
});

const PremiumSaveModel = IDL.Record({
  icpPrice: IDL.Nat,
  maxSupply: IDL.Nat,
  thumbnail: IDL.Text,
});

const PostSaveModel = IDL.Record({
  postId: IDL.Text,
  title: IDL.Text,
  subtitle: IDL.Text,
  content: IDL.Text,
  category: IDL.Text,
  handle: IDL.Text,
  creatorHandle: IDL.Text,
  headerImage: IDL.Text,
  isDraft: IDL.Bool,
  isMembersOnly: IDL.Bool,
  isPublication: IDL.Bool,
  premium: IDL.Opt(PremiumSaveModel),
  scheduledPublishedDate: IDL.Opt(IDL.Int),
  tagIds: IDL.Vec(IDL.Text),
});

const SaveCommentModel = IDL.Record({
  postId: IDL.Text,
  content: IDL.Text,
  commentId: IDL.Opt(IDL.Text),
  replyToCommentId: IDL.Opt(IDL.Text),
});

// Nuance's own declared shapes, transcribed from its generated .did. Used only
// to prove that the bytes this app would send are decodable by the real callee.
const NuancePostSaveModel = IDL.Record({
  category: IDL.Text,
  content: IDL.Text,
  creatorHandle: IDL.Text,
  handle: IDL.Text,
  headerImage: IDL.Text,
  isDraft: IDL.Bool,
  isMembersOnly: IDL.Bool,
  isPublication: IDL.Bool,
  postId: IDL.Text,
  premium: IDL.Opt(
    IDL.Record({ icpPrice: IDL.Nat, maxSupply: IDL.Nat, thumbnail: IDL.Text }),
  ),
  scheduledPublishedDate: IDL.Opt(IDL.Int),
  subtitle: IDL.Text,
  tagIds: IDL.Vec(IDL.Text),
  title: IDL.Text,
});

const NuanceSaveCommentModel = IDL.Record({
  commentId: IDL.Opt(IDL.Text),
  content: IDL.Text,
  postId: IDL.Text,
  replyToCommentId: IDL.Opt(IDL.Text),
});

const okErr = (t: IDL.Type) => IDL.Variant({ ok: t, err: IDL.Text });

async function main(): Promise<void> {
  // ---------------------------------------------------------------- reads
  //
  // These call `src/nuance/client.ts` directly: the module the tile and the
  // resident background ship. Nothing is transcribed, so nothing can drift.

  console.log("Browser read path (src/nuance/client.ts)");

  let sampleId = "";
  let sampleBucket = "";
  let candidates: { postId: string; bucketCanisterId: string }[] = [];

  try {
    const page = await client.feedIndex("latest", 0, 5);
    if (page.posts.length === 0) throw new Error("no posts returned");
    candidates = page.posts;
    sampleId = page.posts[0]!.postId;
    sampleBucket = page.posts[0]!.bucketCanisterId;
    ok("feedIndex(latest)", `${page.posts.length} rows, totalCount ${page.totalCount}`);
  } catch (error) {
    bad("feedIndex(latest)", error);
    console.log("");
    console.log("Cannot continue without a sample post.");
    process.exit(1);
  }

  try {
    const page = await client.feedIndex("popular_week", 0, 3);
    ok("feedIndex(popular_week)", `${page.posts.length} rows`);
  } catch (error) {
    bad("feedIndex(popular_week)", error);
  }

  try {
    const keys = await client.keyPropertiesFor([sampleId]);
    ok("keyPropertiesFor", `${keys.length} rows`);
  } catch (error) {
    bad("keyPropertiesFor", error);
  }

  try {
    const bodies = await client.hydrate(candidates as never);
    // Nuance strips the body in list mode; the two-phase read depends on that.
    const stripped = bodies.every((body) => body.content === "");
    const titled = bodies.filter((body) => body.title !== "").length;
    ok("hydrate", `${bodies.length} bodies, ${titled} titled, list mode strips body: ${stripped}`);
    if (!stripped) {
      console.log("       note: list mode returned a body; the two-phase read assumption changed");
    }
  } catch (error) {
    bad("hydrate", error);
  }

  // The index can retain inaccessible/deleted posts. A decoded protocol error
  // is not Candid drift; continue to a readable post and use it for comments.
  try {
    let readable = 0;
    let decoded = 0;
    for (const candidate of candidates.slice(0, 5)) {
      let body: client.BucketPost;
      try {
        body = await client.getArticle(candidate.bucketCanisterId, candidate.postId);
      } catch (error) {
        if (error instanceof Error && ["Unauthorized", "Article not found"].includes(error.message)) {
          console.log(`       skipped post ${candidate.postId}: ${error.message}`);
          continue;
        }
        throw error;
      }
      decoded += 1;
      sampleId = candidate.postId;
      sampleBucket = candidate.bucketCanisterId;
      if (body.content.length > 0) {
        readable = body.content.length;
        break;
      }
    }
    if (decoded === 0) throw new Error("No accessible article in the sample; success projection was not tested.");
    ok(
      "getArticle",
      readable > 0
        ? `full body readable, ${readable} chars`
        : `${decoded} decoded, all bodies withheld (members-only or premium)`,
    );
  } catch (error) {
    bad("getArticle", error);
  }

  try {
    const page = await client.getComments(sampleBucket, sampleId);
    ok("getComments", `${page.totalNumberOfComments} comments`);
  } catch (error) {
    bad("getComments", error);
  }

  for (const [label, call] of [
    ["getTags", () => client.getTags()],
    ["getBuckets", () => client.getBuckets()],
    ["search", () => client.search("bitcoin")],
    ["relatedPosts", () => client.relatedPosts(sampleId)],
    [
      "profilesFor",
      () =>
        client.profilesFor([
          "t37fy-3gkiy-2ozje-knths-5uxm2-ij766-qw5x7-cge2s-67hov-szsju-fae",
        ]),
    ],
  ] as const) {
    try {
      ok(label, `${(await call()).length} entries`);
    } catch (error) {
      bad(label, error);
    }
  }

  try {
    ok("dailyAllowance", await client.dailyAllowance());
  } catch (error) {
    bad("dailyAllowance", error);
  }

  try {
    // An unregistered principal is the normal pre-registration state. It must
    // come back as null, not throw: that is what the account view renders.
    const profile = await client.profileFor("aaaaa-aa");
    ok("profileFor", profile === null ? "null for a stranger (expected)" : "registered");
  } catch (error) {
    bad("profileFor", error);
  }

  // -------------------------------------------------- backend projections
  //
  // These shapes are decoded in Motoko, which cannot be imported here, so they
  // are transcribed from `backend/nuance/Types.mo` and pointed at the public
  // methods that return the same records the write path gets back.

  console.log("Backend decode projections (backend/nuance/Types.mo)");

  const agent = await HttpAgent.create({ host: HOST });

  const core = Actor.createActor(
    ({ IDL: I }) =>
      I.Service({
        getPostsByPostIds: I.Func([I.Vec(I.Text)], [I.Vec(PostKeyProperties)], ["query"]),
      }),
    { agent, canisterId: POST_CORE },
  ) as Record<string, (...args: never[]) => Promise<never>>;

  const user = Actor.createActor(
    ({ IDL: I }) =>
      I.Service({
        getUserByPrincipalId: I.Func([I.Text], [okErr(UserProfile)], ["query"]),
      }),
    { agent, canisterId: USER },
  ) as Record<string, (...args: never[]) => Promise<never>>;

  const bucket = Actor.createActor(
    ({ IDL: I }) =>
      I.Service({
        getPostComments: I.Func([I.Text], [okErr(CommentsReturnType)], ["query"]),
      }),
    { agent, canisterId: sampleBucket },
  ) as Record<string, (...args: never[]) => Promise<never>>;

  try {
    const rows = (await core.getPostsByPostIds!([sampleId] as never)) as unknown as unknown[];
    ok("PostKeyProperties (nuance_my_posts)", `${rows.length} rows`);
  } catch (error) {
    bad("PostKeyProperties (nuance_my_posts)", error);
  }

  try {
    const result = (await bucket.getPostComments!(sampleId as never)) as unknown as
      | { ok: { totalNumberOfComments: string } }
      | { err: string };
    ok(
      "CommentsReturnType (nuance_comment, nuance_vote_comment)",
      "ok" in result ? `${result.ok.totalNumberOfComments} comments` : `err: ${result.err}`,
    );
  } catch (error) {
    bad("CommentsReturnType (nuance_comment, nuance_vote_comment)", error);
  }

  try {
    const result = (await user.getUserByPrincipalId!("aaaaa-aa" as never)) as unknown as
      | { ok: unknown }
      | { err: string };
    ok(
      "UserProfile (nuance_register)",
      "ok" in result ? "registered" : "err (expected for a stranger)",
    );
  } catch (error) {
    bad("UserProfile (nuance_register)", error);
  }

  console.log("Write-path encodings (encoded locally, never sent)");

  try {
    // The bytes this app would send for a personal published post.
    const bytes = IDL.encode(
      [PostSaveModel],
      [
        {
          postId: "",
          title: "Interface check",
          subtitle: "",
          content: "<p>body</p>",
          category: "",
          handle: "example",
          creatorHandle: "",
          headerImage: "",
          isDraft: true,
          isMembersOnly: false,
          isPublication: false,
          premium: [],
          scheduledPublishedDate: [],
          tagIds: ["1"],
        },
      ],
    );
    // Decoding with Nuance's own declared type proves the callee accepts them.
    IDL.decode([NuancePostSaveModel], bytes);
    ok("PostSaveModel encodes to Nuance's declared shape");
  } catch (error) {
    bad("PostSaveModel encoding", error);
  }

  try {
    const bytes = IDL.encode(
      [SaveCommentModel],
      [{ postId: "1", content: "hi", commentId: [], replyToCommentId: [] }],
    );
    IDL.decode([NuanceSaveCommentModel], bytes);
    ok("SaveCommentModel encodes to Nuance's declared shape");
  } catch (error) {
    bad("SaveCommentModel encoding", error);
  }

  console.log("");
  console.log(`${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.log("Nuance's interface no longer matches this app's projections.");
    process.exit(1);
  }
}

await main();
