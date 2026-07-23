const ALLOCATIONS = {
  RISK_ON: { VTI: 0.7, SCHD: 0.15, IWM: 0.15, CASH: 0 },
  NEUTRAL: { VTI: 0.7, SCHD: 0.2, IWM: 0, CASH: 0.1 },
  RISK_OFF: { VTI: 0.4, SCHD: 0.2, IWM: 0, CASH: 0.4 },
};

/** FRED 점수에 신뢰도로 감쇠한 감성 및 MACD 보조 점수를 더합니다. */
export function combineMarketSignals(
  macroSignal,
  sentiment,
  { sentimentWeight = 2, macd = null, macdWeight = 0.15 } = {},
) {
  if (!macroSignal) return null;
  validateWeight(macdWeight, "MACD_SCORE_WEIGHT", 1);
  const sentimentContribution = sentiment
    ? round(sentiment.sentiment_score * sentiment.confidence * sentimentWeight)
    : 0;
  const baseScore = round(Number(macroSignal.score) + sentimentContribution);
  const usableMacd = Boolean(macd?.available);
  const macdContribution = usableMacd
    ? round(Number(macd.score) * Number(macd.confidence) * macdWeight)
    : 0;
  const score = round(baseScore + macdContribution);
  const regime = score >= 1.5 ? "RISK_ON" : score <= -1.5 ? "RISK_OFF" : "NEUTRAL";
  const reasons = [...(macroSignal.reasons ?? [])];
  if (sentiment) {
    reasons.push(
      `무료 뉴스 감성 ${sentiment.sentiment_score} × 신뢰도 ${sentiment.confidence} = ` +
        `${sentimentContribution >= 0 ? "+" : ""}${sentimentContribution}`,
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
    signalSource: signalSource(Boolean(sentiment), usableMacd),
    macroScore: macroSignal.score,
    baseScore,
    sentimentContribution,
    sentiment: sentiment ?? null,
    macdContribution,
    macd: usableMacd ? macd : null,
  };
}

function signalSource(hasSentiment, hasMacd) {
  if (hasSentiment && hasMacd) return "FRED_NEWS_MACD";
  if (hasSentiment) return "FRED_NEWS";
  if (hasMacd) return "FRED_MACD";
  return "FRED_ONLY";
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
