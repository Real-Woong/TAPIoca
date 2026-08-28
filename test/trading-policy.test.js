import test from "node:test";
import assert from "node:assert/strict";

import {
  formatLimits,
  formatStack,
  loadTradingPolicy,
  unvalidatedLayersInUse,
} from "../src/paper/trading-policy.js";

test("지수 ETF 기본값은 개별 종목용 청산 규칙을 켜지 않는다", () => {
  const policy = loadTradingPolicy({});
  assert.equal(policy.stopLossRate, 0.12);
  assert.equal(policy.trailingActivationRate, null);
  assert.equal(policy.trailingDrawdownRate, null);
  assert.equal(policy.maxHoldingDays, null);
});

test("청산 규칙은 값을 지정하면 켜지고 off로 다시 꺼진다", () => {
  const on = loadTradingPolicy({ MAX_HOLDING_DAYS: "15", TRAILING_DRAWDOWN_RATE: "0.015" });
  assert.equal(on.maxHoldingDays, 15);
  assert.equal(on.trailingDrawdownRate, 0.015);

  const off = loadTradingPolicy({ MAX_HOLDING_DAYS: "off", TRAILING_DRAWDOWN_RATE: "none" });
  assert.equal(off.maxHoldingDays, null);
  assert.equal(off.trailingDrawdownRate, null);
});

// 예전 기본값은 4사이클(=1시간)이었습니다. 월간 FRED 데이터로 만든 레짐에
// 1시간 확정은 사실상 무방비였습니다.
test("레짐 확정 기간을 거래일로 적으면 사이클 수로 환산한다", () => {
  assert.equal(loadTradingPolicy({}).regimeConfirmCycles, 26);
  assert.equal(loadTradingPolicy({ REGIME_CONFIRM_DAYS: "2" }).regimeConfirmCycles, 52);
  assert.equal(loadTradingPolicy({ REGIME_CONFIRM_DAYS: "0.5" }).regimeConfirmCycles, 13);
});

test("사이클 수를 직접 지정하면 거래일 환산보다 우선한다", () => {
  const policy = loadTradingPolicy({ REGIME_CONFIRM_CYCLES: "1", REGIME_CONFIRM_DAYS: "5" });
  assert.equal(policy.regimeConfirmCycles, 1);
});

test("잘못된 설정값은 조용히 기본값으로 넘어가지 않고 실패한다", () => {
  assert.throws(() => loadTradingPolicy({ MIN_ORDER_USD: "10", MAX_ORDER_USD: "5" }));
  assert.throws(() => loadTradingPolicy({ STOP_LOSS_RATE: "2" }), /0보다 크고 1 이하/);
  assert.throws(() => loadTradingPolicy({ MAX_HOLDING_DAYS: "1.5" }), /정수/);
});

test("한도 다섯 개를 한 줄로 찍는다 — .env가 이기는 값이라 로그가 유일한 확인이다", () => {
  // 원금과 달리 이 다섯은 .env 한 줄이면 조용히 달라지고 실행 로그에 흔적이
  // 없었다. 감성 가중치가 문서는 0인데 서버만 1이었던 2026-08-21과 같은 구조다.
  assert.equal(
    formatLimits(loadTradingPolicy({})),
    "1회 $6.7 (최소 $1) · 일일 매수 $13.4 · 총 손실 $6.7 · 일일 손실 $2 · 고정 원금 100,000 KRW",
  );
});

test("주문 한도 기본값을 못 박는다 — .env는 재배포 때 사라진다", () => {
  // 2026-08-28까지 서버 .env가 이 넷을 덮어쓰고 있었고 실행 로그에 흔적이
  // 없었다. 값을 여기로 옮긴 이유는 재배포가 조용히 옛 값으로 되돌리는 것을
  // 막기 위해서다. 지갑 $67.05의 10% · 20% · 10% · 3%다.
  const policy = loadTradingPolicy({});
  assert.equal(policy.maxOrderUsd, 6.7);
  assert.equal(policy.minOrderUsd, 1);
  assert.equal(policy.maxDailyBuyUsd, 13.4);
  assert.equal(policy.maxTotalLossUsd, 6.7);
  assert.equal(policy.maxDailyLossUsd, 2);
});

test("한도 줄은 .env 값을 그대로 비춘다 — 기본값을 찍으면 확인이 되지 않는다", () => {
  const line = formatLimits(loadTradingPolicy({ MAX_ORDER_USD: "20", MAX_DAILY_BUY_USD: "50" }));
  assert.match(line, /1회 \$20/);
  assert.match(line, /일일 매수 \$50/);
  // 원금은 .env로 못 바꾸므로 무엇을 넣어도 같은 값이다.
  assert.match(formatLimits(loadTradingPolicy({ TRADING_BUDGET_KRW: "999" })), /100,000 KRW/);
});


/**
 * 거시 층 가중치의 운영 기본값입니다.
 *
 * 2026-08-08 결정: 0. 근거는 STRATEGY.md ⑨⑩입니다. 기본값을 코드에 박은 이유는
 * `.env` 한 줄에 의존하면 재배포 때 사라질 수 있기 때문입니다 —
 * `TARGET_DRIFT_CAP`을 채택할 때와 같은 방식입니다.
 *
 * `paper-runner.js`는 최상위에서 실행되는 스크립트라 테스트에서 import할 수
 * 없습니다. 그래서 소스를 읽어 기본값을 확인합니다. 값을 바꾸면 이 테스트가
 * 먼저 깨지므로, 결정이 조용히 뒤집히지 않습니다.
 */
test("거시 가중치의 운영 기본값은 0이다", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile("src/paper/paper-runner.js", "utf8");
  const match = /function readMacroWeight\(value\) \{\s*\n\s*if \(value === undefined \|\| value === ""\) return (\d+)/
    .exec(source);

  assert.ok(match, "readMacroWeight의 기본값을 찾지 못했다");
  assert.equal(match[1], "0", "거시 층은 배분에 관여하지 않는다(2026-08-08 결정)");
});

/**
 * 감성 층 가중치의 운영 기본값입니다.
 *
 * 2026-08-08: 0. **거시와 달리 최종 결정이 아니라 판정 전까지의 보류**입니다.
 * 8/20의 10거래일 판정은 자기상관 0.140 — 표본의 표준오차가 판정표를 덮어
 * 아무것도 가르지 못했습니다. **60거래일(2026-10-30)에 한 번 더 판정하고 끝냅니다.**
 * 그때 또 0.1~0.3이면 연장 없이 0으로 확정합니다(STRATEGY.md §3 ②).
 */
test("감성 가중치의 운영 기본값은 판정 전까지 0이다", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile("src/paper/paper-runner.js", "utf8");
  const match = /function readSentimentWeight\(value\) \{\s*\n\s*if \(value === undefined \|\| value === ""\) return (\d+)/
    .exec(source);

  assert.ok(match, "readSentimentWeight의 기본값을 찾지 못했다");
  assert.equal(match[1], "0", "미검증 층은 매매를 바꾸지 않는다(2026-08-08, 판정 전까지)");
});

// 2026-08-21: 문서·README·코드 기본값·아래 테스트가 전부 감성 가중치를 0이라고
// 적고 있었는데 **운영 서버의 .env만 1**이었다. 사흘치 일일 보고서의 통합 점수가
// 정확히 `추세 기여 + 감성 기여`였다 — 0.976 + (−0.228) = 0.748. 미검증 층이
// 목표 현금을 3.5%→5.0%로 밀고 있었다.
//
// **소스의 기본값을 검사하는 것으로는 이것을 잡을 수 없다.** 실제로 도는 값은
// .env에서 온다. 그래서 실행 중인 스택을 보는 관문을 따로 둔다.
test("미검증 층이 켜져 있으면 실행 중인 스택에서 드러난다", () => {
  const running = { macroWeight: 0, sentimentWeight: 1, trendWeight: 1, macdWeight: 0, volTarget: 0.15 };
  const inUse = unvalidatedLayersInUse(running);
  assert.equal(inUse.length, 1);
  assert.equal(inUse[0].env, "SENTIMENT_SCORE_WEIGHT");

  // 판정이 끝날 때까지 실제 돈을 움직일 수 있는 스택은 이것뿐이다.
  assert.deepEqual(
    unvalidatedLayersInUse({ ...running, sentimentWeight: 0 }),
    [],
  );
});

test("스택 한 줄에 가중치가 전부 보인다 — 기여도만으로는 못 본다", () => {
  const line = formatStack({
    macroWeight: 0, sentimentWeight: 0, trendWeight: 1, macdWeight: 0, volTarget: 0.15,
  });
  assert.equal(line, "거시 0 · 감성 0 · 추세 1 · MACD 0 · volTarget 0.15");
});
