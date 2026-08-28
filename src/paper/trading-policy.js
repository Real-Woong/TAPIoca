// 미국 정규장 6.5시간을 15분 주기로 도는 사이클 수입니다.
// 레짐 확정 기간을 "거래일"로 적고 여기서 사이클 수로 환산합니다.
const CYCLES_PER_SESSION = 26;

// .env에 별도 값이 없을 때 적용되는 보수적인 PAPER 기본값입니다.
const DEFAULTS = Object.freeze({
  tradingCurrency: "USD",
  // ── 주문 한도 (2026-08-28에 `.env`에서 여기로 옮김) ──────────────────────
  //
  // **서버 `.env`가 이 넷을 덮어쓰고 있었고 실행 로그에 흔적이 없었습니다.**
  // 배너(`formatLimits`)를 켠 첫 실행에서 드러났습니다 — 문서는 5/10/10/3이라고
  // 적고 있었는데 서버는 6.7/13.4/6.7/2로 돌고 있었습니다. 감성 가중치가 문서는
  // 0인데 서버만 1이었던 2026-08-21과 같은 구조입니다.
  //
  // **값은 지갑($67.05)의 비율로 잡혀 있었습니다** — 10% · 20% · 10% · 3%.
  // 그것이 의도한 값이므로 `.env`를 지우고 기본값으로 박습니다. **`.env` 한 줄은
  // 재배포 때 사라지고, 그러면 한도가 조용히 예전 값으로 돌아갑니다.**
  // 고정은 test/trading-policy.test.js가 합니다.
  //
  // 비율이 아니라 달러로 적는 이유는, 지갑이 커질 때 한도가 **따라 커지면 안
  // 되기 때문**입니다. 증액은 다섯 관문을 통과한 뒤의 명시적 커밋이지
  // 부수 효과가 아닙니다(§ 원금 증액의 관문).
  maxOrderUsd: 6.7,
  minOrderUsd: 1,
  maxDailyBuyUsd: 13.4,
  // 아래 둘은 매매를 멈추지 않습니다. `evaluateRiskLimits`가 alert만 세우고
  // 텔레그램에 한 줄 냅니다(`paper-engine.js`). 한도가 걸리는 것은 정의상 폭락
  // 중인데, 그때는 목표 비중 층이 이미 익스포저를 줄이고 있습니다.
  //
  // **총 손실 $6.7은 지갑의 10%이고 백테스트 MDD는 29.9%입니다.** 정상 낙폭에서
  // 경고가 뜬다는 뜻입니다 — 위험이 아니라 소음입니다. 넓힐 값이지만 그것은
  // 백테스트로 재고 정할 일이라 지금은 서버가 돌던 값을 그대로 옮깁니다.
  maxTotalLossUsd: 6.7,
  maxDailyLossUsd: 2,
  // 목표 비중에서 자산 대비 이 비율 이상 벗어난 ETF만 매매합니다(잔챙이 매매 방지).
  // 매도에만 걸려 있던 밴드를 매수에도 대칭으로 적용합니다. 예전에는 매수가 결손
  // $1에서 트리거돼, 15분마다 매수와 리밸런싱 매도가 서로를 되돌렸습니다.
  rebalanceBandRate: 0.05,
  // ── 밴드의 방향 비대칭을 고치는 세 손잡이입니다. 셋 다 기본값이 "끔"이라
  // 아무것도 지정하지 않으면 위 대칭 밴드가 그대로 동작합니다.
  //
  // 밴드는 크기가 대칭인데 효과는 대칭이 아닙니다. 진입은 목표 전체가 결손이라
  // 밴드를 넘지만, 되돌아올 때는 목표가 내려간 만큼만 초과분이라 밴드에 못 미칩니다.
  // 그래서 신호가 한 번 튀어 세운 포지션이 신호가 되돌아와도 남습니다.
  // 재현: test/rebalance-band-ratchet.test.js
  //
  // ⓑ 매도 쪽 밴드만 좁힙니다. null이면 매수와 같은 값을 씁니다.
  rebalanceExitBandRate: null,
  // ⓒ **초과분**이 목표의 이 배수를 넘으면 덜어냅니다. 자산 대비 밴드와 함께
  //    걸리며 둘 중 좁은 쪽이 이깁니다. 큰 포지션에서는 자산 대비 밴드가,
  //    작은 포지션에서는 이 비율이 먼저 걸립니다. null이면 끕니다.
  //
  //    기준은 보유액이 아니라 초과분입니다(`exitBand()`). 배수 2는
  //    "보유 ≥ 목표 × 3"이고, 이쪽이 먼저 걸리는 교차점은 **밴드 / 배수 = 2.5%**
  //    입니다. 즉 목표가 자산의 2.5% 아래인 종목만 좁아지고 VTI·SCHD는 확정된
  //    5% 밴드 그대로입니다. 실측 발동 경계는 목표 2% 부근입니다
  //    (test/rebalance-band-ratchet.test.js).
  targetDriftCap: 2,
  // ⓐ 목표 비중이 이 값보다 작으면 아예 0으로 봅니다. 밴드보다 작은 목표는
  //    어차피 밴드 안이라 도달할 수도 유지할 수도 없으므로, 들지 않기로 정합니다.
  //    null이면 끕니다.
  minPositionRate: null,
  // 레짐 확정에 필요한 거래일 수입니다. 예전 기본값은 4사이클(=1시간)이었는데,
  // 월간 FRED 데이터로 만든 레짐에 1시간 확정은 사실상 무방비였습니다.
  // 이제는 하루 단위로 세고, 사이클 수는 세션 길이에서 환산합니다.
  regimeConfirmDays: 1,
  // 같은 레짐에서 하루에 허용하는 리밸런싱 매도 횟수입니다.
  // 레짐이 실제로 바뀌면 이 한도와 무관하게 방어 매도를 즉시 허용합니다.
  maxRebalancesPerDay: 1,
  // 체결 1건마다 부과하는 거래비용(수수료+FX 스프레드+슬리피지 가정, 편도 비율).
  // 실제 손익을 정직하게 만들기 위한 보수적 가정값이며 실측으로 보정해야 합니다.
  tradeCostRate: 0.001,
  reentryCooldownHours: 24,
  // 아래 청산 규칙은 개별 종목 모멘텀 매매용 값이었고, 광역 지수 ETF에는 맞지 않습니다.
  // VTI의 연율 변동성 15%는 일변동 약 0.95%라, 3% 손절과 1.5% 트레일링은 노이즈에
  // 그대로 걸립니다. 실제로 07-29 MAX_HOLDING_PERIOD가 VTI 전량을, 07-30
  // TRAILING_PROFIT이 SCHD 전량을 팔아 목표 비중 90% 구간에서 주식 15%까지 내려갔고,
  // 그 뒤 4일 랠리를 통째로 놓쳤습니다. 배분 레이어와 청산 레이어가 싸운 결과입니다.
  // 손절은 재난 방어용으로만 남기고 나머지는 명시적으로 켤 때만 동작합니다.
  stopLossRate: 0.12,
  // 손절선을 연율 변동성의 배수로 잡습니다. null이면 위 고정 비율을 씁니다.
  //
  // Kaminski & Lo(2014)는 손절 문턱을 표준편차 −1.5σ ~ −0.5σ로 설정합니다.
  // 고정 비율은 변동성에 반비례해 잘못 스케일됩니다. 12%는 연율 변동성 14%에서
  // 0.85σ지만 40%짜리 폭락장에서는 0.30σ가 되어, 가장 팔면 안 되는 순간에
  // 가장 쉽게 발동합니다. 기본값은 null입니다 — 백테스트로 재기 전에는 바꾸지 않습니다.
  stopLossSigma: null,
  trailingActivationRate: null,
  trailingDrawdownRate: null,
  maxHoldingDays: null,
});

export function loadTradingPolicy(env = process.env) {
  const maxOrderUsd = readPositive(env.MAX_ORDER_USD, DEFAULTS.maxOrderUsd);
  const minOrderUsd = readPositive(env.MIN_ORDER_USD, DEFAULTS.minOrderUsd);
  if (minOrderUsd > maxOrderUsd) {
    throw new Error("MIN_ORDER_USD는 MAX_ORDER_USD보다 클 수 없습니다.");
  }
  const rebalanceBandRate = readRate(env.REBALANCE_BAND_RATE, DEFAULTS.rebalanceBandRate);

  return Object.freeze({
    // true를 명시한 경우에만 LIVE로 해석합니다. **2026-08-19부터 실행기가 이것을
    // 받아 실주문을 냅니다** — 그전까지는 거부했습니다(`paper-runner.js`).
    // 미검증 층이 켜져 있으면 그 앞에서 멈춥니다(`unvalidatedLayersInUse`).
    mode: env.LIVE_TRADING === "true" ? "LIVE" : "PAPER",
    assetType: "ETF",
    tradingCurrency: env.TRADING_CURRENCY || DEFAULTS.tradingCurrency,
    // 총 원금과 기존 보유분 보호는 환경변수로 변경할 수 없는 안전장치입니다.
    tradingBudgetKrw: 100_000,
    maxOrderUsd,
    minOrderUsd,
    maxDailyBuyUsd: readPositive(env.MAX_DAILY_BUY_USD, DEFAULTS.maxDailyBuyUsd),
    maxTotalLossUsd: readPositive(env.MAX_TOTAL_LOSS_USD, DEFAULTS.maxTotalLossUsd),
    maxDailyLossUsd: readPositive(env.MAX_DAILY_LOSS_USD, DEFAULTS.maxDailyLossUsd),
    rebalanceBandRate,
    // 지정하지 않으면 매수 밴드와 같은 값이라 대칭 밴드가 그대로 재현됩니다.
    rebalanceExitBandRate: readRate(env.REBALANCE_EXIT_BAND_RATE, rebalanceBandRate),
    targetDriftCap: readOptional(env.TARGET_DRIFT_CAP, DEFAULTS.targetDriftCap, readPositive),
    minPositionRate: readOptional(env.MIN_POSITION_RATE, DEFAULTS.minPositionRate, readRate),
    // 사이클 수를 직접 지정하면 그것이 이깁니다(테스트와 일봉 백테스트가 씁니다).
    // 지정하지 않으면 거래일 수를 세션당 사이클 수로 환산합니다.
    regimeConfirmCycles: env.REGIME_CONFIRM_CYCLES
      ? readPositiveInteger(env.REGIME_CONFIRM_CYCLES, 1)
      : Math.round(
          readPositive(env.REGIME_CONFIRM_DAYS, DEFAULTS.regimeConfirmDays) * CYCLES_PER_SESSION,
        ),
    maxRebalancesPerDay: readPositiveInteger(
      env.MAX_REBALANCES_PER_DAY,
      DEFAULTS.maxRebalancesPerDay,
    ),
    tradeCostRate: readNonNegativeRate(env.TRADE_COST_RATE, DEFAULTS.tradeCostRate),
    reentryCooldownHours: readPositiveInteger(
      env.REENTRY_COOLDOWN_HOURS,
      DEFAULTS.reentryCooldownHours,
    ),
    stopLossRate: readRate(env.STOP_LOSS_RATE, DEFAULTS.stopLossRate),
    stopLossSigma: readOptional(env.STOP_LOSS_SIGMA, DEFAULTS.stopLossSigma, readPositive),
    trailingActivationRate: readOptionalRate(
      env.TRAILING_ACTIVATION_RATE,
      DEFAULTS.trailingActivationRate,
    ),
    trailingDrawdownRate: readOptionalRate(
      env.TRAILING_DRAWDOWN_RATE,
      DEFAULTS.trailingDrawdownRate,
    ),
    maxHoldingDays: readOptional(
      env.MAX_HOLDING_DAYS,
      DEFAULTS.maxHoldingDays,
      readPositiveInteger,
    ),
    allowSellExisting: false,
  });
}

function readPositive(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`양수 설정값이 필요합니다: ${value}`);
  return number;
}

function readRate(value, fallback) {
  const number = readPositive(value, fallback);
  if (number > 1) throw new Error(`비율 설정값은 0보다 크고 1 이하여야 합니다: ${value}`);
  return number;
}

// 거래비용처럼 0(비용 없음)을 허용해야 하는 0~1 비율 설정값 리더입니다.
function readNonNegativeRate(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`비율 설정값은 0 이상 1 이하여야 합니다: ${value}`);
  }
  return number;
}

// 끌 수 있는 설정값 리더입니다. "off"는 그 규칙 자체를 비활성으로 만듭니다.
// 기본값이 null인 규칙은 .env에 값을 적어야만 켜집니다.
function readOptional(value, fallback, reader) {
  if (value === undefined || value === "") return fallback;
  if (value === "off" || value === "none") return null;
  return reader(value, fallback);
}

function readOptionalRate(value, fallback) {
  return readOptional(value, fallback, readRate);
}

function readPositiveInteger(value, fallback) {
  const number = readPositive(value, fallback);
  if (!Number.isInteger(number)) throw new Error(`정수 설정값이 필요합니다: ${value}`);
  return number;
}

/**
 * **아직 판정하지 않은 층입니다.** 여기 있는 동안은 실제 돈을 움직일 수 없습니다.
 *
 * 감성 층은 백테스트에 넣을 수 없어(수집창이 지나가면 복원되지 않는다) 운영
 * 로그로만 판정 중이고, 그 판정일은 2026-10-30이다 — `STRATEGY.md` §3 ②.
 */
export const UNVALIDATED_LAYERS = Object.freeze([
  Object.freeze({
    key: "sentiment",
    env: "SENTIMENT_SCORE_WEIGHT",
    label: "감성",
    why: "2026-10-30 자기상관 판정 전까지 보류 (STRATEGY.md §3 ②·§5-1)",
  }),
]);

/**
 * 실행 중인 스택을 한 줄로 만듭니다. **매 실행마다 찍습니다.**
 *
 * 2026-08-21에 이 한 줄이 없어서 놓친 것이 있습니다. `STRATEGY.md`·`README.md`·
 * 코드 기본값·테스트가 전부 감성 가중치를 **0**이라고 적고 있었는데 **운영 서버의
 * `.env`만 1**이었습니다. 일일 보고서는 기여도(`뉴스 감성 -0.228`)만 찍고 가중치는
 * 찍지 않았고, 기여도가 0이 아닌 것은 정상 동작처럼 보였습니다.
 *
 * **기여도는 층이 무엇을 했는지 말해 주지만, 그 층이 켜져 있어도 되는지는 말해
 * 주지 않습니다.** 08-18~20 사흘 동안 미검증 층이 목표 현금을 3.5%→5.0%로
 * 밀고 있었고, 아무도 몰랐습니다.
 */
export function formatStack(stack = {}) {
  return (
    `거시 ${stack.macroWeight} · 감성 ${stack.sentimentWeight} · ` +
    `추세 ${stack.trendWeight} · MACD ${stack.macdWeight} · volTarget ${stack.volTarget}`
  );
}

/**
 * 주문 한도 다섯 개를 한 줄로 냅니다.
 *
 * **원금과 달리 이 다섯은 `.env`가 이깁니다.** `tradingBudgetKrw`는 상수라
 * 코드를 고치지 않으면 못 바꾸는데, 아래 다섯은 `.env` 한 줄이면 조용히
 * 달라지고 실행 로그에는 아무 흔적도 남지 않았습니다. 문서에 적힌 값이 서버에서
 * 참인지 확인할 방법이 없다는 뜻입니다 — 감성 가중치가 문서는 0인데 서버만
 * 1이었던 2026-08-21과 같은 구조의 사각지대입니다.
 *
 * 막지 않고 찍기만 합니다. 총 노출은 지갑에 묶여 있어 안전하고, 이 다섯이
 * 정하는 것은 얼마나 빨리 쓰느냐입니다.
 */
export function formatLimits(policy = {}) {
  return (
    `1회 $${policy.maxOrderUsd} (최소 $${policy.minOrderUsd}) · ` +
    `일일 매수 $${policy.maxDailyBuyUsd} · ` +
    `총 손실 $${policy.maxTotalLossUsd} · 일일 손실 $${policy.maxDailyLossUsd} · ` +
    `고정 원금 ${policy.tradingBudgetKrw?.toLocaleString("en-US")} KRW`
  );
}

/**
 * 켜져 있으면 안 되는 층이 켜져 있는지 봅니다.
 *
 * **가중치 0은 "층을 지운다"가 아닙니다.** 점수는 계속 계산되고 이벤트 로그에
 * 남으므로 판정 표본은 그대로 쌓입니다(`market-signal.js`). 0은 **그 값이 배분에
 * 관여하지 않는다**는 뜻뿐입니다. 그래서 판정 전까지 0으로 두는 데 드는 비용이
 * 없습니다 — 켜 둘 이유도 없다는 뜻입니다.
 */
export function unvalidatedLayersInUse(stack = {}) {
  return UNVALIDATED_LAYERS.filter((layer) => {
    const weight = Number(stack[`${layer.key}Weight`]);
    return Number.isFinite(weight) && weight !== 0;
  });
}
