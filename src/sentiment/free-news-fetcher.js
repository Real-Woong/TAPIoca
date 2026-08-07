import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
const BLUESKY_PUBLIC_API = "https://public.api.bsky.app";
// PAPER 사이클과 캐시 수명이 15분으로 같아서 매 사이클 재수집했고, GDELT를 하루 96번
// 호출해 429가 반복됐습니다. 60분으로 늘려 호출을 1/4로 줄입니다. 감성은 일 단위
// 판단에 쓰이므로 15분 신선도가 필요 없습니다. NEWS_CACHE_MINUTES로 조정합니다.
export const DEFAULT_NEWS_CACHE_MS = 60 * 60 * 1000;
export const DEFAULT_NEWS_QUERY =
  '("Federal Reserve" OR FOMC OR inflation OR recession OR "jobs report" OR "interest rates")';
export const DEFAULT_FED_FEEDS = [
  "https://www.federalreserve.gov/feeds/press_monetary.xml",
  "https://www.federalreserve.gov/feeds/speeches.xml",
];

/** API 키 없는 공식 뉴스와 선택한 전문가 공개 피드를 하나의 입력 목록으로 합칩니다. */
export async function fetchFreeMarketNews({
  dataDir,
  query = DEFAULT_NEWS_QUERY,
  fedFeeds = DEFAULT_FED_FEEDS,
  blueskyAuthors = [],
  opinionFeeds = [],
  maxRecords = 75,
  timespan = "1h",
  now = new Date(),
  maxAgeMs = DEFAULT_NEWS_CACHE_MS,
  fetchImpl = fetch,
}) {
  if (!dataDir) throw new Error("dataDir가 필요합니다.");
  const cachePath = path.join(dataDir, "free-news-cache.json");
  const normalizedMaxRecords = Math.min(250, Math.max(1, Math.trunc(Number(maxRecords) || 75)));
  const cacheKey = JSON.stringify({
    query,
    fedFeeds,
    blueskyAuthors,
    opinionFeeds,
    maxRecords: normalizedMaxRecords,
    timespan,
  });
  const cached = await readCache(cachePath);
  if (cached?.cacheKey === cacheKey && isFresh(cached.fetchedAt, now, maxAgeMs)) {
    return { ...cached, source: "CACHE", stale: false };
  }

  // 어느 소스가 죽었는지 알려면 요청에 이름을 붙여야 합니다. 예전에는 실패
  // 메시지만 이어 붙여서, GDELT가 빠진 것을 `sourceCounts`에 없다는 사실로만
  // 눈치챌 수 있었습니다.
  // 물러서는 중이면 요청을 아예 만들지 않습니다. 실패로 세지도 않습니다 —
  // "거절당했다"와 "안 갔다"는 다른 사실입니다.
  const gdeltCooldownUntil = cached?.gdeltCooldownUntil ?? null;
  const gdeltResting = gdeltCooldownUntil !== null
    && now.getTime() < new Date(gdeltCooldownUntil).getTime();

  const tasks = [
    ...fedFeeds.map((url) => ({
      source: "FED_RSS", detail: url, run: () => fetchFedRss(url, { fetchImpl }),
    })),
    ...(gdeltResting ? [] : [{
      source: "GDELT", detail: query,
      run: () => fetchGdeltNews({ query, maxRecords: normalizedMaxRecords, timespan, fetchImpl }),
    }]),
    // 질의 검색을 둘로 둡니다. 하나가 막혀도 사건에 반응하는 경로가 남습니다.
    { source: "GOOGLE_NEWS", detail: query, run: () => fetchGoogleNews(query, { fetchImpl }) },
    ...unique(blueskyAuthors).map((actor) => ({
      source: "BLUESKY", detail: actor, run: () => fetchBlueskyAuthorFeed(actor, { fetchImpl }),
    })),
    ...unique(opinionFeeds).map((url) => ({
      source: "OPINION_RSS", detail: url, run: () => fetchOpinionRss(url, { fetchImpl }),
    })),
  ];

  const settled = await Promise.allSettled(tasks.map((task) => task.run()));
  const articles = dedupeArticles(
    settled.flatMap((result) => result.status === "fulfilled" ? result.value : []),
  );

  // 소스별 성패를 그대로 남깁니다. 합쳐 놓으면 "무엇이 죽었는가"를 못 봅니다.
  const sourceHealth = tasks.map((task, index) => {
    const result = settled[index];
    return result.status === "fulfilled"
      ? { source: task.source, detail: task.detail, ok: true, articles: result.value.length }
      : { source: task.source, detail: task.detail, ok: false, error: describeError(result.reason) };
  });
  if (gdeltResting) {
    sourceHealth.push({
      source: "GDELT", detail: query, ok: false, skipped: true,
      error: `요청 제한으로 쉬는 중 (${gdeltCooldownUntil}까지)`,
    });
  }

  const failures = sourceHealth
    .filter((item) => !item.ok && !item.skipped)
    .map((item) => `${item.source}: ${item.error}`);

  // GDELT가 실제로 실패했으면 그 시각을 적어 둡니다. 성공하면 지웁니다.
  const gdeltResult = sourceHealth.find((item) => item.source === "GDELT" && !item.skipped);
  const nextCooldown = gdeltResult && !gdeltResult.ok
    ? new Date(now.getTime() + GDELT_COOLDOWN_MS).toISOString()
    : gdeltResult?.ok
      ? null
      : gdeltCooldownUntil;

  if (articles.length === 0) {
    if (cached?.cacheKey === cacheKey) {
      return {
        ...cached,
        source: "STALE_CACHE",
        stale: true,
        warning: failures.join("; ") || "새 뉴스를 가져오지 못했습니다.",
      };
    }
    throw new Error(failures.join("; ") || "Fed RSS와 GDELT에서 뉴스를 찾지 못했습니다.");
  }

  const sourceCounts = countSources(articles);
  const snapshot = {
    version: 1,
    cacheKey,
    fetchedAt: now.toISOString(),
    articles,
    resultCount: articles.length,
    sourceCounts,
    // 성공한 소스도 함께 남깁니다. 죽은 것만 적으면 "원래 없었는지 죽은 것인지"를
    // 나중에 가릴 수 없습니다.
    sourceHealth,
    // 다음에 GDELT를 언제 다시 볼지. 캐시를 다시 써도 살아남아야 합니다.
    gdeltCooldownUntil: nextCooldown,
    warning: failures.length ? failures.join("; ") : undefined,
  };
  await mkdir(dataDir, { recursive: true });
  await writeCache(cachePath, snapshot);
  return { ...snapshot, source: "KEYLESS_NEWS", stale: false };
}

/**
 * 외부 호출의 시한입니다.
 *
 * 예전에는 아무 데도 타임아웃이 없었습니다. `Promise.allSettled`는 전부 끝날
 * 때까지 기다리므로, 한 소스가 응답을 안 주면 **사이클 전체가 그만큼 멈춥니다.**
 *
 * **소스마다 다른 시한을 줍니다.** 2026-08-08에 전부 10초로 두었더니 GDELT만
 * 계속 죽었습니다 — 차단된 것이 아니라 **원래 느렸습니다.** RSS와 Bluesky는
 * 정적 파일에 가까워 1초 안에 오지만, GDELT의 doc API는 넓은 OR 질의를 매번
 * 훑으므로 10~30초가 걸립니다. 같은 잣대를 대면 느린 소스만 골라 죽입니다.
 *
 * 요청은 병렬이라 사이클이 기다리는 시간은 **가장 느린 하나**뿐입니다.
 * 15분 주기에서 30초는 감당할 수 있고, 그 대가로 이벤트에 반응하는 유일한
 * 소스를 살립니다.
 */
const TIMEOUTS = Object.freeze({
  default: 10_000,
  // 429가 51초 만에 오는 것을 확인했습니다(2026-08-08). 그걸 다 기다릴 이유는
  // 없습니다 — 아래 물러서기가 있으니 한 번 실패하면 한동안 안 갑니다.
  gdelt: 20_000,
});

/**
 * GDELT가 거절하면 한동안 가지 않습니다.
 *
 * **2026-08-08 확인: 429다.** 차단도 질의 무게도 아니고 요청 제한이다. 단순
 * 질의도 429가 났고, 그 응답이 오는 데 51초가 걸렸다. 우리 시한(30초)이 그 전에
 * 끊어서 지금까지 `timeout`만 보였고 429는 한 번도 못 봤다.
 *
 * 물러서지 않으면 캐시가 만료될 때마다 **20초를 버리고 아무것도 못 받으면서,
 * 거절하는 서비스를 계속 두드려 제한을 더 깊게 만든다.** 그래서 한 번 실패하면
 * 그 시각을 적어 두고 그동안은 요청 자체를 보내지 않는다.
 */
const GDELT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function timeout(ms = TIMEOUTS.default) {
  return { signal: AbortSignal.timeout(ms) };
}

/**
 * 오류를 사람이 고칠 수 있는 문장으로 바꿉니다.
 *
 * Node의 fetch는 네트워크 단계 실패를 전부 `TypeError: fetch failed`로 감싸고
 * **진짜 이유를 `cause`에 넣습니다.** 메시지만 남기면 DNS 실패인지 연결 거부인지
 * 인증서 문제인지 알 수 없습니다. 실제로 2026-08-07에 GDELT가 그 상태였고,
 * "fetch failed" 여섯 글자만 남아 원인을 못 좁혔습니다.
 */
function describeError(error) {
  const message = error?.message ?? String(error);
  const cause = error?.cause;
  if (!cause) return message;
  const causeText = cause.code ?? cause.message ?? String(cause);
  return causeText && causeText !== message ? `${message} (${causeText})` : message;
}

export async function fetchGdeltNews({
  query = DEFAULT_NEWS_QUERY,
  maxRecords = 75,
  timespan = "1h",
  fetchImpl = fetch,
} = {}) {
  const url = new URL(GDELT_DOC_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("sort", "datedesc");
  url.searchParams.set("timespan", timespan);
  url.searchParams.set("maxrecords", String(Math.min(250, Math.max(1, Number(maxRecords) || 75))));
  const response = await fetchImpl(url, {
    headers: requestHeaders(), ...timeout(TIMEOUTS.gdelt),
  });
  if (!response.ok) throw new Error(`GDELT 요청 실패 (${response.status})`);
  const body = await response.json();
  return (Array.isArray(body?.articles) ? body.articles : []).flatMap((article) => {
    const title = String(article?.title ?? "").trim();
    const articleUrl = String(article?.url ?? "").trim();
    if (!title || !articleUrl) return [];
    return [{
      id: `gdelt:${articleUrl}`,
      text: title,
      title,
      url: articleUrl,
      domain: article.domain ?? safeDomain(articleUrl),
      createdAt: parseGdeltDate(article.seendate),
      provider: "GDELT",
      metrics: {},
    }];
  });
}

/**
 * 질의로 뉴스를 검색합니다. **GDELT가 하던 역할의 대체입니다.**
 *
 * 나머지 소스는 전부 "누가 말했나"로 고정돼 있습니다 — 연준 피드 2개, 지정한
 * 계정 10개, 블로그 5개. **질의로 찾는 소스는 하나뿐이었고 그것이 GDELT였습니다.**
 * 그래서 그것이 빠지자 감성이 사건에 반응하지 못하고 구조적으로 느려졌습니다.
 *
 * Google News RSS는 키가 없고, 질의를 받고, 응답이 RSS라 기존 파서에 그대로
 * 물립니다. **GDELT를 빼지 않고 함께 둡니다** — 제한이 풀려 돌아오면 둘 다
 * 쓰면 되고, 한쪽이 막혀도 질의 검색이 완전히 사라지지 않습니다.
 *
 * 여기도 IP 제한이 있습니다. GDELT보다 관대하지만 무한하지 않으므로, 실패하면
 * 같은 물러서기가 걸립니다.
 */
export async function fetchGoogleNews(query, { fetchImpl = fetch } = {}) {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");

  const response = await fetchImpl(url, { headers: requestHeaders(), ...timeout() });
  if (!response.ok) throw new Error(`Google News 요청 실패 (${response.status})`);
  return parseRss(await response.text(), String(url), {
    provider: "GOOGLE_NEWS",
    domain: "news.google.com",
  });
}

export async function fetchFedRss(url, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { headers: requestHeaders(), ...timeout() });
  if (!response.ok) throw new Error(`Fed RSS 요청 실패 (${response.status})`);
  return parseRss(await response.text(), url, {
    provider: "FED_RSS",
    domain: "federalreserve.gov",
  });
}

export async function fetchOpinionRss(url, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { headers: requestHeaders(), ...timeout() });
  if (!response.ok) throw new Error(`전문가 RSS 요청 실패 (${response.status}): ${url}`);
  return parseRss(await response.text(), url, {
    provider: "OPINION_RSS",
    domain: safeDomain(url),
  });
}

export async function fetchBlueskyAuthorFeed(actor, { limit = 30, fetchImpl = fetch } = {}) {
  const normalizedActor = String(actor ?? "").trim().replace(/^@/, "");
  if (!normalizedActor) return [];
  const url = new URL("/xrpc/app.bsky.feed.getAuthorFeed", BLUESKY_PUBLIC_API);
  url.searchParams.set("actor", normalizedActor);
  url.searchParams.set("filter", "posts_no_replies");
  url.searchParams.set("limit", String(Math.min(100, Math.max(1, Number(limit) || 30))));
  const response = await fetchImpl(url, { headers: requestHeaders(), ...timeout() });
  if (!response.ok) throw new Error(`Bluesky 요청 실패 (${response.status}): ${normalizedActor}`);
  const body = await response.json();
  return (Array.isArray(body?.feed) ? body.feed : []).flatMap((entry) => {
    if (entry?.reason) return [];
    const post = entry?.post;
    const text = String(post?.record?.text ?? "").trim();
    const uri = String(post?.uri ?? "").trim();
    const author = post?.author?.handle ?? normalizedActor;
    if (!text || !uri) return [];
    return [{
      id: `bluesky:${uri}`,
      text,
      title: text.slice(0, 160),
      url: blueskyPostUrl(author, uri),
      domain: "bsky.app",
      author,
      createdAt: validIsoDate(post?.record?.createdAt ?? post?.indexedAt),
      provider: "BLUESKY",
      metrics: {
        like_count: Number(post?.likeCount ?? 0),
        retweet_count: Number(post?.repostCount ?? 0),
        reply_count: Number(post?.replyCount ?? 0),
      },
    }];
  });
}

export function parseRss(
  xml,
  feedUrl = "RSS",
  { provider = "FED_RSS", domain = "federalreserve.gov" } = {},
) {
  const items = String(xml).match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  return items.flatMap((item, index) => {
    const title = cleanXmlText(readTag(item, "title"));
    const description = cleanXmlText(readTag(item, "description"));
    const articleUrl = cleanXmlText(readTag(item, "link"));
    const guid = cleanXmlText(readTag(item, "guid"));
    const pubDate = cleanXmlText(readTag(item, "pubDate"));
    if (!title) return [];
    return [{
      id: `${provider.toLowerCase()}:${guid || articleUrl || `${feedUrl}:${index}`}`,
      text: [title, description].filter(Boolean).join(". "),
      title,
      url: articleUrl || null,
      domain,
      createdAt: validIsoDate(pubDate),
      provider,
      metrics: {},
    }];
  });
}

function blueskyPostUrl(author, uri) {
  const recordKey = String(uri).split("/").at(-1);
  return `https://bsky.app/profile/${encodeURIComponent(author)}/post/${encodeURIComponent(recordKey)}`;
}

function readTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] ?? "";
}

function cleanXmlText(value) {
  return decodeXmlEntities(
    String(value)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeXmlEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] !== "#") return named[code.toLowerCase()] ?? entity;
    const number = code[1].toLowerCase() === "x"
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
  });
}

function dedupeArticles(articles) {
  const seen = new Set();
  return articles.filter((article) => {
    const key = `${article.provider}:${article.url || normalizeTitle(article.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeTitle(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function countSources(articles) {
  return articles.reduce((counts, article) => {
    counts[article.provider] = (counts[article.provider] ?? 0) + 1;
    return counts;
  }, {});
}

function unique(values = []) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function requestHeaders() {
  return {
    accept: "application/json, application/rss+xml, application/xml, text/xml;q=0.9",
    "user-agent": "toss-ai-agent/0.1 (keyless public-data collector)",
  };
}

function parseGdeltDate(value) {
  const text = String(value ?? "");
  const match = text.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return validIsoDate(text);
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}

function validIsoDate(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function safeDomain(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function isFresh(timestamp, now, maxAgeMs) {
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) && now.getTime() - time <= maxAgeMs;
}

async function readCache(cachePath) {
  try {
    return JSON.parse(await readFile(cachePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeCache(cachePath, snapshot) {
  const temporaryPath = `${cachePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, cachePath);
}
