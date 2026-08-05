/**
 * 결정론적 합성 일봉 생성기입니다.
 *
 * 무료 일봉 소스(Yahoo·Stooq)가 자주 막히기 때문에, 백테스터가 실데이터 없이도
 * 항상 돌아가야 합니다. 여기서 만드는 경로는 "신호가 수익을 예측하는가"를 재는
 * 용도가 아닙니다. 그건 실데이터로만 잴 수 있습니다. 이 경로의 용도는
 * **경로 의존 규칙의 기계적 성질**을 재는 것입니다. 손절·보유기간·무거래 밴드·
 * 거래비용·재투입 대칭성은 수익 예측력과 무관하게 경로만으로 손익이 갈립니다.
 */

/** mulberry32. 시드가 같으면 언제 어디서 돌려도 같은 수열을 만듭니다. */
export function createRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller로 균등난수 두 개를 표준정규 하나로 바꿉니다. */
function gaussian(random) {
  const u = Math.max(random(), Number.MIN_VALUE);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const DEFAULT_PATH_OPTIONS = Object.freeze({
  days: 1500,
  startPrice: 100,
  annualDrift: 0.08,
  annualVol: 0.16,
  tradingDays: 252,
  // 직전 수익률을 다음 수익률에 얼마나 되먹일지. 양수면 추세(모멘텀),
  // 음수면 평균회귀입니다. 추세 필터는 두 국면에서 정반대로 동작하므로
  // 둘 다 돌려봐야 규칙의 성질이 보입니다.
  autocorrelation: 0,
  // [{ startDay, days, annualDrift, annualVol }] 형태의 국면 스크립트입니다.
  // 하락장과 회복장을 명시적으로 심어 규칙이 어디서 돈을 잃는지 재현합니다.
  shocks: [],
});

/** 하루치 파라미터를 국면 스크립트에서 찾습니다. 겹치면 마지막 것이 이깁니다. */
function paramsForDay(day, options) {
  let drift = options.annualDrift;
  let vol = options.annualVol;
  for (const shock of options.shocks) {
    const start = Number(shock.startDay);
    const end = start + Number(shock.days);
    if (day >= start && day < end) {
      if (shock.annualDrift !== undefined) drift = Number(shock.annualDrift);
      if (shock.annualVol !== undefined) vol = Number(shock.annualVol);
    }
  }
  return { drift, vol };
}

/** 종가 하나의 경로를 만듭니다. 반환은 오래된 순 배열입니다. */
export function generatePath(seed, overrides = {}) {
  const options = { ...DEFAULT_PATH_OPTIONS, ...overrides };
  const random = createRandom(seed);
  const dt = 1 / options.tradingDays;
  const closes = [];
  let price = options.startPrice;
  let previousReturn = 0;

  for (let day = 0; day < options.days; day += 1) {
    const { drift, vol } = paramsForDay(day, options);
    const shock = gaussian(random) * vol * Math.sqrt(dt);
    // 기하 브라운 운동에 직전 수익률 되먹임을 더합니다.
    const logReturn =
      (drift - (vol * vol) / 2) * dt + shock + options.autocorrelation * previousReturn;
    previousReturn = logReturn;
    price *= Math.exp(logReturn);
    closes.push(round(price));
  }
  return closes;
}

/**
 * 여러 종목의 상관 있는 경로를 만듭니다.
 * VTI–SCHD 상관은 실제로 0.85 이상이므로, 공통 시장 요인에 종목 고유 잡음을 섞습니다.
 */
export function generateMarket(seed, symbols, overrides = {}) {
  const options = { ...DEFAULT_PATH_OPTIONS, ...overrides };
  const market = generatePath(seed, options);
  const closesBySymbol = {};

  for (const [index, symbol] of symbols.entries()) {
    if (index === 0) {
      closesBySymbol[symbol] = market;
      continue;
    }
    // 시장 요인 85% + 고유 요인 15%로 섞어 상관 0.85 수준을 만듭니다.
    const idiosyncratic = generatePath(seed + 1000 * (index + 1), {
      ...options,
      annualDrift: options.annualDrift * 0.8,
    });
    closesBySymbol[symbol] = blendPaths(market, idiosyncratic, 0.85, options.startPrice);
  }
  return closesBySymbol;
}

/** 두 경로의 로그수익률을 비율대로 섞어 새 경로를 만듭니다. */
function blendPaths(first, second, weight, startPrice) {
  const closes = [];
  let price = startPrice;
  for (let index = 1; index < first.length; index += 1) {
    const a = Math.log(first[index] / first[index - 1]);
    const b = Math.log(second[index] / second[index - 1]);
    price *= Math.exp(weight * a + (1 - weight) * b);
    closes.push(round(price));
  }
  // 첫날 종가를 앞에 붙여 길이를 원본과 맞춥니다.
  return [round(startPrice), ...closes];
}

/** 백테스트 리포트에 찍을 거래일 배열을 만듭니다. 주말은 건너뜁니다. */
export function generateTradingDates(count, startIso = "2020-01-02T21:00:00Z") {
  const dates = [];
  const cursor = new Date(startIso);
  while (dates.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}
