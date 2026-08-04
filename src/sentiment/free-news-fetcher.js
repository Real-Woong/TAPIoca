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

  const requests = [
    ...fedFeeds.map((url) => fetchFedRss(url, { fetchImpl })),
    fetchGdeltNews({ query, maxRecords: normalizedMaxRecords, timespan, fetchImpl }),
    ...unique(blueskyAuthors).map((actor) => fetchBlueskyAuthorFeed(actor, { fetchImpl })),
    ...unique(opinionFeeds).map((url) => fetchOpinionRss(url, { fetchImpl })),
  ];
  const settled = await Promise.allSettled(requests);
  const articles = dedupeArticles(
    settled.flatMap((result) => result.status === "fulfilled" ? result.value : []),
  );
  const failures = settled
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message ?? String(result.reason));

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
    warning: failures.length ? failures.join("; ") : undefined,
  };
  await mkdir(dataDir, { recursive: true });
  await writeCache(cachePath, snapshot);
  return { ...snapshot, source: "KEYLESS_NEWS", stale: false };
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
  const response = await fetchImpl(url, { headers: requestHeaders() });
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

export async function fetchFedRss(url, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { headers: requestHeaders() });
  if (!response.ok) throw new Error(`Fed RSS 요청 실패 (${response.status})`);
  return parseRss(await response.text(), url, {
    provider: "FED_RSS",
    domain: "federalreserve.gov",
  });
}

export async function fetchOpinionRss(url, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { headers: requestHeaders() });
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
  const response = await fetchImpl(url, { headers: requestHeaders() });
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
