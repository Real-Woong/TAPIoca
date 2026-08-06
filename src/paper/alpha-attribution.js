import { readPaperEvents } from "./event-log.js";

// alpha가 왜 마이너스인지를 "설계된 차이"와 "결함으로 인한 이탈"로 가릅니다.
//
// 리포트는 alpha 한 숫자만 보여줍니다. 그 숫자만으로는 현금을 일부러 들고 있어서
// 뒤처진 것인지, 목표 비중을 못 채워서 뒤처진 것인지 구분할 수 없습니다. 앞은
// 위험을 줄이려고 낸 비용이고 뒤는 고쳐야 할 버그입니다. 대응이 정반대입니다.
//
// 사이클마다 이렇게 나눕니다(벤치마크는 VTI 100% 매수후보유):
//
//   전략수익률 − 벤치수익률
//     = (목표주식비중 − 1) × 벤치수익률      … 구조적 현금 드래그 (설계)
//     + (실제주식비중 − 목표주식비중) × 벤치수익률  … 목표 미달 (결함)
//     + 나머지                                  … 종목 선택 + 거래비용 + 구간내 매매
//
// 비중은 구간이 **시작될 때** 것을 씁니다. 구간 도중에 대량 매도가 일어나면 그
// 손익은 이탈이 아니라 나머지로 흘러갑니다. 즉 나머지 항목은 순수한 종목 선택이
// 아니라 "구간 안에서 벌어진 일" 전부를 담습니다. 지속적인 목표 미달만 이탈로
// 잡히므로, 하루짜리 급매도는 이 분해로 원인을 특정할 수 없습니다.
//
// 세 항 모두 벤치수익률에 비례합니다. 즉 **현금을 들고 있어도 시장이 내리면
// 이득**입니다. 부호가 항상 마이너스로 나온다면 그건 시장이 올랐기 때문입니다.

/** 이벤트 한 쌍(t-1 → t)에서 초과수익을 세 항으로 나눕니다. */
function attributeStep(previous, current) {
  const beginEquity = Number(previous.equityUsd);
  const endEquity = Number(current.equityUsd);
  const beginBench = Number(previous.benchmark?.valueUsd);
  const endBench = Number(current.benchmark?.valueUsd);
  if (!(beginEquity > 0) || !(beginBench > 0)) return null;
  if (!Number.isFinite(endEquity) || !Number.isFinite(endBench)) return null;

  const benchReturn = endBench / beginBench - 1;
  const strategyReturn = endEquity / beginEquity - 1;

  // 실제 주식 비중은 직전 시점 기준입니다. 이번 구간의 손익을 낳은 것은
  // 구간이 끝난 뒤의 비중이 아니라 구간을 시작할 때 들고 있던 비중입니다.
  const actualEquityWeight = Number(previous.marketValueUsd) / beginEquity;
  const targetCash = Number(previous.targetAllocation?.CASH);
  // 목표가 기록되지 않은 사이클은 이탈을 0으로 두어 결함으로 오인하지 않습니다.
  const targetEquityWeight = Number.isFinite(targetCash) ? 1 - targetCash : actualEquityWeight;

  const structural = (targetEquityWeight - 1) * benchReturn;
  const shortfall = (actualEquityWeight - targetEquityWeight) * benchReturn;
  const excess = strategyReturn - benchReturn;

  return {
    at: current.at,
    beginEquity,
    benchReturn,
    strategyReturn,
    actualEquityWeight,
    targetEquityWeight,
    // 금액 기준으로 바꿔야 구간별 크기를 비교할 수 있습니다.
    structuralUsd: structural * beginEquity,
    shortfallUsd: shortfall * beginEquity,
    residualUsd: (excess - structural - shortfall) * beginEquity,
    excessUsd: excess * beginEquity,
  };
}

/**
 * 전체 기간의 alpha를 항목별로 나눕니다.
 *
 * 항목의 합은 실제 alpha와 정확히 같지 않습니다. 전략은 자기 자산 위에서,
 * 벤치마크는 자기 자산 위에서 각각 복리로 불어나기 때문입니다. 그 차이를
 * 숨기지 않고 `compoundingUsd`로 따로 보고합니다. 이 값이 다른 항목만큼
 * 커지면 분해 자체를 신뢰하면 안 된다는 신호입니다.
 */
export function attributeAlpha(events) {
  const usable = events.filter(
    (event) => Number.isFinite(Number(event?.equityUsd)) && event?.benchmark,
  );
  if (usable.length < 2) {
    return { steps: [], totals: null, sampleSize: usable.length };
  }

  const steps = [];
  for (let index = 1; index < usable.length; index += 1) {
    const step = attributeStep(usable[index - 1], usable[index]);
    if (step) steps.push(step);
  }

  const first = usable[0];
  const last = usable[usable.length - 1];
  const alphaUsd = (Number(last.equityUsd) - Number(first.equityUsd))
    - (Number(last.benchmark.valueUsd) - Number(first.benchmark.valueUsd));

  const structuralUsd = sum(steps, "structuralUsd");
  const shortfallUsd = sum(steps, "shortfallUsd");
  const residualUsd = sum(steps, "residualUsd");

  // 거래비용은 로그에 누적치가 있으므로 나머지에서 떼어내 종목 선택만 남깁니다.
  // 나머지 = 종목선택 − 비용 이므로, 종목선택 = 나머지 + 비용입니다.
  const feesUsd = Number(last.feesUsd ?? 0) - Number(first.feesUsd ?? 0);

  return {
    sampleSize: usable.length,
    from: first.at,
    to: last.at,
    alphaUsd: round(alphaUsd),
    totals: {
      structuralUsd: round(structuralUsd),
      shortfallUsd: round(shortfallUsd),
      selectionAndCostUsd: round(residualUsd),
      feesUsd: round(feesUsd),
      selectionUsd: round(residualUsd + feesUsd),
      compoundingUsd: round(alphaUsd - structuralUsd - shortfallUsd - residualUsd),
    },
    steps,
  };
}

/** 이탈이 가장 컸던 구간을 골라냅니다. 붕괴가 한 시점에 몰렸는지 보려는 것입니다. */
export function worstShortfallDays(steps, limit = 5) {
  const byDay = new Map();
  for (const step of steps) {
    const day = step.at.slice(0, 10);
    const entry = byDay.get(day) ?? { day, shortfallUsd: 0, structuralUsd: 0, excessUsd: 0 };
    entry.shortfallUsd += step.shortfallUsd;
    entry.structuralUsd += step.structuralUsd;
    entry.excessUsd += step.excessUsd;
    byDay.set(day, entry);
  }
  return [...byDay.values()]
    .sort((a, b) => a.excessUsd - b.excessUsd)
    .slice(0, limit)
    .map((entry) => ({
      day: entry.day,
      shortfallUsd: round(entry.shortfallUsd),
      structuralUsd: round(entry.structuralUsd),
      excessUsd: round(entry.excessUsd),
    }));
}

function sum(steps, key) {
  return steps.reduce((total, step) => total + step[key], 0);
}

function round(value) {
  const rounded = Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
  // -0은 표에 "-$0.00"으로 찍히고 비교에서도 0과 다르게 취급되므로 0으로 눕힙니다.
  return rounded === 0 ? 0 : rounded;
}

export async function loadAlphaAttribution(dataDir) {
  return attributeAlpha(await readPaperEvents(dataDir));
}
