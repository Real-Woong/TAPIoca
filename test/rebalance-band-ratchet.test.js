import test from "node:test";
import assert from "node:assert/strict";

import { createPaperState, runPaperCycle, summarizePaperState } from "../src/paper/paper-engine.js";
import { createUsdBudget } from "../src/paper/trading-budget.js";
import { loadTradingPolicy } from "../src/paper/trading-policy.js";
import { allocationForScore, regimeForScore } from "../src/sentiment/market-signal.js";

/**
 * 무거래 밴드의 방향 비대칭을 재현합니다.
 *
 * 밴드는 크기가 대칭입니다(매수·매도 모두 자산의 5%). 그러나 **효과는 대칭이
 * 아닙니다.** 진입할 때는 목표 비중 전체가 결손이라 밴드를 넘지만, 되돌아올 때는
 * 목표가 내려간 만큼만 초과분이라 밴드에 못 미칩니다. 그래서 신호가 한 번 튀어
 * 만든 포지션은 신호가 되돌아와도 남습니다.
 *
 * `market-signal.js`의 배분 보간은 "점수 0.1 변동이 30%p 점프가 아니라 2%p
 * 드리프트가 되고, 무거래 밴드 안에 들어와 실제 주문으로 이어지지 않는다"는
 * 이유로 도입됐습니다. 그 절반은 맞습니다 — 작은 드리프트는 흡수됩니다. 흡수되지
 * 않는 것은 **이미 밴드를 넘어 세워진 포지션의 해체**입니다. 절벽은 배분 층에서
 * 사라진 게 아니라 체결 층으로 옮겨갔습니다.
 *
 * **주의: 이 파일은 현재 동작을 고정하는 재현 테스트입니다. 바라는 동작이 아닙니다.**
 * IWM 6%가 남는 것을 단언하는 것은 그게 옳아서가 아니라, 고쳤을 때 무엇이
 * 바뀌는지 눈에 보이게 하기 위해서입니다. 밴드를 고치면 이 단언들은 뒤집혀야
 * 합니다 — 조용히 통과하면 안 고쳐진 것입니다.
 *
 * 이것은 통계가 아니라 코드의 결정론적 성질이므로 표본 크기와 무관하게 참입니다.
 * 그래서 백테스트가 아니라 테스트로 잽니다. 백테스터는 감성 층을 null로 넣으므로
 * (`backtest-engine.js`) 목표를 하루 만에 밀어올릴 만큼 빠른 입력이 없고,
 * 200일선만으로는 이 경로를 밟을 수 없습니다.
 */

// 운영과 같은 밴드(5%)·주문 한도를 쓰되 거래비용만 0으로 둡니다.
// 비용이 섞이면 자산이 매 사이클 조금씩 줄어 비중 단언에 잡음이 됩니다.
const BASE_ENV = {
  MAX_ORDER_USD: "5",
  MAX_DAILY_BUY_USD: "10",
  TRADE_COST_RATE: "0",
  REGIME_CONFIRM_CYCLES: "1",
};

// 가격을 전 구간 고정합니다. 그래야 비중 변화의 원인이 **엔진의 주문뿐**이 됩니다.
// 가격이 움직이면 "래칫 때문인가 평가액 때문인가"를 가를 수 없습니다.
const PRICES = [
  { symbol: "VTI", lastPrice: 300 },
  { symbol: "SCHD", lastPrice: 28 },
  { symbol: "IWM", lastPrice: 230 },
];

/** 점수 하나로 운영과 같은 배분표를 만듭니다. 표를 손으로 적지 않는 것이 핵심입니다. */
function signalFor(score) {
  return {
    fetchedAt: "2026-01-01T00:00:00Z",
    evaluatedAt: "2026-01-01T00:00:00Z",
    regime: regimeForScore(score),
    score,
    targetAllocation: allocationForScore(score),
    indicators: {},
    reasons: ["TEST"],
    source: "TEST",
    stale: false,
  };
}

/**
 * 점수 구간을 순서대로 밟은 뒤 마지막 상태를 돌려줍니다.
 * phases: [[일수, 점수], ...]
 */
function walk(phases, env = {}) {
  const policy = loadTradingPolicy({ ...BASE_ENV, ...env });
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["VTI", "SCHD", "IWM"],
    now: new Date("2026-01-01T14:30:00Z"),
  });

  let day = 0;
  for (const [days, score] of phases) {
    for (let i = 0; i < days; i += 1) {
      day += 1;
      runPaperCycle(state, PRICES, policy, new Date(Date.UTC(2026, 0, day, 14, 30)), signalFor(score));
    }
  }

  const summary = summarizePaperState(state, PRICES);
  const priceOf = (symbol) => PRICES.find((p) => p.symbol === symbol).lastPrice;
  const valueOf = (symbol) => {
    const position = state.positions[symbol];
    return position ? position.quantity * priceOf(symbol) : 0;
  };

  return {
    state,
    equityUsd: summary.equityUsd,
    bandUsd: policy.rebalanceBandRate * summary.equityUsd,
    buyCount: (symbol) =>
      state.trades.filter((trade) => trade.symbol === symbol && trade.side === "BUY").length,
    valueOf,
    weightOf: (symbol) => valueOf(symbol) / summary.equityUsd,
    sellCount: (symbol) =>
      state.trades.filter((trade) => trade.symbol === symbol && trade.side === "SELL").length,
  };
}

// 워밍업 25일은 일일 매수 한도 $10로 $67 지갑을 다 채우고도 남는 길이입니다.
// 이 구간의 IWM 목표는 0이므로 스파이크 전에는 한 주도 들고 있지 않습니다.
const WARMUP = [25, 0];
// 감성이 하루 만에 뒤집어 통합 점수를 0.6까지 민 날입니다(2026-08-05 실제 경로).
// IWM 목표가 0 → 6%가 되고, 결손 6%가 밴드 5%를 넘어 매수가 실행됩니다.
const SPIKE = [3, 0.6];

test("스파이크로 세운 포지션은 목표가 1/4로 내려가도 스스로 빠지지 않는다", () => {
  const before = walk([WARMUP]);
  assert.equal(before.weightOf("IWM"), 0, "워밍업 구간에서는 IWM을 들지 않는다");

  // 2026-08-06 실제 통합 점수입니다. IWM 목표는 6% → 1.6%로 내려갑니다.
  const after = walk([WARMUP, SPIKE, [40, 0.156]]);

  const target = allocationForScore(0.156).IWM;
  assert.equal(target, 0.016);

  // 40거래일이 지나도 보유 비중은 스파이크 당시의 6%에 그대로 멈춰 있습니다.
  assert.ok(
    Math.abs(after.weightOf("IWM") - 0.06) < 0.0005,
    `IWM 보유 비중이 6%에서 움직이지 않아야 한다: ${after.weightOf("IWM")}`,
  );
  assert.ok(
    after.weightOf("IWM") / target > 3.7,
    `보유가 목표의 3.7배를 넘는다: ${after.weightOf("IWM") / target}`,
  );
  assert.equal(after.sellCount("IWM"), 0, "40거래일 동안 단 한 번도 덜어내지 않는다");

  // 원인은 이것 하나입니다. 초과분이 밴드보다 작아 매도 조건에 걸리지 않습니다.
  const excessUsd = after.valueOf("IWM") - after.equityUsd * target;
  assert.ok(
    excessUsd > 0 && excessUsd < after.bandUsd,
    `초과분 $${excessUsd.toFixed(2)}가 밴드 $${after.bandUsd.toFixed(2)} 안에 갇혀 있다`,
  );
});

test("되돌림 반응은 연속이 아니라 계단이다 — 점수 0.01 차이가 비중 6%p를 가른다", () => {
  // 배분 층은 점수에 대해 연속입니다: 목표는 0.90% → 1.00%로 0.1%p만 움직입니다.
  const lowTarget = allocationForScore(0.09).IWM;
  const highTarget = allocationForScore(0.0995).IWM;
  assert.ok(highTarget - lowTarget < 0.002, "목표 비중 차이는 0.2%p 미만이다");

  // 체결 층은 불연속입니다: 전량 매도와 전량 유지로 갈립니다.
  const low = walk([WARMUP, SPIKE, [40, 0.09]]);
  const high = walk([WARMUP, SPIKE, [40, 0.0995]]);

  assert.equal(low.weightOf("IWM"), 0, "점수 0.09에서는 전량 정리된다");
  assert.ok(
    Math.abs(high.weightOf("IWM") - 0.06) < 0.0005,
    `점수 0.0995에서는 6%가 통째로 남는다: ${high.weightOf("IWM")}`,
  );

  // 그 사이 어디에도 부분 정리가 없습니다. 목표 0.1%p 차이가 포트폴리오 6%p를 가릅니다.
  assert.equal(low.sellCount("IWM"), 1);
  assert.equal(high.sellCount("IWM"), 0);
});

test("잔여물은 목표가 정확히 0이 될 때만 풀린다", () => {
  // 점수가 0 이하로 내려가야 IWM 목표가 0이 되고, 그제야 초과분이 밴드를 넘습니다.
  const released = walk([WARMUP, SPIKE, [40, 0.156], [1, 0]]);

  assert.equal(released.weightOf("IWM"), 0);
  assert.equal(released.sellCount("IWM"), 1, "목표가 0이 된 첫 사이클에 한 번에 정리된다");

  // 즉 잠금이 풀리는 조건은 "신호가 약해짐"이 아니라 "신호가 부호를 바꿈"입니다.
  // 0과 0.156 사이 어디에 머물러도 6%는 그대로 남습니다.
  const stillStuck = walk([WARMUP, SPIKE, [40, 0.156], [40, 0.11]]);
  assert.ok(Math.abs(stillStuck.weightOf("IWM") - 0.06) < 0.0005);
  assert.equal(stillStuck.sellCount("IWM"), 0);
});

/**
 * ── 후보 세 개 ──────────────────────────────────────────────────────────
 *
 * 셋 다 잔여물을 없앱니다. 가르는 것은 **없애는 방식**입니다.
 *
 *  ⓐ MIN_POSITION_RATE   목표가 밴드보다 작으면 안 든다 → 목표 1.6%를 0으로 만든다
 *  ⓑ REBALANCE_EXIT_BAND 이탈 밴드만 좁힌다 → 모든 종목에 똑같이 걸린다
 *  ⓒ TARGET_DRIFT_CAP    보유가 목표의 n배를 넘으면 덜어낸다 → 작은 포지션에만 걸린다
 *
 * 여기서 재는 것은 "잔여물이 빠지는가"와 "신호가 진동할 때 무엇을 하는가"입니다.
 * 15년 회전율 대가는 `npm run backtest -- --compare bandshape`가 잽니다.
 */
const CANDIDATES = {
  "ⓐ 최소포지션": { MIN_POSITION_RATE: "0.05" },
  "ⓑ 이탈밴드": { REBALANCE_EXIT_BAND_RATE: "0.02" },
  // 배수 2인 이유는 §"큰 포지션의 밴드를 건드리지 않는다" 테스트에 있습니다.
  // 교차점 = 밴드 / (배수 − 1) 이므로 2에서만 교차점이 밴드 5%와 일치합니다.
  "ⓒ 목표대비": { TARGET_DRIFT_CAP: "2" },
};

test("세 후보 모두 잔여물을 없애지만, 목표를 따라가는 것은 ⓑ·ⓒ뿐이다", () => {
  const target = allocationForScore(0.156).IWM;

  for (const [name, env] of Object.entries(CANDIDATES)) {
    const after = walk([WARMUP, SPIKE, [40, 0.156]], env);
    assert.ok(after.weightOf("IWM") < 0.06, `${name}: 6% 잔여물이 남지 않는다`);
  }

  // ⓑ·ⓒ는 목표 1.6%에 정확히 안착합니다. 잔여물만 덜어내고 포지션은 유지합니다.
  for (const name of ["ⓑ 이탈밴드", "ⓒ 목표대비"]) {
    const after = walk([WARMUP, SPIKE, [40, 0.156]], CANDIDATES[name]);
    assert.ok(
      Math.abs(after.weightOf("IWM") - target) < 0.0005,
      `${name}: 목표 ${target}에 안착해야 한다 — 실제 ${after.weightOf("IWM")}`,
    );
  }

  // ⓐ는 전량 정리합니다. 잔여물은 없지만 목표 1.6%도 못 듭니다.
  // 오차 방향이 뒤집혔을 뿐 목표를 못 따라가는 것은 같습니다.
  const minPosition = walk([WARMUP, SPIKE, [40, 0.156]], CANDIDATES["ⓐ 최소포지션"]);
  assert.equal(minPosition.weightOf("IWM"), 0, "ⓐ는 목표가 밴드 미만이면 아예 안 든다");
});

test("ⓐ는 감성이 진동할 때 잔여물 대신 회전율을 만든다", () => {
  // 감성이 잡음이라면 이것이 실제 경로입니다. 점수가 0.6과 0.156을 오갈 때
  // IWM 목표는 6%와 1.6% 사이를 왕복합니다 — 밴드 5%를 계속 넘나듭니다.
  const oscillation = [WARMUP];
  for (let i = 0; i < 5; i += 1) oscillation.push([5, 0.6], [5, 0.156]);

  const current = walk(oscillation);
  const minPosition = walk(oscillation, CANDIDATES["ⓐ 최소포지션"]);
  const driftCap = walk(oscillation, CANDIDATES["ⓒ 목표대비"]);

  // 지금은 진동을 아예 무시합니다 — 한 번 사고 끝. 잔여물의 대가가 이것입니다.
  assert.equal(current.buyCount("IWM"), 1);
  assert.equal(current.sellCount("IWM"), 0);

  // ⓐ는 진동마다 전량 매수·전량 매도를 반복합니다. 목표가 밴드를 넘나들면
  // 0%와 6% 사이에만 머물 수 있어 중간이 없기 때문입니다.
  assert.equal(minPosition.buyCount("IWM"), 5, "ⓐ는 진동 횟수만큼 전량 매수한다");
  assert.equal(minPosition.sellCount("IWM"), 5, "ⓐ는 진동 횟수만큼 전량 매도한다");

  // ⓒ는 첫 진입 뒤 목표 근처에 머뭅니다. 잡음을 거래로 바꾸지 않습니다.
  assert.equal(driftCap.buyCount("IWM"), 1);
  assert.equal(driftCap.sellCount("IWM"), 1);
  assert.ok(
    driftCap.state.trades.length < minPosition.state.trades.length,
    "ⓒ의 총 체결이 ⓐ보다 적다",
  );
});

test("ⓒ는 큰 포지션의 밴드를 건드리지 않는다 — ⓑ와 갈리는 지점", () => {
  // VTI 목표 70%에 자산 대비 5% 밴드는 상대오차 7%지만,
  // IWM 목표 1.6%에 같은 밴드는 상대오차 312%입니다. 하나의 절대 문턱으로
  // 크기가 40배 다른 포지션을 같이 다룰 수 없다는 것이 문제의 뿌리입니다.
  const equityUsd = 67.03;
  const bandRate = 0.05;
  const absoluteBandUsd = bandRate * equityUsd;
  const driftCap = 2;

  // ⓒ의 이탈 문턱 = min(자산×5%, 목표×(배수−1)).
  // 두 항이 같아지는 지점이 교차점이고, 그 아래 목표에서만 상대 규칙이 이깁니다.
  //   목표 × (배수−1) = 자산 × 밴드  →  교차 비중 = 밴드 / (배수−1)
  // 배수 2에서 교차점은 정확히 밴드와 같은 5%가 됩니다. 즉 **목표 전체가 밴드
  // 안에 들어가는 종목만** 좁아집니다. 배수를 1.25로 두면 교차점이 20%로 올라가
  // SCHD(19.5%)까지 끌려들어옵니다 — 손대지 않기로 한 곳입니다.
  const crossoverWeight = bandRate / (driftCap - 1);
  assert.equal(crossoverWeight, bandRate);

  const thresholdFor = (weight) =>
    Math.max(1, Math.min(absoluteBandUsd, (driftCap - 1) * weight * equityUsd));

  // VTI·SCHD는 자산 대비 밴드가 여전히 먼저 걸립니다.
  // 2026-08-07 `--compare band`에서 0.05로 확정한 값이 그대로 남습니다.
  assert.equal(thresholdFor(0.7), absoluteBandUsd);
  assert.equal(thresholdFor(0.195), absoluteBandUsd);
  // IWM만 목표 대비 상한이 먼저 걸립니다.
  assert.ok(thresholdFor(0.016) < absoluteBandUsd);

  // ⓑ는 반대로 모든 종목의 문턱을 똑같이 내립니다. 확정된 5%까지 함께 좁아집니다.
  assert.ok(0.02 * equityUsd < absoluteBandUsd);
});
