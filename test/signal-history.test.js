import test from "node:test";
import assert from "node:assert/strict";

import {
  extractSentimentSeries,
  summarizeSentimentSeries,
  toDailySeries,
} from "../src/paper/signal-history.js";

function event(at, { fetchedAt, score, articleCount = 400 } = {}) {
  return {
    at,
    score: 0.5,
    contributions: { sentiment: score * 0.6 },
    signals: {
      weights: { sentiment: 1 },
      fred: { score: -0.5 },
      sentiment: { score, confidence: 0.6, articleCount, fetchedAt },
      sentimentFreshness: { ageHours: 1, multiplier: 0.9 },
      trend: { score: 0.98, confidence: 1, annualizedVol: 0.14 },
      macd: { score: 0.47, confidence: 1 },
    },
  };
}

// PAPER 실행기는 15분마다 돌지만 뉴스는 60분 캐시를 재사용한다. 사이클마다 한 건씩
// 세면 같은 뉴스가 네 번 계산돼 표본이 부풀고 자기상관이 1에 가깝게 왜곡된다.
test("같은 수집 시각의 스냅샷은 한 건으로만 센다", () => {
  const series = extractSentimentSeries([
    event("2026-08-05T14:00:00Z", { fetchedAt: "2026-08-05T13:10:00Z", score: 0.108 }),
    event("2026-08-05T14:15:00Z", { fetchedAt: "2026-08-05T13:10:00Z", score: 0.108 }),
    event("2026-08-05T14:30:00Z", { fetchedAt: "2026-08-05T13:10:00Z", score: 0.108 }),
    event("2026-08-05T15:15:00Z", { fetchedAt: "2026-08-05T14:40:00Z", score: -0.2 }),
  ]);

  assert.equal(series.length, 2);
  assert.deepEqual(series.map((row) => row.score), [0.108, -0.2]);
  // 첫 관측을 남기므로 그 사이클의 통합 점수·기여도가 함께 붙는다.
  assert.equal(series[0].fredScore, -0.5);
  assert.equal(series[0].trendScore, 0.98);
});

test("원본 신호가 없는 예전 이벤트는 건너뛴다", () => {
  const series = extractSentimentSeries([
    { at: "2026-08-01T14:00:00Z", score: 0.3 },
    { at: "2026-08-04T14:00:00Z", signals: { sentiment: null } },
    event("2026-08-05T14:00:00Z", { fetchedAt: "2026-08-05T13:10:00Z", score: 0.1 }),
  ]);
  assert.equal(series.length, 1);
});

// UTC 14:00은 뉴욕 10:00으로 같은 날이지만, UTC 다음 날 01:00은 뉴욕으로는 전날 21:00이다.
// 서버가 UTC라 거래일을 UTC로 세면 장 마감 후 실행이 다음 날로 새어 나간다.
test("거래일은 뉴욕 시간 기준으로 묶는다", () => {
  const series = extractSentimentSeries([
    event("2026-08-06T01:00:00Z", { fetchedAt: "2026-08-06T00:40:00Z", score: 0.2 }),
  ]);
  assert.equal(series[0].tradingDate, "2026-08-05");
});

test("하루에 여러 스냅샷이 있으면 마지막 것만 일별 시계열에 남긴다", () => {
  const daily = toDailySeries(extractSentimentSeries([
    event("2026-08-05T14:00:00Z", { fetchedAt: "2026-08-05T13:10:00Z", score: 0.1 }),
    event("2026-08-05T18:00:00Z", { fetchedAt: "2026-08-05T17:10:00Z", score: 0.3 }),
    event("2026-08-06T14:00:00Z", { fetchedAt: "2026-08-06T13:10:00Z", score: -0.2 }),
  ]));

  assert.deepEqual(daily.map((row) => row.tradingDate), ["2026-08-05", "2026-08-06"]);
  assert.deepEqual(daily.map((row) => row.score), [0.3, -0.2]);
});

// 이 통계가 감성 층을 유지할지 말지를 가른다. 매일 부호가 뒤집히는 값은
// 난수와 구분되지 않으므로 자기상관이 0 근처로 나와야 한다.
test("매일 부호가 뒤집히는 값은 자기상관이 음수로 나온다", () => {
  const alternating = Array.from({ length: 20 }, (unused, index) =>
    event(`2026-08-${String(index + 1).padStart(2, "0")}T14:00:00Z`, {
      fetchedAt: `2026-08-${String(index + 1).padStart(2, "0")}T13:00:00Z`,
      score: index % 2 === 0 ? 0.3 : -0.3,
    }),
  );

  const summary = summarizeSentimentSeries(extractSentimentSeries(alternating));
  assert.equal(summary.count, 20);
  assert.ok(summary.autocorrelation < 0, `자기상관 ${summary.autocorrelation}`);
  assert.equal(summary.signFlips, 19);
  // 표준편차 0.3인데 하루 변동폭이 0.6이면 값이 매일 새로 뽑히는 것이다.
  assert.equal(summary.meanAbsChange, 0.6);
});

test("이어지는 값은 자기상관이 양수로 나온다", () => {
  const drifting = Array.from({ length: 20 }, (unused, index) =>
    event(`2026-08-${String(index + 1).padStart(2, "0")}T14:00:00Z`, {
      fetchedAt: `2026-08-${String(index + 1).padStart(2, "0")}T13:00:00Z`,
      // -0.475에서 0.475까지 한 방향으로 움직입니다(정확히 0을 밟지 않게 어긋냅니다).
      score: Math.round((index * 0.05 - 0.475) * 1000) / 1000,
    }),
  );

  const summary = summarizeSentimentSeries(extractSentimentSeries(drifting));
  assert.ok(summary.autocorrelation > 0.8, `자기상관 ${summary.autocorrelation}`);
  assert.equal(summary.signFlips, 1);
});

// 표본이 적을 때 숫자를 내면 그 숫자가 근거처럼 쓰인다. 아예 내지 않는 편이 안전하다.
test("표본이 10건 미만이면 자기상관을 계산하지 않는다", () => {
  const few = Array.from({ length: 5 }, (unused, index) =>
    event(`2026-08-0${index + 1}T14:00:00Z`, {
      fetchedAt: `2026-08-0${index + 1}T13:00:00Z`,
      score: index * 0.1,
    }),
  );

  const summary = summarizeSentimentSeries(extractSentimentSeries(few));
  assert.equal(summary.count, 5);
  assert.equal(summary.autocorrelation, null);
});

test("기록이 없으면 빈 요약을 낸다", () => {
  const summary = summarizeSentimentSeries([]);
  assert.equal(summary.count, 0);
  assert.equal(summary.autocorrelation, null);
});
