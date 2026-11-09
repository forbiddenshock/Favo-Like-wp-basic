/**
 * favo-like-wp-basic - Cloudflare Worker
 *
 * 1. Cloudflare Cron Triggers で定期実行（最短1分おき）
 * 2. X API v2 からユーザーの「いいね (Likes)」「RT (Reposts)」「引用 (Quotes)」を取得
 * 3. ポスト内の画像・動画をダウンロードして WordPress メディアライブラリへ保存（リンク切れ対策）
 * 4. 該当ポストを「1ポスト＝1記事」として WordPress に作成・保管（REST API + XML-RPC 自動フォールバック対応）
 * 5. (オプション) GitHub リポジトリへ Markdown ファイル（YearYYYY.md / MonthYYYYMM.md / Fulldata.md）として保存
 *
 * ※ 将来的に x-logger-extra や favo-like-ed-basic (EmDash版) へそのまま統合できるモジュール構成になっています。
 */

export const X_FAVO_STYLE = `<style>
    .x-log-day-container { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .x-log-post { border: 1px solid #e1e8ed; border-radius: 8px; padding: 14px; margin-bottom: 16px; background: #fff; }
    .x-log-header { font-size: 0.85em; color: #657786; margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .x-log-header a { color: #1da1f2; text-decoration: none; font-weight: 600; }
    .x-favo-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.8em; font-weight: bold; color: #fff; }
    .x-favo-badge-like { background: #e0245e; }
    .x-favo-badge-rt { background: #17bf63; }
    .x-favo-badge-quote { background: #1da1f2; }
    .x-log-body { font-size: 1.0em; line-height: 1.55; color: #14171a; word-break: break-word; }
    .x-log-body p { margin: 0 0 1em 0; }
    .x-log-body p:last-child { margin-bottom: 0; }
    .x-log-media { margin-top: 10px; }
    .x-log-media img, .x-log-media video { max-width: 100%; height: auto; border-radius: 6px; margin-top: 4px; display: block; }
    .x-log-quoted { border: 1px solid #ccd6dd; border-radius: 6px; margin: 10px 1.5em; padding: 10px 1.5em; background: #f5f8fa; }
    .x-log-quoted-header { font-weight: bold; font-size: 0.85em; color: #555; margin-bottom: 4px; }
  </style>`;

// ============================================================================
// ユーティリティ関数（エスケープ・日時変換・OAuth 1.0a 署名）
// ============================================================================

export function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * ツイート本文の改行を整形：
 * - 二重改行（空行）は段落 <p style="margin: 0 0 1em 0;">...</p> として維持
 * - 単一改行は <br /> に変換
 */
export function formatTweetBodyHtml(text) {
  const normalized = String(text || "")
    .trim()
    .replace(/\r\n|\r/g, "\n");
  if (!normalized) return "";

  const paragraphs = normalized.split(/\n{2,}/);
  if (paragraphs.length === 1) {
    return escapeHtml(paragraphs[0]).replace(/\n/g, "<br />\n");
  }

  return paragraphs
    .map((para, idx) => {
      const inner = escapeHtml(para).replace(/\n/g, "<br />\n");
      const margin = idx < paragraphs.length - 1 ? "0 0 1em 0" : "0";
      return `<p style="margin: ${margin};">${inner}</p>`;
    })
    .join("\n");
}

/**
 * ISO日時文字列を指定タイムゾーン（デフォルト Asia/Tokyo）の YYYY-MM-DD と HH:MM:SS に変換
 */
export function formatInTimezone(isoDateStr, timeZone = "Asia/Tokyo") {
  const date = isoDateStr ? new Date(isoDateStr) : new Date();
  const validDate = isNaN(date.getTime()) ? new Date() : date;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(validDate);

  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }
  const hour = map.hour === "24" ? "00" : map.hour;
  const dateStr = `${map.year}-${map.month}-${map.day}`;
  const timeStr = `${hour}:${map.minute}`;
  const isoLocal = `${dateStr}T${hour}:${map.minute}:${map.second || "00"}`;
  return {
    dateStr,
    timeStr,
    isoLocal,
    yearStr: map.year,
    yearMonthStr: `${map.year}${map.month}`
  };
}

function rfc3986Encode(str) {
  return encodeURIComponent(String(str)).replace(/[!'()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * Web Crypto API を用いた OAuth 1.0a Authorization ヘッダー生成
 * （X API v2 で「いいね (liked_tweets)」を取得する際の User Context 認証に必須）
 */
async function buildOAuth1Header(method, urlObj, credentials) {
  const oauthParams = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0"
  };

  const allParams = [];
  for (const [k, v] of urlObj.searchParams.entries()) {
    allParams.push([rfc3986Encode(k), rfc3986Encode(v)]);
  }
  for (const [k, v] of Object.entries(oauthParams)) {
    allParams.push([rfc3986Encode(k), rfc3986Encode(v)]);
  }

  allParams.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const paramString = allParams.map(([k, v]) => `${k}=${v}`).join("&");
  const baseUrl = `${urlObj.origin}${urlObj.pathname}`;
  const signatureBase = `${method.toUpperCase()}&${rfc3986Encode(baseUrl)}&${rfc3986Encode(paramString)}`;
  const signingKey = `${rfc3986Encode(credentials.apiSecret)}&${rfc3986Encode(credentials.accessSecret)}`;

  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(signatureBase));
  const sigBytes = new Uint8Array(sigBuffer);
  let sigBinary = "";
  for (let i = 0; i < sigBytes.length; i++) {
    sigBinary += String.fromCharCode(sigBytes[i]);
  }
  oauthParams.oauth_signature = btoa(sigBinary);

  const headerParts = Object.entries(oauthParams)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${rfc3986Encode(k)}="${rfc3986Encode(v)}"`)
    .join(", ");

  return `OAuth ${headerParts}`;
}

export function hasOAuth1Credentials(env) {
  return Boolean(
    env.X_API_KEY?.trim() &&
      env.X_API_SECRET?.trim() &&
      env.X_ACCESS_TOKEN?.trim() &&
      env.X_ACCESS_SECRET?.trim()
  );
}

/**
 * X API v2 認証（公開 API は Bearer 優先、401時に OAuth 1.0a を再試行。User Context は OAuth 1.0a 固定）
 */
async function xApiFetch(urlStr, env, options = {}) {
  const urlObj = new URL(urlStr);
  const hasOAuth1 = hasOAuth1Credentials(env);
  const authMethods = options.requireUserContext
    ? hasOAuth1
      ? ["oauth1"]
      : []
    : [env.X_BEARER_TOKEN?.trim() ? "bearer" : "", hasOAuth1 ? "oauth1" : ""].filter(Boolean);

  if (authMethods.length === 0) {
    if (options.requireUserContext) {
      throw new Error(
        "いいね(liked_tweets)の取得には X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET のOAuth 1.0a認証情報が必要です。"
      );
    }
    throw new Error(
      "X API の認証情報が設定されていません。X_BEARER_TOKEN または OAuth 1.0a 4キーを設定してください。"
    );
  }

  for (const [index, authMethod] of authMethods.entries()) {
    let authHeader;
    if (authMethod === "oauth1") {
      authHeader = await buildOAuth1Header("GET", urlObj, {
        apiKey: env.X_API_KEY.trim(),
        apiSecret: env.X_API_SECRET.trim(),
        accessToken: env.X_ACCESS_TOKEN.trim(),
        accessSecret: env.X_ACCESS_SECRET.trim()
      });
    } else {
      let token = env.X_BEARER_TOKEN.trim();
      if (token.includes("%")) {
        try {
          token = decodeURIComponent(token);
        } catch {
          // Keep the configured token unchanged if it is not valid percent-encoding.
        }
      }
      authHeader = `Bearer ${token}`;
    }

    const res = await fetch(urlObj.toString(), {
      method: "GET",
      headers: {
        Authorization: authHeader,
        "User-Agent": "favo-like-wp-worker/1.0"
      }
    });

    if (res.ok) return res.json();
    if (res.status === 401 && index < authMethods.length - 1) {
      await res.text();
      continue;
    }

    const bodyText = await res.text();
    throw new Error(
      `X API Error (${res.status}, ${authMethod}, ${urlObj.pathname}): ${bodyText}`
    );
  }
}

async function resolveXUser(env) {
  const rawUsername = (env.X_USERNAME || "").trim().replace(/^@/, "");
  if (env.X_USER_ID && rawUsername) {
    return { userId: String(env.X_USER_ID).trim(), username: rawUsername };
  }
  if (!rawUsername) {
    throw new Error("X_USERNAME が設定されていません。");
  }

  const url = `https://api.x.com/2/users/by/username/${encodeURIComponent(rawUsername)}`;
  const data = await xApiFetch(url, env);
  if (!data?.data?.id) {
    throw new Error(`Xユーザー @${rawUsername} のIDが取得できませんでした。`);
  }
  return { userId: data.data.id, username: data.data.username || rawUsername };
}

// ============================================================================
// メディア抽出・ポスト正規化（いいね / RT / 引用 対応）
// ============================================================================

function extractMediaDescriptor(m) {
  if (!m) return null;
  if (m.type === "video" || m.type === "animated_gif") {
    const variants = Array.isArray(m.variants) ? m.variants : [];
    const mp4Variants = variants
      .filter((v) => v.content_type === "video/mp4" && v.url)
      .sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));

    if (mp4Variants.length > 0) {
      return {
        mediaKey: m.media_key,
        type: "video",
        url: mp4Variants[0].url,
        fallbackUrls: mp4Variants.slice(1).map((v) => v.url),
        posterUrl: m.preview_image_url || m.url || "",
        alt: m.alt_text || "Post Video"
      };
    }
    if (m.preview_image_url || m.url) {
      return {
        mediaKey: m.media_key,
        type: "photo",
        url: m.preview_image_url || m.url,
        alt: m.alt_text || "Post Media"
      };
    }
    return null;
  }

  const photoUrl = m.url || m.preview_image_url;
  if (!photoUrl) return null;
  return {
    mediaKey: m.media_key,
    type: "photo",
    url: photoUrl,
    alt: m.alt_text || "Post Media"
  };
}

function collectMediaForTweet(tweetObj, mediaMap) {
  if (!tweetObj) return [];
  const keys = tweetObj?.attachments?.media_keys || [];
  const list = [];
  const seenKeys = new Set();

  for (const key of keys) {
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const desc = extractMediaDescriptor(mediaMap.get(key));
    if (desc) {
      list.push({ ...desc });
    }
  }
  return list;
}

function resolveFullTweetText(tweetObj) {
  if (!tweetObj) return "";
  return tweetObj?.note_tweet?.text || tweetObj?.text || "";
}

/**
 * タイムラインの取得結果から「RT (retweeted)」と「引用 (quoted)」のみを抽出して正規化する
 */
export function normalizeFavoTimelineResponse(apiData, ownerUsername, options = {}) {
  const timeZone = options.timeZone || "Asia/Tokyo";
  const includeQuotes = options.includeQuotes !== false;
  const includeRetweets = options.includeRetweets !== false;

  const rawTweets = apiData?.data || [];
  const includes = apiData?.includes || {};
  const mediaMap = new Map((includes.media || []).map((m) => [m.media_key, m]));
  const userMap = new Map((includes.users || []).map((u) => [u.id, u]));
  const tweetMap = new Map((includes.tweets || []).map((t) => [t.id, t]));

  const normalized = [];

  for (const tweet of rawTweets) {
    const refs = tweet.referenced_tweets || [];
    const isRetweet = refs.some((r) => r.type === "retweeted");
    const isQuote = refs.some((r) => r.type === "quoted");

    // このツールでは「RT」と「引用」のみを対象とする（通常の単独ポストや単純リプライはスキップ）
    if (!isRetweet && !isQuote) continue;
    if (isRetweet && !includeRetweets) continue;
    if (isQuote && !isRetweet && !includeQuotes) continue;

    const favoType = isRetweet ? "rt" : "quote";
    const { dateStr, timeStr, isoLocal, yearStr, yearMonthStr } = formatInTimezone(
      tweet.created_at,
      timeZone
    );

    const refEntry =
      refs.find((r) => r.type === "retweeted") || refs.find((r) => r.type === "quoted");

    let referencedPost = null;
    let refTweet = null;
    if (refEntry) {
      refTweet = tweetMap.get(refEntry.id);
      if (refTweet) {
        const refAuthor = userMap.get(refTweet.author_id);
        const refUsername = refAuthor?.username || "unknown";
        const refMedia = collectMediaForTweet(refTweet, mediaMap);

        for (const nestedRef of refTweet.referenced_tweets || []) {
          const nestedTweet = tweetMap.get(nestedRef.id);
          if (nestedTweet) {
            for (const nm of collectMediaForTweet(nestedTweet, mediaMap)) {
              if (!refMedia.some((existing) => existing.url === nm.url)) {
                refMedia.push({ ...nm });
              }
            }
          }
        }

        referencedPost = {
          type: refEntry.type,
          id: refTweet.id,
          username: refUsername,
          name: refAuthor?.name || refUsername,
          text: resolveFullTweetText(refTweet),
          media: refMedia
        };
      }
    }

    const mediaList = collectMediaForTweet(tweet, mediaMap);
    if (isRetweet && referencedPost && Array.isArray(referencedPost.media)) {
      for (const rm of referencedPost.media) {
        if (!mediaList.some((existing) => existing.url === rm.url)) {
          mediaList.push({ ...rm });
        }
      }
    }

    normalized.push({
      id: tweet.id,
      favoType, // "rt" | "quote"
      username: ownerUsername,
      createdAt: tweet.created_at,
      dateStr,
      timeStr,
      isoLocal,
      yearStr,
      yearMonthStr,
      text: resolveFullTweetText(tweet),
      media: mediaList,
      referencedPost
    });
  }

  return normalized;
}

/**
 * いいね一覧 API (/2/users/:id/liked_tweets) の結果を正規化する
 */
export function normalizeLikedTweetsResponse(apiData, options = {}) {
  const timeZone = options.timeZone || "Asia/Tokyo";
  const rawTweets = apiData?.data || [];
  const includes = apiData?.includes || {};
  const mediaMap = new Map((includes.media || []).map((m) => [m.media_key, m]));
  const userMap = new Map((includes.users || []).map((u) => [u.id, u]));
  const tweetMap = new Map((includes.tweets || []).map((t) => [t.id, t]));

  const normalized = [];

  for (const tweet of rawTweets) {
    const author = userMap.get(tweet.author_id);
    const authorUsername = author?.username || "unknown";
    const { dateStr, timeStr, isoLocal, yearStr, yearMonthStr } = formatInTimezone(
      tweet.created_at,
      timeZone
    );

    const refs = tweet.referenced_tweets || [];
    const refEntry =
      refs.find((r) => r.type === "quoted") ||
      refs.find((r) => r.type === "replied_to") ||
      refs[0];

    let referencedPost = null;
    if (refEntry) {
      const refTweet = tweetMap.get(refEntry.id);
      if (refTweet) {
        const refAuthor = userMap.get(refTweet.author_id);
        const refUsername = refAuthor?.username || "unknown";
        referencedPost = {
          type: refEntry.type,
          id: refTweet.id,
          username: refUsername,
          name: refAuthor?.name || refUsername,
          text: resolveFullTweetText(refTweet),
          media: collectMediaForTweet(refTweet, mediaMap)
        };
      }
    }

    normalized.push({
      id: tweet.id,
      favoType: "like",
      username: authorUsername,
      authorName: author?.name || authorUsername,
      createdAt: tweet.created_at,
      dateStr,
      timeStr,
      isoLocal,
      yearStr,
      yearMonthStr,
      text: resolveFullTweetText(tweet),
      media: collectMediaForTweet(tweet, mediaMap),
      referencedPost
    });
  }

  return normalized;
}

// ============================================================================
// 1ポスト＝1記事のスラッグ・タイトル・HTML 生成
// ============================================================================

/**
 * 1ポスト＝1記事の一意スラッグを生成（重複投稿防止用）
 */
export function buildSinglePostSlug(post) {
  const type = post.favoType || "post";
  return `x-favo-${type}-${post.id}`;
}

/**
 * 1ポスト＝1記事のわかりやすいタイトルを生成
 */
export function buildSinglePostTitle(post) {
  const typeLabel =
    post.favoType === "like" ? "[いいね]" : post.favoType === "rt" ? "[RT]" : "[引用]";

  let targetUser = post.username;
  let sourceText = post.text || "";

  if (post.favoType === "rt" && post.referencedPost) {
    targetUser = post.referencedPost.username || post.username;
    sourceText = post.referencedPost.text || post.text || "";
  } else {
    sourceText = sourceText.replace(/^RT @[A-Za-z0-9_]+:\s*/i, "");
  }

  const cleanSnippet = sourceText
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 42);

  const summary = cleanSnippet
    ? `${cleanSnippet}${sourceText.length > 42 ? "…" : ""}`
    : post.dateStr;

  if (post.favoType === "quote" && post.referencedPost) {
    return `${typeLabel} @${post.referencedPost.username}: ${summary}`;
  }
  return `${typeLabel} @${targetUser}: ${summary}`;
}

function renderMediaHtml(mediaArray) {
  if (!mediaArray || mediaArray.length === 0) return "";
  const itemsHtml = mediaArray
    .map((m) => {
      const src = escapeHtml(m.wpUrl || m.url);
      if (m.type === "video") {
        const posterAttr =
          m.wpPosterUrl || m.posterUrl
            ? ` poster="${escapeHtml(m.wpPosterUrl || m.posterUrl)}"`
            : "";
        return `        <video controls playsinline preload="metadata" src="${src}"${posterAttr} style="max-width: 100%; height: auto; border-radius: 6px; margin-top: 4px;"><source src="${src}" type="video/mp4" /><a href="${src}" target="_blank" rel="noopener">動画を表示</a></video>`;
      }
      return `        <a href="${src}" target="_blank" rel="noopener"><img decoding="async" src="${src}" alt="${escapeHtml(m.alt || "Post Media")}" loading="lazy" /></a>`;
    })
    .join("<br />\n");

  return `\n    <div class="x-log-media">\n${itemsHtml}\n    </div>`;
}

/**
 * 1ポスト分のカード HTML を生成
 */
export function renderSinglePostHtml(post) {
  const postUrl = `https://x.com/${encodeURIComponent(post.username)}/status/${encodeURIComponent(post.id)}`;
  const bodyHtml = formatTweetBodyHtml(post.text);
  const mediaHtml = renderMediaHtml(post.media);

  const badgeClass =
    post.favoType === "like"
      ? "x-favo-badge x-favo-badge-like"
      : post.favoType === "rt"
        ? "x-favo-badge x-favo-badge-rt"
        : "x-favo-badge x-favo-badge-quote";
  const badgeText =
    post.favoType === "like" ? "♥ いいね" : post.favoType === "rt" ? "🔁 RT" : "💬 引用";

  let quotedHtml = "";
  if (post.referencedPost) {
    const ref = post.referencedPost;
    const refUrl = `https://x.com/${encodeURIComponent(ref.username)}/status/${encodeURIComponent(ref.id)}`;
    const refBodyHtml = formatTweetBodyHtml(ref.text);
    const refMediaHtml = renderMediaHtml(ref.media);
    quotedHtml = `\n    <div class="x-log-quoted">
      <div class="x-log-quoted-header">@${escapeHtml(ref.username)} のポスト (<a href="${refUrl}" target="_blank" rel="noopener">元ポスト</a>):</div>
      <div class="x-log-body" style="word-break: break-word;">${refBodyHtml}</div>${refMediaHtml}
    </div>`;
  }

  return `  <div class="x-log-post" id="x-post-${escapeHtml(post.id)}" data-favo-type="${escapeHtml(post.favoType || "post")}">
    <div class="x-log-header">
      <span class="${badgeClass}">${badgeText}</span>
      <span><strong>@${escapeHtml(post.username)}</strong></span>
      <a href="${postUrl}" target="_blank" rel="noopener">${escapeHtml(post.dateStr)} ${escapeHtml(post.timeStr)} (元ポスト)</a>
    </div>
    <div class="x-log-body" style="word-break: break-word;">${bodyHtml}</div>${mediaHtml}${quotedHtml}
  </div>`;
}

/**
 * 1ポスト＝1記事として WordPress に保存する記事本文 HTML を生成
 */
export function buildSingleArticleHtml(post) {
  const blockHtml = renderSinglePostHtml(post);
  return `<div class="x-log-day-container" data-post-id="${escapeHtml(post.id)}" data-favo-type="${escapeHtml(post.favoType || "post")}">\n  ${X_FAVO_STYLE}\n${blockHtml}\n</div>`;
}

// ============================================================================
// WordPress REST API & XML-RPC クライアント（メディア保存＆1ポスト1記事保存）
// ============================================================================

function getWpCredentials(env) {
  const user = (env.WP_USERNAME || "").trim();
  const pass = (env.WP_APP_PASSWORD || "").trim().replace(/\s+/g, "");
  if (!user || !pass) {
    throw new Error("WP_USERNAME または WP_APP_PASSWORD が設定されていません。");
  }
  return { user, pass };
}

function getWpAuthHeader(env) {
  const { user, pass } = getWpCredentials(env);
  const token = btoa(`${user}:${pass}`);
  return `Basic ${token}`;
}

function normalizeWpBaseUrl(wpUrl) {
  let u = String(wpUrl || "").trim().replace(/\/+$/, "");
  if (u && !/^https?:\/\//i.test(u)) {
    u = `https://${u}`;
  }
  return u;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function parseXmlRpcFault(xmlText) {
  if (!xmlText.includes("<fault>")) return null;
  const codeMatch = xmlText.match(/<name>faultCode<\/name>\s*<value>\s*<(?:int|i4)>([^<]+)<\/(?:int|i4)>/);
  const strMatch = xmlText.match(/<name>faultString<\/name>\s*<value>\s*<string>([\s\S]*?)<\/string>/);
  return {
    code: codeMatch ? codeMatch[1] : "unknown",
    message: strMatch ? strMatch[1] : xmlText.slice(0, 300)
  };
}

async function uploadMediaViaXmlRpc(arrayBuffer, filename, contentType, env) {
  const wpBase = normalizeWpBaseUrl(env.WP_URL);
  const { user, pass } = getWpCredentials(env);
  const base64Data = arrayBufferToBase64(arrayBuffer);

  const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<methodCall>
  <methodName>wp.uploadFile</methodName>
  <params>
    <param><value><int>1</int></value></param>
    <param><value><string>${escapeHtml(user)}</string></value></param>
    <param><value><string>${escapeHtml(pass)}</string></value></param>
    <param>
      <value>
        <struct>
          <member><name>name</name><value><string>${escapeHtml(filename)}</string></value></member>
          <member><name>type</name><value><string>${escapeHtml(contentType)}</string></value></member>
          <member><name>bits</name><value><base64>${base64Data}</base64></value></member>
          <member><name>overwrite</name><value><boolean>1</boolean></value></member>
        </struct>
      </value>
    </param>
  </params>
</methodCall>`;

  const res = await fetch(`${wpBase}/xmlrpc.php`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8" },
    body: xmlBody
  });

  const resXml = await res.text();
  if (!res.ok) {
    throw new Error(`XML-RPC メディア通信エラー (${res.status}): ${resXml.slice(0, 200)}`);
  }

  const fault = parseXmlRpcFault(resXml);
  if (fault) {
    throw new Error(`XML-RPC メディアアップロード失敗 (${fault.code}): ${fault.message}`);
  }

  const urlMatch =
    resXml.match(/<name>url<\/name>\s*<value>\s*(?:<string>)?([^<\s]+)(?:<\/string>)?/) ||
    resXml.match(/<name>link<\/name>\s*<value>\s*(?:<string>)?([^<\s]+)(?:<\/string>)?/);
  if (!urlMatch || !urlMatch[1]) {
    throw new Error(`XML-RPC メディアURL取得失敗: ${resXml.slice(0, 200)}`);
  }

  let uploadedUrl = urlMatch[1].replace(/&amp;/g, "&");
  if (wpBase.startsWith("https://") && uploadedUrl.startsWith("http://")) {
    uploadedUrl = uploadedUrl.replace(/^http:\/\//i, "https://");
  }
  return uploadedUrl;
}

async function savePostViaXmlRpc(existingPostId, title, slug, contentHtml, env) {
  const wpBase = normalizeWpBaseUrl(env.WP_URL);
  const { user, pass } = getWpCredentials(env);

  const methodName = existingPostId ? "wp.editPost" : "wp.newPost";
  const postIdParam = existingPostId
    ? `    <param><value><int>${existingPostId}</int></value></param>\n`
    : "";

  const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<methodCall>
  <methodName>${methodName}</methodName>
  <params>
    <param><value><int>1</int></value></param>
    <param><value><string>${escapeHtml(user)}</string></value></param>
    <param><value><string>${escapeHtml(pass)}</string></value></param>
${postIdParam}    <param>
      <value>
        <struct>
          <member><name>post_type</name><value><string>post</string></value></member>
          <member><name>post_status</name><value><string>publish</string></value></member>
          <member><name>post_title</name><value><string>${escapeHtml(title)}</string></value></member>
          <member><name>post_name</name><value><string>${escapeHtml(slug)}</string></value></member>
          <member><name>post_content</name><value><string>${escapeHtml(contentHtml)}</string></value></member>
        </struct>
      </value>
    </param>
  </params>
</methodCall>`;

  const res = await fetch(`${wpBase}/xmlrpc.php`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8" },
    body: xmlBody
  });

  const resXml = await res.text();
  if (!res.ok) {
    throw new Error(`XML-RPC 記事保存通信エラー (${res.status}): ${resXml.slice(0, 200)}`);
  }

  const fault = parseXmlRpcFault(resXml);
  if (fault) {
    throw new Error(`WordPress XML-RPC 認証・保存エラー (${fault.code}): ${fault.message}`);
  }

  let savedId = existingPostId;
  if (!savedId) {
    const idMatch = resXml.match(/<value>\s*<string>(\d+)<\/string>\s*<\/value>/);
    if (idMatch) savedId = Number(idMatch[1]);
  }

  return {
    id: savedId || existingPostId || 0,
    link: `${wpBase}/?p=${savedId || 0}`
  };
}

async function uploadMediaToWordPress(mediaUrl, filenamePrefix, env) {
  const wpBase = normalizeWpBaseUrl(env.WP_URL);
  const authHeader = getWpAuthHeader(env);

  const mediaRes = await fetch(mediaUrl, {
    headers: { "User-Agent": "favo-like-wp-worker/1.0" }
  });
  if (!mediaRes.ok) {
    throw new Error(`メディアのダウンロードに失敗しました (${mediaRes.status}): ${mediaUrl}`);
  }

  const rawContentType = (mediaRes.headers.get("content-type") || "").toLowerCase();
  let ext = "jpg";
  let uploadContentType = "image/jpeg";

  if (rawContentType.includes("mp4") || mediaUrl.toLowerCase().includes(".mp4")) {
    ext = "mp4";
    uploadContentType = "video/mp4";
  } else if (rawContentType.includes("png") || mediaUrl.toLowerCase().includes(".png")) {
    ext = "png";
    uploadContentType = "image/png";
  } else if (rawContentType.includes("gif") || mediaUrl.toLowerCase().includes(".gif")) {
    ext = "gif";
    uploadContentType = "image/gif";
  } else if (rawContentType.includes("webp") || mediaUrl.toLowerCase().includes(".webp")) {
    ext = "webp";
    uploadContentType = "image/webp";
  }

  const filename = `${filenamePrefix}-${Date.now()}.${ext}`;
  const arrayBuffer = await mediaRes.arrayBuffer();

  const uploadRes = await fetch(`${wpBase}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": uploadContentType,
      "Content-Disposition": `attachment; filename="${filename}"`
    },
    body: arrayBuffer
  });

  if (uploadRes.ok) {
    const mediaJson = await uploadRes.json();
    let uploadedUrl = mediaJson.source_url || mediaJson?.guid?.rendered || mediaUrl;
    if (wpBase.startsWith("https://") && uploadedUrl.startsWith("http://")) {
      uploadedUrl = uploadedUrl.replace(/^http:\/\//i, "https://");
    }
    return uploadedUrl;
  }

  if (uploadRes.status === 401 || uploadRes.status === 403) {
    return await uploadMediaViaXmlRpc(arrayBuffer, filename, uploadContentType, env);
  }

  const errText = await uploadRes.text();
  throw new Error(`WordPressメディアアップロード失敗 (${uploadRes.status}): ${errText}`);
}

async function resolveMediaItemForWordPress(mediaItem, prefix, uploadCache, env) {
  let uploadedCount = 0;

  if (mediaItem.type === "video" && mediaItem.posterUrl) {
    if (uploadCache.has(mediaItem.posterUrl)) {
      mediaItem.wpPosterUrl = uploadCache.get(mediaItem.posterUrl);
    } else {
      try {
        const wpPoster = await uploadMediaToWordPress(
          mediaItem.posterUrl,
          `${prefix}-poster`,
          env
        );
        uploadCache.set(mediaItem.posterUrl, wpPoster);
        mediaItem.wpPosterUrl = wpPoster;
        uploadedCount++;
      } catch (err) {
        console.error(`動画サムネイル保存失敗 (${prefix}):`, err.message);
        mediaItem.wpPosterUrl = mediaItem.posterUrl;
      }
    }
  }

  if (uploadCache.has(mediaItem.url)) {
    mediaItem.wpUrl = uploadCache.get(mediaItem.url);
    return uploadedCount;
  }

  const candidateUrls = [
    mediaItem.url,
    ...(Array.isArray(mediaItem.fallbackUrls) ? [...mediaItem.fallbackUrls].reverse() : [])
  ].filter(Boolean);

  let lastErr = null;
  for (const candidateUrl of candidateUrls) {
    try {
      const wpUrl = await uploadMediaToWordPress(candidateUrl, prefix, env);
      uploadCache.set(mediaItem.url, wpUrl);
      mediaItem.wpUrl = wpUrl;
      uploadedCount++;
      return uploadedCount;
    } catch (err) {
      lastErr = err;
      console.error(`メディア保存試行失敗 (${prefix} -> ${candidateUrl}):`, err.message);
    }
  }

  if (lastErr) {
    console.error(`メディア保存最終フォールバック (${prefix}):`, lastErr.message);
  }
  mediaItem.wpUrl = mediaItem.url;
  return uploadedCount;
}

async function findWpPostBySlug(slug, env) {
  const wpBase = normalizeWpBaseUrl(env.WP_URL);
  const authHeader = getWpAuthHeader(env);

  const queryUrl = `${wpBase}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&per_page=1&_=${Date.now()}`;
  const res = await fetch(queryUrl, {
    headers: {
      Authorization: authHeader,
      Accept: "application/json"
    }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WordPress記事検索エラー (${res.status}): ${errText}`);
  }

  const posts = await res.json();
  return Array.isArray(posts) && posts.length > 0 ? posts[0] : null;
}

function shouldRepairExistingPostBlock(existingBlockHtml, post) {
  const html = String(existingBlockHtml || "");
  const hasPostMedia = Array.isArray(post.media) && post.media.length > 0;
  const hasRefMedia =
    post.referencedPost &&
    Array.isArray(post.referencedPost.media) &&
    post.referencedPost.media.length > 0;

  if ((hasPostMedia || hasRefMedia) && !html.includes("x-log-media")) {
    return true;
  }

  const hasVideo =
    (hasPostMedia && post.media.some((m) => m.type === "video")) ||
    (hasRefMedia && post.referencedPost.media.some((m) => m.type === "video"));
  if (hasVideo && !html.includes("<video")) {
    return true;
  }

  const hasDoubleNewline =
    /\r?\n\s*\r?\n/.test(String(post.text || "").trim()) ||
    /\r?\n\s*\r?\n/.test(String(post.referencedPost?.text || "").trim());
  if (hasDoubleNewline && !html.includes("<p")) {
    return true;
  }

  return false;
}

/**
 * 1ポスト＝1記事として WordPress に保存（既存かつ修復不要ならスキップ）
 */
export async function upsertWordPressSinglePost(post, env, sharedUploadCache = new Map()) {
  const wpBase = normalizeWpBaseUrl(env.WP_URL);
  const authHeader = getWpAuthHeader(env);
  const slug = buildSinglePostSlug(post);
  const title = buildSinglePostTitle(post);

  const existingPost = await findWpPostBySlug(slug, env);
  const existingContent = existingPost?.content?.raw || existingPost?.content?.rendered || "";

  if (existingPost && !shouldRepairExistingPostBlock(existingContent, post)) {
    return {
      id: post.id,
      favoType: post.favoType,
      slug,
      postId: existingPost.id,
      action: "unchanged",
      uploadedMediaCount: 0
    };
  }

  let uploadedMediaCount = 0;

  if (Array.isArray(post.media)) {
    for (let i = 0; i < post.media.length; i++) {
      const m = post.media[i];
      uploadedMediaCount += await resolveMediaItemForWordPress(
        m,
        `wp-favo-${post.favoType}-${post.id}-${i}`,
        sharedUploadCache,
        env
      );
    }
  }

  if (post.referencedPost && Array.isArray(post.referencedPost.media)) {
    for (let i = 0; i < post.referencedPost.media.length; i++) {
      const m = post.referencedPost.media[i];
      uploadedMediaCount += await resolveMediaItemForWordPress(
        m,
        `wp-favo-ref-${post.favoType}-${post.id}-${i}`,
        sharedUploadCache,
        env
      );
    }
  }

  const articleHtml = buildSingleArticleHtml(post);
  const endpoint = existingPost
    ? `${wpBase}/wp-json/wp/v2/posts/${existingPost.id}`
    : `${wpBase}/wp-json/wp/v2/posts`;

  const payload = {
    title,
    slug,
    status: "publish",
    content: articleHtml
  };

  if (!existingPost && post.isoLocal) {
    payload.date = post.isoLocal;
  }

  const saveRes = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload)
  });

  let savedPost;
  if (saveRes.ok) {
    savedPost = await saveRes.json();
  } else if (saveRes.status === 401 || saveRes.status === 403) {
    savedPost = await savePostViaXmlRpc(
      existingPost?.id || null,
      title,
      slug,
      articleHtml,
      env
    );
  } else {
    const errText = await saveRes.text();
    throw new Error(`WordPress記事保存エラー (${saveRes.status}): ${errText}`);
  }

  return {
    id: post.id,
    favoType: post.favoType,
    slug,
    title,
    postId: savedPost.id,
    link: savedPost.link,
    action: existingPost ? "updated" : "created",
    uploadedMediaCount
  };
}

// ============================================================================
// GitHub Markdown 生成・同期（オプション）
// ============================================================================

function formatMarkdownParagraphs(text) {
  const normalized = String(text || "")
    .trim()
    .replace(/\r\n|\r/g, "\n");
  if (!normalized) return "";
  return normalized
    .split(/\n{2,}/)
    .map((para) => para.replace(/\n/g, "  \n"))
    .join("\n\n");
}

export function renderSinglePostMarkdown(post) {
  const postUrl = `https://x.com/${post.username}/status/${post.id}`;
  const typeTag =
    post.favoType === "like" ? "[いいね]" : post.favoType === "rt" ? "[RT]" : "[引用]";
  const cleanText = formatMarkdownParagraphs(post.text);

  let md = `<!-- x-post:${post.id} date:${post.dateStr} time:${post.timeStr} type:${post.favoType || "post"} -->\n`;
  md += `### ${typeTag} [${post.timeStr} @${post.username}](${postUrl})\n\n`;
  md += `${cleanText}\n`;

  if (post.referencedPost) {
    const ref = post.referencedPost;
    const refUrl = `https://x.com/${ref.username}/status/${ref.id}`;
    const refFormatted = formatMarkdownParagraphs(ref.text);
    const refLines = refFormatted
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
    md += `\n> **@${ref.username} のポスト ([元ポスト](${refUrl})):**\n${refLines}\n`;
  }

  md += `<!-- /x-post:${post.id} -->`;
  return md;
}

export function parseExistingMarkdownEntries(markdownText) {
  const entries = new Map();
  const str = String(markdownText || "");
  const regex =
    /<!--\s*x-post:(\d+)\s+date:(\d{4}-\d{2}-\d{2})\s+time:(\d{2}:\d{2})(?:\s+type:([a-z]+))?\s*-->([\s\S]*?)<!--\s*\/x-post:\1\s*-->/g;

  let m;
  while ((m = regex.exec(str)) !== null) {
    const id = m[1];
    const dateStr = m[2];
    const timeStr = m[3];
    const rawBlock = m[0].trim();
    entries.set(id, { id, dateStr, timeStr, rawBlock });
  }
  return entries;
}

export function buildMergedMarkdownDocument(title, existingMarkdown, newPosts) {
  const entries = parseExistingMarkdownEntries(existingMarkdown);
  let addedCount = 0;

  for (const post of newPosts) {
    if (!entries.has(post.id)) {
      entries.set(post.id, {
        id: post.id,
        dateStr: post.dateStr,
        timeStr: post.timeStr,
        rawBlock: renderSinglePostMarkdown(post)
      });
      addedCount++;
    }
  }

  const byDate = new Map();
  for (const entry of entries.values()) {
    if (!byDate.has(entry.dateStr)) {
      byDate.set(entry.dateStr, []);
    }
    byDate.get(entry.dateStr).push(entry);
  }

  const sortedDates = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a));

  const sections = [];
  for (const dateStr of sortedDates) {
    const list = byDate.get(dateStr);
    list.sort((a, b) => {
      try {
        const bigA = BigInt(a.id);
        const bigB = BigInt(b.id);
        return bigB > bigA ? 1 : bigB < bigA ? -1 : 0;
      } catch {
        return b.id.localeCompare(a.id);
      }
    });
    const dayBody = list.map((item) => item.rawBlock).join("\n\n");
    sections.push(`## ${dateStr}\n\n${dayBody}`);
  }

  const content = `# ${title}\n\n${sections.join("\n\n---\n\n")}\n`;
  return { content, addedCount, totalCount: entries.size };
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUtf8(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function normalizeGitHubRepo(rawRepo) {
  let r = String(rawRepo || "").trim();
  r = r.replace(/^https?:\/\/github\.com\//i, "");
  r = r.replace(/\.git$/i, "");
  r = r.replace(/^\/+|\/+$/g, "");
  return r;
}

async function upsertGitHubMarkdownFile(filePath, docTitle, postsForFile, env) {
  const repo = normalizeGitHubRepo(env.GITHUB_REPO || env.GH_SYNC_REPO || "");
  const token = (env.GITHUB_TOKEN || env.GH_SYNC_TOKEN || "").trim();
  const branch = (env.GITHUB_BRANCH || env.GH_SYNC_BRANCH || "").trim();

  const normalizedPath = filePath.replace(/^\/+/, "");
  const apiUrl = new URL(`https://api.github.com/repos/${repo}/contents/${normalizedPath}`);
  if (branch) {
    apiUrl.searchParams.set("ref", branch);
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "favo-like-wp-worker/1.0",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  let existingSha = null;
  let existingMarkdown = "";

  const getRes = await fetch(apiUrl.toString(), { method: "GET", headers });
  if (getRes.ok) {
    const fileData = await getRes.json();
    existingSha = fileData.sha;
    if (fileData.content) {
      existingMarkdown = base64ToUtf8(fileData.content);
    }
  } else if (getRes.status !== 404) {
    const errText = await getRes.text();
    throw new Error(`GitHubファイル取得失敗 (${getRes.status} ${normalizedPath}): ${errText}`);
  }

  const { content, addedCount, totalCount } = buildMergedMarkdownDocument(
    docTitle,
    existingMarkdown,
    postsForFile
  );

  if (existingSha && addedCount === 0) {
    return { filePath: normalizedPath, action: "unchanged", addedCount: 0, totalCount };
  }

  const putBody = {
    message: `Update ${normalizedPath} (+${addedCount} favo/like posts)`,
    content: utf8ToBase64(content)
  };
  if (existingSha) putBody.sha = existingSha;
  if (branch) putBody.branch = branch;

  const putUrl = `https://api.github.com/repos/${repo}/contents/${normalizedPath}`;
  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(putBody)
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(
      `GitHubファイル更新失敗 (${putRes.status} ${normalizedPath} [repo=${repo}]): ${errText}`
    );
  }

  return {
    filePath: normalizedPath,
    action: existingSha ? "updated" : "created",
    addedCount,
    totalCount
  };
}

async function syncPostsToGitHub(posts, env) {
  const token = (env.GITHUB_TOKEN || env.GH_SYNC_TOKEN || "").trim();
  const repo = (env.GITHUB_REPO || env.GH_SYNC_REPO || "").trim();
  if (!token || !repo || posts.length === 0) {
    return { enabled: false, results: [] };
  }

  const rawTargets = (env.GH_MD_TARGETS || env.GITHUB_MD_TARGETS || "year,month,full")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const dirPrefix = (env.GH_MD_DIR || env.GITHUB_MD_DIR || "").trim().replace(/^\/+|\/+$/g, "");
  const withDir = (name) => (dirPrefix ? `${dirPrefix}/${name}` : name);

  const results = [];

  if (rawTargets.includes("year")) {
    const byYear = new Map();
    for (const p of posts) {
      if (!byYear.has(p.yearStr)) byYear.set(p.yearStr, []);
      byYear.get(p.yearStr).push(p);
    }
    for (const [yearStr, yearPosts] of byYear.entries()) {
      const fileName = `FavoYear${yearStr}.md`;
      const res = await upsertGitHubMarkdownFile(
        withDir(fileName),
        `X Favo/Like/RT/Quote - Year ${yearStr}`,
        yearPosts,
        env
      );
      results.push(res);
    }
  }

  if (rawTargets.includes("month")) {
    const byMonth = new Map();
    for (const p of posts) {
      if (!byMonth.has(p.yearMonthStr)) byMonth.set(p.yearMonthStr, []);
      byMonth.get(p.yearMonthStr).push(p);
    }
    for (const [ymStr, monthPosts] of byMonth.entries()) {
      const fileName = `FavoMonth${ymStr}.md`;
      const res = await upsertGitHubMarkdownFile(
        withDir(fileName),
        `X Favo/Like/RT/Quote - Month ${ymStr}`,
        monthPosts,
        env
      );
      results.push(res);
    }
  }

  if (rawTargets.includes("full")) {
    const res = await upsertGitHubMarkdownFile(
      withDir("FavoFulldata.md"),
      "X Favo/Like/RT/Quote - Full Data",
      posts,
      env
    );
    results.push(res);
  }

  return { enabled: true, targets: rawTargets, results };
}

// ============================================================================
// 参照元ポスト補完 & メイン同期処理
// ============================================================================

async function enrichReferencedTweets(apiData, env) {
  if (!apiData || !Array.isArray(apiData.data)) return;
  if (!apiData.includes) apiData.includes = {};
  if (!Array.isArray(apiData.includes.tweets)) apiData.includes.tweets = [];
  if (!Array.isArray(apiData.includes.media)) apiData.includes.media = [];
  if (!Array.isArray(apiData.includes.users)) apiData.includes.users = [];

  const existingTweetMap = new Map(apiData.includes.tweets.map((t) => [t.id, t]));
  const existingMediaMap = new Map(apiData.includes.media.map((m) => [m.media_key, m]));
  const existingUserMap = new Map(apiData.includes.users.map((u) => [u.id, u]));

  const refIdsToFetch = new Set();

  for (const t of apiData.data) {
    for (const ref of t.referenced_tweets || []) {
      if (ref.id) refIdsToFetch.add(ref.id);
    }
  }
  for (const t of apiData.includes.tweets) {
    for (const ref of t.referenced_tweets || []) {
      if (ref.id) refIdsToFetch.add(ref.id);
    }
  }

  if (refIdsToFetch.size === 0) return;

  try {
    const idsParam = Array.from(refIdsToFetch).slice(0, 100).join(",");
    const lookupUrl = new URL("https://api.x.com/2/tweets");
    lookupUrl.searchParams.set("ids", idsParam);
    lookupUrl.searchParams.set(
      "tweet.fields",
      "created_at,text,note_tweet,entities,attachments,referenced_tweets,author_id"
    );
    lookupUrl.searchParams.set(
      "expansions",
      "attachments.media_keys,author_id,referenced_tweets.id,referenced_tweets.id.author_id,referenced_tweets.id.attachments.media_keys"
    );
    lookupUrl.searchParams.set(
      "media.fields",
      "media_key,type,url,preview_image_url,variants,alt_text"
    );
    lookupUrl.searchParams.set("user.fields", "id,username,name");

    const refData = await xApiFetch(lookupUrl.toString(), env);

    for (const t of refData?.data || []) {
      existingTweetMap.set(t.id, t);
    }
    for (const t of refData?.includes?.tweets || []) {
      if (!existingTweetMap.has(t.id)) {
        existingTweetMap.set(t.id, t);
      }
    }
    for (const m of refData?.includes?.media || []) {
      existingMediaMap.set(m.media_key, m);
    }
    for (const u of refData?.includes?.users || []) {
      existingUserMap.set(u.id, u);
    }

    apiData.includes.tweets = Array.from(existingTweetMap.values());
    apiData.includes.media = Array.from(existingMediaMap.values());
    apiData.includes.users = Array.from(existingUserMap.values());
  } catch (err) {
    console.error("参照元ポストの追加取得をスキップしました:", err.message);
  }
}

/**
 * X API から「いいね」「RT」「引用」を取得して正規化されたポスト配列を返す
 * （x-logger-extra 等からも直接呼び出し可能）
 */
export async function fetchFavoLikePosts(env) {
  const timeZone = env.TIMEZONE || "Asia/Tokyo";
  const maxResults = Math.min(100, Math.max(5, parseInt(env.X_MAX_RESULTS || "20", 10) || 20));
  const includeLikes = String(env.INCLUDE_LIKES ?? "true").toLowerCase() !== "false";
  const includeRetweets = String(env.INCLUDE_RETWEETS ?? "true").toLowerCase() !== "false";
  const includeQuotes = String(env.INCLUDE_QUOTES ?? "true").toLowerCase() !== "false";

  const { userId, username } = await resolveXUser(env);
  const allPosts = [];
  const warnings = [];

  // 1. タイムラインから「RT」と「引用」を取得
  if (includeRetweets || includeQuotes) {
    const timelineUrl = new URL(`https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets`);
    timelineUrl.searchParams.set("max_results", String(maxResults));
    timelineUrl.searchParams.set(
      "tweet.fields",
      "created_at,text,note_tweet,entities,attachments,referenced_tweets,author_id"
    );
    timelineUrl.searchParams.set(
      "expansions",
      "attachments.media_keys,author_id,referenced_tweets.id,referenced_tweets.id.author_id,referenced_tweets.id.attachments.media_keys"
    );
    timelineUrl.searchParams.set(
      "media.fields",
      "media_key,type,url,preview_image_url,variants,alt_text"
    );
    timelineUrl.searchParams.set("user.fields", "id,username,name");

    const timelineData = await xApiFetch(timelineUrl.toString(), env);
    await enrichReferencedTweets(timelineData, env);

    const rtAndQuotePosts = normalizeFavoTimelineResponse(timelineData, username, {
      timeZone,
      includeQuotes,
      includeRetweets
    });
    allPosts.push(...rtAndQuotePosts);
  }

  // 2. いいね一覧 API (/2/users/:id/liked_tweets) から「いいね」を取得
  if (includeLikes) {
    try {
      const likesUrl = new URL(
        `https://api.x.com/2/users/${encodeURIComponent(userId)}/liked_tweets`
      );
      likesUrl.searchParams.set("max_results", String(maxResults));
      likesUrl.searchParams.set(
        "tweet.fields",
        "created_at,text,note_tweet,entities,attachments,referenced_tweets,author_id"
      );
      likesUrl.searchParams.set(
        "expansions",
        "attachments.media_keys,author_id,referenced_tweets.id,referenced_tweets.id.author_id,referenced_tweets.id.attachments.media_keys"
      );
      likesUrl.searchParams.set(
        "media.fields",
        "media_key,type,url,preview_image_url,variants,alt_text"
      );
      likesUrl.searchParams.set("user.fields", "id,username,name");

      const likesData = await xApiFetch(likesUrl.toString(), env, { requireUserContext: true });
      await enrichReferencedTweets(likesData, env);

      const likedPosts = normalizeLikedTweetsResponse(likesData, { timeZone });
      allPosts.push(...likedPosts);
    } catch (err) {
      warnings.push(
        `いいね(liked_tweets)取得スキップ: ${err.message}（※X APIの仕様上、「いいね」の取得には X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET の4つのOAuth 1.0aキーが必要です）`
      );
    }
  }

  // 古い順（作成日時昇順）に並べて順番にWordPressへ記事作成できるようにする
  allPosts.sort((a, b) => {
    try {
      const bigA = BigInt(a.id);
      const bigB = BigInt(b.id);
      return bigA > bigB ? 1 : bigA < bigB ? -1 : 0;
    } catch {
      return String(a.id).localeCompare(String(b.id));
    }
  });

  return { username, posts: allPosts, warnings };
}

export async function runFavoLikeSync(env) {
  const { username, posts, warnings } = await fetchFavoLikePosts(env);
  const sharedUploadCache = new Map();
  const wpResults = [];

  for (const post of posts) {
    const res = await upsertWordPressSinglePost(post, env, sharedUploadCache);
    wpResults.push(res);
  }

  const githubResult = await syncPostsToGitHub(posts, env);

  return {
    ok: true,
    executedAt: new Date().toISOString(),
    username,
    fetchedCount: posts.length,
    countsByType: {
      like: posts.filter((p) => p.favoType === "like").length,
      rt: posts.filter((p) => p.favoType === "rt").length,
      quote: posts.filter((p) => p.favoType === "quote").length
    },
    warnings,
    wordpress: wpResults,
    github: githubResult
  };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runFavoLikeSync(env).catch((err) => {
        console.error("[favo-like-wp cron error]", err);
      })
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/trigger" && request.method === "POST") {
      if (env.TRIGGER_SECRET) {
        const auth = request.headers.get("Authorization") || "";
        if (auth !== `Bearer ${env.TRIGGER_SECRET}`) {
          return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
          });
        }
      }
      try {
        const result = await runFavoLikeSync(env);
        return new Response(JSON.stringify(result, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: err.message || String(err) }, null, 2),
          {
            status: 500,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          }
        );
      }
    }

    return new Response(
      JSON.stringify(
        {
          service: "favo-like-wp-basic",
          status: "running",
          mode: "1-post-1-article",
          timezone: env.TIMEZONE || "Asia/Tokyo",
          targets: {
            likes: String(env.INCLUDE_LIKES ?? "true") !== "false",
            retweets: String(env.INCLUDE_RETWEETS ?? "true") !== "false",
            quotes: String(env.INCLUDE_QUOTES ?? "true") !== "false"
          },
          oauth1Configured: hasOAuth1Credentials(env),
          bearerTokenConfigured: Boolean(env.X_BEARER_TOKEN?.trim()),
          githubSyncEnabled: Boolean(env.GITHUB_TOKEN && env.GITHUB_REPO)
        },
        null,
        2
      ),
      {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      }
    );
  }
};
