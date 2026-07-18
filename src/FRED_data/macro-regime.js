// 여러 경제지표를 직접 BUY/SELL로 바꾸지 않고 먼저 위험 상태로 분류합니다.
// 반환 상태는 RISK_ON, NEUTRAL, RISK_OFF 중 하나입니다.
export function evaluateMacroRegime(macroData, now = new Date()) {
  const series = macroData?.series;
  if (!series) throw new Error("macroData.series가 필요합니다.");

  // FRED 요청을 최신 날짜 우선(desc)으로 했으므로 0번 관측값이 최신값입니다.
  const fedLower = latest(series.fedLower);
  const fedUpper = latest(series.fedUpper);
  const corePce = latest(series.corePce);
  const unemployment = latest(series.unemployment);
  const sahm = latest(series.sahm);
  const yieldCurve = latest(series.yieldCurve);

  // 기준금리는 같은 값이 매일 반복되므로 직전 행이 아닌 약 90일 전과 비교합니다.
  const oldRate = valueOnOrBefore(
    series.fedUpper.observations,
    daysBefore(now, 90),
  );
  const rateChange90d = oldRate === null ? 0 : fedUpper.value - oldRate;

  // PCE와 실업률은 월간 지표이므로 최신값과 3개 관측치 전 값을 비교합니다.
  const corePceChange3m = changeByPeriods(series.corePce.observations, 3);
  const unemploymentChange3m = changeByPeriods(
    series.unemployment.observations,
    3,
  );

  // 우호적인 신호는 양수, 위험 신호는 음수로 누적합니다.
  let score = 0;
  // 최종 판정이 나온 이유를 상태 출력에 함께 보여주기 위한 배열입니다.
  const reasons = [];

  // 90일 동안 0.25%p 이상 인하했으면 완화, 인상했으면 긴축으로 봅니다.
  if (rateChange90d <= -0.25) {
    score += 1;
    reasons.push("최근 90일 기준금리 인하");
  } else if (rateChange90d >= 0.25) {
    score -= 1;
    reasons.push("최근 90일 기준금리 인상");
  } else {
    reasons.push("최근 90일 기준금리 변화 없음");
  }

  // 근원 PCE의 현재 수준을 봅니다. 이 경계값은 PAPER 검증용 초기 가설입니다.
  if (corePce.value <= 2.5) {
    score += 1;
    reasons.push("근원 PCE가 2.5% 이하");
  } else if (corePce.value >= 3) {
    score -= 1;
    reasons.push("근원 PCE가 3% 이상");
  }

  // 물가의 절대 수준과 별개로 최근 방향이 둔화인지 재상승인지도 반영합니다.
  if (corePceChange3m <= -0.2) {
    score += 1;
    reasons.push("최근 3개월 근원 PCE 둔화");
  } else if (corePceChange3m >= 0.2) {
    score -= 1;
    reasons.push("최근 3개월 근원 PCE 재상승");
  }

  // 실업률이 짧은 기간에 빠르게 오르면 고용 악화 신호로 봅니다.
  if (unemploymentChange3m >= 0.3) {
    score -= 1;
    reasons.push("최근 3개월 실업률 상승");
  }

  // Sahm 0.50 이상은 강한 경기침체 신호, 0.35 이상은 접근 경고로 처리합니다.
  if (sahm.value >= 0.5) {
    score -= 3;
    reasons.push("Sahm 경기침체 신호 발생");
  } else if (sahm.value >= 0.35) {
    score -= 1;
    reasons.push("Sahm 경기침체 신호 접근");
  } else {
    reasons.push("Sahm 경기침체 신호 없음");
  }

  // 10년-2년 금리차가 음수면 장단기 금리 역전 상태입니다.
  if (yieldCurve.value < 0) {
    score -= 1;
    reasons.push("미국 10년-2년 금리 역전");
  } else if (yieldCurve.value >= 0.2) {
    score += 0.5;
    reasons.push("미국 10년-2년 금리차 정상 구간");
  }

  // 누적 점수를 세 가지 시장 위험 상태로 단순화합니다.
  const regime = score >= 1.5
    ? "RISK_ON"
    : score <= -1.5
      ? "RISK_OFF"
      : "NEUTRAL";

  return {
    evaluatedAt: now.toISOString(),
    regime,
    score,
    targetAllocation: allocationFor(regime),
    // 계산에 사용한 지표도 반환해 결과를 사람이 검증할 수 있게 합니다.
    indicators: {
      fedTargetRange: {
        lower: fedLower.value,
        upper: fedUpper.value,
        date: fedUpper.date,
        change90d: round(rateChange90d),
      },
      corePce: metric(corePce, corePceChange3m),
      unemployment: metric(unemployment, unemploymentChange3m),
      sahm: metric(sahm),
      yieldCurve: metric(yieldCurve),
    },
    reasons,
  };
}

// 경제 상태를 ETF와 현금의 실험용 목표 비중으로 바꿉니다.
function allocationFor(regime) {
  if (regime === "RISK_ON") {
    return { VTI: 0.7, SCHD: 0.15, IWM: 0.15, CASH: 0 };
  }
  if (regime === "RISK_OFF") {
    return { VTI: 0.4, SCHD: 0.2, IWM: 0, CASH: 0.4 };
  }
  return { VTI: 0.7, SCHD: 0.2, IWM: 0, CASH: 0.1 };
}

// 최신 관측값을 가져오고, 데이터가 없으면 조용히 잘못 계산하지 않고 중단합니다.
function latest(item) {
  const observation = item?.observations?.[0];
  if (!observation) {
    throw new Error(`${item?.id ?? "UNKNOWN"} 관측값이 없습니다.`);
  }
  return observation;
}

// 최신값과 지정한 관측치만큼 과거값의 차이를 계산합니다.
function changeByPeriods(observations, periods) {
  if (!Array.isArray(observations) || observations.length <= periods) return 0;
  return observations[0].value - observations[periods].value;
}

// targetDate와 같거나 더 과거인 관측값 중 가장 가까운 값을 찾습니다.
function valueOnOrBefore(observations, targetDate) {
  const match = observations.find(
    (item) => new Date(`${item.date}T00:00:00Z`) <= targetDate,
  );
  return match?.value ?? null;
}

// 날짜에서 원하는 일수만큼 이전 시각을 계산합니다.
function daysBefore(date, days) {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

// 지표별 출력 형태를 { value, date, change3m? }로 통일합니다.
function metric(observation, change3m) {
  return {
    value: observation.value,
    date: observation.date,
    ...(change3m === undefined ? {} : { change3m: round(change3m) }),
  };
}

// 부동소수점 결과를 읽기 쉽도록 소수점 셋째 자리까지 반올림합니다.
function round(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

// FRED 원본 데이터
//     ↓
// 최근 금리·물가·고용 변화 계산
//     ↓
// 각 신호에 점수 부여
//     ↓
// RISK_ON / NEUTRAL / RISK_OFF
//     ↓
// ETF 목표 비중 계산