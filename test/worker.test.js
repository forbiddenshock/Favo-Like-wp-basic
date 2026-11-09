import test from "node:test";
import assert from "node:assert/strict";
import {
  formatTweetBodyHtml,
  normalizeFavoTimelineResponse,
  normalizeLikedTweetsResponse,
  buildSinglePostSlug,
  buildSinglePostTitle,
  buildSingleArticleHtml,
  buildMergedMarkdownDocument,
  fetchFavoLikePosts
} from "../src/worker.js";

test("normalizeFavoTimelineResponse filters out normal/reply posts and keeps only RTs and Quotes with media", () => {
  const sampleTimelineData = {
    data: [
      {
        id: "1001",
        created_at: "2026-11-08T17:30:00.000Z",
        text: "これは通常のポストなので除外されるべき"
      },
      {
        id: "1002",
        created_at: "2026-11-08T18:00:00.000Z",
        text: "@someone これは通常のリプライなので除外されるべき",
        referenced_tweets: [{ type: "replied_to", id: "900" }]
      },
      {
        id: "1003",
        created_at: "2026-11-08T19:00:00.000Z",
        text: "引用コメント\n\n2段落目",
        referenced_tweets: [{ type: "quoted", id: "2001" }]
      },
      {
        id: "1004",
        created_at: "2026-11-08T20:00:00.000Z",
        text: "RT @rt_author: RT元のポスト本文",
        referenced_tweets: [{ type: "retweeted", id: "2002" }]
      }
    ],
    includes: {
      media: [
        {
          media_key: "3_2001",
          type: "video",
          preview_image_url: "https://pbs.twimg.com/media/video_thumb.jpg",
          variants: [
            { bit_rate: 832000, content_type: "video/mp4", url: "https://video.twimg.com/quoted_vid.mp4" }
          ]
        },
        {
          media_key: "3_2002",
          type: "photo",
          url: "https://pbs.twimg.com/media/rt_img.jpg"
        }
      ],
      users: [
        { id: "u_quote", username: "quoted_user" },
        { id: "u_rt", username: "rt_author" }
      ],
      tweets: [
        {
          id: "2001",
          author_id: "u_quote",
          text: "引用元ツイート本文",
          attachments: { media_keys: ["3_2001"] }
        },
        {
          id: "2002",
          author_id: "u_rt",
          text: "RT元のポスト本文全文",
          attachments: { media_keys: ["3_2002"] }
        }
      ]
    }
  };

  const posts = normalizeFavoTimelineResponse(sampleTimelineData, "showya_kiss", {
    timeZone: "Asia/Tokyo",
    includeQuotes: true,
    includeRetweets: true
  });

  // 通常ポスト(1001)とリプライ(1002)は除外され、引用(1003)とRT(1004)の2件だけ残ること
  assert.equal(posts.length, 2);

  // 引用ポスト (1003)
  assert.equal(posts[0].id, "1003");
  assert.equal(posts[0].favoType, "quote");
  assert.equal(posts[0].referencedPost.username, "quoted_user");
  assert.equal(posts[0].referencedPost.media[0].type, "video");
  assert.equal(posts[0].referencedPost.media[0].url, "https://video.twimg.com/quoted_vid.mp4");
  assert.equal(buildSinglePostSlug(posts[0]), "x-favo-quote-1003");
  assert.ok(buildSinglePostTitle(posts[0]).startsWith("[引用] @quoted_user:"));

  const quoteArticleHtml = buildSingleArticleHtml(posts[0]);
  assert.ok(quoteArticleHtml.includes("💬 引用"));
  assert.ok(quoteArticleHtml.includes('<p style="margin: 0 0 1em 0;">引用コメント</p>'));
  assert.ok(quoteArticleHtml.includes('<video controls playsinline preload="metadata"'));

  // RTポスト (1004)
  assert.equal(posts[1].id, "1004");
  assert.equal(posts[1].favoType, "rt");
  assert.equal(posts[1].media.length, 1);
  assert.equal(posts[1].media[0].url, "https://pbs.twimg.com/media/rt_img.jpg");
  assert.equal(buildSinglePostSlug(posts[1]), "x-favo-rt-1004");
  assert.ok(buildSinglePostTitle(posts[1]).startsWith("[RT] @rt_author: RT元のポスト本文全文"));
});

test("normalizeLikedTweetsResponse normalizes liked posts with author and media for 1-post-1-article", () => {
  const sampleLikedData = {
    data: [
      {
        id: "5001",
        author_id: "u_liked",
        created_at: "2026-11-08T21:15:00.000Z",
        text: "素敵なイラストを投稿しました！ https://t.co/xxx",
        attachments: { media_keys: ["3_5001"] }
      }
    ],
    includes: {
      users: [{ id: "u_liked", username: "illust_creator", name: "絵師さん" }],
      media: [
        {
          media_key: "3_5001",
          type: "photo",
          url: "https://pbs.twimg.com/media/illust1.png"
        }
      ],
      tweets: []
    }
  };

  const likedPosts = normalizeLikedTweetsResponse(sampleLikedData, { timeZone: "Asia/Tokyo" });
  assert.equal(likedPosts.length, 1);

  const p = likedPosts[0];
  assert.equal(p.id, "5001");
  assert.equal(p.favoType, "like");
  assert.equal(p.username, "illust_creator");
  assert.equal(p.media[0].url, "https://pbs.twimg.com/media/illust1.png");
  assert.equal(buildSinglePostSlug(p), "x-favo-like-5001");
  assert.equal(buildSinglePostTitle(p), "[いいね] @illust_creator: 素敵なイラストを投稿しました！");

  const html = buildSingleArticleHtml(p);
  assert.ok(html.includes("♥ いいね"));
  assert.ok(html.includes("@illust_creator"));
  assert.ok(html.includes("https://pbs.twimg.com/media/illust1.png"));

  const mdDoc = buildMergedMarkdownDocument("Favo Log", "", [p]);
  assert.ok(mdDoc.content.includes("[いいね]"));
  assert.ok(!mdDoc.content.includes("illust1.png"));
});

test("fetchFavoLikePosts retries public X API calls with OAuth 1.0a after a Bearer 401", async (t) => {
  const authorizationHeaders = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    authorizationHeaders.push(options.headers.Authorization);
    if (authorizationHeaders.length === 1) {
      return new Response(JSON.stringify({ title: "Unauthorized" }), { status: 401 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });

  const result = await fetchFavoLikePosts({
    X_USERNAME: "test_user",
    X_USER_ID: "123",
    X_BEARER_TOKEN: "valid-bearer-token",
    X_API_KEY: "api-key",
    X_API_SECRET: "api-secret",
    X_ACCESS_TOKEN: "access-token",
    X_ACCESS_SECRET: "access-secret",
    INCLUDE_LIKES: "false"
  });

  assert.deepEqual(result.posts, []);
  assert.equal(authorizationHeaders.length, 2);
  assert.ok(authorizationHeaders[0].startsWith("Bearer "));
  assert.ok(authorizationHeaders[1].startsWith("OAuth "));
});

test("fetchFavoLikePosts does not use a Bearer token for the liked-tweets endpoint", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    assert.fail("A user-context request must not be sent with the app-only Bearer token");
  });

  const result = await fetchFavoLikePosts({
    X_USERNAME: "test_user",
    X_USER_ID: "123",
    X_BEARER_TOKEN: "app-only-token",
    INCLUDE_RETWEETS: "false",
    INCLUDE_QUOTES: "false"
  });

  assert.deepEqual(result.posts, []);
  assert.match(result.warnings[0], /OAuth 1\.0a認証情報が必要/);
});
