// 이 상수는 환경변수로 늘릴 수 없는 절대 상한입니다.
// 즉, 설정을 잘못 입력해도 PAPER 지갑 원금은 반드시 10만 원입니다.
export const ABSOLUTE_BUDGET_CAP_KRW = 100_000;

export function createUsdBudget(krwPerUsd, fundingKrw = ABSOLUTE_BUDGET_CAP_KRW) {
  if (fundingKrw !== ABSOLUTE_BUDGET_CAP_KRW) {
    throw new Error(`자동매매 초기 원금은 ${ABSOLUTE_BUDGET_CAP_KRW}원으로 고정됩니다.`);
  }

  const rate = decimalFraction(krwPerUsd, "krwPerUsd");
  // 정수 연산으로 달러 센트 단위에서 내림합니다. 부동소수점 반올림으로도
  // 최초 출금액이 100,000원을 넘을 수 없습니다.
  const fundedUsdCentsBigInt =
    (BigInt(fundingKrw) * rate.scale * 100n) / rate.numerator;
  const fundedUsdCents = Number(fundedUsdCentsBigInt);
  const fundedUsd = fundedUsdCents / 100;
  const fundedKrwActual = Number(fundedUsdCentsBigInt * rate.numerator) /
    Number(rate.scale * 100n);

  return Object.freeze({
    fundingKrw,
    krwPerUsd: Number(krwPerUsd),
    fundedUsd,
    fundedKrwActual,
    reserveKrw: fundingKrw - fundedKrwActual,
  });
}

function decimalFraction(value, name) {
  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`${name}는 양수여야 합니다.`);
  const fraction = match[2] ?? "";
  const numerator = BigInt(`${match[1]}${fraction}`);
  if (numerator <= 0n) throw new Error(`${name}는 양수여야 합니다.`);
  return { numerator, scale: 10n ** BigInt(fraction.length) };
}

export function sizePaperOrder({
  cashUsd,
  maxOrderUsd,
  minOrderUsd = 0.01,
  requestedUsd = maxOrderUsd,
}) {
  // 잔여 현금, 1회 주문 한도, 이번 요청액 중 가장 작은 금액만 사용합니다.
  // 센트 미만은 버려서 계산 과정에서 한도를 초과하지 않게 합니다.
  const cash = nonNegativeNumber(cashUsd, "cashUsd");
  const orderLimit = positiveNumber(maxOrderUsd, "maxOrderUsd");
  const minimum = positiveNumber(minOrderUsd, "minOrderUsd");
  const requested = positiveNumber(requestedUsd, "requestedUsd");
  const amountCents = Math.floor(Math.min(cash, orderLimit, requested) * 100);
  const amountUsd = amountCents / 100;
  return amountUsd >= minimum ? amountUsd : 0;
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name}는 양수여야 합니다.`);
  return number;
}

function nonNegativeNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name}는 0 이상이어야 합니다.`);
  return number;
}
