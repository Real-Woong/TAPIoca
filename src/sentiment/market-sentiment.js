import { analyzeSentiment } from "./sentiment-analyzer.js";
import { fetchFreeMarketNews } from "./free-news-fetcher.js";

export async function loadMarketSentiment({
  dataDir,
  provider = "local",
  ollamaModel,
  ollamaBaseUrl,
  query,
  fedFeeds,
  blueskyAuthors,
  opinionFeeds,
  opinionWeight = 0.1,
  maxResults,
  cacheMinutes,
  now = new Date(),
  fetchImpl = fetch,
}) {
  const snapshot = await fetchFreeMarketNews({
    dataDir,
    ...(cacheMinutes ? { maxAgeMs: readCacheMs(cacheMinutes) } : {}),
    query,
    fedFeeds,
    blueskyAuthors,
    opinionFeeds,
    maxRecords: maxResults,
    now,
    fetchImpl,
  });
  const normalizedOpinionWeight = readOpinionWeight(opinionWeight);
  const { officialArticles, opinionArticles } = splitByLayer(snapshot.articles);
  const analysisOptions = {
    provider,
    model: ollamaModel,
    baseUrl: ollamaBaseUrl,
    fetchImpl,
  };
  const [officialSentiment, opinionSentiment] = await Promise.all([
    analyzeLayer(officialArticles, analysisOptions),
    analyzeLayer(opinionArticles, analysisOptions),
  ]);
  const result = combineSentimentLayers({
    officialSentiment,
    opinionSentiment,
    officialCount: officialArticles.length,
    opinionCount: opinionArticles.length,
    opinionWeight: normalizedOpinionWeight,
  });
  return {
    ...result,
    provider: provider === "ollama" ? "OLLAMA_LOCAL" : "LOCAL_RULES",
    fetchedAt: snapshot.fetchedAt,
    analyzedAt: now.toISOString(),
    articleCount: snapshot.resultCount,
    sourceCounts: snapshot.sourceCounts,
    officialArticleCount: officialArticles.length,
    opinionArticleCount: opinionArticles.length,
    officialSentiment,
    opinionSentiment,
    opinionWeight: normalizedOpinionWeight,
    source: snapshot.source,
    stale: snapshot.stale,
    warning: snapshot.warning,
    // 어느 소스가 살아 있고 어느 소스가 죽었는지 그대로 올려 보냅니다.
    // 죽은 소스가 있으면 이 층의 성격 자체가 달라지므로(예: 이벤트에 반응하는
    // 소스가 빠지면 값이 구조적으로 느려집니다) 판정 전에 보여야 합니다.
    sourceHealth: snapshot.sourceHealth ?? null,
  };
}

/**
 * 소스를 두 층으로 나눕니다.
 *
 *   공식  기관 발표와 보도. 가중치의 대부분을 먹습니다(기본 0.7).
 *   의견  개인·블로그. 나머지(기본 0.3)입니다.
 *
 * **분류에 없는 소스는 조용히 버려집니다.** 예전에는 목록을 인라인으로 두 번
 * 적어놨는데, 새 소스를 넣고 여기 안 적으면 받아놓고 안 쓰게 됩니다. 그래서
 * 한 곳에 모으고 **분류 안 된 것이 나오면 예외를 던집니다** — 조용히 버리는
 * 것보다 시끄럽게 멈추는 편이 낫습니다.
 */
export const LAYER_BY_PROVIDER = Object.freeze({
  FED_RSS: "official",
  // 질의 검색은 둘 다 보도 기반이라 공식 층입니다.
  GDELT: "official",
  GOOGLE_NEWS: "official",
  BLUESKY: "opinion",
  OPINION_RSS: "opinion",
});

export function splitByLayer(articles) {
  const officialArticles = [];
  const opinionArticles = [];
  const unknown = new Set();

  for (const article of articles ?? []) {
    const layer = LAYER_BY_PROVIDER[article.provider];
    if (layer === "official") officialArticles.push(article);
    else if (layer === "opinion") opinionArticles.push(article);
    else unknown.add(article.provider ?? "(없음)");
  }

  if (unknown.size > 0) {
    throw new Error(
      `분류되지 않은 뉴스 소스가 있습니다: ${[...unknown].join(", ")}. `
      + "LAYER_BY_PROVIDER에 추가하십시오 — 분류가 없으면 그 기사는 분석에서 빠집니다.",
    );
  }
  return { officialArticles, opinionArticles };
}

/** NEWS_CACHE_MINUTES를 밀리초로 바꿉니다. 잘못된 값이면 기본값을 쓰도록 undefined를 냅니다. */
function readCacheMs(minutes) {
  const value = Number(minutes);
  return Number.isFinite(value) && value > 0 ? value * 60 * 1000 : undefined;
}

function analyzeLayer(articles, options) {
  if (articles.length > 0) return analyzeSentiment(articles, options);
  return Promise.resolve({
    sentiment_score: 0,
    confidence: 0,
    summary_reason: "분석할 항목이 없어 중립으로 처리했습니다.",
    bullish_signals: [],
    bearish_signals: [],
  });
}

export function combineSentimentLayers({
  officialSentiment,
  opinionSentiment,
  officialCount,
  opinionCount,
  opinionWeight = 0.1,
}) {
  const hasOfficial = officialCount > 0;
  const hasOpinion = opinionCount > 0;
  if (!hasOfficial && !hasOpinion) return officialSentiment;
  if (!hasOfficial) {
    return {
      ...opinionSentiment,
      confidence: round(opinionSentiment.confidence * opinionWeight),
      summary_reason: `전문가 의견 ${opinionCount}건만 있어 신뢰도를 ${opinionWeight}배로 제한했습니다.`,
    };
  }
  if (!hasOpinion) return officialSentiment;

  const denominator = 1 + opinionWeight;
  return {
    sentiment_score: round(
      (officialSentiment.sentiment_score + opinionWeight * opinionSentiment.sentiment_score) /
        denominator,
    ),
    confidence: round(
      (officialSentiment.confidence + opinionWeight * opinionSentiment.confidence) / denominator,
    ),
    summary_reason:
      `공식 뉴스 ${officialCount}건에 전문가 의견 ${opinionCount}건을 ` +
      `${opinionWeight} 비중으로 보조 반영했습니다.`,
    bullish_signals: mergeSignals(
      officialSentiment.bullish_signals,
      opinionSentiment.bullish_signals,
    ),
    bearish_signals: mergeSignals(
      officialSentiment.bearish_signals,
      opinionSentiment.bearish_signals,
    ),
  };
}

function readOpinionWeight(value) {
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight < 0 || weight > 0.5) {
    throw new Error("OPINION_SCORE_WEIGHT는 0~0.5 숫자여야 합니다.");
  }
  return weight;
}

function mergeSignals(first = [], second = []) {
  return [...new Set([...first, ...second])].slice(0, 5);
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}
