import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

// 모든 PAPER 사이클의 신호·결정·체결·자산 스냅샷을 한 줄 JSON(JSONL)으로 덧붙입니다.
// 기존 기록을 절대 덮어쓰지 않는 append-only 로그라, 사후 감사와 성과 분석의 원천이 됩니다.
// 가변 상태 스냅샷(paper-state.json)만으로는 재구성할 수 없는 "왜 이 거래를 했는가"를 남깁니다.
export function paperEventLogPath(dataDir) {
  return path.join(dataDir, "paper-events.jsonl");
}

export async function appendPaperEvent(dataDir, event) {
  await mkdir(dataDir, { recursive: true });
  await appendFile(paperEventLogPath(dataDir), `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

export async function readPaperEvents(dataDir, { limit } = {}) {
  let text;
  try {
    text = await readFile(paperEventLogPath(dataDir), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  const selected = Number.isFinite(limit) ? lines.slice(-limit) : lines;
  return selected.map((line) => JSON.parse(line));
}

/**
 * 각 신호층의 "가중치를 곱하기 전" 원본 값을 남깁니다.
 *
 * 기존에는 기여도(원점수 × 신뢰도 × 가중치 × 신선도)만 저장해서, 나중에 가중치를
 * 바꿔 다시 계산할 수 없었습니다. 가격 기반 층(추세·MACD)과 FRED는 언제든 다시
 * 받아올 수 있지만, **뉴스 감성은 그날의 GDELT·Bluesky·RSS 수집창이 지나가면
 * 영영 복원할 수 없습니다.** 이 층을 백테스트하려면 지금부터 쌓는 수밖에 없습니다.
 */
function buildSignalSnapshot(marketSignal) {
  if (!marketSignal) return null;
  const { sentiment, trend, macd, sentimentFreshness } = marketSignal;
  return {
    weights: marketSignal.weights ?? null,
    // FRED 원점수. 시계열은 언제든 다시 받을 수 있으므로 점수만 대조용으로 남깁니다.
    fred: { score: marketSignal.macroScore ?? null },
    // 재현 불가능한 유일한 층이라 수집 시각·소스 구성까지 통째로 남깁니다.
    sentiment: sentiment
      ? {
          score: sentiment.sentiment_score ?? null,
          confidence: sentiment.confidence ?? null,
          articleCount: sentiment.articleCount ?? null,
          sourceCounts: sentiment.sourceCounts ?? null,
          provider: sentiment.provider ?? null,
          fetchedAt: sentiment.fetchedAt ?? null,
          analyzedAt: sentiment.analyzedAt ?? null,
          stale: Boolean(sentiment.stale),
          warning: sentiment.warning ?? null,
        }
      : null,
    sentimentFreshness: sentimentFreshness
      ? { ageHours: sentimentFreshness.ageHours, multiplier: sentimentFreshness.multiplier }
      : null,
    trend: trend
      ? {
          score: trend.score ?? null,
          confidence: trend.confidence ?? null,
          readySymbols: trend.readySymbols ?? null,
          totalSymbols: trend.totalSymbols ?? null,
          annualizedVol: trend.volatility?.annualized ?? null,
        }
      : null,
    macd: macd
      ? {
          score: macd.score ?? null,
          confidence: macd.confidence ?? null,
          readySymbols: macd.readySymbols ?? null,
          totalSymbols: macd.totalSymbols ?? null,
        }
      : null,
  };
}

/** 사이클 시점의 체결 기준가. 장중 매수가 고점에 쏠리는지 사후에 확인할 수 있습니다. */
function buildPriceSnapshot(prices) {
  const list = prices instanceof Map ? [...prices.values()] : (prices ?? []);
  const snapshot = {};
  for (const price of list) {
    if (price?.symbol && Number.isFinite(Number(price.lastPrice))) {
      snapshot[price.symbol] = Number(price.lastPrice);
    }
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

/** 한 사이클의 실행 결과와 통합 신호를 감사 가능한 이벤트 한 건으로 만듭니다. */
export function buildPaperEvent({ now = new Date(), marketSignal, result, prices }) {
  const summary = result.summary;
  return {
    at: now.toISOString(),
    regime: marketSignal?.regime ?? null,
    score: marketSignal?.score ?? null,
    signalSource: marketSignal?.signalSource ?? marketSignal?.source ?? null,
    stale: Boolean(marketSignal?.stale),
    // 각 신호층이 최종 점수에 얼마나 기여했는지 분해해 저장합니다.
    contributions: marketSignal
      ? {
          macro: marketSignal.macroScore ?? null,
          sentiment: marketSignal.sentimentContribution ?? 0,
          trend: marketSignal.trendContribution ?? 0,
          macd: marketSignal.macdContribution ?? 0,
        }
      : null,
    targetAllocation: marketSignal?.targetAllocation ?? null,
    volatilityAnnualized: marketSignal?.volatilityAnnualized ?? null,
    exposureMultiplier: marketSignal?.exposureMultiplier ?? null,
    // 가중치를 곱하기 전 원본 신호와 그 시점 가격. 사후 재계산의 원천입니다.
    signals: buildSignalSnapshot(marketSignal),
    prices: buildPriceSnapshot(prices),
    decisions: (result.decisions ?? []).map((decision) => ({
      symbol: decision.symbol,
      action: decision.action,
      reason: decision.reason,
      amountUsd: decision.amountUsd ?? null,
    })),
    equityUsd: summary.equityUsd,
    cashUsd: summary.cashUsd,
    marketValueUsd: summary.marketValueUsd,
    realizedPnlUsd: summary.realizedPnlUsd,
    unrealizedPnlUsd: summary.unrealizedPnlUsd,
    totalPnlUsd: summary.totalPnlUsd,
    feesUsd: summary.feesUsd ?? null,
    returnPct: summary.returnPct ?? null,
    benchmark: summary.benchmark
      ? {
          symbol: summary.benchmark.symbol,
          valueUsd: summary.benchmark.valueUsd,
          pnlUsd: summary.benchmark.pnlUsd,
          returnPct: summary.benchmark.returnPct,
        }
      : null,
    alphaUsd: summary.alphaUsd ?? null,
  };
}
