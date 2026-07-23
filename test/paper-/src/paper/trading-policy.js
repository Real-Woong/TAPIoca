// .env에 별도 값이 없을 때 적용되는 보수적인 PAPER 기본값입니다.
const DEFAULTS = Object.freeze({
  tradingCurrency: "USD",
  maxOrderUsd: 5,
  minOrderUsd: 1,
  maxDailyBuyUsd: 10,
  maxTotalLossUsd: 10,
  maxDailyLossUsd: 3,
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

function readPositiveInteger(value, fallback) {
  const number = readPositive(value, fallback);
  if (!Number.isInteger(number)) throw new Error(`정수 설정값이 필요합니다: ${value}`);
  return number;
}
