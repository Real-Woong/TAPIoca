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
    // 청산 직후 같은 종목을 곧바로 다시 사지 않도록 종목별 재진입 시각을 기록합니다.
    symbolCooldowns: {},
    // 일일·누적 손실 한도를 실제 신규매수 중단 조건으로 사용합니다.
    risk: {
      dailyStartEquityUsd: {},
      lastEquityUsd: budget.fundedUsd,
      lastCheck: null,
    },
    completedSymbols: [],
    dailyBuyUsd: {},
    trades: [],
    // 마지막으로 매매 판단에 사용한 FRED + X 통합 신호를 보관합니다.
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
  prepareRiskState(state, priceMap, dateKey);
  state.symbolCooldowns ??= {};
  state.completedSymbols ??= [];

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
      if (!state.completedSymbols.includes(symbol)) state.completedSymbols.push(symbol);
      state.symbolCooldowns[symbol] = {
        reason: exit.reason,
        until: new Date(
          now.getTime() + policy.reentryCooldownHours * 60 * 60 * 1000,
        ).toISOString(),
      };
      delete state.positions[symbol];
    }
  }

  if (macroSignal) {
    // 상태 파일에는 API 원본 전체가 아니라 실제 판단에 사용한 요약만 저장합니다.
    state.macro = compactMacroSignal(macroSignal);
  }

  const risk = evaluateRiskLimits(state, priceMap, policy, dateKey, now);
  if (risk.buyPaused) {
    decisions.push({
      symbol: "PORTFOLIO",
      action: "PAUSE_BUY",
      reason: risk.reason,
      totalPnlUsd: risk.totalPnlUsd,
      dailyPnlUsd: risk.dailyPnlUsd,
    });
  } else if (macroSignal) {
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
  const summary = summarizePaperState(state, priceMap);
  state.risk.lastEquityUsd = summary.equityUsd;
  return { state, decisions, summary };
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
    if (dailyRemaining < policy.minOrderUsd || state.cashUsd < policy.minOrderUsd) break;

    const summary = summarizePaperState(state, priceMap);
    // 목표 현금 비중을 침범하지 않도록 앞으로 더 투자할 수 있는 총액을 계산합니다.
    const investableRemaining = roundUsd(
      summary.equityUsd * (1 - cashWeight) - summary.marketValueUsd,
    );
    if (investableRemaining < policy.minOrderUsd) break;

    const candidates = state.watchlist
      // 청산 직후 쿨다운 동안만 재진입을 막고, 이후에는 목표 비중에 다시 참여시킵니다.
      .filter((symbol) => !isSymbolCoolingDown(state, symbol, now))
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
      .filter((candidate) => candidate && candidate.deficitUsd >= policy.minOrderUsd)
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
      minOrderUsd: policy.minOrderUsd,
      requestedUsd,
    });
    if (amountUsd < policy.minOrderUsd) break;

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
    if (state.positions[symbol] || isSymbolCoolingDown(state, symbol, now)) continue;
    const market = priceMap.get(symbol);
    if (!market) continue;
    const dailyRemaining = Math.max(0, policy.maxDailyBuyUsd - dailyBought);
    if (dailyRemaining < policy.minOrderUsd || state.cashUsd < policy.minOrderUsd) break;

    const amountUsd = sizePaperOrder({
      cashUsd: state.cashUsd,
      maxOrderUsd: policy.maxOrderUsd,
      minOrderUsd: policy.minOrderUsd,
      requestedUsd: dailyRemaining,
    });
    if (amountUsd < policy.minOrderUsd) break;

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
    signalSource: signal.signalSource,
    macroScore: signal.macroScore,
    sentimentContribution: signal.sentimentContribution,
    sentiment: signal.sentiment,
    baseScore: signal.baseScore,
    macdContribution: signal.macdContribution,
    macd: signal.macd,
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
  const unrealizedPnlUsd = roundUsd(
    positions.reduce((sum, item) => sum + item.unrealizedPnlUsd, 0),
  );
  const equityUsd = roundUsd(state.cashUsd + marketValueUsd);
  return {
    fundingKrw: state.funding.fundingKrw,
    fundedUsd: state.funding.fundedUsd,
    cashUsd: state.cashUsd,
    marketValueUsd,
    equityUsd,
    realizedPnlUsd: state.realizedPnlUsd,
    unrealizedPnlUsd,
    totalPnlUsd: roundUsd(equityUsd - state.funding.fundedUsd),
    tradeCount: state.trades.length,
    positions,
  };
}

function prepareRiskState(state, priceMap, dateKey) {
  const currentEquityUsd = summarizePaperState(state, priceMap).equityUsd;
  state.risk ??= {
    dailyStartEquityUsd: {},
    lastEquityUsd: currentEquityUsd,
    lastCheck: null,
  };
  state.risk.dailyStartEquityUsd ??= {};
  if (state.risk.dailyStartEquityUsd[dateKey] === undefined) {
    const previousEquity = Number(state.risk.lastEquityUsd);
    state.risk.dailyStartEquityUsd[dateKey] = Number.isFinite(previousEquity)
      ? previousEquity
      : currentEquityUsd;
  }
}

function evaluateRiskLimits(state, priceMap, policy, dateKey, now) {
  const summary = summarizePaperState(state, priceMap);
  const dailyStartEquityUsd = Number(state.risk.dailyStartEquityUsd[dateKey]);
  const dailyPnlUsd = roundUsd(summary.equityUsd - dailyStartEquityUsd);
  let reason = null;

  if (summary.totalPnlUsd <= -policy.maxTotalLossUsd) {
    reason = "TOTAL_LOSS_LIMIT";
  } else if (dailyPnlUsd <= -policy.maxDailyLossUsd) {
    reason = "DAILY_LOSS_LIMIT";
  }

  const result = {
    checkedAt: now.toISOString(),
    dailyStartEquityUsd,
    equityUsd: summary.equityUsd,
    totalPnlUsd: summary.totalPnlUsd,
    dailyPnlUsd,
    buyPaused: Boolean(reason),
    reason,
  };
  state.risk.lastCheck = result;
  return result;
}

function isSymbolCoolingDown(state, symbol, now) {
  const until = state.symbolCooldowns?.[symbol]?.until;
  if (!until) return false;
  const untilMs = new Date(until).getTime();
  if (!Number.isFinite(untilMs) || now.getTime() >= untilMs) {
    delete state.symbolCooldowns[symbol];
    return false;
  }
  return true;
}

function roundUsd(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
