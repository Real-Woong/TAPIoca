import test from "node:test";
import assert from "node:assert/strict";

import { combineMarketSignals } from "../src/sentiment/market-signal.js";

const macro = {
  regime: "NEUTRAL",
  score: 0,
  targetAllocation: { VTI: 0.7, SCHD: 0.2, IWM: 0, CASH: 0.1 },
  reasons: ["FRED test"],
  source: "FRED",
};

test("감성 점수에 confidence를 곱해 FRED 점수와 합친다", () => {
  const combined = combineMarketSignals(macro, {
    sentiment_score: 1,
    confidence: 0.8,
    summary_reason: "bullish",
    bullish_signals: ["breakout"],
    bearish_signals: [],
  });
  assert.equal(combined.macroScore, 0);
  assert.equal(combined.sentimentContribution, 1.6);
  assert.equal(combined.score, 1.6);
  assert.equal(combined.regime, "RISK_ON");
  assert.equal(combined.targetAllocation.IWM, 0.15);
  assert.equal(combined.signalSource, "FRED_NEWS");
});

test("뉴스 감성을 사용할 수 없으면 FRED 결과를 그대로 유지한다", () => {
  const combined = combineMarketSignals(macro, null);
  assert.equal(combined.score, macro.score);
  assert.equal(combined.signalSource, "FRED_ONLY");
  assert.equal(combined.sentiment, null);
});

test("MACD를 신뢰도와 작은 가중치로 기본 점수에 더한다", () => {
  const combined = combineMarketSignals(macro, null, {
    macd: { available: true, score: 0.8, confidence: 0.75 },
    macdWeight: 0.15,
  });

  assert.equal(combined.baseScore, 0);
  assert.equal(combined.macdContribution, 0.09);
  assert.equal(combined.score, 0.09);
  assert.equal(combined.signalSource, "FRED_MACD");
});

test("표본이 부족한 MACD는 기존 판정에 영향을 주지 않는다", () => {
  const combined = combineMarketSignals(macro, null, {
    macd: { available: false, score: 1, confidence: 1 },
  });

  assert.equal(combined.score, macro.score);
  assert.equal(combined.macd, null);
  assert.equal(combined.signalSource, "FRED_ONLY");
});

test("이동평균 추세를 신뢰도와 가중치로 점수에 더한다", () => {
  const combined = combineMarketSignals(macro, null, {
    trend: { available: true, score: -0.8, confidence: 1 },
    trendWeight: 1,
  });

  assert.equal(combined.trendContribution, -0.8);
  assert.equal(combined.score, -0.8);
  assert.equal(combined.signalSource, "FRED_TREND");
  assert.equal(combined.trend.score, -0.8);
});

test("강한 하락 추세는 중립 거시 점수를 RISK_OFF로 끌어내린다", () => {
  const combined = combineMarketSignals(
    { ...macro, score: -1 },
    { sentiment_score: -0.3, confidence: 1, summary_reason: "", bullish_signals: [], bearish_signals: [] },
    {
      sentimentWeight: 1,
      trend: { available: true, score: -1, confidence: 1 },
      trendWeight: 1,
    },
  );

  // 거시 -1, 감성 -0.3, 추세 -1 = -2.3 → RISK_OFF
  assert.equal(combined.regime, "RISK_OFF");
  assert.equal(combined.signalSource, "FRED_NEWS_TREND");
});

test("사용할 수 없는 추세는 기존 판정에 영향을 주지 않는다", () => {
  const combined = combineMarketSignals(macro, null, {
    trend: { available: false, score: -1, confidence: 1 },
  });

  assert.equal(combined.score, macro.score);
  assert.equal(combined.trend, null);
  assert.equal(combined.signalSource, "FRED_ONLY");
});

test("변동성이 목표보다 높으면 주식 익스포저를 줄이고 현금을 늘린다", () => {
  const combined = combineMarketSignals(macro, null, {
    trend: { available: true, score: 0.5, confidence: 1, volatility: { annualized: 0.3 } },
    trendWeight: 0, // 배분 변화만 검증하기 위해 점수 기여는 0으로 둔다.
    volTarget: 0.15,
    minExposure: 0.3,
  });

  // 연율 변동성 0.30, 목표 0.15 → 배수 0.5
  assert.equal(combined.exposureMultiplier, 0.5);
  // NEUTRAL 기본 VTI 0.7 → 0.35, SCHD 0.2 → 0.1, 현금은 그만큼 증가
  assert.equal(combined.targetAllocation.VTI, 0.35);
  assert.equal(combined.targetAllocation.SCHD, 0.1);
  assert.ok(combined.targetAllocation.CASH > 0.5);
});

test("변동성이 목표 이하이면 익스포저를 줄이지 않는다", () => {
  const combined = combineMarketSignals(macro, null, {
    trend: { available: true, score: 0.5, confidence: 1, volatility: { annualized: 0.1 } },
    trendWeight: 0,
    volTarget: 0.15,
  });

  assert.equal(combined.exposureMultiplier, 1);
  assert.equal(combined.targetAllocation.VTI, 0.7);
});

test("기본 상한 1이라 변동성이 아무리 낮아도 기본 배분 이상으로 늘리지 않는다", () => {
  const combined = combineMarketSignals(macro, null, {
    trend: { available: true, score: 0.5, confidence: 1, volatility: { annualized: 0.05 } },
    trendWeight: 0,
    volTarget: 0.15,
  });

  // 0.15/0.05 = 3이지만 상한 1에서 잘립니다. 이것이 지금까지의 모든 측정과 같은
  // 동작이고, 변동성 관리가 한 방향으로만 작동해 온 이유입니다.
  assert.equal(combined.exposureMultiplier, 1);
  assert.equal(combined.targetAllocation.VTI, 0.7);
});

test("maxExposure를 올리면 조용한 구간에서 주식을 더 든다", () => {
  const combined = combineMarketSignals(macro, null, {
    trend: { available: true, score: 0.5, confidence: 1, volatility: { annualized: 0.1 } },
    trendWeight: 0,
    volTarget: 0.11,
    maxExposure: 1.2,
  });

  // 0.11/0.1 = 1.1 → 상한 1.2 안이라 그대로 통과합니다.
  assert.equal(combined.exposureMultiplier, 1.1);
  // NEUTRAL 기본 VTI 0.7 → 0.77, SCHD 0.2 → 0.22. 늘린 만큼 현금이 줄어듭니다.
  assert.equal(combined.targetAllocation.VTI, 0.77);
  assert.equal(combined.targetAllocation.SCHD, 0.22);
  assert.ok(Math.abs(combined.targetAllocation.CASH - 0.01) < 1e-9);
});

test("기본 배분이 주식 90%라 상한 1.12 부근에서 이미 포화된다", () => {
  // 이것이 이 손잡이의 실효 범위를 정합니다. NEUTRAL 기본 배분은 주식 90%(VTI 70 +
  // SCHD 20)이므로 배수 1/0.9 = 1.111에서 주식 합이 100%에 닿습니다. 그 위로는
  // 상한을 아무리 올려도 배분이 같습니다 — 남은 현금 10%를 다 쓴 뒤에는 살 것이
  // 없기 때문입니다. **상한을 1.2 위로 올리는 것은 의미가 없습니다.**
  const atCap = (maxExposure) =>
    combineMarketSignals(macro, null, {
      trend: { available: true, score: 0.5, confidence: 1, volatility: { annualized: 0.02 } },
      trendWeight: 0,
      volTarget: 0.15,
      maxExposure,
    }).targetAllocation;

  assert.deepEqual(atCap(1.2), atCap(1.6));
  assert.deepEqual(atCap(1.6), atCap(5));
});

test("maxExposure를 아무리 올려도 레버리지가 되지 않는다 — 주식 합이 100%에서 멈춘다", () => {
  const combined = combineMarketSignals(macro, null, {
    trend: { available: true, score: 0.5, confidence: 1, volatility: { annualized: 0.02 } },
    trendWeight: 0,
    volTarget: 0.15,
    maxExposure: 5,
  });

  assert.equal(combined.exposureMultiplier, 5);

  const allocation = combined.targetAllocation;
  const equitySum = Object.entries(allocation)
    .filter(([symbol]) => symbol !== "CASH")
    .reduce((sum, [, weight]) => sum + weight, 0);

  // 이 지갑에는 차입이 없습니다. 비율은 유지한 채 100%로 눌러 담습니다.
  assert.ok(Math.abs(equitySum - 1) < 1e-9, `주식 합이 100%여야 한다: ${equitySum}`);
  assert.equal(allocation.CASH, 0);
  // 눌러 담아도 종목 사이 비율(VTI:SCHD = 7:2)은 그대로입니다.
  assert.ok(Math.abs(allocation.VTI / allocation.SCHD - 3.5) < 0.01);
});

test("minExposure 아래로는 익스포저를 줄이지 않는다", () => {
  const combined = combineMarketSignals(macro, null, {
    trend: { available: true, score: 0, confidence: 1, volatility: { annualized: 0.9 } },
    trendWeight: 0,
    volTarget: 0.15,
    minExposure: 0.3,
  });

  // 0.15/0.9 = 0.167 < 0.3 → 하한 0.3으로 고정
  assert.equal(combined.exposureMultiplier, 0.3);
});

test("레이어별 상태를 항상 담고 꺼진 신호의 사유를 남긴다", () => {
  const combined = combineMarketSignals(macro, null, {
    trend: { available: false, reason: "NO_DAILY_CLOSES" },
    macd: { available: true, score: 0.4, confidence: 1 },
    macdWeight: 0.15,
  });

  const byKey = Object.fromEntries(combined.layers.map((layer) => [layer.key, layer]));
  assert.equal(byKey.NEWS.available, false);
  assert.equal(byKey.NEWS.reason, "NOT_LOADED");
  assert.equal(byKey.TREND.available, false);
  assert.equal(byKey.TREND.reason, "NO_DAILY_CLOSES");
  assert.equal(byKey.TREND.weight, 1);
  assert.equal(byKey.MACD.available, true);
  assert.equal(byKey.MACD.contribution, 0.06);
});

// ── 연속 목표 비중 ──────────────────────────────────────────────
// 예전에는 점수 -1.5 한 점에서 주식 90%↔60%가 갈렸습니다. 07-22~08-04 동안
// 점수가 -1.2와 -2.3을 오가며 목표 비중이 매일 뒤집혔고, 그 진동의 원인은
// 캐시된 감성 스냅샷이었습니다.

function equityWeight(allocation) {
  return round3(1 - Number(allocation.CASH ?? 0));
}

function round3(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}

test("점수 경계에서 목표 비중이 계단이 아니라 연속으로 움직인다", () => {
  const at = (score) => equityWeight(
    combineMarketSignals({ ...macro, score }, null, { trendWeight: 0 }).targetAllocation,
  );

  // 경계선 양쪽 0.1 차이가 만드는 비중 변화가 무거래 밴드(5%)보다 작아야 합니다.
  assert.ok(Math.abs(at(-1.45) - at(-1.55)) < 0.05, `${at(-1.45)} vs ${at(-1.55)}`);
  // 단조 감소해야 합니다.
  const curve = [1.5, 0.5, 0, -0.5, -1.2, -1.5, -2.5].map(at);
  for (let i = 1; i < curve.length; i += 1) {
    assert.ok(curve[i] <= curve[i - 1], `단조성 위반: ${curve}`);
  }
});

test("앵커 점수에서는 기존 레짐 표와 정확히 일치한다", () => {
  const alloc = (score) =>
    combineMarketSignals({ ...macro, score }, null, { trendWeight: 0 }).targetAllocation;

  assert.deepEqual(alloc(0), { VTI: 0.7, SCHD: 0.2, IWM: 0, CASH: 0.1 });
  assert.deepEqual(alloc(-1.5), { VTI: 0.4, SCHD: 0.2, IWM: 0, CASH: 0.4 });
  assert.deepEqual(alloc(1.5), { VTI: 0.7, SCHD: 0.15, IWM: 0.15, CASH: 0 });
});

test("중간 점수에서는 두 표 사이를 보간하고 합이 1을 유지한다", () => {
  const alloc = combineMarketSignals({ ...macro, score: -0.75 }, null, { trendWeight: 0 })
    .targetAllocation;

  // NEUTRAL과 RISK_OFF의 정확히 중간입니다.
  assert.equal(alloc.VTI, 0.55);
  assert.equal(alloc.CASH, 0.25);
  const sum = Object.values(alloc).reduce((total, weight) => total + weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `비중 합 ${sum}`);
});

// ── 감성 스냅샷 신선도 ──────────────────────────────────────────
// 07-23~07-31 보고서에서 감성 값이 소수점 3자리까지 4일간 동일했습니다.
// 캐시 재사용이었고, 그 값이 레짐 경계를 넘나들며 주식 비중을 뒤집었습니다.

const now = new Date("2026-08-04T12:00:00Z");
const bullish = (fetchedAt) => ({
  sentiment_score: 1, confidence: 0.8, fetchedAt,
  summary_reason: "bullish", bullish_signals: [], bearish_signals: [],
});

test("갓 수집한 감성은 감쇠 없이 그대로 반영한다", () => {
  const combined = combineMarketSignals(macro, bullish("2026-08-04T12:00:00Z"), { now });
  assert.equal(combined.sentimentContribution, 1.6);
  assert.equal(combined.sentimentFreshness.multiplier, 1);
});

test("반감기만큼 오래된 스냅샷은 기여도를 절반으로 깎는다", () => {
  const combined = combineMarketSignals(macro, bullish("2026-08-04T06:00:00Z"), {
    now, sentimentHalfLifeHours: 6,
  });
  assert.equal(combined.sentimentFreshness.ageHours, 6);
  assert.equal(combined.sentimentContribution, 0.8);
});

test("상한을 넘긴 스냅샷은 판단에서 완전히 뺀다", () => {
  const combined = combineMarketSignals(macro, bullish("2026-08-03T00:00:00Z"), {
    now, sentimentMaxAgeHours: 24,
  });
  assert.equal(combined.sentimentContribution, 0);
  assert.equal(combined.score, 0);
  const news = combined.layers.find((layer) => layer.key === "NEWS");
  assert.equal(news.available, false);
  assert.equal(news.reason, "STALE_SNAPSHOT");
});

test("수집 시각을 모르면 감쇠시키지 않는다", () => {
  const combined = combineMarketSignals(macro, bullish(undefined), { now });
  assert.equal(combined.sentimentContribution, 1.6);
  assert.equal(combined.sentimentFreshness.ageHours, null);
});

// `--compare vol`의 "끔" 변형이 실제로 레이어를 끄는지 고정한다. volTarget이
// 0으로 내려가도 배수가 1로 유지되지 않으면, 그 비교는 켠 것끼리 재는 셈이 된다.
test("변동성 목표가 0이면 익스포저를 전혀 줄이지 않는다", () => {
  const combined = combineMarketSignals(macro, null, {
    trend: { available: true, score: 0.5, confidence: 1, volatility: { annualized: 0.6 } },
    trendWeight: 0,
    volTarget: 0,
    minExposure: 0.3,
  });

  assert.equal(combined.exposureMultiplier, 1);
  // 목표 비중이 기본 NEUTRAL 표 그대로여야 한다.
  assert.equal(combined.targetAllocation.VTI, 0.7);
  assert.equal(combined.targetAllocation.SCHD, 0.2);
});

// 목표를 낮출수록 익스포저가 단조 감소해야 한다. 부호가 뒤집히면 비교표의
// 해석이 통째로 뒤집힌다.
test("변동성 목표가 낮을수록 익스포저가 작아진다", () => {
  const multiplierFor = (volTarget) => combineMarketSignals(macro, null, {
    trend: { available: true, score: 0.5, confidence: 1, volatility: { annualized: 0.25 } },
    trendWeight: 0,
    volTarget,
    minExposure: 0.3,
  }).exposureMultiplier;

  assert.ok(multiplierFor(0.1) < multiplierFor(0.15));
  assert.ok(multiplierFor(0.15) < multiplierFor(0.2));
  assert.equal(multiplierFor(0.2), 0.8);
});

test("거시 가중치 0이면 배분에 관여하지 않지만 점수는 남는다", () => {
  const combined = combineMarketSignals({ ...macro, score: -0.5 }, null, {
    macroWeight: 0, trendWeight: 0, volTarget: 0,
  });

  // 점수에서 빠졌으므로 중립 배분입니다.
  assert.equal(combined.score, 0);
  assert.equal(combined.targetAllocation.VTI, 0.7);
  // 그래도 원점수는 기록됩니다 — 지우지 않는 이유는 진단을 남기기 위해서입니다.
  assert.equal(combined.macroScore, -0.5);
  assert.equal(combined.macroContribution, 0);

  // 보고서가 "꺼진 신호"로 드러내야 합니다.
  const fred = combined.layers.find((layer) => layer.key === "FRED");
  assert.equal(fred.available, false);
  assert.equal(fred.weight, 0);
});

test("거시 가중치 1이 지금까지의 동작이다", () => {
  const combined = combineMarketSignals({ ...macro, score: -0.5 }, null, {
    trendWeight: 0, volTarget: 0,
  });
  assert.equal(combined.score, -0.5);
  assert.equal(combined.macroContribution, -0.5);
});

test("거시 가중치를 줄이면 그만큼만 반영된다", () => {
  const combined = combineMarketSignals({ ...macro, score: -1 }, null, {
    macroWeight: 0.5, trendWeight: 0, volTarget: 0,
  });
  assert.equal(combined.score, -0.5);
});

test("가중치가 0이어도 감성 원점수는 그대로 실려 나간다", () => {
  // 표본 수집이 여기에 달려 있습니다. 가중치를 0으로 두고도 판정을 할 수 있는
  // 이유는 원점수가 이벤트 로그에 남기 때문이고, 그것이 깨지면 2주를 버립니다.
  const combined = combineMarketSignals(macro, {
    sentiment_score: -0.343,
    confidence: 0.774,
    summary_reason: "",
    bullish_signals: [],
    bearish_signals: [],
  }, { sentimentWeight: 0, trendWeight: 0, volTarget: 0 });

  assert.equal(combined.sentimentContribution, 0, "배분에는 관여하지 않는다");
  assert.equal(combined.score, 0);
  // 그래도 원점수는 남는다 — 이벤트 로그가 여기서 읽는다.
  assert.equal(combined.sentiment.sentiment_score, -0.343);
  assert.equal(combined.sentiment.confidence, 0.774);
});
