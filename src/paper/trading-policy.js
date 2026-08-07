// 미국 정규장 6.5시간을 15분 주기로 도는 사이클 수입니다.
// 레짐 확정 기간을 "거래일"로 적고 여기서 사이클 수로 환산합니다.
const CYCLES_PER_SESSION = 26;

// .env에 별도 값이 없을 때 적용되는 보수적인 PAPER 기본값입니다.
const DEFAULTS = Object.freeze({
  tradingCurrency: "USD",
  maxOrderUsd: 5,
  minOrderUsd: 1,
  maxDailyBuyUsd: 10,
  maxTotalLossUsd: 10,
  maxDailyLossUsd: 3,
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
    // true를 명시한 경우에만 LIVE로 해석하지만, 현재 실행기는 LIVE 자체를 거부합니다.
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
