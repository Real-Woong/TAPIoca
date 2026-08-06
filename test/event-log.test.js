import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendPaperEvent,
  buildPaperEvent,
  readPaperEvents,
} from "../src/paper/event-log.js";

test("이벤트를 덧붙이고 최근 N건을 순서대로 읽는다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "events-"));
  try {
    for (let index = 0; index < 5; index += 1) {
      await appendPaperEvent(dataDir, { at: `2026-07-25T0${index}:00:00Z`, index });
    }
    const all = await readPaperEvents(dataDir);
    assert.equal(all.length, 5);
    assert.equal(all[0].index, 0);

    const recent = await readPaperEvents(dataDir, { limit: 2 });
    assert.deepEqual(recent.map((event) => event.index), [3, 4]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("로그 파일이 없으면 빈 배열을 반환한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "events-"));
  try {
    assert.deepEqual(await readPaperEvents(dataDir), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("신호와 실행 결과에서 감사 가능한 이벤트를 만든다", () => {
  const event = buildPaperEvent({
    now: new Date("2026-07-25T14:00:00Z"),
    marketSignal: {
      regime: "RISK_OFF",
      score: -2.3,
      signalSource: "FRED_NEWS_TREND",
      macroScore: -1.5,
      sentimentContribution: -0.3,
      trendContribution: -0.5,
      macdContribution: 0,
      targetAllocation: { VTI: 0.4, SCHD: 0.2, CASH: 0.4 },
    },
    result: {
      decisions: [
        { symbol: "VTI", action: "SELL", reason: "MACRO_RISK_OFF_REBALANCE_SELL", amountUsd: 12.3 },
        { symbol: "PORTFOLIO", action: "PAUSE_BUY", reason: "DAILY_LOSS_LIMIT" },
      ],
      summary: {
        equityUsd: 66.5,
        cashUsd: 30,
        marketValueUsd: 36.5,
        realizedPnlUsd: 0.1,
        unrealizedPnlUsd: -0.6,
        totalPnlUsd: -0.5,
        returnPct: -0.746,
        benchmark: { symbol: "VTI", valueUsd: 66, pnlUsd: -1.05, returnPct: -1.566 },
        alphaUsd: 0.55,
      },
    },
  });

  assert.equal(event.regime, "RISK_OFF");
  assert.equal(event.contributions.trend, -0.5);
  assert.equal(event.decisions.length, 2);
  assert.equal(event.decisions[0].reason, "MACRO_RISK_OFF_REBALANCE_SELL");
  assert.equal(event.benchmark.symbol, "VTI");
  assert.equal(event.alphaUsd, 0.55);
});

// 감성 층은 그날의 수집창이 지나가면 복원할 수 없다. 원본 값이 로그에 남지 않으면
// 나중에 "가중치를 바꿨다면"을 되돌릴 방법이 영원히 사라지므로 여기서 고정한다.
test("가중치를 곱하기 전 원본 신호와 그 시점 가격을 함께 남긴다", () => {
  const event = buildPaperEvent({
    now: new Date("2026-08-05T14:00:00Z"),
    marketSignal: {
      regime: "NEUTRAL",
      score: 0.547,
      macroScore: -0.5,
      // 0.108 × 신뢰도 0.611 × 가중치 1 × 신선도 0.909
      sentimentContribution: 0.06,
      trendContribution: 0.981,
      macdContribution: 0,
      weights: { sentiment: 1, trend: 1, macd: 0, volTarget: 0.15, minExposure: 0.3 },
      sentiment: {
        sentiment_score: 0.108,
        confidence: 0.611,
        articleCount: 434,
        sourceCounts: { FED_RSS: 30, GDELT: 75, BLUESKY: 229, OPINION_RSS: 100 },
        provider: "LOCAL_RULES",
        fetchedAt: "2026-08-05T13:10:00Z",
      },
      sentimentFreshness: { ageHours: 0.833, multiplier: 0.909 },
      trend: {
        score: 0.980867, confidence: 1, readySymbols: 3, totalSymbols: 3,
        volatility: { annualized: 0.142 },
      },
      macd: { score: 0.468955, confidence: 1, readySymbols: 3, totalSymbols: 3 },
    },
    result: { decisions: [], summary: { equityUsd: 67.63, cashUsd: 6.39 } },
    prices: [
      { symbol: "VTI", lastPrice: 301.2 },
      { symbol: "IWM", lastPrice: 240.8 },
    ],
  });

  // 기여도(0)만 남으면 MACD 원점수 0.469를 되살릴 수 없다.
  assert.equal(event.contributions.macd, 0);
  assert.equal(event.signals.macd.score, 0.468955);
  assert.equal(event.signals.weights.macd, 0);

  assert.equal(event.signals.sentiment.score, 0.108);
  assert.equal(event.signals.sentiment.fetchedAt, "2026-08-05T13:10:00Z");
  assert.equal(event.signals.sentiment.sourceCounts.BLUESKY, 229);
  assert.equal(event.signals.sentimentFreshness.multiplier, 0.909);
  assert.equal(event.signals.trend.annualizedVol, 0.142);
  assert.equal(event.signals.fred.score, -0.5);
  assert.deepEqual(event.prices, { VTI: 301.2, IWM: 240.8 });

  // 원본 기여도 = 원점수 × 신뢰도 × 가중치 × 신선도로 재계산이 되는지 확인한다.
  const { sentiment, sentimentFreshness, weights } = event.signals;
  const recomputed = sentiment.score * sentiment.confidence * weights.sentiment
    * sentimentFreshness.multiplier;
  assert.ok(Math.abs(recomputed - event.contributions.sentiment) < 0.001);
});

test("신호나 가격이 없어도 이벤트를 만든다", () => {
  const event = buildPaperEvent({
    marketSignal: null,
    result: { decisions: [], summary: { equityUsd: 67 } },
  });
  assert.equal(event.signals, null);
  assert.equal(event.prices, null);
});
