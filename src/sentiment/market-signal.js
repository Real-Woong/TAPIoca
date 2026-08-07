export const ALLOCATIONS = {
  RISK_ON: { VTI: 0.7, SCHD: 0.15, IWM: 0.15, CASH: 0 },
  NEUTRAL: { VTI: 0.7, SCHD: 0.2, IWM: 0, CASH: 0.1 },
  RISK_OFF: { VTI: 0.4, SCHD: 0.2, IWM: 0, CASH: 0.4 },
};

// 레짐 경계 점수입니다. 이 값에서 위 표와 정확히 일치합니다.
export const REGIME_THRESHOLD = 1.5;

/**
 * 점수를 목표 비중으로 바꿉니다. 세 표를 앵커로 두고 그 사이를 선형 보간합니다.
 *
 * 예전에는 점수 -1.5 한 점에서 주식 90%↔60%가 갈렸습니다. 노이즈가 그 선을
 * 걸치고 있었으므로 최대 노이즈 지점에 최대 베팅을 건 구조였고, 실제로 07-22~08-04
 * 동안 점수가 -1.2와 -2.3 사이를 오가며 목표 비중이 매일 뒤집혔습니다.
 * 보간하면 점수 0.1 변동이 30%p 점프가 아니라 2%p 드리프트가 되고,
 * 무거래 밴드(기본 5%) 안에 들어와 실제 주문으로 이어지지 않습니다.
 */
export function allocationForScore(score, tables = ALLOCATIONS) {
  const value = Number(score);
  if (!Number.isFinite(value)) return { ...tables.NEUTRAL };
  if (value <= -REGIME_THRESHOLD) return { ...tables.RISK_OFF };
  if (value >= REGIME_THRESHOLD) return { ...tables.RISK_ON };
  return value < 0
    ? blend(tables.NEUTRAL, tables.RISK_OFF, -value / REGIME_THRESHOLD)
    : blend(tables.NEUTRAL, tables.RISK_ON, value / REGIME_THRESHOLD);
}

/** from에서 to로 ratio(0~1)만큼 이동한 비중표를 만듭니다. */
function blend(from, to, ratio) {
  const clamped = clamp(Number(ratio) || 0, 0, 1);
  const symbols = new Set([...Object.keys(from), ...Object.keys(to)]);
  const blended = {};
  for (const symbol of symbols) {
    const start = Number(from[symbol]) || 0;
    const end = Number(to[symbol]) || 0;
    blended[symbol] = round(start + (end - start) * clamped);
  }
  return blended;
}

export function regimeForScore(score) {
  const value = Number(score);
  return value >= REGIME_THRESHOLD
    ? "RISK_ON"
    : value <= -REGIME_THRESHOLD
      ? "RISK_OFF"
      : "NEUTRAL";
}

/** FRED 점수에 신뢰도로 감쇠한 감성·추세·MACD 점수를 더합니다. */
export function combineMarketSignals(
  macroSignal,
  sentiment,
  {
    sentimentWeight = 2,
    trend = null,
    trendWeight = 1,
    macd = null,
    macdWeight = 0.15,
    // Moreira & Muir(2017) 변동성 관리: 목표 연율 변동성보다 시장이 요동치면 익스포저를 줄입니다.
    volTarget = 0.15,
    minExposure = 0.3,
    // 익스포저 배수의 상한입니다. 기본 1은 "조용할 때도 기본 배분보다 더 들지
    // 않는다"는 뜻이라, 변동성 관리가 **한 방향으로만** 동작해 왔습니다.
    // 1보다 크게 두면 변동성이 목표보다 낮은 구간에서 주식을 더 듭니다.
    //
    // 이 시스템이 사는 것은 낙폭인데, 낙폭 여유를 현금으로 쌓아두기만 하면
    // CAGR로 돌아오지 않습니다. 아낀 낙폭을 노출로 되쓰는 손잡이입니다.
    // **기본값 1은 지금까지의 모든 측정과 동일한 동작입니다** — 재기 전에는
    // 켜지 않습니다.
    maxExposure = 1,
    // 감성 스냅샷이 오래될수록 신뢰도를 깎고, 이 시간을 넘기면 기여도를 0으로 만듭니다.
    sentimentHalfLifeHours = 6,
    sentimentMaxAgeHours = 24,
    now = new Date(),
  } = {},
) {
  if (!macroSignal) return null;
  validateWeight(trendWeight, "TREND_SCORE_WEIGHT", 3);
  validateWeight(macdWeight, "MACD_SCORE_WEIGHT", 1);
  const freshness = sentimentFreshness(
    sentiment, now, sentimentHalfLifeHours, sentimentMaxAgeHours,
  );
  const sentimentContribution = sentiment
    ? round(
        sentiment.sentiment_score * sentiment.confidence * sentimentWeight * freshness.multiplier,
      )
    : 0;
  const baseScore = round(Number(macroSignal.score) + sentimentContribution);
  // Faber 이동평균 추세는 하락장 방어를 위한 1급 타이밍 신호로, MACD보다 큰 가중치를 씁니다.
  const usableTrend = Boolean(trend?.available);
  const trendContribution = usableTrend
    ? round(Number(trend.score) * Number(trend.confidence) * trendWeight)
    : 0;
  const usableMacd = Boolean(macd?.available);
  const macdContribution = usableMacd
    ? round(Number(macd.score) * Number(macd.confidence) * macdWeight)
    : 0;
  const score = round(baseScore + trendContribution + macdContribution);
  const regime = regimeForScore(score);
  const reasons = [...(macroSignal.reasons ?? [])];
  if (sentiment) {
    reasons.push(
      `무료 뉴스 감성 ${sentiment.sentiment_score} × 신뢰도 ${sentiment.confidence}` +
        (freshness.multiplier < 1 ? ` × 신선도 ${freshness.multiplier}` : "") +
        ` = ${sentimentContribution >= 0 ? "+" : ""}${sentimentContribution}` +
        (freshness.ageHours === null ? "" : ` (수집 ${freshness.ageHours}시간 전)`),
    );
    if (freshness.multiplier === 0) {
      reasons.push(
        `뉴스 감성 제외: 스냅샷이 ${sentimentMaxAgeHours}시간을 넘겨 판단에서 뺐습니다.`,
      );
    }
  }
  if (usableTrend) {
    reasons.push(
      `추세(200일선) ${trend.score} × 신뢰도 ${trend.confidence} × 가중치 ${trendWeight} = ` +
        `${trendContribution >= 0 ? "+" : ""}${trendContribution}`,
    );
  }
  if (usableMacd) {
    reasons.push(
      `MACD ${macd.score} × 신뢰도 ${macd.confidence} × 가중치 ${macdWeight} = ` +
        `${macdContribution >= 0 ? "+" : ""}${macdContribution}`,
    );
  }

  // 변동성 관리: 최근 연율 변동성이 목표보다 높으면 주식 비중을 그 비율만큼 줄이고 현금을 늘립니다.
  const annualizedVol = usableTrend ? Number(trend.volatility?.annualized) : NaN;
  let exposureMultiplier = 1;
  if (volTarget > 0 && Number.isFinite(annualizedVol) && annualizedVol > 0) {
    exposureMultiplier = clamp(round(volTarget / annualizedVol), minExposure, maxExposure);
  }
  const regimeAllocation = allocationFor(score, macroSignal.targetAllocation);
  const targetAllocation = exposureMultiplier === 1
    ? regimeAllocation
    : scaleForExposure(regimeAllocation, exposureMultiplier);
  if (exposureMultiplier < 1) {
    reasons.push(
      `변동성 관리: 연율 변동성 ${round(annualizedVol * 100)}% > 목표 ${round(volTarget * 100)}% → ` +
        `주식 익스포저 ×${exposureMultiplier}`,
    );
  } else if (exposureMultiplier > 1) {
    reasons.push(
      `변동성 관리: 연율 변동성 ${round(annualizedVol * 100)}% < 목표 ${round(volTarget * 100)}% → ` +
        `주식 익스포저 ×${exposureMultiplier} (상한 ${maxExposure})`,
    );
  }

  return {
    ...macroSignal,
    regime,
    score,
    targetAllocation,
    reasons,
    // 레이어별 상태를 항상 함께 넘깁니다. 예전에는 신호가 없으면 필드가 null이 되고
    // 보고서가 그 줄을 통째로 생략해서, 꺼진 신호를 알아챌 방법이 없었습니다.
    layers: [
      layerStatus("FRED", "거시(FRED)", null, true, Number(macroSignal.score), null),
      // 신선도로 기여도가 0이 된 경우도 "꺼진 신호"로 드러냅니다.
      layerStatus(
        "NEWS", "뉴스 감성", sentimentWeight,
        Boolean(sentiment) && freshness.multiplier > 0, sentimentContribution,
        sentiment ? (freshness.multiplier > 0 ? null : "STALE_SNAPSHOT") : "NOT_LOADED",
      ),
      layerStatus("TREND", "추세(200일선)", trendWeight, usableTrend, trendContribution,
        unavailableReason(trend)),
      layerStatus("MACD", "MACD", macdWeight, usableMacd, macdContribution, unavailableReason(macd)),
    ],
    signalSource: signalSource(Boolean(sentiment), usableTrend, usableMacd),
    // 실제로 적용된 가중치를 결과에 실어 보냅니다. 기여도만 기록하면 나중에
    // "가중치를 바꿨다면 어땠을까"를 되돌릴 수 없습니다(기여도 = 원점수 × 신뢰도 × 가중치).
    weights: {
      sentiment: sentimentWeight,
      trend: trendWeight,
      macd: macdWeight,
      volTarget,
      minExposure,
    },
    macroScore: macroSignal.score,
    baseScore,
    sentimentContribution,
    sentiment: sentiment ?? null,
    // 보고서가 "왜 며칠째 같은 감성 값인가"를 스스로 드러낼 수 있게 나이를 함께 넘깁니다.
    sentimentFreshness: freshness,
    trendContribution,
    trend: usableTrend ? trend : null,
    macdContribution,
    macd: usableMacd ? macd : null,
    volatilityAnnualized: Number.isFinite(annualizedVol) ? annualizedVol : null,
    exposureMultiplier,
  };
}

function scaleForExposure(allocation, multiplier) {
  const scaled = {};
  let equitySum = 0;
  for (const [symbol, weight] of Object.entries(allocation)) {
    if (symbol === "CASH") continue;
    scaled[symbol] = round(Number(weight) * multiplier);
    equitySum += scaled[symbol];
  }
  // 배수가 1을 넘으면 주식 합이 100%를 넘을 수 있습니다. 현금이 마이너스가 되는
  // 것은 곧 레버리지이고 이 지갑에는 없는 수단이므로, 비율을 유지한 채 100%로
  // 눌러 담습니다. 그래서 상한을 아무리 올려도 실제 노출은 전액 주식에서 멈춥니다.
  if (equitySum > 1) {
    for (const symbol of Object.keys(scaled)) {
      scaled[symbol] = round(scaled[symbol] / equitySum);
    }
    equitySum = 1;
  }
  // 줄인 주식 비중만큼 현금으로 돌립니다.
  scaled.CASH = round(Math.max(0, 1 - equitySum));
  return scaled;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function layerStatus(key, label, weight, available, contribution, reason) {
  return {
    key,
    label,
    weight,
    available,
    contribution: round(Number(contribution) || 0),
    ...(available ? {} : { reason }),
  };
}

/** 신호 객체가 왜 못 쓰이는지 한 단어로 만듭니다. 객체 자체가 없으면 수집 단계에서 실패한 것입니다. */
function unavailableReason(signal) {
  if (signal?.available) return null;
  if (!signal) return "NOT_LOADED";
  return signal.reason ?? "UNAVAILABLE";
}

function signalSource(hasSentiment, hasTrend, hasMacd) {
  const parts = [];
  if (hasSentiment) parts.push("NEWS");
  if (hasTrend) parts.push("TREND");
  if (hasMacd) parts.push("MACD");
  return parts.length ? `FRED_${parts.join("_")}` : "FRED_ONLY";
}

function validateWeight(value, name, maximum) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > maximum) {
    throw new Error(`${name}는 0~${maximum} 숫자여야 합니다.`);
  }
}

// 기본 ETF 세트일 때만 점수 기반 연속 배분을 씁니다. 다른 종목 세트가 오면
// 거시 신호가 준 표를 그대로 존중합니다(테스트·커스텀 워치리스트 경로).
function allocationFor(score, original) {
  const symbols = Object.keys(original ?? {}).filter((symbol) => symbol !== "CASH");
  const isDefaultEtfSet =
    symbols.length > 0 && symbols.every((symbol) => symbol in ALLOCATIONS.NEUTRAL);
  return isDefaultEtfSet ? allocationForScore(score) : original;
}

/**
 * 감성 스냅샷의 나이로 기여도 배수를 만듭니다.
 *
 * 07-23~07-31 보고서에서 감성 값이 소수점 3자리까지 동일하게 4일간 반복됐습니다.
 * 뉴스가 안 변한 게 아니라 캐시 스냅샷이 재사용된 것이고, 그 값이 레짐 경계를
 * 넘나들며 주식 비중을 뒤집었습니다. 오래된 스냅샷은 신뢰도를 반감기로 깎고
 * 상한을 넘기면 아예 판단에서 뺍니다.
 */
function sentimentFreshness(sentiment, now, halfLifeHours, maxAgeHours) {
  if (!sentiment) return { multiplier: 1, ageHours: null, stale: false };
  const fetchedAt = new Date(sentiment.fetchedAt ?? "").getTime();
  // 수집 시각을 모르면 감쇠시키지 않습니다. 없는 정보로 신호를 끄면 더 위험합니다.
  if (!Number.isFinite(fetchedAt)) return { multiplier: 1, ageHours: null, stale: false };

  const ageHours = Math.max(0, (now.getTime() - fetchedAt) / (60 * 60 * 1000));
  if (maxAgeHours > 0 && ageHours >= maxAgeHours) {
    return { multiplier: 0, ageHours: round(ageHours), stale: true };
  }
  const multiplier = halfLifeHours > 0 ? 0.5 ** (ageHours / halfLifeHours) : 1;
  return { multiplier: round(multiplier), ageHours: round(ageHours), stale: ageHours > halfLifeHours };
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}
