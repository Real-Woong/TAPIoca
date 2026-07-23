import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeSentimentLocally,
  analyzeSentimentWithOllama,
  validateSentimentResult,
} from "../src/sentiment/sentiment-analyzer.js";

test("강세 문장에서 양수 감성과 요구된 JSON 스키마를 반환한다", () => {
  const result = analyzeSentimentLocally([
    { text: "$SPY bullish breakout and strong growth", metrics: { like_count: 30 } },
    { text: "Cooling inflation raises soft landing hopes" },
  ]);
  assert.ok(result.sentiment_score > 0);
  assert.ok(result.confidence > 0);
  assert.deepEqual(Object.keys(result), [
    "sentiment_score",
    "confidence",
    "summary_reason",
    "bullish_signals",
    "bearish_signals",
  ]);
  assert.ok(result.bullish_signals.length > 0);
});

test("약세 표현과 부정을 방향에 반영한다", () => {
  const bearish = analyzeSentimentLocally(["recession risk and market crash", "weak growth, selloff ahead"]);
  const negated = analyzeSentimentLocally(["recession is not likely", "not bearish"]);
  assert.ok(bearish.sentiment_score < 0);
  assert.ok(negated.sentiment_score > bearish.sentiment_score);
});

test("스키마 밖의 필드나 범위를 거부한다", () => {
  assert.throws(() => validateSentimentResult({
    sentiment_score: 2,
    confidence: 0.5,
    summary_reason: "test",
    bullish_signals: [],
    bearish_signals: [],
    extra: true,
  }), /JSON 필드/);
});

test("Ollama에 JSON 스키마와 temperature 0을 전달하고 응답을 재검증한다", async () => {
  let requestBody;
  const result = await analyzeSentimentWithOllama(["market rally"], {
    model: "local-test-model",
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            sentiment_score: 0.4,
            confidence: 0.7,
            summary_reason: "rally",
            bullish_signals: ["rally"],
            bearish_signals: [],
          }),
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(requestBody.format.additionalProperties, false);
  assert.equal(requestBody.options.temperature, 0);
  assert.equal(result.sentiment_score, 0.4);
});
