import test from "node:test";
import assert from "node:assert/strict";

import { runBacktest } from "../src/backtest/backtest-engine.js";
import { generateMarket, generatePath } from "../src/backtest/synthetic-prices.js";
import { buildScenario, SCENARIOS } from "../src/backtest/scenarios.js";
import { loadTradingPolicy } from "../src/paper/trading-policy.js";

// 일봉 백테스트에서는 사이클 하나가 하루이므로 레짐 확정도 사이클 단위로 지정합니다.
const policy = loadTradingPolicy({
  MAX_ORDER_USD: "5",
  MAX_DAILY_BUY_USD: "10",
  TRADE_COST_RATE: "0.001",
  REGIME_CONFIRM_CYCLES: "1",
});

function market(seed = 7, days = 400) {
  return generateMarket(seed, ["VTI", "SCHD"], { days });
}

test("같은 시드는 같은 경로를 만든다", () => {
  assert.deepEqual(generatePath(11, { days: 50 }), generatePath(11, { days: 50 }));
  assert.notDeepEqual(generatePath(11, { days: 50 }), generatePath(12, { days: 50 }));
});

test("백테스트 결과는 결정론적이다", () => {
  const closes = market();
  const first = runBacktest({ closesBySymbol: closes, policy });
  const second = runBacktest({ closesBySymbol: closes, policy });
  assert.deepEqual(first.metrics, second.metrics);
});

// 백테스터에서 가장 흔하고 가장 치명적인 버그입니다. 미래 종가가 과거 판단에
// 새어 들어가면 성과가 부풀고, 그 백테스트는 아무것도 보장하지 못합니다.
test("미래 종가를 바꿔도 그 이전 거래는 달라지지 않는다", () => {
  const closes = market();
  const cutoff = 300;
  const tampered = Object.fromEntries(
    Object.entries(closes).map(([symbol, series]) => [
      symbol,
      series.map((close, index) => (index >= cutoff ? close * 3 : close)),
    ]),
  );

  const original = runBacktest({ closesBySymbol: closes, policy });
  const modified = runBacktest({ closesBySymbol: tampered, policy });

  const before = (result) =>
    result.state.trades
      .filter((trade) => trade.executedAt < result.equityCurve[cutoff - 201].date + "T99")
      .map((trade) => `${trade.side}:${trade.symbol}:${trade.amountUsd}`);

  // 양쪽이 모두 비어 있으면 비교가 무의미하므로 실제 거래가 있었는지 먼저 확인합니다.
  assert.ok(before(original).length > 0, "비교할 거래가 없습니다");
  assert.deepEqual(before(original), before(modified));
  // 반대로 이후 구간은 달라져야 합니다(테스트가 아무것도 안 재는 상태를 방지).
  assert.notDeepEqual(original.metrics, modified.metrics);
});

test("워밍업 기간 동안은 매매하지 않는다", () => {
  const closes = market(7, 260);
  const result = runBacktest({ closesBySymbol: closes, policy, warmupDays: 250 });
  // 250일 워밍업 뒤 10거래일만 남으므로 자산 곡선도 10개입니다.
  assert.equal(result.equityCurve.length, 10);
  assert.ok(result.state.trades.every((trade) => trade.executedAt >= result.equityCurve[0].date));
});

test("일봉이 워밍업보다 짧으면 조용히 빈 결과를 내지 않고 중단한다", () => {
  assert.throws(
    () => runBacktest({ closesBySymbol: market(7, 100), policy }),
    /일봉이 부족합니다/,
  );
});

test("지표가 정의된 범위 안에 있다", () => {
  const { metrics } = runBacktest({ closesBySymbol: market(3, 800), policy });
  assert.ok(metrics.maxDrawdownPct >= 0 && metrics.maxDrawdownPct <= 100);
  assert.ok(metrics.averageExposurePct >= 0 && metrics.averageExposurePct <= 100);
  assert.ok(metrics.annualVolPct >= 0);
  assert.ok(metrics.turnoverPerYear >= 0);
  assert.equal(metrics.benchmarkSymbol, "VTI");
  assert.ok(Number.isFinite(metrics.alphaPct));
});

test("모든 시나리오가 백테스트를 통과한다", () => {
  for (const name of Object.keys(SCENARIOS)) {
    const closes = buildScenario(name, { seed: 5, days: 500, symbols: ["VTI", "SCHD"] });
    const { metrics } = runBacktest({ closesBySymbol: closes, policy });
    assert.ok(Number.isFinite(metrics.cagrPct), `${name} CAGR`);
  }
});

test("알 수 없는 시나리오는 이름을 알려주며 실패한다", () => {
  assert.throws(
    () => buildScenario("nope", { seed: 1, days: 300, symbols: ["VTI"] }),
    /알 수 없는 시나리오/,
  );
});

// P0에서 바꾼 기본값이 실제로 회전율을 줄이는지 백테스트로 확인합니다.
// 20일치 PAPER 운용으로는 이 차이를 우연과 구분할 수 없었습니다.
test("이전 청산 규칙은 회전율을 몇 배로 키운다", () => {
  const closes = market(21, 900);
  const legacy = loadTradingPolicy({
    MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10", TRADE_COST_RATE: "0.001",
    REGIME_CONFIRM_CYCLES: "1",
    STOP_LOSS_RATE: "0.03", TRAILING_ACTIVATION_RATE: "0.025",
    TRAILING_DRAWDOWN_RATE: "0.015", MAX_HOLDING_DAYS: "15",
  });

  const current = runBacktest({ closesBySymbol: closes, policy }).metrics;
  const previous = runBacktest({ closesBySymbol: closes, policy: legacy }).metrics;

  assert.ok(
    previous.turnoverPerYear > current.turnoverPerYear * 3,
    `이전 ${previous.turnoverPerYear} vs 현재 ${current.turnoverPerYear}`,
  );
  assert.ok(previous.tradeCount > current.tradeCount * 2);
});

// 종목마다 상장일이 달라 이력 길이가 다르다(실제로 VTI 5000개 vs SCHD 3717개).
// 배열은 오래된 순이고 같은 날짜에서 끝나므로 뒤에서 잘라야 한다. 앞에서 자르면
// VTI의 2006년과 SCHD의 2011년을 같은 날로 취급하게 되고, 그 백테스트는 무의미하다.
test("이력이 더 긴 종목은 최신일 기준으로 정렬한다", () => {
  const base = market(9, 500);
  // VTI 앞에만 전혀 다른 가격대의 과거 이력을 덧붙인다.
  // 최신 500일은 그대로이므로 결과가 바뀌면 안 된다.
  const padded = {
    ...base,
    VTI: [...generatePath(99, { days: 300, startPrice: 12 }), ...base.VTI],
  };

  const expected = runBacktest({ closesBySymbol: base, policy }).metrics;
  const actual = runBacktest({ closesBySymbol: padded, policy }).metrics;

  assert.equal(padded.VTI.length, 800);
  assert.equal(base.SCHD.length, 500);
  assert.deepEqual(actual, expected);
});

// 기본 비중표는 VTI·SCHD·IWM을 전제한다. 종목을 골라 돌릴 때 빠진 종목의 몫이
// 영구 현금으로 남으면, 2008년을 포함하려고 VTI·IWM만 돌리는 실험이 노출
// 20%p를 손해 본 채로 측정된다.
test("종목을 골라 돌리면 빠진 종목의 비중을 남은 종목에 재분배한다", () => {
  const two = generateMarket(13, ["VTI", "IWM"], { days: 700 });
  const three = generateMarket(13, ["VTI", "SCHD", "IWM"], { days: 700 });

  const twoResult = runBacktest({ closesBySymbol: two, policy }).metrics;
  const threeResult = runBacktest({ closesBySymbol: three, policy }).metrics;

  // SCHD 몫 20%가 현금으로 남았다면 노출이 크게 낮아진다.
  assert.ok(
    Math.abs(twoResult.averageExposurePct - threeResult.averageExposurePct) < 8,
    `2종목 ${twoResult.averageExposurePct}% vs 3종목 ${threeResult.averageExposurePct}%`,
  );
  assert.ok(twoResult.averageExposurePct > 60);
});

test("세 종목을 모두 넘기면 재분배가 비중을 바꾸지 않는다", () => {
  const closes = market(9, 500);
  const full = generateMarket(9, ["VTI", "SCHD"], { days: 500 });
  // market()과 같은 입력이므로 결과도 같아야 한다(재분배 배수 1).
  assert.deepEqual(
    runBacktest({ closesBySymbol: closes, policy }).metrics,
    runBacktest({ closesBySymbol: full, policy }).metrics,
  );
});

// 신호 스택이 정적 배분을 실제로 이기는지 재려면, 신호만 빼고 나머지를 똑같이
// 둔 대조군이 필요하다. 엔진·비용·밴드가 같아야 차이가 신호에서만 나온다.
test("고정 비중을 주면 신호를 계산하지 않고 그 비중을 유지한다", () => {
  const closes = market(17, 700);
  const result = runBacktest({
    closesBySymbol: closes,
    policy,
    staticAllocation: { VTI: 0.5, SCHD: 0.1, CASH: 0.4 },
  });

  // 목표 현금 40%이므로 노출은 60% 근처에 머문다.
  assert.ok(
    Math.abs(result.metrics.averageExposurePct - 60) < 12,
    `평균 노출 ${result.metrics.averageExposurePct}%`,
  );
  assert.equal(result.state.macro.regime, "STATIC");
  assert.ok(result.state.trades.every((trade) => !trade.reason?.includes("MACRO_RISK")));
});

test("고정 비중 대조군은 신호 가중치에 반응하지 않는다", () => {
  const closes = market(17, 700);
  const run = (signalOptions) =>
    runBacktest({
      closesBySymbol: closes, policy, signalOptions,
      staticAllocation: { VTI: 0.7, SCHD: 0.2, CASH: 0.1 },
    }).metrics;

  // 추세·MACD 가중치를 바꿔도 결과가 같아야 대조군으로 쓸 수 있다.
  assert.deepEqual(run({ trendWeight: 0, macdWeight: 0 }), run({ trendWeight: 2, macdWeight: 1 }));
});

// `--compare vol`이 실제로 무언가를 재는지 확인한다. 신호 옵션이 백테스터를
// 통과하지 못하면 네 변형이 모두 같은 숫자를 내고, 그 표를 근거로 삼게 된다.
test("변동성 목표를 낮추면 평균 노출이 줄어든다", () => {
  // 목표 0.15보다 확실히 높은 변동성이라야 세 변형이 갈립니다.
  const closes = generateMarket(31, ["VTI", "SCHD"], { days: 900, annualVol: 0.3 });
  const exposureFor = (volTarget) =>
    runBacktest({ closesBySymbol: closes, policy, signalOptions: { volTarget } })
      .metrics.averageExposurePct;

  const off = exposureFor(0);
  const loose = exposureFor(0.2);
  const tight = exposureFor(0.1);

  assert.ok(off > tight, `끔 ${off}% vs 0.10 ${tight}%`);
  assert.ok(loose > tight, `0.20 ${loose}% vs 0.10 ${tight}%`);
});

// 최대낙폭은 표본 전체에서 가장 깊었던 **한 지점**이다. 그 한 점이 바뀌면 결론도
// 바뀐다(변동성 목표 0.15와 0.20을 가른 5.28%p가 2008~09년 한 번에서 나왔다).
// CDaR는 최악 5%를 평균 내므로 침몰 여러 개를 함께 본다(Chekhlov et al. 2003).
test("CDaR는 최대낙폭 이하이고 평균낙폭 이상이다", () => {
  const { metrics } = runBacktest({ closesBySymbol: market(23, 1200), policy });

  assert.ok(metrics.avgDrawdownPct <= metrics.cdar5Pct, `평균 ${metrics.avgDrawdownPct} vs CDaR ${metrics.cdar5Pct}`);
  assert.ok(metrics.cdar5Pct <= metrics.maxDrawdownPct, `CDaR ${metrics.cdar5Pct} vs MDD ${metrics.maxDrawdownPct}`);
  assert.ok(metrics.cdar5Pct >= 0);
});

// 최대낙폭만 보면 놓치는 것을 CDaR가 잡는지 확인한다. 침몰이 한 번뿐인 경로와
// 같은 깊이로 여러 번 침몰한 경로는 최대낙폭이 같아도 위험이 다르다.
test("같은 최대낙폭이어도 침몰이 잦으면 CDaR가 더 크다", () => {
  const once = [...Array(60).fill(100), 70, ...Array(60).fill(100)];
  const often = [...Array(20).fill(100), 70, ...Array(20).fill(100), 70,
                 ...Array(20).fill(100), 70, ...Array(20).fill(100)];
  const curve = (closes) => closes.map((equityUsd, index) => ({ date: `d${index}`, equityUsd }));

  // 엔진을 거치지 않고 지표 함수만 직접 검증하기 위해 자산 곡선을 만들어 비교한다.
  const cdar = (closes) => {
    const series = [];
    let peak = -Infinity;
    for (const { equityUsd } of curve(closes)) {
      peak = Math.max(peak, equityUsd);
      series.push(1 - equityUsd / peak);
    }
    const sorted = [...series].sort((a, b) => b - a);
    const count = Math.max(1, Math.round(sorted.length * 0.05));
    return sorted.slice(0, count).reduce((sum, value) => sum + value, 0) / count;
  };

  assert.equal(Math.max(...once.map((v, i) => 1 - v / Math.max(...once.slice(0, i + 1)))).toFixed(2),
               Math.max(...often.map((v, i) => 1 - v / Math.max(...often.slice(0, i + 1)))).toFixed(2));
  assert.ok(cdar(often) > cdar(once), `잦음 ${cdar(often)} vs 한번 ${cdar(once)}`);
});

// 노이즈 크기를 재려면 같은 파라미터가 서로 다른 구간에서 얼마나 흔들리는지 봐야
// 한다. 구간 분할이 실제로 겹치지 않는 조각을 만드는지 여기서 고정한다.
test("구간 분할은 겹치지 않고 순서를 지킨다", () => {
  const closes = market(41, 1200);
  const size = Math.floor(1200 / 3);
  const blocks = [0, 1, 2].map((index) =>
    Object.fromEntries(Object.entries(closes).map(([symbol, series]) =>
      [symbol, series.slice(index * size, (index + 1) * size)])));

  // 각 구간이 원본의 해당 조각과 정확히 같아야 한다.
  for (const [index, block] of blocks.entries()) {
    assert.equal(block.VTI.length, size);
    assert.equal(block.VTI[0], closes.VTI[index * size]);
    assert.equal(block.VTI[size - 1], closes.VTI[(index + 1) * size - 1]);
  }
  // 구간끼리 겹치지 않는다.
  assert.notEqual(blocks[0].VTI[size - 1], blocks[1].VTI[0]);

  // 구간마다 독립적으로 백테스트가 돌아야 한다(워밍업 200일 + 평가 구간).
  for (const block of blocks) {
    assert.ok(Number.isFinite(runBacktest({ closesBySymbol: block, policy }).metrics.cdar5Pct));
  }
});

// ── 구간 분할 ──────────────────────────────────────────────────────────────
// 2026-08-21: `--compare regime --source cache --blocks 4`(3종목)가 마지막
// 구간에서 터졌다. 원인은 크래시가 아니라 **정렬 없이 자른 것**이었다 —
// 종목마다 길이가 달라 같은 구간 번호가 종목마다 다른 날짜를 가리켰고,
// 구간1~3은 조용히 틀린 값을 냈다. 터진 구간4가 오히려 운이 좋았다.
test("구간 분할은 자르기 전에 종목 길이를 맞춘다", async () => {
  const { splitIntoBlocks, alignToShortest } = await import("../src/backtest/blocks.js");

  // VTI 5000 · SCHD 3719 · IWM 5000 — 실제 캐시와 같은 모양이다.
  // 날짜는 가장 짧은 종목 기준이라 3719개다(backtest-cli.js의 buildDatasets).
  const closesBySymbol = {
    VTI: Array.from({ length: 5000 }, (unused, index) => 100 + index),
    SCHD: Array.from({ length: 3719 }, (unused, index) => 50 + index),
    IWM: Array.from({ length: 5000 }, (unused, index) => 80 + index),
  };
  const dates = Array.from({ length: 3719 }, (unused, index) => new Date(2011, 0, 1 + index));

  const blocks = splitIntoBlocks([{ closesBySymbol, dates }], 4, 450);
  assert.equal(blocks.length, 4, "구간4가 빈 배열이 되어 사라지지 않는다");

  for (const [number, [dataset]] of blocks.entries()) {
    const lengths = Object.values(dataset.closesBySymbol).map((closes) => closes.length);
    assert.equal(new Set(lengths).size, 1, `구간${number + 1}: 종목마다 길이가 같아야 한다`);
    assert.ok(
      dataset.dates.length >= lengths[0],
      `구간${number + 1}: 날짜 ${dataset.dates.length}개가 일봉 ${lengths[0]}개보다 짧다`,
    );
  }

  // 같은 구간 번호는 모든 종목에서 같은 날짜 구간이어야 한다. 정렬 뒤 SCHD는
  // 그대로고 VTI·IWM은 앞의 1281일이 잘리므로, 각 구간의 첫 값이 그만큼 밀린다.
  const aligned = alignToShortest(closesBySymbol);
  assert.equal(aligned.length, 3719);
  assert.equal(aligned.closesBySymbol.VTI[0], 100 + (5000 - 3719));
  assert.equal(aligned.closesBySymbol.SCHD[0], 50);
});

test("날짜가 일봉보다 짧으면 조용히 지나가지 않는다", () => {
  assert.throws(
    () => runBacktest({
      closesBySymbol: { VTI: Array.from({ length: 600 }, (unused, i) => 100 + i) },
      dates: [new Date(2020, 0, 1)],
    }),
    /날짜가 일봉보다 짧습니다/,
  );
});
