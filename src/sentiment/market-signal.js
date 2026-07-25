const ALLOCATIONS = {
  RISK_ON: { VTI: 0.7, SCHD: 0.15, IWM: 0.15, CASH: 0 },
  NEUTRAL: { VTI: 0.7, SCHD: 0.2, IWM: 0, CASH: 0.1 },
  RISK_OFF: { VTI: 0.4, SCHD: 0.2, IWM: 0, CASH: 0.4 },
};

/** FRED 점수에 신뢰도로 감쇠한 감성·추세·MACD 점수를 더합니다. */
export function combineMarketSignals(
  macroSignal,
  sentiment,
  { sentimentWeight = 2, trend = null, trendWeight = 1, macd = null, macdWeight = 0.15 } = {},
) {
  if (!macroSignal) return null;
  validateWeight(trendWeight, "TREND_SCORE_WEIGHT", 3);
  validateWeight(macdWeight, "MACD_SCORE_WEIGHT", 1);
  const sentimentContribution = sentiment
    ? round(sentiment.sentiment_score * sentiment.confidence * sentimentWeight)
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
  const regime = score >= 1.5 ? "RISK_ON" : score <= -1.5 ? "RISK_OFF" : "NEUTRAL";
  const reasons = [...(macroSignal.reasons ?? [])];
  if (sentiment) {
    reasons.push(
      `무료 뉴스 감성 ${sentiment.sentiment_score} × 신뢰도 ${sentiment.confidence} = ` +
        `${sentimentContribution >= 0 ? "+" : ""}${sentimentContribution}`,
    );
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
  return {
    ...macroSignal,
    regime,
    score,
    targetAllocation: allocationFor(regime, macroSignal.targetAllocation),
    reasons,
    signalSource: signalSource(Boolean(sentiment), usableTrend, usableMacd),
    macroScore: macroSignal.score,
    baseScore,
    sentimentContribution,
    sentiment: sentiment ?? null,
    trendContribution,
    trend: usableTrend ? trend : null,
    macdContribution,
    macd: usableMacd ? macd : null,
  };
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

function allocationFor(regime, original) {
  const symbols = Object.keys(original ?? {}).filter((symbol) => symbol !== "CASH");
  const isDefaultEtfSet = symbols.every((symbol) => symbol in ALLOCATIONS[regime]);
  return isDefaultEtfSet ? { ...ALLOCATIONS[regime] } : original;
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}
