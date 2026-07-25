import test from "node:test";
import assert from "node:assert/strict";

import { combineMarketSignals } from "../src/sentiment/market-signal.js";

const macro = {
  regime: "NEUTRAL",
  score: 0,
  targetAllocation: { VTI: 0.7, SCHD: 0.2, IWM: 0, CASH: 0.1 },
  reasons: ["FRED test"],
  source: "FRED",
};

test("감성 점수에 confidence를 곱해 FRED 점수와 합친다", () => {
  const combined = combineMarketSignals(macro, {
    sentiment_score: 1,
    confidence: 0.8,
    summary_reason: "bullish",
    bullish_signals: ["breakout"],
    bearish_signals: [],
  });
  assert.equal(combined.macroScore, 0);
  assert.equal(combined.sentimentContribution, 1.6);
  assert.equal(combined.score, 1.6);
  assert.equal(combined.regime, "RISK_ON");
  assert.equal(combined.targetAllocation.IWM, 0.15);
  assert.equal(combined.signalSource, "FRED_NEWS");
});

test("뉴스 감성을 사용할 수 없으면 FRED 결과를 그대로 유지한다", () => {
  const combined = combineMarketSignals(macro, null);
  assert.equal(combined.score, macro.score);
  assert.equal(combined.signalSource, "FRED_ONLY");
  assert.equal(combined.sentiment, null);
});

test("MACD를 신뢰도와 작은 가중치로 기본 점수에 더한다", () => {
  const combined = combineMarketSignals(macro, null, {
    macd: { available: true, score: 0.8, confidence: 0.75 },
    macdWeight: 0.15,
  });

  assert.equal(combined.baseScore, 0);
  assert.equal(combined.macdContribution, 0.09);
  assert.equal(combined.score, 0.09);
  assert.equal(combined.signalSource, "FRED_MACD");
});

test("표본이 부족한 MACD는 기존 판정에 영향을 주지 않는다", () => {
  const combined = combineMarketSignals(macro, null, {
    macd: { available: false, score: 1, confidence: 1 },
  });

  assert.equal(combined.score, macro.score);
  assert.equal(combined.macd, null);
  assert.equal(combined.signalSource, "FRED_ONLY");
});

test("이동평균 추세를 신뢰도와 가중치로 점수에 더한다", () => {
  const combined = combineMarketSignals(macro, null, {
    trend: { available: true, score: -0.8, confidence: 1 },
    trendWeight: 1,
  });

  assert.equal(combined.trendContribution, -0.8);
  assert.equal(combined.score, -0.8);
  assert.equal(combined.signalSource, "FRED_TREND");
  assert.equal(combined.trend.score, -0.8);
});

test("강한 하락 추세는 중립 거시 점수를 RISK_OFF로 끌어내린다", () => {
  const combined = combineMarketSignals(
    { ...macro, score: -1 },
    { sentiment_score: -0.3, confidence: 1, summary_reason: "", bullish_signals: [], bearish_signals: [] },
    {
      sentimentWeight: 1,
      trend: { available: true, score: -1, confidence: 1 },
      trendWeight: 1,
    },
  );

  // 거시 -1, 감성 -0.3, 추세 -1 = -2.3 → RISK_OFF
  assert.equal(combined.regime, "RISK_OFF");
  assert.equal(combined.signalSource, "FRED_NEWS_TREND");
});

test("사용할 수 없는 추세는 기존 판정에 영향을 주지 않는다", () => {
  const combined = combineMarketSignals(macro, null, {
    trend: { available: false, score: -1, confidence: 1 },
  });

  assert.equal(combined.score, macro.score);
  assert.equal(combined.trend, null);
  assert.equal(combined.signalSource, "FRED_ONLY");
});

test("변동성이 목표보다 높으면 주식 익스포저를 줄이고 현금을 늘린다", () => {
  const combined = combineMarketSignals(macro, null, {
    trend: { available: true, score: 0.5, confidence: 1, volatility: { annualized: 0.3 } },
    trendWeight: 0, // 배분 변화만 검증하기 위해 점수 기여는 0으로 둔다.
    volTarget: 0.15,
    minExposure: 0.3,
  });

  // 연율 변동성 0.30, 목표 0.15 → 배수 0.5
  assert.equal(combined.exposureMultiplier, 0.5);
  // NEUTRAL 기본 VTI 0.7 → 0.35, SCHD 0.2 → 0.1, 현금은 그만큼 증가
  assert.equal(combined.targetAllocation.VTI, 0.35);
  assert.equal(combined.targetAllocation.SCHD, 0.1);
  assert.ok(combined.targetAllocation.CASH > 0.5);
});

test("변동성이 목표 이하이면 익스포저를 줄이지 않는다", () => {
  const combined = combineMarketSignals(macro, null, {
    trend: { available: true, score: 0.5, confidence: 1, volatility: { annualized: 0.1 } },
    trendWeight: 0,
    volTarget: 0.15,
  });

  assert.equal(combined.exposureMultiplier, 1);
  assert.equal(combined.targetAllocation.VTI, 0.7);
});

test("minExposure 아래로는 익스포저를 줄이지 않는다", () => {
  const combined = combineMarketSignals(macro, null, {
    trend: { available: true, score: 0, confidence: 1, volatility: { annualized: 0.9 } },
    trendWeight: 0,
    volTarget: 0.15,
    minExposure: 0.3,
  });

  // 0.15/0.9 = 0.167 < 0.3 → 하한 0.3으로 고정
  assert.equal(combined.exposureMultiplier, 0.3);
});
