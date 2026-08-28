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
import {
  formatLimits,
  formatStack,
  loadTradingPolicy,
  unvalidatedLayersInUse,
} from "./trading-policy.js";
import { getUsRegularSessionStatus } from "../market/us-market-session.js";
import { buildDailyMacdSignal, updateMacdSignal } from "../market/macd-signal.js";
import { loadDailyCloses, loadTrendSignal } from "../market/trend-signal.js";
import { runLiveCycle } from "../live/live-cycle.js";
import { createTossBroker } from "../live/toss-broker.js";
import { buildOrders } from "../live/order-lifecycle.js";
import { readOrderEvents } from "../live/order-store.js";
import { toOrderIntents } from "../live/paper-bridge.js";

const dataDir = path.resolve(process.env.PAPER_DATA_DIR || "data");
const statePath = path.join(dataDir, "paper-state.json");
const lockPath = path.join(dataDir, "paper-runner.lock");
const watchlist = readWatchlist(process.env.ETF_WATCHLIST || "VTI,SCHD,IWM");
let lock;

// systemd 타이머가 실행하는 진입점입니다.
// 순서: 장 시간 확인 -> 잠금 -> 환율/현재가 조회 -> 장부 계산 -> 안전 저장
//       -> (LIVE_TRADING=true 일 때만) 실주문.
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
  // **LIVE에서도 PAPER 장부는 그대로 돕니다.** 끄면 안 됩니다 — 같은 신호로 두
  // 장부를 나란히 돌려 그 차이를 봐야 체결 비용의 실측값이 나옵니다
  // (`live-cycle.js`). 실주문은 PAPER 결정을 받아 뒤에 덧붙는 단계입니다.
  const live = policy.mode === "LIVE";

  // ── 배너 ──────────────────────────────────────────────────────────────
  // **장 시간 검사보다 앞입니다.** 9/1 전환 절차는 개장 30분 전(22:00)에 이
  // 명령으로 배너를 눈으로 확인하는데, 뒤에 두면 장외에서 그냥 되돌아 나가
  // **확인해야 할 줄이 안 찍힙니다.** 셋 다 정책과 환경변수만 읽으므로 네트워크도
  // 토큰도 쓰지 않습니다 — 장 시간과 무관하게 찍는 것이 맞습니다.
  if (live) {
    console.log("■ LIVE_TRADING=true — PAPER 장부와 함께 실주문을 냅니다.");
  }

  // **스택을 매 실행마다 찍습니다.** 기여도만 보고는 어떤 가중치로 돌고 있는지
  // 알 수 없습니다 — 2026-08-21에 그래서 미검증 층이 사흘간 배분을 밀고 있었습니다.
  const stack = {
    macroWeight: readMacroWeight(process.env.MACRO_SCORE_WEIGHT),
    sentimentWeight: readSentimentWeight(process.env.SENTIMENT_SCORE_WEIGHT),
    trendWeight: readTrendWeight(process.env.TREND_SCORE_WEIGHT),
    macdWeight: readMacdWeight(process.env.MACD_SCORE_WEIGHT),
    volTarget: readRate01(process.env.VOL_TARGET_ANNUALIZED, 0.15, "VOL_TARGET_ANNUALIZED"),
  };
  console.log(`■ 스택: ${formatStack(stack)}`);
  assertValidatedStack(stack, live);

  // **한도는 `.env`가 이기고 로그에 안 남았습니다.** 원금(10만 원)은 상수라
  // 실행 로그로 확인되는데, 이 다섯은 `.env` 한 줄이면 조용히 달라집니다
  // (`trading-policy.js:72-92`). 문서에 적힌 값과 서버가 다른지 알 방법이
  // 없었던 것이 감성 가중치가 서버에서만 1이었던 일(2026-08-21)과 같은
  // 구조입니다. **총 노출은 지갑에 묶여 있어 안전하고, 이 다섯이 정하는 것은
  // 속도입니다.** 그래서 막는 대신 찍습니다.
  console.log(`■ 한도: ${formatLimits(policy)}`);

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
    // 강제 실행은 PAPER 장부에만 해당합니다. 실주문 쪽은 `planCycle`이 장 시간을
    // 다시 보고 멈춥니다 — 여기서 뚫으면 안전장치를 우회하는 길이 생깁니다.
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
    ...stack,
    trend,
    macd,
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

  // **실주문은 장부를 저장하고 기록을 남긴 뒤에 냅니다.** 순서가 반대면, 주문을
  // 낸 뒤 저장에서 죽었을 때 "냈는데 장부에 없는" 상태가 남습니다.
  const liveResult = live
    ? await submitLiveOrders({ client, session, now, decisions: result.decisions })
    : null;

  printResult(result, exchangeRate, marketSignal, liveResult);
}

/**
 * PAPER가 낸 결정을 실제 주문으로 옮깁니다.
 *
 * 여기서 하는 일은 **연결뿐입니다.** 낼지 말지의 판단은 전부 `runLiveCycle`
 * 안에 있습니다 — 긴급중지·미결 주문·보유 대사·장 시간·금액 주문 창. 그 판단을
 * 이쪽으로 옮기면 안전장치가 두 곳에 흩어져 어느 쪽이 이기는지 알 수 없게 됩니다.
 */
async function submitLiveOrders({ client, session, now, decisions }) {
  const { intents, dropped } = toOrderIntents(decisions);
  // 버린 것을 먼저 말합니다. 조용히 거르면 "왜 주문이 안 나갔는가"를 못 되짚습니다.
  for (const item of dropped) {
    console.log(`  실주문 제외: ${item.symbol} ${item.action} — ${item.why}`);
  }

  const broker = createTossBroker({
    getAccessToken: () => client.getAccessToken(),
    accountSeq: await resolveAccountSeq(client),
    // 응답을 못 받은 주문을 조회하려면 우리 아이디를 브로커 아이디로 바꿔야 합니다.
    lookupBrokerOrderId: async (wanted) => {
      const orders = buildOrders(await readOrderEvents(dataDir));
      return orders.get(wanted)?.brokerOrderId ?? null;
    },
  });

  return runLiveCycle({
    dataDir,
    broker,
    decisions: intents,
    // 우리가 매매하는 종목만 대사합니다. 사용자가 다른 것을 사고팔아도 우리
    // 대사가 깨지면 안 됩니다.
    managedSymbols: watchlist,
    session,
    now,
  });
}

/**
 * 어느 계좌에 낼 것인가.
 *
 * `TOSS_ACCOUNT_SEQ`가 있으면 그것이 이깁니다. 없고 계좌가 하나뿐이면 그것을
 * 씁니다 — 그래야 `LIVE_TRADING` 하나만 바꿔도 돌아갑니다. **여럿이면 고르지
 * 않고 멈춥니다.** 무인 실행기가 어느 계좌인지 추측해서는 안 됩니다.
 */
async function resolveAccountSeq(client) {
  const configured = Number(process.env.TOSS_ACCOUNT_SEQ);
  if (Number.isInteger(configured) && configured > 0) return configured;

  const accounts = await client.getAccounts();
  if (accounts.length === 0) throw new Error("계좌를 찾지 못했습니다.");
  if (accounts.length === 1) return accounts[0].accountSeq;
  throw new Error(
    `계좌가 ${accounts.length}개입니다. TOSS_ACCOUNT_SEQ로 어느 계좌인지 지정하십시오 ` +
      `(${accounts.map((account) => account.accountSeq).join(", ")}).`,
  );
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

/**
 * 감성 층의 가중치입니다. **판정이 끝날 때까지 0입니다** (2026-08-08 결정).
 *
 * 거시(⑫)와 달리 이것은 **최종 결정이 아니라 보류**입니다. 판정은 10거래일
 * 표본으로 8/20 전후에 하고, 그때 값을 정합니다.
 *
 * 0으로 두는 이유 둘:
 *
 * 1. **미검증 층이 매매를 바꾸고 있었다.** 신호인지 잡음인지 모르는 채로
 *    노출을 약 6.6%p 깎고 있었다.
 * 2. **백테스터는 감성을 아예 안 넣는다**(`backtest-engine.js`가 `null`을
 *    넘긴다). 즉 우리가 잰 모든 숫자(MDD 29.9%, CAGR 5.99%, 노출 75.6%)는
 *    감성이 없는 스택의 것이다. 감성을 얹은 채 돌리면 **측정한 적 없는 것을
 *    돌리는 것**이 된다. 0으로 두면 실운영이 백테스트와 정확히 일치한다.
 *
 * **표본 수집에는 지장이 없다.** 원점수는 가중치와 무관하게 이벤트 로그에
 * 남고(`market-signal.js`가 `sentiment`를 그대로 실어 보낸다), 판정은 그
 * 원점수의 자기상관으로 한다.
 */
/**
 * **미검증 층은 실제 돈을 움직이지 못합니다.**
 *
 * LIVE에서는 멈춥니다. PAPER에서는 경고만 하고 계속 돕니다 — PAPER 장부가 멈추면
 * 판정 표본이 그날치를 잃고, 그것이야말로 이 층을 켜 둔 이유였던 판정을 늦춥니다.
 * 대신 **PAPER 장부도 그 사흘은 백테스트 숫자와 비교할 수 없다**는 것을 같은
 * 자리에서 말합니다.
 *
 * **안전 스위치는 안전한 쪽으로 넘어집니다**(`live-safety.test.js`와 같은 원칙).
 * 설정이 어긋난 채로 실주문을 내느니 사이클을 거르는 편이 낫습니다 — cron이
 * 실패하면 보고서가 오지 않아 사람이 알아챕니다.
 */
function assertValidatedStack(stack, live) {
  const inUse = unvalidatedLayersInUse(stack);
  if (inUse.length === 0) return;

  const detail = inUse
    .map((layer) => `${layer.label}(${layer.env}=${stack[`${layer.key}Weight`]}) — ${layer.why}`)
    .join(", ");

  if (live) {
    throw new Error(
      `미검증 층이 켜진 채로 실주문을 낼 수 없습니다: ${detail}\n` +
        `  .env에서 ${inUse.map((layer) => `${layer.env}=0`).join(", ")} 으로 두고 다시 실행하세요.`,
    );
  }
  console.warn(
    `⚠️  미검증 층이 배분에 관여하고 있습니다: ${detail}\n` +
      "   PAPER 장부는 계속 돌지만, 이 사이클은 백테스트 숫자와 비교할 수 없습니다 —\n" +
      "   백테스터는 감성을 null로 넣습니다(backtest-engine.js).",
  );
}

function readSentimentWeight(value) {
  if (value === undefined || value === "") return 0;
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

function printResult({ decisions, summary }, exchangeRate, marketSignal, liveResult) {
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
    // 초과성과는 기준선이 열린 날부터의 구간에서만 냅니다. 구간을 못 맞추면
    // 숫자 대신 그 사실을 찍습니다.
    const alpha = Number.isFinite(Number(summary.alphaUsd))
      ? `초과성과 ${summary.alphaUsd.toFixed(2)} USD (${(summary.benchmark.startedAt ?? "").slice(0, 10)}~)`
      : "초과성과 계산 안 함 (기준선 개설일의 지갑 자산 불명)";
    console.log(
      `벤치마크 ${summary.benchmark.symbol} 매수후보유: ` +
        `${summary.benchmark.pnlUsd.toFixed(2)} USD (${summary.benchmark.returnPct}%), ${alpha}`,
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

  if (!liveResult) {
    console.log("실제 주문 API는 호출하지 않았습니다.");
    return;
  }

  // **멈춘 이유를 결과와 같은 자리에 냅니다.** 실주문이 안 나간 사이클과 낼
  // 것이 없던 사이클은 로그에서 똑같이 조용한데, 둘은 전혀 다른 사실입니다.
  console.log("\n■ 실주문");
  for (const line of liveResult.log) console.log(`  ${line}`);
  if (liveResult.halted) {
    console.log(`  멈춤(${liveResult.reason}): ${liveResult.message}`);
    return;
  }
  if (liveResult.submitted.length === 0) {
    console.log("  낼 주문이 없었습니다.");
    return;
  }
  for (const order of liveResult.submitted) {
    console.log(
      `  제출: ${order.symbol} ${order.side} $${order.amountUsd} ` +
        `(${order.clientOrderId} → ${order.brokerOrderId})`,
    );
  }
}
