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
