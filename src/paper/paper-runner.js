#!/usr/bin/env node

import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadMacroSignal } from "../FRED_data/macro-snapshot.js";
import { loadMarketSentiment } from "../sentiment/market-sentiment.js";
import { combineMarketSignals } from "../sentiment/market-signal.js";
import { createPaperState, runPaperCycle } from "./paper-engine.js";
import { createTossClientFromEnv, TossApiError } from "../toss/toss-client.js";
import { createUsdBudget } from "./trading-budget.js";
import { loadTradingPolicy } from "./trading-policy.js";
import { getUsRegularSessionStatus } from "../market/us-market-session.js";
import { updateMacdSignal } from "../market/macd-signal.js";

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
  // 현재가 스냅샷을 15분 단위로 누적합니다. 실패하거나 표본이 부족하면 MACD 없이 진행합니다.
  const macd = await updateMacdSignal({ dataDir, prices, now }).catch((error) => {
    console.error(`MACD 시장 신호를 사용할 수 없습니다: ${error.message}`);
    return null;
  });
  const marketSignal = combineMarketSignals(macroSignal, sentiment, {
    sentimentWeight: readSentimentWeight(process.env.SENTIMENT_SCORE_WEIGHT),
    macd,
    macdWeight: readMacdWeight(process.env.MACD_SCORE_WEIGHT),
  });
  let state = await readState();

  if (!state) {
    // 첫 정규장 실행에서만 현재 환율을 적용해 10만 원 이하의 가상 USD 지갑을 만듭니다.
    const budget = createUsdBudget(exchangeRate.rate);
    state = createPaperState({ budget, watchlist, now });
  }

  const result = runPaperCycle(state, prices, policy, now, marketSignal);
  await writeState(result.state);
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

function readMacdWeight(value) {
  if (value === undefined || value === "") return 0.15;
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new Error("MACD_SCORE_WEIGHT는 0~1 숫자여야 합니다.");
  }
  return weight;
}

function printResult({ decisions, summary }, exchangeRate, marketSignal) {
  console.log(`PAPER 실행 완료: ${new Date().toISOString()}`);
  console.log(`적용 환율: 1 USD = ${exchangeRate.rate} KRW`);
  console.log(`고정 원금: ${summary.fundingKrw.toLocaleString("ko-KR")} KRW`);
  console.log(`최초 PAPER 지갑: ${summary.fundedUsd.toFixed(2)} USD`);
  console.log(`현금: ${summary.cashUsd.toFixed(2)} USD`);
  console.log(`ETF 평가액: ${summary.marketValueUsd.toFixed(2)} USD`);
  console.log(`총손익: ${summary.totalPnlUsd.toFixed(2)} USD`);
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
      console.log("무료 뉴스 감성: 사용 불가 (FRED·MACD로 폴백)");
    }
    if (marketSignal.macd) {
      console.log(
        `MACD: ${marketSignal.macd.score} ` +
          `(신뢰도 ${marketSignal.macd.confidence}, ` +
          `${marketSignal.macd.readySymbols}/${marketSignal.macd.totalSymbols}종목)`,
      );
    } else {
      console.log("MACD: 준비 중 (12·26·9 계산에 최소 34개 가격 표본 필요)");
    }
  } else {
    console.log("거시경제 판정: 사용 불가 — 신규 매수를 중단했습니다.");
  }
  for (const decision of decisions) {
    console.log(`- ${decision.symbol}: ${decision.action} (${decision.reason})`);
  }
  console.log("실제 주문 API는 호출하지 않았습니다.");
}
