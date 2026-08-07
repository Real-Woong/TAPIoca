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
    cacheMinutes: process.env.NEWS_CACHE_MINUTES,
    blueskyAuthors: csv(process.env.BLUESKY_AUTHORS),
    opinionFeeds: csv(process.env.OPINION_RSS_FEEDS),
    opinionWeight: process.env.OPINION_SCORE_WEIGHT || 0.1,
  });
  console.log(JSON.stringify(result, null, 2));

  // JSON 안에 묻히면 안 보입니다. **어느 소스가 죽었는지는 한눈에 보여야 합니다** —
  // 소스 구성이 바뀌면 이 층이 재는 대상 자체가 달라지기 때문입니다.
  const health = result.sourceHealth;
  if (Array.isArray(health) && health.length > 0) {
    console.log("\n■ 소스 상태");
    for (const item of health) {
      console.log(
        `  ${item.ok ? "✔" : "✖"} ${String(item.source).padEnd(12)} ` +
          (item.ok ? `${item.articles}건` : item.error),
      );
    }
    const dead = health.filter((item) => !item.ok).map((item) => item.source);
    if (dead.length > 0) {
      console.log(
        `\n  죽은 소스: ${[...new Set(dead)].join(", ")}\n` +
          "  이 상태로 쌓는 표본은 '그 소스가 빠진 감성'을 재는 것입니다.",
      );
    }
  } else if (result.source === "CACHE" || result.source === "STALE_CACHE") {
    console.log(
      "\n■ 소스 상태: 캐시에서 읽어 알 수 없습니다." +
        "\n  갓 수집한 값으로 보려면 캐시가 만료된 뒤 다시 실행하십시오.",
    );
  }
} catch (error) {
  console.error(`감성 분석 오류: ${error.message}`);
  process.exitCode = 1;
}

function csv(value) {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}
