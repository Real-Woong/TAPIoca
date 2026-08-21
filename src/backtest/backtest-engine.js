import { buildDailyMacdSignal } from "../market/macd-signal.js";
import { buildTrendSignal, DEFAULT_TREND_OPTIONS } from "../market/trend-signal.js";
import { combineMarketSignals } from "../sentiment/market-signal.js";
import { createPaperState, runPaperCycle, summarizePaperState } from "../paper/paper-engine.js";

/**
 * 일봉 종가로 PAPER 엔진을 그대로 돌려보는 백테스터입니다.
 *
 * 핵심 설계: 신호 계산과 매매 판단에 **운영과 동일한 함수**를 씁니다
 * (buildTrendSignal · buildDailyMacdSignal · combineMarketSignals · runPaperCycle).
 * 백테스트용으로 로직을 다시 구현하면 운영과 다른 것을 재게 되고, 그러면
 * 백테스트가 통과해도 아무것도 보장하지 못합니다.
 *
 * 재현 불가능한 입력의 처리:
 * - FRED 거시 점수는 기본적으로 상수(macroScore)입니다. 개정 이력을 받아오면
 *   `macroScores`로 날짜별 값을 넣어 그 층이 때를 맞추는지도 잴 수 있습니다.
 * - 뉴스 감성은 과거 스냅샷이 존재하지 않으므로 아예 제외합니다(null).
 * 따라서 이 백테스터가 재는 것은 **가격 기반 레이어와 체결 규칙**이며,
 * 거시·감성 레이어의 예측력은 여기서 검증되지 않습니다.
 */

const DEFAULT_ALLOCATION = Object.freeze({ VTI: 0.7, SCHD: 0.2, IWM: 0, CASH: 0.1 });

/** 연율 → 일할 환산에 쓰는 거래일 수입니다(지표 연율화와 같은 값).*/
const TRADING_DAYS_PER_YEAR = 252;

export function runBacktest({
  closesBySymbol,
  dates,
  policy,
  fundedUsd = 67.05,
  // 거시 레이어를 상수로 고정합니다. 0이면 가격 레이어만으로 판단합니다.
  macroScore = 0,
  // 날짜별 거시 점수를 주면 상수 대신 이것을 씁니다(길이는 timeline과 같아야
  // 합니다). `macro-history.js`가 FRED 개정 이력에서 만들어 냅니다.
  // null 항목은 "그날은 알 수 없었다"는 뜻이고, 그때는 macroScore로 되돌립니다 —
  // 0을 쓰면 "모른다"와 "중립"이 같은 값이 되어 구분할 수 없습니다.
  macroScores = null,
  signalOptions = {},
  // 200일선이 준비될 때까지는 매매하지 않고 지나갑니다.
  warmupDays = DEFAULT_TREND_OPTIONS.maPeriod,
  // 신호 계산에 넘기는 최대 이력입니다. 운영도 300개만 캐시하므로 같게 둡니다.
  maxSamples = DEFAULT_TREND_OPTIONS.maxSamples,
  benchmarkSymbol,
  // 고정 비중을 주면 신호를 계산하지 않고 그 비중만 유지합니다.
  // 엔진·비용·밴드는 그대로라, 차이가 오직 "신호가 있느냐"에서만 나옵니다.
  // 신호 스택이 정적 배분을 실제로 이기는지 재는 유일한 방법입니다.
  staticAllocation = null,
  /**
   * 현금의 연율 수익률입니다. **기본 0은 사실이 아니라 가정입니다.**
   *
   * 엔진은 지금까지 현금을 0%로 놓고 계산해 왔다(아래 무위험이자율 주석도 같은
   * 가정이다). 주식과 현금만 비교할 때는 두 변형에 똑같이 적용되므로 상대
   * 비교가 유지됐다. **그런데 채권·금을 현금과 비교하는 순간 이 가정이 편향이
   * 된다** — 실제 T-bill은 2004~2026 평균 연 1.7% 안팎이었으므로, 현금을 든
   * 변형만 그만큼 손해 보는 것으로 계산된다.
   *
   * 그래서 손잡이를 만들되 **기본값은 0으로 둔다.** 과거 숫자와의 연속성이
   * 끊기면 안 되기 때문이다. 채권 비교에서는 0과 0.017을 둘 다 돌려
   * **결론이 그 사이에서 뒤집히는지**를 본다. 뒤집히면 그 결론은 자산이 아니라
   * 이 가정이 정한 것이다.
   *
   * 평평한 값이라는 것도 사실이 아니다(2004년 1%, 2007년 5%, 2021년 0%).
   * 엄밀히 하려면 FRED의 단기금리 이력을 써야 한다 — 아직 안 했다.
   */
  cashYieldAnnual = 0,
}) {
  const symbols = Object.keys(closesBySymbol);
  if (symbols.length === 0) throw new Error("closesBySymbol에 최소 한 종목이 필요합니다.");
  const length = Math.min(...symbols.map((symbol) => closesBySymbol[symbol].length));
  if (length <= warmupDays) {
    throw new Error(`일봉이 부족합니다: ${length}개, 워밍업 ${warmupDays}일 필요`);
  }

  // 종목마다 상장일이 달라 이력 길이가 다릅니다(VTI 5000개 vs SCHD 3717개).
  // 모든 배열은 오래된 순이고 같은 날짜에서 끝나므로, 짧은 쪽에 맞춰 **뒤에서**
  // 잘라야 같은 날짜가 같은 인덱스에 옵니다. 앞에서 자르면 VTI의 2006년과
  // SCHD의 2011년을 같은 날로 취급하게 됩니다.
  const aligned = Object.fromEntries(
    symbols.map((symbol) => [symbol, closesBySymbol[symbol].slice(-length)]),
  );

  // **날짜도 종가와 같은 규칙으로 뒤에서 맞춥니다.** 종가만 짧은 쪽에 맞추고
  // 날짜를 그대로 두면 인덱스가 어긋나고, 날짜가 더 짧으면 `timeline[index]`가
  // undefined가 되어 한참 뒤에서 터집니다(2026-08-21 구간 분할).
  if (Array.isArray(dates) && dates.length < length) {
    throw new Error(`날짜가 일봉보다 짧습니다: 날짜 ${dates.length}개, 일봉 ${length}개`);
  }
  const timeline = Array.isArray(dates) ? dates.slice(-length) : defaultDates(length);
  const state = createPaperState({
    budget: {
      fundingKrw: 100_000,
      krwPerUsd: 100_000 / fundedUsd,
      fundedUsd,
      fundedKrwActual: 100_000,
      reserveKrw: 0,
    },
    // 벤치마크 종목을 앞에 두면 엔진이 그것으로 매수후보유 기준선을 엽니다.
    watchlist: symbols,
    now: timeline[warmupDays],
  });

  const equityCurve = [];
  // 벤치마크의 낙폭도 함께 재야 "위험을 줄인 대가로 수익을 준 것인가"를 판정할 수 있습니다.
  // 수익률만 비교하면 방어형 전략은 언제나 지는 것처럼 보입니다.
  const benchmarkCurve = [];
  const exposures = [];
  let previousEquity = fundedUsd;
  const dailyReturns = [];

  for (let index = warmupDays; index < length; index += 1) {
    const now = timeline[index];
    const history = sliceHistory(aligned, index, maxSamples);
    const dayMacroScore = macroScores?.[index] ?? macroScore;
    const combined = staticAllocation
      ? staticSignal(staticAllocation)
      : combineMarketSignals(constantMacro(dayMacroScore), null, {
          ...signalOptions,
          trend: buildTrendSignal(history, {}, now),
          macd: buildDailyMacdSignal(history, {}, now),
          now,
        });
    const marketSignal = {
      ...combined,
      targetAllocation: restrictAllocation(combined.targetAllocation, symbols),
    };
    const prices = symbols.map((symbol) => ({
      symbol,
      lastPrice: aligned[symbol][index],
      timestamp: now.toISOString(),
    }));

    // 현금 이자를 매매 **전에** 붙입니다. 그날 쓸 수 있는 돈에 포함되어야
    // 실제와 같습니다. 0이면 아무 일도 하지 않으므로 기존 숫자와 동일합니다.
    if (cashYieldAnnual > 0 && state.cashUsd > 0) {
      state.cashUsd += state.cashUsd * (cashYieldAnnual / TRADING_DAYS_PER_YEAR);
    }

    const { summary } = runPaperCycle(state, prices, policy, now, marketSignal);
    equityCurve.push({ date: isoDate(now), equityUsd: summary.equityUsd });
    if (summary.benchmark) benchmarkCurve.push({ equityUsd: summary.benchmark.valueUsd });
    exposures.push(summary.equityUsd > 0 ? summary.marketValueUsd / summary.equityUsd : 0);
    dailyReturns.push(previousEquity > 0 ? summary.equityUsd / previousEquity - 1 : 0);
    previousEquity = summary.equityUsd;
  }

  const finalSummary = summarizePaperState(
    state,
    symbols.map((symbol) => ({ symbol, lastPrice: aligned[symbol][length - 1] })),
  );
  return {
    state,
    summary: finalSummary,
    equityCurve,
    metrics: computeMetrics({
      dailyReturns, equityCurve, benchmarkCurve, exposures, summary: finalSummary, state, fundedUsd,
      benchmarkSymbol: benchmarkSymbol ?? state.benchmark?.symbol,
    }),
  };
}

/** 신호 계산에 넘길 최근 이력만 잘라냅니다. 미래 종가는 절대 포함하지 않습니다. */
function sliceHistory(closesBySymbol, index, maxSamples) {
  const start = Math.max(0, index + 1 - maxSamples);
  const history = {};
  for (const [symbol, closes] of Object.entries(closesBySymbol)) {
    history[symbol] = closes.slice(start, index + 1);
  }
  return history;
}

/**
 * 목표 비중을 실제로 테스트하는 종목에만 재분배합니다(백테스트 전용).
 *
 * 기본 비중표는 VTI·SCHD·IWM을 전제하는데, 종목을 골라 돌리면 빠진 종목의
 * 비중이 갈 곳 없이 남아 영구 현금이 됩니다. 예컨대 2008년을 포함하려고
 * VTI·IWM만 돌리면(SCHD는 2011년 상장) SCHD 몫 20%가 그대로 현금이 되어
 * 노출이 20%p 낮게 잡힙니다.
 *
 * 현금 목표는 그대로 두고 주식 몫만 남은 종목에 비례 배분합니다.
 * 세 종목을 모두 넘기면 배수가 1이라 아무것도 바뀌지 않습니다.
 */
function restrictAllocation(allocation, symbols) {
  const cashWeight = Number(allocation.CASH) || 0;
  const present = symbols.filter((symbol) => symbol in allocation);
  const equitySum = present.reduce((sum, symbol) => sum + (Number(allocation[symbol]) || 0), 0);
  if (equitySum <= 0) return { ...allocation, CASH: 1 };

  const scale = (1 - cashWeight) / equitySum;
  const restricted = { CASH: round(cashWeight) };
  for (const symbol of present) {
    restricted[symbol] = round((Number(allocation[symbol]) || 0) * scale);
  }
  return restricted;
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}

/** 신호 없이 고정 비중만 유지하는 대조군입니다. */
function staticSignal(allocation) {
  return {
    fetchedAt: null,
    evaluatedAt: null,
    regime: "STATIC",
    score: 0,
    targetAllocation: { ...allocation },
    indicators: {},
    reasons: ["정적 비중 대조군"],
    source: "BACKTEST_STATIC",
  };
}

/** 과거 FRED 값을 되살리는 대신 상수 거시 점수를 씁니다. */
function constantMacro(score) {
  return {
    fetchedAt: null,
    evaluatedAt: null,
    regime: "NEUTRAL",
    score,
    targetAllocation: { ...DEFAULT_ALLOCATION },
    indicators: {},
    reasons: [`백테스트 상수 거시 점수 ${score}`],
    source: "BACKTEST_CONSTANT",
  };
}

function computeMetrics({
  dailyReturns, equityCurve, benchmarkCurve, exposures, summary, state, fundedUsd, benchmarkSymbol,
}) {
  const tradingDays = 252;
  const years = dailyReturns.length / tradingDays;
  const finalEquity = summary.equityUsd;
  const totalReturn = fundedUsd > 0 ? finalEquity / fundedUsd - 1 : 0;
  const cagr = years > 0 && fundedUsd > 0 ? (finalEquity / fundedUsd) ** (1 / years) - 1 : 0;

  const mean = average(dailyReturns);
  const variance = dailyReturns.length > 1
    ? dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (dailyReturns.length - 1)
    : 0;
  const annualVol = Math.sqrt(variance) * Math.sqrt(tradingDays);
  // 무위험이자율 0 가정입니다. 전략 간 상대 비교용이므로 절대값으로 읽지 마십시오.
  const sharpe = annualVol > 0 ? (mean * tradingDays) / annualVol : 0;

  const maxDrawdown = maxDrawdownOf(equityCurve);
  const benchmarkDrawdown = maxDrawdownOf(benchmarkCurve ?? []);
  // 최대낙폭은 관측 한 번이라 흔들린다. 최악 5% 평균과 전체 평균을 함께 낸다.
  const conditionalDrawdown5 = conditionalDrawdown(equityCurve, 0.95);
  const averageDrawdown = average(drawdownSeries(equityCurve));

  // 회전율: 총 체결금액 / 평균 자산 / 연수. 비용이 엣지를 잡아먹는지 보는 지표입니다.
  const tradedUsd = state.trades.reduce((sum, trade) => sum + Math.abs(trade.amountUsd), 0);
  const averageEquity = average(equityCurve.map((point) => point.equityUsd)) || fundedUsd;
  const turnoverPerYear = years > 0 ? tradedUsd / averageEquity / years : 0;

  return {
    years: round3(years),
    totalReturnPct: round3(totalReturn * 100),
    cagrPct: round3(cagr * 100),
    annualVolPct: round3(annualVol * 100),
    sharpe: round3(sharpe),
    maxDrawdownPct: round3(maxDrawdown * 100),
    cdar5Pct: round3(conditionalDrawdown5 * 100),
    avgDrawdownPct: round3(averageDrawdown * 100),
    benchmarkMaxDrawdownPct: benchmarkCurve?.length ? round3(benchmarkDrawdown * 100) : null,
    averageExposurePct: round3(average(exposures) * 100),
    tradeCount: state.trades.length,
    turnoverPerYear: round3(turnoverPerYear),
    feesUsd: round3(summary.feesUsd),
    benchmarkSymbol: benchmarkSymbol ?? null,
    benchmarkReturnPct: summary.benchmark ? summary.benchmark.returnPct : null,
    alphaPct: summary.benchmark
      ? round3(totalReturn * 100 - summary.benchmark.returnPct)
      : null,
  };
}

/** 고점 대비 최대 낙폭입니다. */
function maxDrawdownOf(curve) {
  return Math.max(0, ...drawdownSeries(curve), 0);
}

/** 각 시점의 고점 대비 하락폭(언더워터 곡선)입니다. */
function drawdownSeries(curve) {
  let peak = -Infinity;
  const series = [];
  for (const point of curve) {
    peak = Math.max(peak, point.equityUsd);
    if (peak > 0) series.push(1 - point.equityUsd / peak);
  }
  return series;
}

/**
 * CDaR — 최악 (1-alpha) 구간 낙폭의 평균 (Chekhlov, Uryasev & Zabarankin 2003).
 *
 * 최대낙폭은 **관측 한 번**입니다. 표본 전체에서 가장 깊었던 한 지점이 전부라
 * 통계적 오차가 크고, 그 한 점이 바뀌면 결론도 바뀝니다. 실제로 변동성 목표
 * 0.15와 0.20을 가른 5.28%p 차이는 2008~09년 한 번의 침몰에서 나왔습니다.
 *
 * CDaR는 최악 5% 구간을 평균 내므로 수십 개의 침몰을 함께 봅니다. 원 논문은
 * 이 평균화 덕분에 "미래 위험 예측이 낫고 더 안정적인 배분이 나온다"고 말합니다.
 * 최대낙폭은 alpha→1의 극한, 평균낙폭은 alpha=0의 극한으로 같은 가족입니다.
 */
function conditionalDrawdown(curve, alpha = 0.95) {
  const series = drawdownSeries(curve);
  if (series.length === 0) return 0;
  const sorted = [...series].sort((a, b) => b - a);
  // 최악 (1-alpha) 비율만큼 세되, 표본이 작아도 최소 한 건은 본다.
  const count = Math.max(1, Math.round(sorted.length * (1 - alpha)));
  return average(sorted.slice(0, count));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function defaultDates(length) {
  const dates = [];
  const cursor = new Date("2020-01-02T21:00:00Z");
  while (dates.length < length) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function round3(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}
