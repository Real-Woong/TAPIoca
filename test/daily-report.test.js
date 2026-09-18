import test from "node:test";
import assert from "node:assert/strict";

import { createPaperState, runPaperCycle } from "../src/paper/paper-engine.js";
import { createUsdBudget } from "../src/paper/trading-budget.js";
import { loadTradingPolicy } from "../src/paper/trading-policy.js";
import { normalizeHoldings } from "../src/live/cost-basis.js";
import { formatDailyReport } from "../src/telegram/daily-report-format.js";

test("일일 보고서에 원금, 손익, 보유종목과 당일 거래를 포함한다", () => {
  const state = {
    funding: { fundingKrw: 100000, fundedUsd: 67.03 },
    cashUsd: 62.03,
    realizedPnlUsd: 0,
    positions: {
      VTI: { symbol: "VTI", quantity: 0.05, entryPrice: 100, lastPrice: 102, costUsd: 5 },
    },
    trades: [{
      side: "BUY", symbol: "VTI", amountUsd: 5, reason: "INITIAL_PAPER_ENTRY",
      executedAt: "2026-07-14T14:00:00Z",
    }],
  };

  const report = formatDailyReport(state, "2026-07-14");

  assert.match(report, /100,000원/);
  assert.match(report, /VTI/);
  assert.match(report, /BUY VTI/);
  assert.match(report, /실현손익/);
  assert.match(report, /미실현손익/);
  assert.match(report, /PAPER 모드/);
});

test("손실 한도에 닿으면 경고를 표시하되 매매는 계속한다고 알린다", () => {
  const state = {
    funding: { fundingKrw: 100000, fundedUsd: 67.03 },
    cashUsd: 67.03,
    realizedPnlUsd: 0,
    positions: {},
    trades: [],
    risk: {
      lastCheck: {
        alert: true, reason: "DAILY_LOSS_LIMIT", totalPnlUsd: -2.1, dailyPnlUsd: -3.4,
      },
    },
  };

  const report = formatDailyReport(state, "2026-07-14");

  assert.match(report, /일일 손실 한도 도달/);
  // 자동 중단은 폭락 중에 위험관리를 꺼버려 오히려 낙폭을 키웠다. 이제는 알리기만 한다.
  assert.match(report, /매매는 계속합니다/);
  assert.doesNotMatch(report, /신규 매수 중단/);
});

test("신호가 꺼져 있어도 줄을 생략하지 않고 사유와 경고를 함께 알린다", () => {
  const state = {
    funding: { fundingKrw: 100000, fundedUsd: 67.05 },
    cashUsd: 67.05,
    realizedPnlUsd: 0,
    positions: {},
    trades: [],
    macro: {
      regime: "RISK_OFF",
      score: -2.222,
      targetAllocation: { VTI: 0.4, SCHD: 0.2, CASH: 0.4 },
      sentiment: { sentiment_score: -0.653, confidence: 0.589, articleCount: 70 },
      trend: null,
      macd: { score: 0.31379, confidence: 1, readySymbols: 3, totalSymbols: 3 },
      layers: [
        { key: "FRED", label: "거시(FRED)", weight: null, available: true, contribution: -1.5 },
        { key: "NEWS", label: "뉴스 감성", weight: 2, available: true, contribution: -0.769 },
        { key: "TREND", label: "추세(200일선)", weight: 1, available: false, contribution: 0,
          reason: "NO_DAILY_CLOSES" },
        { key: "MACD", label: "MACD", weight: 0.15, available: true, contribution: 0.047 },
      ],
    },
  };

  const report = formatDailyReport(state, "2026-07-23");

  assert.match(report, /추세\(200일선\): 사용 불가 — 일봉 종가 수집 실패/);
  assert.match(report, /⚠️ 비활성 신호: 추세\(200일선\)\(일봉 종가 수집 실패\)/);
  assert.match(report, /신호 기여: .*거시\(FRED\) -1\.5.*MACD \+0\.047/);
});

test("레이어 정보가 없는 예전 상태도 그대로 렌더한다", () => {
  const state = {
    funding: { fundingKrw: 100000, fundedUsd: 67.05 },
    cashUsd: 67.05,
    realizedPnlUsd: 0,
    positions: {},
    trades: [],
    macro: {
      regime: "NEUTRAL",
      score: -1.2,
      targetAllocation: { VTI: 0.7, SCHD: 0.2, CASH: 0.1 },
    },
  };

  const report = formatDailyReport(state, "2026-07-23");

  assert.match(report, /통합 시장 상태: NEUTRAL/);
  assert.match(report, /추세\(200일선\): 사용 불가 — 사용 불가/);
  assert.doesNotMatch(report, /⚠️/);
});

test("뉴스 소스 구성과 부분 수집 실패를 보고서에 함께 알린다", () => {
  const state = {
    funding: { fundingKrw: 100000, fundedUsd: 67.05 },
    cashUsd: 67.05,
    realizedPnlUsd: 0,
    positions: {},
    trades: [],
    macro: {
      regime: "RISK_OFF",
      score: -2.2,
      targetAllocation: { VTI: 0.4, CASH: 0.4 },
      sentiment: {
        sentiment_score: -0.653,
        confidence: 0.589,
        articleCount: 70,
        sourceCounts: { FED_RSS: 70, GDELT: 0 },
        warning: "GDELT 응답 오류 503",
      },
      layers: [],
    },
  };

  const report = formatDailyReport(state, "2026-07-23");

  assert.match(report, /FED_RSS 70/);
  assert.match(report, /※ 일부 수집 실패: GDELT 응답 오류 503/);
});

// 08-05 실보고서에서 감성 줄에 수집 시각이 끝내 찍히지 않았습니다. 원인은 포맷터가
// 아니라 compactMacroSignal이 sentimentFreshness를 상태에 옮기지 않은 것이었습니다.
// 기존 보고서 테스트는 state.macro를 손으로 만들어서 이 누락을 잡지 못했으므로,
// 여기서는 신호 결합 → 사이클 → 보고서까지 실제 경로로 확인합니다.
test("감성 수집 시각이 신호 결합에서 보고서까지 살아남는다", async () => {
  const { combineMarketSignals } = await import("../src/sentiment/market-signal.js");
  const { createPaperState, runPaperCycle } = await import("../src/paper/paper-engine.js");
  const { createUsdBudget } = await import("../src/paper/trading-budget.js");
  const { loadTradingPolicy } = await import("../src/paper/trading-policy.js");

  const now = new Date("2026-08-05T12:00:00Z");
  const combined = combineMarketSignals(
    { score: -0.5, regime: "NEUTRAL", targetAllocation: { VTI: 0.7, CASH: 0.3 }, reasons: [] },
    {
      sentiment_score: 0.108,
      confidence: 0.611,
      articleCount: 434,
      // 반감기 6시간 기준 3시간 지난 스냅샷이므로 나이와 감쇠 배수가 함께 찍힙니다.
      fetchedAt: "2026-08-05T09:00:00Z",
    },
    { sentimentWeight: 1, now },
  );
  assert.equal(combined.sentimentFreshness.ageHours, 3);

  const state = createPaperState({
    budget: createUsdBudget("67.05"), watchlist: ["VTI"], now,
  });
  const result = runPaperCycle(
    state,
    [{ symbol: "VTI", lastPrice: 100 }],
    loadTradingPolicy({ MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10" }),
    now,
    combined,
  );

  assert.equal(result.state.macro.sentimentFreshness.ageHours, 3);
  assert.match(
    formatDailyReport(result.state, "2026-08-05"),
    /무료 뉴스 감성: .* ※ 수집 3시간 전, 신선도 ×0\.707/,
  );
});

// 2026-08-27: 기준선마다 시작일이 다른데 초과성과가 그 사실을 무시하고 뺐다.
// 지갑 손익은 자금 투입일부터, 정책믹스 기준선은 운영 상태에서 20일 뒤부터라,
// 그 20일치 손익이 통째로 "신호 초과성과"로 들어가 있었다. 시작일을 함께 찍고
// **겹치는 구간에서만** 뺀다.
function reportFixture(overrides = {}) {
  return {
    createdAt: "2026-07-14T13:43:19.602Z",
    funding: { fundingKrw: 100000, fundedUsd: 67.05 },
    cashUsd: 6.39,
    realizedPnlUsd: -0.25,
    positions: {
      VTI: { symbol: "VTI", quantity: 0.15, entryPrice: 290, lastPrice: 293.2, costUsd: 43.5 },
    },
    trades: [],
    // 이 기준선은 개설 시점의 지갑 자산을 직접 들고 있다(새로 열리는 기준선).
    benchmark: { symbol: "VTI", quantity: 0.2296, entryPriceUsd: 292, lastPrice: 301.75,
      fundedUsd: 67.05, startedAt: "2026-07-27T13:30:00Z", walletEquityUsdAtStart: 66.71 },
    // 이쪽은 그 값이 없는 옛 기준선이라 위험 관리의 일별 시작 자산으로 대신한다.
    policyBenchmark: {
      mix: { VTI: 0.7, SCHD: 0.2, IWM: 0, CASH: 0.1 },
      fundedUsd: 67.05,
      cashUsd: 6.71,
      positions: { VTI: { quantity: 0.1607, lastPrice: 301.75 } },
      startedAt: "2026-07-14T14:00:00Z",
    },
    risk: { dailyStartEquityUsd: { "2026-07-14": 67.05 } },
    ...overrides,
  };
}

test("정책믹스 기준선과 그 대비 초과성과를 보고서에 함께 알린다", () => {
  const report = formatDailyReport(reportFixture(), "2026-08-05");

  assert.match(report, /정책믹스\(VTI70·SCHD20·현금10 고정 · 2026-07-14~\)/);
  assert.match(report, /└ 신호 초과성과: [+-]\$/);
  // VTI 100% 벤치마크도 그대로 남아야 한다. 기준선을 갈아치우는 게 아니라 더하는 것이다.
  assert.match(report, /벤치마크\(VTI 매수후보유 · 2026-07-27~\)/);
  assert.match(report, /초과성과\(alpha\)/);
  // 지갑이 언제부터의 손익인지도 함께 찍는다. 세 시작일이 다르다는 것이 보여야 한다.
  assert.match(report, /누적손익\(2026-07-14~\)/);
});

test("초과성과는 기준선이 열린 날부터의 지갑 손익에서 뺀다", () => {
  const report = formatDailyReport(reportFixture(), "2026-08-05");

  // 지갑 자산 = 6.39 + 0.15×293.2 = 50.37
  // VTI 기준선 손익 = 0.2296×301.75 − 67.05 = +2.23
  // 07-27부터의 지갑 손익 = 50.37 − 66.71 = −16.34 → alpha = −18.57
  // (옛 방식은 자금 투입일부터의 −16.68에서 빼 −18.91이었다.)
  assert.match(report, /초과성과\(alpha\): -\$18\.57 \(2026-07-27~ 같은 구간\)/);

  // 정책믹스 손익 = 6.71 + 0.1607×301.75 − 67.05 = −11.85
  // 07-14부터의 지갑 손익 = 50.37 − 67.05 = −16.68 → alpha = −4.83
  // 개설 시점 값이 없어 일별 시작 자산으로 맞췄다는 사실을 줄에 남긴다.
  assert.match(
    report,
    /└ 신호 초과성과: -\$4\.83 \(2026-07-14~ 같은 구간 · 개설일 시작 자산 기준\)/,
  );
});

// 구간을 못 맞추면 숫자를 만들어내지 않는다. 틀린 숫자를 맞는 것처럼 보여주는 것이
// 애초에 고치려던 문제다.
test("기준선 개설일의 지갑 자산을 모르면 초과성과를 내지 않는다", () => {
  const state = reportFixture({ risk: undefined });
  delete state.benchmark.walletEquityUsdAtStart;

  const report = formatDailyReport(state, "2026-08-05");

  assert.match(report, /초과성과\(alpha\): 계산 안 함 — 기준선 개설일\(2026-07-27~\)의/);
  assert.match(report, /└ 신호 초과성과: 계산 안 함/);
  // 기준선 자체의 손익은 그대로 보여준다. 못 내는 것은 뺄셈뿐이다.
  assert.match(report, /정책믹스\(VTI70·SCHD20·현금10 고정 · 2026-07-14~\): [+-]\$/);
});

// 2026-08-21: 보고서가 기여도(`뉴스 감성 -0.228`)만 찍어서, 문서가 0이라고 적은
// 감성 가중치가 운영 .env에서만 1인 채로 사흘간 배분을 밀고 있는 것을 놓쳤다.
// 기여도가 0이 아닌 것은 정상 동작과 구분되지 않는다. 가중치를 직접 적는다.
function stateWithWeights(weights) {
  return {
    funding: { fundingKrw: 100000, fundedUsd: 67.05 },
    cashUsd: 1.5,
    realizedPnlUsd: 0,
    positions: {},
    trades: [],
    macro: {
      regime: "NEUTRAL",
      score: 0.748,
      targetAllocation: { VTI: 0.7, SCHD: 0.18, IWM: 0.08, CASH: 0.05 },
      weights,
      layers: [
        { key: "NEWS", label: "뉴스 감성", weight: weights.sentiment, available: true,
          contribution: -0.228 },
        { key: "TREND", label: "추세(200일선)", weight: 1, available: true, contribution: 0.976 },
      ],
    },
  };
}

test("보고서가 실행 중인 가중치를 그대로 적는다", () => {
  const report = formatDailyReport(
    stateWithWeights({ macro: 0, sentiment: 0, trend: 1, macd: 0, volTarget: 0.15 }),
    "2026-08-19",
  );

  assert.match(report, /실행 스택: 거시 0 · 감성 0 · 추세 1 · MACD 0 · volTarget 0\.15/);
  assert.doesNotMatch(report, /미검증 층 작동 중/);
});

test("판정 전인 감성 층이 켜져 있으면 보고서가 경고한다", () => {
  // 실제로 08-18~20에 돌던 스택이다. 통합 점수 0.748 = 추세 0.976 + 감성 -0.228.
  const report = formatDailyReport(
    stateWithWeights({ macro: 0, sentiment: 1, trend: 1, macd: 0, volTarget: 0.15 }),
    "2026-08-19",
  );

  assert.match(report, /실행 스택: 거시 0 · 감성 1 /);
  assert.match(report, /⚠️ 미검증 층 작동 중: 감성 가중치가 0이 아닙니다/);
});

/**
 * 2026-09-04에 찾았다. **위 두 테스트는 통과하는데 실제 보고서에는 그 줄이 없다.**
 * 두 테스트가 `state.macro`를 손으로 지어 `weights`를 넣기 때문이다. 운영에서
 * `state.macro`를 만드는 것은 `compactMacroSignal`이고, 그 화이트리스트에
 * `weights`가 없었다 — 08-21에 이 줄을 만들면서 같이 안 바꿨다.
 *
 * 그래서 `실행 스택` 줄은 생긴 날부터 한 번도 안 찍혔고, **미검증 층 경고는
 * 감성 가중치가 1이어도 침묵한다.** 잡으려던 상황이 정확히 그것이다(⑬).
 *
 * 픽스처가 아니라 엔진이 만든 상태를 그대로 넘겨서 그 이음매를 막는다.
 */
test("엔진이 만든 상태에도 실행 스택이 남아 보고서에 찍힌다", () => {
  const policy = loadTradingPolicy({ MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10" });
  const now = new Date("2026-09-03T14:00:00Z");
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["VTI"],
    now,
  });

  runPaperCycle(state, [{ symbol: "VTI", lastPrice: 100 }], policy, now, {
    fetchedAt: now.toISOString(),
    evaluatedAt: now.toISOString(),
    regime: "NEUTRAL",
    score: 0.948,
    targetAllocation: { VTI: 0.7, CASH: 0.3 },
    reasons: ["TEST"],
    source: "TEST",
    stale: false,
    weights: { macro: 0, sentiment: 1, trend: 1, macd: 0, volTarget: 0.15 },
  });

  const report = formatDailyReport(state, "2026-09-03");

  assert.match(report, /실행 스택: 거시 0 · 감성 1 · 추세 1 · MACD 0 · volTarget 0\.15/);
  assert.match(report, /⚠️ 미검증 층 작동 중: 감성 가중치가 0이 아닙니다/);
});

/**
 * 2026-09-02에 찾았다. 9/1에 실거래를 켰는데 그날 밤 보고서는 여전히
 * `📊 Toss ETF PAPER 일일 보고서` / `PAPER 모드 — 실제 주문 없음`이라고 적었다.
 * 두 줄 다 문자열로 박혀 있었고 진입점은 정책을 읽지 않았다.
 *
 * 그날은 주문이 0건이라 우연히 참이었을 뿐이다. **실주문이 한 건이라도 나가는
 * 날, 이 줄은 매일 아침 이것만 읽는 사람에게 거짓말을 한다.**
 */
function liveState() {
  return {
    funding: { fundingKrw: 100000, fundedUsd: 67.05 },
    cashUsd: 1.5,
    realizedPnlUsd: 0,
    positions: {},
    trades: [],
  };
}

test("LIVE면 제목과 마지막 줄이 실거래라고 말한다", () => {
  const report = formatDailyReport(liveState(), "2026-09-02", {
    live: { orders: [], unresolvedCount: 0 },
  });

  assert.match(report, /📊 Toss ETF LIVE 일일 보고서/);
  assert.match(report, /LIVE 모드 — 실제 주문이 나갑니다/);
  assert.doesNotMatch(report, /PAPER 모드 — 실제 주문 없음/);
  // 숫자가 어느 장부의 것인지도 같이 적는다. LIVE 딱지만 붙이면 PAPER 숫자를
  // 실계좌 잔고로 읽게 된다. **보유는 2026-09-12부터 실계좌를 따로 적으므로**
  // 이 줄이 말하는 것은 손익·성과다.
  assert.match(report, /손익·성과는 PAPER 장부이고, 계좌는 «실계좌 보유» 칸입니다/);
  assert.match(report, /오늘의 실주문/);
});

test("PAPER면 실주문 칸이 아예 없다", () => {
  const report = formatDailyReport(liveState(), "2026-09-02");

  assert.match(report, /📊 Toss ETF PAPER 일일 보고서/);
  assert.match(report, /PAPER 모드 — 실제 주문 없음/);
  assert.doesNotMatch(report, /오늘의 실주문/);
});

test("오늘 나간 실주문을 요청액·체결액·수량과 함께 적는다", () => {
  const report = formatDailyReport(liveState(), "2026-09-02", {
    live: {
      orders: [
        { symbol: "SCHD", side: "BUY", state: "FILLED",
          requestedUsd: 2, filledUsd: 1.99, filledQuantity: 0.05965 },
      ],
      unresolvedCount: 0,
    },
  });

  // 요청과 체결을 같이 적어야 실행 비용이 보인다. 둘 중 하나만 적으면 안 보인다.
  assert.match(report, /• BUY SCHD: 요청 \$2\.00 → 체결 \$1\.99 \(0\.059650주\) \[FILLED\]/);
  // 가상 거래와 같은 칸에 섞지 않는다. 둘의 차이가 재려던 값이다.
  assert.match(report, /오늘의 가상 거래\n• 없음/);
});

test("미결 주문이 있으면 매매가 멈춘다는 사실을 적는다", () => {
  const report = formatDailyReport(liveState(), "2026-09-02", {
    live: { orders: [], unresolvedCount: 2 },
  });

  assert.match(report, /⚠️ 결말이 안 난 주문 2건 — 풀릴 때까지 매매가 멈춥니다/);
});

// 원장을 못 읽는다고 하루치 보고를 통째로 잃으면 사람이 아무것도 모르는 채로
// 다음 장을 맞는다. 보고서는 나가되, 못 읽었다고 적는다.
test("실주문 원장을 못 읽으면 보고서가 그 사실을 적는다", () => {
  const report = formatDailyReport(liveState(), "2026-09-02", {
    live: { error: "Unexpected token } in JSON at position 12" },
  });

  assert.match(report, /⚠️ 실주문 원장을 읽지 못했습니다: Unexpected token/);
  assert.match(report, /LIVE 모드 — 실제 주문이 나갑니다/);
});

/**
 * 2026-09-12에 찾았다. 사장님이 토스 앱을 열어 보고 물었다 — 보고서는 관리
 * 3종목을 $65.62로 찍고 있었는데 계좌에는 $20.13뿐이었다(8월 probe 잔해).
 *
 * **`위 손익·보유는 PAPER 장부의 숫자입니다` 한 줄로는 안 막힌다.** 그 라벨은
 * 읽는 사람이 차이를 **이미 알고 있을 때만** 작동한다. 매일 아침 이것만 읽는
 * 사람에게는 계좌에 없는 포트폴리오가 계좌 잔고로 읽힌다.
 */
function accountState() {
  return {
    funding: { fundingKrw: 100000, fundedUsd: 67.05 },
    cashUsd: 1.5,
    realizedPnlUsd: 0,
    positions: {
      VTI: { symbol: "VTI", quantity: 0.123, costUsd: 46.53, lastPrice: 381.22 },
      SCHD: { symbol: "SCHD", quantity: 0.402, costUsd: 13.56, lastPrice: 34.13 },
    },
    trades: [],
  };
}

test("LIVE면 실계좌 보유를 함께 적고, 장부와 벌어진 차이를 적는다", () => {
  const report = formatDailyReport(accountState(), "2026-09-11", {
    live: { orders: [], unresolvedCount: 0 },
    account: { positions: { VTI: 0.005248, SCHD: 0.475734 } },
  });

  assert.match(report, /실계좌 보유 \(토스\)/);
  assert.match(report, /• VTI: 0\.005248주 \(\$2\.00\)/);
  assert.match(report, /• SCHD: 0\.475734주 \(\$16\.24\)/);
  // 장부 46.89 + 13.72 = 60.61 대 실계좌 2.00 + 16.24 = 18.24
  assert.match(report, /⚠️ 장부 \$60\.61 ≠ 실계좌 \$18\.24 — 차이 \$42\.37/);
  // 장부 칸이 장부라고 말해야 두 칸을 헷갈리지 않는다.
  assert.match(report, /보유 ETF \(장부\)/);
});

test("장부와 실계좌가 같으면 경고를 붙이지 않는다", () => {
  const state = accountState();
  const report = formatDailyReport(state, "2026-09-11", {
    live: { orders: [], unresolvedCount: 0 },
    account: { positions: { VTI: 0.123, SCHD: 0.402 } },
  });

  assert.match(report, /• VTI: 0\.123000주 \(\$46\.89\)/);
  assert.doesNotMatch(report, /≠ 실계좌/);
});

// 계좌 조회는 이 보고서에서 유일하게 네트워크를 탄다. 그것 때문에 하루치
// 보고를 통째로 잃으면 사람이 아무것도 모르는 채로 다음 장을 맞는다.
test("실계좌를 조회하지 못해도 보고서는 나가고, 못 읽었다고 적는다", () => {
  const report = formatDailyReport(accountState(), "2026-09-11", {
    live: { orders: [], unresolvedCount: 0 },
    account: { error: "계좌 조회가 15초 안에 안 왔습니다" },
  });

  assert.match(report, /⚠️ 실계좌를 조회하지 못했습니다: 계좌 조회가 15초 안에 안 왔습니다/);
  assert.match(report, /LIVE 모드 — 실제 주문이 나갑니다/);
  assert.match(report, /보유 ETF \(장부\)/);
});

// 장부에 없는 종목은 환산할 가격이 없다. 모르는 것을 0으로 더하면 차이가
// 실제보다 커 보이므로, 수량만 적고 합계를 포기한다.
test("장부에 가격이 없는 종목은 수량만 적고 차이를 계산하지 않는다", () => {
  const report = formatDailyReport(accountState(), "2026-09-11", {
    live: { orders: [], unresolvedCount: 0 },
    account: { positions: { VTI: 0.005248, IWM: 0.006665 } },
  });

  assert.match(report, /• IWM: 0\.006665주 \(평가액 미상 — 장부에 가격이 없습니다\)/);
  assert.doesNotMatch(report, /≠ 실계좌/);
});

test("PAPER면 실계좌 칸이 아예 없다", () => {
  const report = formatDailyReport(accountState(), "2026-09-11");

  assert.doesNotMatch(report, /실계좌 보유/);
  assert.match(report, /PAPER 모드 — 실제 주문 없음/);
});

test("추세 일봉이 얼어붙으면 나이와 함께 경고한다", () => {
  const state = {
    funding: { fundingKrw: 100000, fundedUsd: 67.05 },
    cashUsd: 67.05,
    realizedPnlUsd: 0,
    positions: {},
    trades: [],
    macro: {
      regime: "NEUTRAL",
      score: 0.826,
      targetAllocation: { VTI: 0.7, SCHD: 0.17, IWM: 0.08, CASH: 0.05 },
      trend: {
        score: 0.825704, confidence: 1, readySymbols: 3, totalSymbols: 3,
        stale: true,
        staleSince: "2026-09-17T13:00:00.000Z",
        evaluatedAt: "2026-09-18T20:24:00.000Z",
        fetchError: "TWELVEDATA: 응답 오류 429",
      },
      layers: [
        { key: "TREND", label: "추세(200일선)", weight: 1, available: true, contribution: 0.826 },
      ],
    },
  };

  const report = formatDailyReport(state, "2026-09-18");

  // 점수는 나온다 — 죽은 것이 아니라 얼어붙은 것이다. 그래서 «비활성 신호»가 안 잡는다.
  assert.match(report, /추세\(200일선\): 0\.825704 .*※ 캐시 사용/);
  assert.match(report, /⚠️ 추세 일봉이 갱신되지 않았습니다 — 캐시는 31\.4시간 전 값이고/);
  assert.match(report, /TWELVEDATA: 응답 오류 429/);
});

test("추세 일봉이 일부 종목만 실패하면 비율에 안 보이므로 따로 적는다", () => {
  const state = {
    funding: { fundingKrw: 100000, fundedUsd: 67.05 },
    cashUsd: 67.05,
    realizedPnlUsd: 0,
    positions: {},
    trades: [],
    macro: {
      regime: "NEUTRAL",
      score: 0.9,
      targetAllocation: { VTI: 0.7, SCHD: 0.2, CASH: 0.1 },
      // 분모가 관심종목이 아니라 **받아온 종목**이라 2/2로 만점처럼 보인다.
      trend: {
        score: 0.9, confidence: 1, readySymbols: 2, totalSymbols: 2,
        failures: ["IWM: 응답 오류 404"],
      },
      layers: [
        { key: "TREND", label: "추세(200일선)", weight: 1, available: true, contribution: 0.9 },
      ],
    },
  };

  const report = formatDailyReport(state, "2026-09-18");

  assert.match(report, /추세\(200일선\): 0\.9 \(신뢰도 1, 2\/2종목\)/);
  assert.match(report, /⚠️ 추세 일봉 일부 수집 실패: IWM: 응답 오류 404/);
});

test("사이클이 멈추면 조용한 날과 구분되게 나이를 적는다", () => {
  const base = {
    funding: { fundingKrw: 100000, fundedUsd: 67.05 },
    cashUsd: 1.5,
    realizedPnlUsd: 0,
    positions: {},
    trades: [],
    macro: null,
  };
  const at = "2026-09-18T20:00:00.000Z";

  // 정상: 보고서는 마감 10분 뒤에 나가고 사이클은 15분마다 돈다.
  const healthy = formatDailyReport(
    { ...base, lastCycleAt: at }, "2026-09-18",
    { now: new Date("2026-09-18T20:12:00.000Z") },
  );
  assert.match(healthy, /마지막 사이클: 12분 전/);
  assert.doesNotMatch(healthy, /⚠️ 마지막 사이클/);

  // 멈춘 날: 거래 0건·상태 그대로라 본문만 봐서는 조용한 날과 같다.
  const stalled = formatDailyReport(
    { ...base, lastCycleAt: at }, "2026-09-18",
    { now: new Date("2026-09-18T23:30:00.000Z") },
  );
  assert.match(stalled, /⚠️ 마지막 사이클: 3\.5시간 전 — 그 뒤로 매매도 대사도 돌지 않았습니다/);
});

test("이 기록이 없던 예전 장부는 없는 것을 경고로 바꾸지 않는다", () => {
  const report = formatDailyReport(
    {
      funding: { fundingKrw: 100000, fundedUsd: 67.05 },
      cashUsd: 67.05, realizedPnlUsd: 0, positions: {}, trades: [], macro: null,
    },
    "2026-09-18",
  );

  assert.doesNotMatch(report, /마지막 사이클/);
});

/** 9/17 마감 상태입니다. STATE/2026-09-18.md 「맞는 것 — 장부 정합」과 같은 숫자입니다. */
function krwState() {
  return {
    funding: { fundingKrw: 100000, krwPerUsd: 1491.4, fundedUsd: 67.05 },
    cashUsd: 1.5,
    realizedPnlUsd: -0.25,
    positions: {
      VTI: { symbol: "VTI", quantity: 1, entryPrice: 65.3, lastPrice: 65.32, costUsd: 65.3 },
    },
    trades: [],
  };
}

test("원화 손익을 환율 몫과 전략 몫으로 갈라 적는다", () => {
  const report = formatDailyReport(krwState(), "2026-09-17", { fx: { rate: 1373.38 } });

  // 달러로는 -$0.23인데 원화로는 -8,231원이다. 원금(원화)과 수익률(달러)을
  // 같은 블록에 두면 읽는 사람이 -343원을 계산한다 — 24배 틀린다.
  assert.match(report, /원화 환산\(오늘 1,373\.38원\): 91,769원/);
  assert.match(report, /원금 100,000원 대비 -8,231원 \(-8\.2%\)/);
  assert.match(report, /└ 환율 -7,913원 \(개설 1,491\.40원\) · 전략 -316원/);
});

test("환율 몫과 전략 몫과 잔돈을 더하면 원화 손익과 정확히 같다", () => {
  const report = formatDailyReport(krwState(), "2026-09-17", { fx: { rate: 1373.38 } });
  const total = Number(report.match(/원금 100,000원 대비 (-?[\d,]+)원/)[1].replace(/,/g, ""));
  const parts = [...report.matchAll(/(?:환율|전략|미환전) (-?[\d,]+)원/g)]
    .map((match) => Number(match[1].replace(/,/g, "")));

  assert.equal(parts.length, 3);
  assert.equal(parts.reduce((sum, part) => sum + part, 0), total);
});

test("환율을 못 읽으면 조용히 빼지 않고 못 읽었다고 적는다", () => {
  // 조용히 빼면 원화가 안 보이던 상태로 돌아간다. 그것이 애초의 문제였다.
  const report = formatDailyReport(krwState(), "2026-09-17", { fx: { error: "timeout" } });

  assert.match(report, /원화 환산: ⚠️ 오늘 환율을 못 읽었습니다 — timeout/);
  assert.doesNotMatch(report, /└ 환율/);
});

test("개설 환율이 없던 예전 장부는 없는 것을 경고로 바꾸지 않는다", () => {
  const state = krwState();
  delete state.funding.krwPerUsd;

  const report = formatDailyReport(state, "2026-09-17", { fx: { rate: 1373.38 } });

  assert.doesNotMatch(report, /원화 환산/);
});

test("원화 줄은 달러 줄을 건드리지 않는다", () => {
  const withFx = formatDailyReport(krwState(), "2026-09-17", { fx: { rate: 1373.38 } });
  const without = formatDailyReport(krwState(), "2026-09-17");
  const dollarLines = (text) => text.split("\n").filter((line) => line.includes("$"));

  assert.deepEqual(dollarLines(withFx), dollarLines(without));
});

/** 2026-09-18에 서버에서 실제로 받은 `/api/v1/holdings` 응답입니다. */
function tossHoldings() {
  return [
    { symbol: "IWM", quantity: "0.006665", lastPrice: "285.67", averagePurchasePrice: "300.047561",
      marketValue: { purchaseAmount: "1.999817", amount: "1.90399", amountAfterCost: "1.90399" },
      profitLoss: { amount: "-0.095827", amountAfterCost: "-0.095827", rate: "-0.0479" },
      cost: { commission: "0", tax: null } },
    { symbol: "SCHD", quantity: "0.402434", lastPrice: "33.92", averagePurchasePrice: "33.611039",
      marketValue: { purchaseAmount: "13.526225", amount: "13.650561", amountAfterCost: "13.640561" },
      profitLoss: { amount: "0.124336", amountAfterCost: "0.114336", rate: "0.0091" },
      cost: { commission: "0.01", tax: null } },
    { symbol: "VTI", quantity: "0.047685", lastPrice: "376.41", averagePurchasePrice: "375.366299",
      marketValue: { purchaseAmount: "17.899342", amount: "17.94911", amountAfterCost: "17.93911" },
      profitLoss: { amount: "0.049768", amountAfterCost: "0.039768", rate: "0.0027" },
      cost: { commission: "0.01", tax: null } },
    // 사장님 자산입니다. 이 시스템이 보고할 것이 아닙니다.
    { symbol: "GOOGL", quantity: "2.236649", lastPrice: "200", averagePurchasePrice: "190",
      marketValue: { purchaseAmount: "424.96", amount: "447.33" },
      profitLoss: { amount: "22.37", rate: "0.0526" }, cost: {} },
  ];
}

function pnlState() {
  const state = krwState();
  state.positions = {
    VTI: { symbol: "VTI", quantity: 0.124, lastPrice: 376.41, costUsd: 46.53 },
    SCHD: { symbol: "SCHD", quantity: 0.402, lastPrice: 33.92, costUsd: 13.56 },
    IWM: { symbol: "IWM", quantity: 0.017, lastPrice: 285.67, costUsd: 5.21 },
  };
  return state;
}

test("실계좌 손익은 토스가 주는 숫자를 그대로 적는다", () => {
  const account = {
    positions: { VTI: 0.047685, SCHD: 0.402434, IWM: 0.006665 },
    holdings: normalizeHoldings(tossHoldings(), ["VTI", "SCHD", "IWM"]),
    at: "2026-09-18T20:10:00Z",
  };

  const report = formatDailyReport(pnlState(), "2026-09-17", { account, live: { orders: [] } });

  assert.match(report, /매입 \$33\.43 → 평가 \$33\.50 · \+\$0\.08 \(\+0\.23%\)/);
  assert.match(report, /• SCHD: 평단 \$33\.61 → \$33\.92 · \+\$0\.12 \(\+0\.91%\)/);
  assert.match(report, /• IWM: 평단 \$300\.05 → \$285\.67 · -\$0\.10 \(-4\.79%\)/);
  // 실현손익은 어느 엔드포인트에도 없다. 미실현만이라고 칸 이름이 말한다.
  assert.match(report, /실계좌 손익 \(토스 기준 · 미실현만\)/);
});

test("실계좌 손익은 관리 종목만 적는다 — 나머지는 사장님 자산이다", () => {
  const account = {
    positions: { VTI: 0.047685 },
    holdings: normalizeHoldings(tossHoldings(), ["VTI", "SCHD", "IWM"]),
    at: "2026-09-18T20:10:00Z",
  };

  const report = formatDailyReport(pnlState(), "2026-09-17", { account, live: { orders: [] } });

  assert.doesNotMatch(report, /GOOGL/);
});

test("실계좌 손익은 위 보유 칸과 같은 순서로 적는다", () => {
  const account = {
    positions: { VTI: 0.047685, SCHD: 0.402434, IWM: 0.006665 },
    holdings: normalizeHoldings(tossHoldings(), ["VTI", "SCHD", "IWM"]),
    at: "2026-09-18T20:10:00Z",
  };

  const report = formatDailyReport(pnlState(), "2026-09-17", { account, live: { orders: [] } });
  const block = report.slice(report.indexOf("실계좌 손익"));
  const order = [...block.matchAll(/• (VTI|SCHD|IWM):/g)].map((match) => match[1]);

  // 장부 순서다. 알파벳순(IWM·SCHD·VTI)이 아니다 — 두 칸을 나란히 읽는 칸이다.
  assert.deepEqual(order, ["VTI", "SCHD", "IWM"]);
});

test("계좌를 못 읽으면 실계좌 손익 칸이 아예 없다", () => {
  const report = formatDailyReport(pnlState(), "2026-09-17", {
    account: { error: "timeout" }, live: { orders: [] },
  });

  assert.doesNotMatch(report, /실계좌 손익/);
});

test("실계좌 손익 칸은 실계좌 보유 칸을 건드리지 않는다", () => {
  const holdings = normalizeHoldings(tossHoldings(), ["VTI", "SCHD", "IWM"]);
  const positions = { VTI: 0.047685, SCHD: 0.402434, IWM: 0.006665 };
  const withPnl = formatDailyReport(pnlState(), "2026-09-17", {
    account: { positions, holdings, at: "x" }, live: { orders: [] },
  });
  const without = formatDailyReport(pnlState(), "2026-09-17", {
    account: { positions, at: "x" }, live: { orders: [] },
  });
  const heldBlock = (text) => text.slice(text.indexOf("실계좌 보유"), text.indexOf("오늘의 가상 거래"))
    .split("\n").filter((line) => line.startsWith("• ") || line.startsWith("⚠️"));

  assert.deepEqual(heldBlock(withPnl).slice(0, 4), heldBlock(without).slice(0, 4));
});

test("장부 블록에 머리를 달아 실계좌와 가른다", () => {
  const report = formatDailyReport(pnlState(), "2026-09-17", { live: { orders: [] } });
  const lines = report.split("\n");
  const head = lines.findIndex((line) => line.startsWith("── 장부"));

  // 아래 실계좌 칸들은 스스로 이름을 달고 있고, 이 블록만 라벨이 없었다.
  assert.ok(head > 0);
  assert.match(lines[head], /실계좌/);
  assert.ok(lines[head + 1].startsWith("초기 원금:"));
});

test("신호 머리는 신호를 못 읽은 날에도 붙는다", () => {
  const state = pnlState();
  delete state.macro;
  const report = formatDailyReport(state, "2026-09-17", { live: { orders: [] } });
  const lines = report.split("\n");
  const head = lines.indexOf("── 신호 ──");

  // 신호가 없어도 «사용 가능한 신호 없음»이 그 자리에 선다. 머리가 사라지면
  // 그날만 블록 구분이 없어져, 없는 것을 못 본 것으로 읽게 된다.
  assert.ok(head > 0);
  assert.match(lines[head + 1], /통합 시장 상태/);
});
