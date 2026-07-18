import { evaluateExit } from "./exit-strategy.js";
import { sizePaperOrder } from "./trading-budget.js";

export function createPaperState({ budget, watchlist, now = new Date() }) {
  // 실제 계좌와 분리된 가상 지갑입니다. 모든 매매 기록은 JSON 장부에만 남습니다.
  return {
    version: 1,
    mode: "PAPER",
    createdAt: now.toISOString(),
    funding: budget,
    cashUsd: budget.fundedUsd,
    realizedPnlUsd: 0,
    watchlist: [...watchlist],
    positions: {},
    completedSymbols: [],
    dailyBuyUsd: {},
    trades: [],
    // 마지막으로 매매 판단에 사용한 FRED 거시경제 신호를 보관합니다.
    macro: null,
    lastRunAt: null,
  };
}

export function runPaperCycle(state, prices, policy, now = new Date(), macroSignal = undefined) {
  // 방어선을 한 번 더 둡니다. LIVE 설정에서는 PAPER 계산조차 진행하지 않습니다.
  if (state.mode !== "PAPER" || policy.mode !== "PAPER") {
    throw new Error("PAPER 엔진은 LIVE 모드에서 실행할 수 없습니다.");
  }

  const dateKey = now.toISOString().slice(0, 10);
  const priceMap = new Map(prices.map((price) => [price.symbol, price]));
  const decisions = [];
  let dailyBought = Number(state.dailyBuyUsd[dateKey] ?? 0);

  // 매수보다 청산 판단을 먼저 수행해 손절/수익실현 조건을 우선 처리합니다.
  for (const [symbol, position] of Object.entries(state.positions)) {
    const market = priceMap.get(symbol);
    if (!market) continue;
    const exit = evaluateExit(position, market.lastPrice, policy, now);
    position.peakPrice = exit.peakPrice ?? position.peakPrice;
    position.lastPrice = market.lastPrice;
    position.lastPriceAt = market.timestamp ?? now.toISOString();
    decisions.push({ symbol, ...exit });

    if (exit.action === "SELL") {
      const proceedsUsd = roundUsd(position.quantity * market.lastPrice);
      const pnlUsd = roundUsd(proceedsUsd - position.costUsd);
      state.cashUsd = roundUsd(state.cashUsd + proceedsUsd);
      state.realizedPnlUsd = roundUsd(state.realizedPnlUsd + pnlUsd);
      state.trades.push({
        side: "SELL",
        symbol,
        quantity: position.quantity,
        price: market.lastPrice,
        amountUsd: proceedsUsd,
        pnlUsd,
        reason: exit.reason,
        executedAt: now.toISOString(),
      });
      state.completedSymbols.push(symbol);
      delete state.positions[symbol];
    }
  }

  if (macroSignal) {
    // 상태 파일에는 API 원본 전체가 아니라 실제 판단에 사용한 요약만 저장합니다.
    state.macro = compactMacroSignal(macroSignal);
    dailyBought = runMacroTargetBuys({
      state,
      priceMap,
      policy,
      now,
      dailyBought,
      decisions,
      macroSignal,
    });
  } else if (macroSignal === undefined) {
    // 기존 테스트나 직접 함수 호출은 이전 동작을 유지합니다.
    // PAPER 실행기는 항상 거시 신호 또는 null을 명시적으로 전달합니다.
    dailyBought = runLegacyBuys({
      state,
      priceMap,
      policy,
      now,
      dailyBought,
      decisions,
    });
  } else {
    // null은 FRED와 캐시를 모두 사용할 수 없다는 의미입니다.
    // 기존 포지션의 청산 판단은 위에서 수행했지만 신규 매수는 안전하게 멈춥니다.
    decisions.push({
      symbol: "PORTFOLIO",
      action: "PAUSE_BUY",
      reason: "MACRO_SIGNAL_UNAVAILABLE",
    });
  }

  state.dailyBuyUsd[dateKey] = dailyBought;
  state.lastRunAt = now.toISOString();
  return { state, decisions, summary: summarizePaperState(state, priceMap) };
}

// FRED 목표 비중을 기준으로 가장 덜 채워진 ETF부터 일일 한도 안에서 매수합니다.
function runMacroTargetBuys({
  state,
  priceMap,
  policy,
  now,
  dailyBought,
  decisions,
  macroSignal,
}) {
  const allocation = macroSignal.targetAllocation ?? {};
  const cashWeight = validWeight(allocation.CASH);

  while (true) {
    const dailyRemaining = Math.max(0, policy.maxDailyBuyUsd - dailyBought);
    if (dailyRemaining < 0.01 || state.cashUsd < 0.01) break;

    const summary = summarizePaperState(state, priceMap);
    // 목표 현금 비중을 침범하지 않도록 앞으로 더 투자할 수 있는 총액을 계산합니다.
    const investableRemaining = roundUsd(
      summary.equityUsd * (1 - cashWeight) - summary.marketValueUsd,
    );
    if (investableRemaining < 0.01) break;

    const candidates = state.watchlist
      // 기존 정책대로 한 번 완전히 청산된 종목은 자동 재진입하지 않습니다.
      .filter((symbol) => !state.completedSymbols.includes(symbol))
      .map((symbol, index) => {
        const market = priceMap.get(symbol);
        const weight = validWeight(allocation[symbol]);
        if (!market || weight <= 0) return null;

        const position = state.positions[symbol];
        const currentValue = position ? position.quantity * market.lastPrice : 0;
        const targetValue = summary.equityUsd * weight;
        const deficitUsd = targetValue - currentValue;

        return {
          symbol,
          index,
          market,
          targetValue,
          deficitUsd,
          // 목표 대비 보유 비율이 낮은 ETF를 먼저 사면 비중이 한쪽으로 쏠리지 않습니다.
          fulfillment: targetValue > 0 ? currentValue / targetValue : Infinity,
        };
      })
      .filter((candidate) => candidate && candidate.deficitUsd >= 0.01)
      .sort((a, b) =>
        a.fulfillment - b.fulfillment ||
        b.targetValue - a.targetValue ||
        a.index - b.index
      );

    const candidate = candidates[0];
    if (!candidate) break;

    const requestedUsd = Math.min(
      dailyRemaining,
      investableRemaining,
      candidate.deficitUsd,
    );
    const amountUsd = sizePaperOrder({
      cashUsd: state.cashUsd,
      maxOrderUsd: policy.maxOrderUsd,
      requestedUsd,
    });
    if (amountUsd < 0.01) break;

    addToPosition({
      state,
      market: candidate.market,
      symbol: candidate.symbol,
      amountUsd,
      now,
      reason: `MACRO_${macroSignal.regime}_TARGET_BUY`,
      macroSignal,
    });
    dailyBought = roundUsd(dailyBought + amountUsd);
    decisions.push({
      symbol: candidate.symbol,
      action: "BUY",
      reason: `MACRO_${macroSignal.regime}_TARGET_BUY`,
      amountUsd,
      targetWeight: validWeight(allocation[candidate.symbol]),
    });
  }

  return dailyBought;
}

// 거시 신호를 전달하지 않은 기존 호출을 위한 이전 순차 매수 방식입니다.
function runLegacyBuys({ state, priceMap, policy, now, dailyBought, decisions }) {
  for (const symbol of state.watchlist) {
    if (state.positions[symbol] || state.completedSymbols.includes(symbol)) continue;
    const market = priceMap.get(symbol);
    if (!market) continue;
    const dailyRemaining = Math.max(0, policy.maxDailyBuyUsd - dailyBought);
    if (dailyRemaining < 0.01 || state.cashUsd < 0.01) break;

    const amountUsd = sizePaperOrder({
      cashUsd: state.cashUsd,
      maxOrderUsd: policy.maxOrderUsd,
      requestedUsd: dailyRemaining,
    });
    if (amountUsd < 0.01) break;

    addToPosition({
      state,
      market,
      symbol,
      amountUsd,
      now,
      reason: "INITIAL_PAPER_ENTRY",
    });
    dailyBought = roundUsd(dailyBought + amountUsd);
    decisions.push({ symbol, action: "BUY", reason: "INITIAL_PAPER_ENTRY", amountUsd });
  }
  return dailyBought;
}

// 신규 포지션 생성과 기존 포지션 추가 매수를 한 함수에서 처리합니다.
function addToPosition({ state, market, symbol, amountUsd, now, reason, macroSignal }) {
  const addedQuantity = amountUsd / market.lastPrice;
  const existing = state.positions[symbol];

  state.cashUsd = roundUsd(state.cashUsd - amountUsd);
  if (existing) {
    const quantity = existing.quantity + addedQuantity;
    const costUsd = roundUsd(existing.costUsd + amountUsd);
    existing.quantity = quantity;
    // 여러 번 매수했을 때 청산 기준이 되는 평균 매입가를 다시 계산합니다.
    existing.entryPrice = costUsd / quantity;
    existing.costUsd = costUsd;
    existing.peakPrice = Math.max(existing.peakPrice, market.lastPrice);
    existing.lastPrice = market.lastPrice;
    existing.lastPriceAt = market.timestamp ?? now.toISOString();
  } else {
    state.positions[symbol] = {
      symbol,
      openedByAgent: true,
      quantity: addedQuantity,
      entryPrice: market.lastPrice,
      peakPrice: market.lastPrice,
      lastPrice: market.lastPrice,
      lastPriceAt: market.timestamp ?? now.toISOString(),
      costUsd: amountUsd,
      openedAt: now.toISOString(),
    };
  }

  state.trades.push({
    side: "BUY",
    symbol,
    quantity: addedQuantity,
    price: market.lastPrice,
    amountUsd,
    reason,
    macroRegime: macroSignal?.regime,
    macroScore: macroSignal?.score,
    executedAt: now.toISOString(),
  });
}

function compactMacroSignal(signal) {
  return {
    fetchedAt: signal.fetchedAt,
    evaluatedAt: signal.evaluatedAt,
    regime: signal.regime,
    score: signal.score,
    targetAllocation: signal.targetAllocation,
    indicators: signal.indicators,
    reasons: signal.reasons,
    source: signal.source,
    stale: Boolean(signal.stale),
  };
}

function validWeight(value) {
  const weight = Number(value);
  return Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0;
}

export function summarizePaperState(state, prices = new Map()) {
  // 현금 + 보유 ETF 평가액을 합쳐 현재 가상 자산과 총손익을 계산합니다.
  const priceMap = prices instanceof Map
    ? prices
    : new Map(prices.map((price) => [price.symbol, price]));
  const positions = Object.values(state.positions).map((position) => {
    const currentPrice = priceMap.get(position.symbol)?.lastPrice ?? position.lastPrice ?? position.entryPrice;
    const marketValueUsd = roundUsd(position.quantity * currentPrice);
    return {
      symbol: position.symbol,
      costUsd: position.costUsd,
      marketValueUsd,
      unrealizedPnlUsd: roundUsd(marketValueUsd - position.costUsd),
    };
  });
  const marketValueUsd = roundUsd(positions.reduce((sum, item) => sum + item.marketValueUsd, 0));
  const equityUsd = roundUsd(state.cashUsd + marketValueUsd);
  return {
    fundingKrw: state.funding.fundingKrw,
    fundedUsd: state.funding.fundedUsd,
    cashUsd: state.cashUsd,
    marketValueUsd,
    equityUsd,
    realizedPnlUsd: state.realizedPnlUsd,
    totalPnlUsd: roundUsd(equityUsd - state.funding.fundedUsd),
    tradeCount: state.trades.length,
    positions,
  };
}

function roundUsd(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
