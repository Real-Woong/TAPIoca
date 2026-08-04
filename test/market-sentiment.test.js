import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { combineSentimentLayers, loadMarketSentiment } from "../src/sentiment/market-sentiment.js";

const official = {
  sentiment_score: 0.4,
  confidence: 0.8,
  summary_reason: "official",
  bullish_signals: ["growth"],
  bearish_signals: [],
};
const opinion = {
  sentiment_score: -0.8,
  confidence: 0.9,
  summary_reason: "opinion",
  bullish_signals: [],
  bearish_signals: ["recession"],
};

test("전문가 의견을 공식 뉴스의 10% 보조 계층으로 합친다", () => {
  const result = combineSentimentLayers({
    officialSentiment: official,
    opinionSentiment: opinion,
    officialCount: 20,
    opinionCount: 5,
    opinionWeight: 0.1,
  });

  assert.equal(result.sentiment_score, 0.291);
  assert.equal(result.confidence, 0.809);
  assert.deepEqual(result.bearish_signals, ["recession"]);
});

test("전문가 의견만 있으면 신뢰도를 10%로 제한한다", () => {
  const result = combineSentimentLayers({
    officialSentiment: official,
    opinionSentiment: opinion,
    officialCount: 0,
    opinionCount: 5,
    opinionWeight: 0.1,
  });

  assert.equal(result.sentiment_score, -0.8);
  assert.equal(result.confidence, 0.09);
});

test("cacheMinutes를 주면 그 값으로 뉴스 캐시 수명을 정한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sentiment-"));
  try {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls += 1;
      if (String(url).includes("gdeltproject")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ articles: [{ title: "stocks rally", url: "https://a/1", seendate: "20260803T120000Z" }] }),
          text: async () => "",
        };
      }
      return { ok: true, status: 200, text: async () => "<rss><channel></channel></rss>" };
    };

    const base = { dataDir, fetchImpl, blueskyAuthors: [], opinionFeeds: [] };
    await loadMarketSentiment({ ...base, cacheMinutes: 60, now: new Date("2026-08-03T12:00:00Z") });
    const afterFirst = calls;

    // 30분 뒤: 기본값 15분이었다면 재수집했겠지만 60분 설정이라 캐시를 씁니다.
    await loadMarketSentiment({ ...base, cacheMinutes: 60, now: new Date("2026-08-03T12:30:00Z") });
    assert.equal(calls, afterFirst);

    // 70분 뒤에는 다시 수집합니다.
    await loadMarketSentiment({ ...base, cacheMinutes: 60, now: new Date("2026-08-03T13:10:00Z") });
    assert.ok(calls > afterFirst);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
