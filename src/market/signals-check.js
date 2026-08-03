#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildDailyMacdSignal } from "./macd-signal.js";
import { loadDailyCloses, loadTrendSignal } from "./trend-signal.js";

// 일봉 종가 수집이 실제로 되는지 확인하는 조회 전용 진단입니다.
// 실행 중인 PAPER 장부와 캐시를 건드리지 않도록 임시 디렉터리에 받습니다.
const symbols = (process.env.ETF_WATCHLIST || "VTI,SCHD,IWM")
  .split(",")
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);

const apiKey = process.env.TWELVE_DATA_API_KEY;
const dataDir = await mkdtemp(path.join(tmpdir(), "signals-check-"));

try {
  console.log(`대상 종목: ${symbols.join(", ")}`);
  console.log(`TWELVE_DATA_API_KEY: ${apiKey ? `설정됨 (${maskKey(apiKey)})` : "없음 — 공개 소스만 시도"}`);
  console.log("");

  const trend = await loadTrendSignal({ dataDir, symbols, apiKey });
  const closes = await loadDailyCloses({ dataDir });
  const macd = buildDailyMacdSignal(closes);

  console.log("── 일봉 수집 ──────────────────────────");
  for (const symbol of symbols) {
    const series = closes[symbol];
    const source = trend.sources?.[symbol];
    console.log(
      series?.length
        ? `  ✔ ${symbol.padEnd(5)} ${String(series.length).padStart(3)}개  ` +
          `최근 종가 ${series.at(-1)}  (출처 ${source})`
        : `  ✘ ${symbol.padEnd(5)} 수집 실패`,
    );
  }
  if (trend.failures?.length) {
    console.log(`  ⚠️ 일부 실패: ${trend.failures.join(" | ")}`);
  }

  console.log("");
  console.log("── 추세(200일선) ──────────────────────");
  if (trend.available) {
    console.log(`  ✔ 점수 ${trend.score} (신뢰도 ${trend.confidence}, ${trend.readySymbols}/${trend.totalSymbols}종목)`);
    for (const [symbol, indicator] of Object.entries(trend.indicators)) {
      console.log(
        indicator.ready
          ? `    ${symbol.padEnd(5)} 종가 ${indicator.price} vs 200일선 ${indicator.movingAverage} ` +
            `(${indicator.deviationPercent >= 0 ? "+" : ""}${indicator.deviationPercent}%) ${indicator.direction}`
          : `    ${symbol.padEnd(5)} 표본 ${indicator.sampleCount}/${indicator.minimumSamples} — 준비 중`,
      );
    }
    if (trend.volatility) {
      console.log(`    연율 변동성 ${(trend.volatility.annualized * 100).toFixed(1)}%`);
    }
  } else {
    console.log(`  ✘ 사용 불가 (${trend.reason})`);
  }

  console.log("");
  console.log("── MACD (일봉 12/26/9) ────────────────");
  if (macd.available) {
    console.log(`  ✔ 점수 ${macd.score} (신뢰도 ${macd.confidence}, ${macd.readySymbols}/${macd.totalSymbols}종목, ${macd.source})`);
    for (const [symbol, indicator] of Object.entries(macd.indicators)) {
      if (!indicator.ready) continue;
      console.log(
        `    ${symbol.padEnd(5)} histogram ${indicator.histogramPercent}% → 점수 ${indicator.score} ${indicator.direction}`,
      );
    }
  } else {
    console.log(`  ✘ 사용 불가 (${macd.reason})`);
  }

  console.log("");
  console.log("조회 전용 진단입니다. PAPER 장부와 캐시를 변경하지 않았습니다.");
  if (!trend.available || !macd.available) process.exitCode = 1;
} catch (error) {
  console.error("");
  console.error(`✘ 일봉 수집 실패: ${error.message}`);
  console.error("");
  console.error("확인 순서:");
  console.error("  1. .env에 TWELVE_DATA_API_KEY가 따옴표·공백 없이 KEY=값 형태인지");
  console.error("  2. 위 오류에 TWELVEDATA 항목이 없으면 키를 못 읽은 것입니다");
  console.error("  3. 'API credits' 문구가 있으면 하루 한도(800회)를 넘긴 것입니다");
  process.exitCode = 1;
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

/** 로그에 키 전체가 남지 않도록 앞뒤만 보여줍니다. */
function maskKey(value) {
  const key = String(value);
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-2)}`;
}
