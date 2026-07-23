import test from "node:test";
import assert from "node:assert/strict";

import { combineSentimentLayers } from "../src/sentiment/market-sentiment.js";

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
