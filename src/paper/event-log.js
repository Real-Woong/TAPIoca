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

/** 한 사이클의 실행 결과와 통합 신호를 감사 가능한 이벤트 한 건으로 만듭니다. */
export function buildPaperEvent({ now = new Date(), marketSignal, result }) {
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
