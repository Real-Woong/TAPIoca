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
  // 레짐이 이 횟수만큼 연속으로 유지돼야 목표 비중을 바꿉니다(15분 주기 × 4 = 1시간).
  // 뉴스 감성이 장중에 뒤집힐 때마다 주식 비중이 40%↔70%로 튀던 문제를 막습니다.
  regimeConfirmCycles: 4,
  // 같은 레짐에서 하루에 허용하는 리밸런싱 매도 횟수입니다.
  // 레짐이 실제로 바뀌면 이 한도와 무관하게 방어 매도를 즉시 허용합니다.
  maxRebalancesPerDay: 1,
  // 체결 1건마다 부과하는 거래비용(수수료+FX 스프레드+슬리피지 가정, 편도 비율).
  // 실제 손익을 정직하게 만들기 위한 보수적 가정값이며 실측으로 보정해야 합니다.
  tradeCostRate: 0.001,
  reentryCooldownHours: 24,
  stopLossRate: 0.03,
  trailingActivationRate: 0.025,
  trailingDrawdownRate: 0.015,
  maxHoldingDays: 15,
});

export function loadTradingPolicy(env = process.env) {
  const maxOrderUsd = readPositive(env.MAX_ORDER_USD, DEFAULTS.maxOrderUsd);
  const minOrderUsd = readPositive(env.MIN_ORDER_USD, DEFAULTS.minOrderUsd);
  if (minOrderUsd > maxOrderUsd) {
    throw new Error("MIN_ORDER_USD는 MAX_ORDER_USD보다 클 수 없습니다.");
  }

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
    rebalanceBandRate: readRate(env.REBALANCE_BAND_RATE, DEFAULTS.rebalanceBandRate),
    regimeConfirmCycles: readPositiveInteger(
      env.REGIME_CONFIRM_CYCLES,
      DEFAULTS.regimeConfirmCycles,
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
    trailingActivationRate: readRate(
      env.TRAILING_ACTIVATION_RATE,
      DEFAULTS.trailingActivationRate,
    ),
    trailingDrawdownRate: readRate(env.TRAILING_DRAWDOWN_RATE, DEFAULTS.trailingDrawdownRate),
    maxHoldingDays: readPositiveInteger(env.MAX_HOLDING_DAYS, DEFAULTS.maxHoldingDays),
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

function readPositiveInteger(value, fallback) {
  const number = readPositive(value, fallback);
  if (!Number.isInteger(number)) throw new Error(`정수 설정값이 필요합니다: ${value}`);
  return number;
}
