#!/usr/bin/env node

import path from "node:path";
import { loadMarketSentiment } from "./market-sentiment.js";

try {
  const result = await loadMarketSentiment({
    dataDir: path.resolve(process.env.PAPER_DATA_DIR || "data"),
    provider: process.env.SENTIMENT_PROVIDER || "local",
    ollamaModel: process.env.OLLAMA_MODEL,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    query: process.env.NEWS_QUERY,
    maxResults: process.env.NEWS_MAX_RECORDS,
    blueskyAuthors: csv(process.env.BLUESKY_AUTHORS),
    opinionFeeds: csv(process.env.OPINION_RSS_FEEDS),
    opinionWeight: process.env.OPINION_SCORE_WEIGHT || 0.1,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`감성 분석 오류: ${error.message}`);
  process.exitCode = 1;
}

function csv(value) {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}
