#!/usr/bin/env node

import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadMacroSignal } from "../FRED_data/macro-snapshot.js";
import { loadMarketSentiment } from "../sentiment/market-sentiment.js";
import { combineMarketSignals } from "../sentiment/market-signal.js";
import { createPaperState, runPaperCycle } from "./paper-engine.js";
import { appendPaperEvent, buildPaperEvent } from "./event-log.js";
import { createTossClientFromEnv, TossApiError } from "../toss/toss-client.js";
import { createUsdBudget } from "./trading-budget.js";
import { loadTradingPolicy } from "./trading-policy.js";
import { getUsRegularSessionStatus } from "../market/us-market-session.js";
import { buildDailyMacdSignal, updateMacdSignal } from "../market/macd-signal.js";
import { loadDailyCloses, loadTrendSignal } from "../market/trend-signal.js";

const dataDir = path.resolve(process.env.PAPER_DATA_DIR || "data");
const statePath = path.join(dataDir, "paper-state.json");
const lockPath = path.join(dataDir, "paper-runner.lock");
const watchlist = readWatchlist(process.env.ETF_WATCHLIST || "VTI,SCHD,IWM");
let lock;

// systemd 타이머가 실행하는 PAPER 모드의 진입점입니다.
// 순서: 장 시간 확인 -> 잠금 -> 환율/현재가 조회 -> 장부 계산 -> 안전 저장.
try {
  await run();
} catch (error) {
  if (error?.code === "EEXIST") {
    console.error("다른 PAPER 실행이 진행 중이라 이번 실행을 건너뜁니다.");
  } else if (error instanceof TossApiError) {
    console.error(`토스 API 오류: ${error.message}`);
    if (error.code) console.error(`코드: ${error.code}`);
    if (error.requestId) console.error(`요청 ID: ${error.requestId}`);
  } else {
    console.error(`오류: ${error.message}`);
  }
  process.exitCode = 1;
} finally {
  if (lock) {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

async function run() {
  const policy = loadTradingPolicy();
  // 실제 주문 기능은 구현하지 않았으며 LIVE 설정이 감지되면 즉시 중단합니다.
  if (policy.mode !== "PAPER") {
    throw new Error("실주문 실행기는 아직 구현되지 않았습니다. LIVE_TRADING=false로 되돌리세요.");
  }

  const session = getUsRegularSessionStatus();
  const forced = process.argv.includes("--force");
  // 장외에는 Toss 클라이언트를 만들기 전에 반환하므로 토큰과 시세 API를 호출하지 않습니다.
  if (!session.isOpen && !forced) {
    console.log(
      `미국 정규장 시간이 아닙니다 (${session.newYorkTime} ET, ${session.reason}). ` +
        "토큰 발급과 시장 조회를 건너뜁니다.",
    );
    return;
  }
  if (forced && !session.isOpen) {
    console.log(`강제 PAPER 실행: 미국 정규장 밖입니다 (${session.newYorkTime} ET).`);
  }

  await mkdir(dataDir, { recursive: true });
  // wx 모드는 이미 잠금 파일이 있으면 실패합니다. 실행이 겹쳐 장부가 깨지는 것을 막습니다.
  lock = await open(lockPath, "wx");

  const now = new Date();
  const client = createTossClientFromEnv();
  // 환율·가격과 거시경제 신호는 서로 의존하지 않으므로 동시에 조회합니다.
  // FRED가 실패하면 null을 반환해 청산 계산은 계속하고 신규 매수만 중단합니다.
  const macroRequest = loadMacroSignal({
    dataDir,
    apiKey: process.env.FRED_API_KEY,
    now,
  }).catch((error) => {
    console.error(`FRED 거시 신호를 사용할 수 없습니다: ${error.message}`);
    return null;
  });
  // Fed RSS와 GDELT는 API 키 없이 사용합니다. 장애 시 FRED·MACD 경로는 계속 동작합니다.
  const sentimentRequest = loadMarketSentiment({
    dataDir,
    provider: process.env.SENTIMENT_PROVIDER || "local",
    ollamaModel: process.env.OLLAMA_MODEL,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    query: process.env.NEWS_QUERY,
    maxResults: process.env.NEWS_MAX_RECORDS,
    cacheMinutes: process.env.NEWS_CACHE_MINUTES,
    blueskyAuthors: readCsv(process.env.BLUESKY_AUTHORS),
    opinionFeeds: readCsv(process.env.OPINION_RSS_FEEDS),
    opinionWeight: process.env.OPINION_SCORE_WEIGHT || 0.1,
    now,
  }).catch((error) => {
    console.error(`무료 시장 뉴스를 사용할 수 없습니다: ${error.message}`);
    return null;
  });
  const [exchangeRate, rawPrices, macroSignal, sentiment] = await Promise.all([
    client.getExchangeRate("USD", "KRW"),
    client.getPrices(watchlist),
    macroRequest,
    sentimentRequest,
  ]);
  const prices = normalizePrices(rawPrices);
  // 15분 가격 스냅샷은 진단용으로 계속 쌓습니다. 판단에는 쓰지 않습니다.
  await updateMacdSignal({ dataDir, prices, now }).catch((error) => {
    console.error(`MACD 가격 스냅샷 갱신 실패: ${error.message}`);
  });
  // Faber 이동평균 추세: Stooq 무료 일봉으로 200일선을 계산합니다. 실패하면 추세 없이 진행합니다.
  const trend = await loadTrendSignal({
    dataDir,
    symbols: watchlist,
    now,
    apiKey: process.env.TWELVE_DATA_API_KEY,
  }).catch((error) => {
    console.error(`이동평균 추세 신호를 사용할 수 없습니다: ${error.message}`);
    return null;
  });
  // MACD는 추세 신호가 방금 받아둔 같은 일봉 종가로 계산합니다(추가 요청 없음).
  const macd = await loadDailyCloses({ dataDir })
    .then((closes) => buildDailyMacdSignal(closes, macdOptions(), now))
    .catch((error) => {
      console.error(`MACD 시장 신호를 사용할 수 없습니다: ${error.message}`);
      return null;
    });
  const marketSignal = combineMarketSignals(macroSignal, sentiment, {
    macroWeight: readMacroWeight(process.env.MACRO_SCORE_WEIGHT),
    sentimentWeight: readSentimentWeight(process.env.SENTIMENT_SCORE_WEIGHT),
    trend,
    trendWeight: readTrendWeight(process.env.TREND_SCORE_WEIGHT),
    macd,
    macdWeight: readMacdWeight(process.env.MACD_SCORE_WEIGHT),
    volTarget: readRate01(process.env.VOL_TARGET_ANNUALIZED, 0.15, "VOL_TARGET_ANNUALIZED"),
    minExposure: readRate01(process.env.MIN_EXPOSURE, 0.3, "MIN_EXPOSURE"),
  });
  let state = await readState();

  if (!state) {
    // 첫 정규장 실행에서만 현재 환율을 적용해 10만 원 이하의 가상 USD 지갑을 만듭니다.
    const budget = createUsdBudget(exchangeRate.rate);
    state = createPaperState({ budget, watchlist, now });
  }

  const result = runPaperCycle(state, prices, policy, now, marketSignal);
  await writeState(result.state);
  // 모든 사이클을 append-only 로그에 남깁니다. 실패해도 매매·저장은 이미 끝났으므로 진행합니다.
  await appendPaperEvent(dataDir, buildPaperEvent({ now, marketSignal, result, prices }))
    .catch((error) => {
      console.error(`이벤트 로그 기록 실패: ${error.message}`);
    });
  printResult(result, exchangeRate, marketSignal);
}

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(state) {
  // 임시 파일을 완성한 뒤 rename하여, 저장 중 프로세스가 종료돼도 기존 장부를 보호합니다.
  const temporaryPath = `${statePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, statePath);
}

function normalizePrices(rawPrices) {
  return rawPrices.flat(2).map((item) => ({
    symbol: item.symbol,
    timestamp: item.timestamp,
    lastPrice: Number(item.lastPrice),
    currency: item.currency,
  })).filter((item) => item.symbol && Number.isFinite(item.lastPrice) && item.lastPrice > 0);
}

function readWatchlist(value) {
  const symbols = value.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) throw new Error("ETF_WATCHLIST에 최소 한 종목이 필요합니다.");
  return [...new Set(symbols)];
}

function readCsv(value) {
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function readSentimentWeight(value) {
  if (value === undefined || value === "") return 2;
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight < 0 || weight > 5) {
    throw new Error("SENTIMENT_SCORE_WEIGHT는 0~5 숫자여야 합니다.");
  }
  return weight;
}

/**
 * 거시 층의 가중치입니다. **기본값은 0입니다** — 2026-08-08에 사람이 정했습니다.
 *
 * 근거는 `STRATEGY.md` ⑨⑩입니다.
 *   · 상수인 동안 이 층은 신호가 아니라 **노출 다이얼**이다 (Sharpe 부호일치 전부 ✗)
 *   · 값이 움직이는 것은 **평균적으로 해롭다** — 2008 한 구간만 우위, 나머지 3구간 열세
 *
 * 그리고 남은 선택(어떤 상수로 둘 것인가)에서 0을 골랐습니다. −0.5는 오늘의
 * FRED 값일 뿐이고, 20년 되살리기 평균은 +0.153이라 **분포의 비관 쪽 끝에
 * 고정할 이유가 없었습니다.** 노출을 줄이고 싶다면 여섯 개 FRED 문턱의
 * 부산물이 아니라 명시적인 손잡이로 정합니다.
 *
 * **점수는 계속 계산되고 기록됩니다.** 배분에만 관여하지 않습니다 — 폭락이
 * 한 번 더 쌓이면 같은 질문을 다시 물을 수 있어야 합니다.
 *
 * 되돌리려면 `.env`에 `MACRO_SCORE_WEIGHT=1`을 넣습니다.
 */
function readMacroWeight(value) {
  if (value === undefined || value === "") return 0;
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new Error("MACRO_SCORE_WEIGHT는 0~1 숫자여야 합니다.");
  }
  return weight;
}

function readTrendWeight(value) {
  if (value === undefined || value === "") return 1;
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight < 0 || weight > 3) {
    throw new Error("TREND_SCORE_WEIGHT는 0~3 숫자여야 합니다.");
  }
  return weight;
}

/** 일봉 MACD의 히스토그램 스케일만 환경변수로 조정할 수 있게 열어둡니다. */
function macdOptions() {
  const scale = Number(process.env.MACD_HISTOGRAM_SCALE_PERCENT);
  return Number.isFinite(scale) && scale > 0 ? { histogramScalePercent: scale } : {};
}

/**
 * MACD 기본 가중치는 0입니다. 즉 판단에는 쓰지 않고 진단 지표로만 표시합니다.
 *
 * 근거 두 가지입니다.
 * 1. 산술: 0.15 가중치의 실제 기여도는 08-04 기준 +0.029였습니다. 결정이 갈리는
 *    지점이 ±1.5이므로, 어떤 값이 나와도 배분을 바꿀 수 없는 크기였습니다.
 * 2. 백테스트: 0 / 0.15 / 0.5 / 1.0을 4국면 × 시드 4개로 돌린 결과, 0.5가 bear
 *    한 칸에서만 튀고 1.0에서 사라졌습니다. 단조성이 없는 개선은 노이즈입니다.
 *
 * 실데이터 백테스트에서 증분이 확인되면 MACD_SCORE_WEIGHT로 켜십시오.
 */
function readMacdWeight(value) {
  if (value === undefined || value === "") return 0;
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new Error("MACD_SCORE_WEIGHT는 0~1 숫자여야 합니다.");
  }
  return weight;
}

function readRate01(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(`${name}는 0~1 숫자여야 합니다.`);
  }
  return rate;
}

function printResult({ decisions, summary }, exchangeRate, marketSignal) {
  console.log(`PAPER 실행 완료: ${new Date().toISOString()}`);
  console.log(`적용 환율: 1 USD = ${exchangeRate.rate} KRW`);
  console.log(`고정 원금: ${summary.fundingKrw.toLocaleString("ko-KR")} KRW`);
  console.log(`최초 PAPER 지갑: ${summary.fundedUsd.toFixed(2)} USD`);
  console.log(`현금: ${summary.cashUsd.toFixed(2)} USD`);
  console.log(`ETF 평가액: ${summary.marketValueUsd.toFixed(2)} USD`);
  console.log(`총손익: ${summary.totalPnlUsd.toFixed(2)} USD (${summary.returnPct}%)`);
  if (summary.feesUsd) {
    console.log(`누적 거래비용: -${summary.feesUsd.toFixed(2)} USD`);
  }
  if (summary.benchmark) {
    console.log(
      `벤치마크 ${summary.benchmark.symbol} 매수후보유: ` +
        `${summary.benchmark.pnlUsd.toFixed(2)} USD (${summary.benchmark.returnPct}%), ` +
        `초과성과 ${summary.alphaUsd.toFixed(2)} USD`,
    );
  }
  if (marketSignal) {
    console.log(
      `통합 시장 판정: ${marketSignal.regime} ` +
        `(점수 ${marketSignal.score}, ${marketSignal.signalSource || marketSignal.source})`,
    );
    if (marketSignal.sentiment) {
      console.log(
        `무료 뉴스 감성: ${marketSignal.sentiment.sentiment_score} ` +
          `(신뢰도 ${marketSignal.sentiment.confidence}, ${marketSignal.sentiment.provider}, ` +
          `${marketSignal.sentiment.articleCount}건)`,
      );
      if (marketSignal.sentiment.opinionArticleCount > 0) {
        console.log(
          `전문가 의견: ${marketSignal.sentiment.opinionArticleCount}건 ` +
            `(보조 비중 ${marketSignal.sentiment.opinionWeight})`,
        );
      }
    } else {
      console.log("무료 뉴스 감성: 사용 불가 (FRED·추세로 폴백)");
    }
    if (marketSignal.trend) {
      console.log(
        `추세(200일선): ${marketSignal.trend.score} ` +
          `(신뢰도 ${marketSignal.trend.confidence}, ` +
          `${marketSignal.trend.readySymbols}/${marketSignal.trend.totalSymbols}종목)`,
      );
    } else {
      console.log("추세(200일선): 준비 중 (일봉 200개 필요)");
    }
    if (Number(marketSignal.exposureMultiplier) < 1) {
      console.log(
        `변동성 관리: 연율 ${(Number(marketSignal.volatilityAnnualized) * 100).toFixed(1)}% → ` +
          `주식 익스포저 ×${marketSignal.exposureMultiplier}`,
      );
    }
    if (marketSignal.macd) {
      console.log(
        `MACD: ${marketSignal.macd.score} ` +
          `(신뢰도 ${marketSignal.macd.confidence}, ` +
          `${marketSignal.macd.readySymbols}/${marketSignal.macd.totalSymbols}종목, 일봉)`,
      );
    } else {
      console.log("MACD: 준비 중 (12·26·9 계산에 최소 34개 일봉 종가 필요)");
    }
  } else {
    console.log("거시경제 판정: 사용 불가 — 신규 매수를 중단했습니다.");
  }
  for (const decision of decisions) {
    console.log(`- ${decision.symbol}: ${decision.action} (${decision.reason})`);
  }
  console.log("실제 주문 API는 호출하지 않았습니다.");
}
