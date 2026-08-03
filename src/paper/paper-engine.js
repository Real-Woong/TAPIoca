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
    // 지금까지 부과된 누적 거래비용(수수료+FX+슬리피지 가정)입니다.
    feesUsd: 0,
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
    // 같은 원금을 벤치마크 종목에 한 번에 넣고 그대로 보유했을 때의 성과입니다.
    // 전략이 단순 매수후보유를 실제로 이기는지 비교하는 기준선입니다.
    benchmark: null,
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
  state.feesUsd ??= 0;
  const costRate = Number(policy.tradeCostRate) || 0;
  // 첫 실행에 벤치마크(매수후보유)를 개설하고, 이후에는 최신가로 평가액만 갱신합니다.
  updateBenchmark(state, priceMap, now, costRate);

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
      const grossUsd = position.quantity * market.lastPrice;
      const feeUsd = roundUsd(grossUsd * costRate);
      const proceedsUsd = roundUsd(grossUsd - feeUsd);
      const pnlUsd = roundUsd(proceedsUsd - position.costUsd);
      state.cashUsd = roundUsd(state.cashUsd + proceedsUsd);
      state.realizedPnlUsd = roundUsd(state.realizedPnlUsd + pnlUsd);
      state.feesUsd = roundUsd(state.feesUsd + feeUsd);
      state.trades.push({
        side: "SELL",
        symbol,
        quantity: position.quantity,
        price: market.lastPrice,
        amountUsd: proceedsUsd,
        feeUsd,
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

  // 레짐이 확정되기 전까지는 직전 확정 레짐의 목표 비중을 유지합니다.
  // 이 아래의 매수·매도는 모두 확정된 신호(effectiveSignal)만 사용합니다.
  const effectiveSignal = macroSignal
    ? applyRegimeHysteresis(state, macroSignal, policy, now)
    : macroSignal;

  if (effectiveSignal) {
    // 상태 파일에는 API 원본 전체가 아니라 실제 판단에 사용한 요약만 저장합니다.
    state.macro = compactMacroSignal(effectiveSignal);
    // 목표 비중을 초과한 보유분은 손실 한도(매수 중단)와 무관하게 먼저 덜어내
    // 익스포저를 낮춥니다. 매수만 하고 팔지 않던 비대칭 문제를 해결합니다.
    if (canRebalanceToday(state, policy, effectiveSignal.regime, dateKey)) {
      const sold = runRebalanceSells({
        state, priceMap, policy, now, decisions, macroSignal: effectiveSignal,
      });
      if (sold > 0) recordRebalance(state, effectiveSignal.regime, dateKey);
    }
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
  } else if (effectiveSignal) {
    dailyBought = runMacroTargetBuys({
      state,
      priceMap,
      policy,
      now,
      dailyBought,
      decisions,
      macroSignal: effectiveSignal,
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

/**
 * 레짐이 정해진 횟수만큼 연속으로 유지될 때만 목표 비중을 바꿉니다.
 * 통합 점수가 임계선 근처에서 진동하면 15분마다 주식 비중이 40%↔70%로 튀고,
 * 매수와 리밸런싱 매도가 같은 날 서로를 되돌려 거래비용만 쌓입니다.
 */
function applyRegimeHysteresis(state, macroSignal, policy, now) {
  const required = Math.max(1, Number(policy.regimeConfirmCycles) || 1);
  const tracker = (state.regimeTracker ??= {});
  const observed = macroSignal.regime;

  // 첫 실행이거나 확정 레짐이 없으면 바로 채택합니다.
  if (!tracker.active || observed === tracker.active) {
    confirmRegime(tracker, macroSignal, now);
    return macroSignal;
  }

  tracker.pendingCycles = tracker.pending === observed ? tracker.pendingCycles + 1 : 1;
  tracker.pending = observed;

  if (tracker.pendingCycles >= required) {
    confirmRegime(tracker, macroSignal, now);
    return macroSignal;
  }

  // 아직 확정 전입니다. 점수·진단은 최신값을 그대로 보여주되
  // 목표 비중만 직전 확정 레짐의 것으로 되돌립니다.
  return {
    ...macroSignal,
    regime: tracker.active,
    targetAllocation: tracker.allocation ?? macroSignal.targetAllocation,
    pendingRegime: observed,
    pendingRegimeCycles: `${tracker.pendingCycles}/${required}`,
    reasons: [
      ...(macroSignal.reasons ?? []),
      `레짐 확정 대기: ${observed} ${tracker.pendingCycles}/${required}회 — ` +
        `${tracker.active} 비중 유지`,
    ],
  };
}

/** 확정 레짐과 그때의 목표 비중을 저장합니다. 대기 중에는 이 비중을 그대로 씁니다. */
function confirmRegime(tracker, macroSignal, now) {
  const changed = tracker.active !== macroSignal.regime;
  tracker.active = macroSignal.regime;
  if (changed || !tracker.activeSince) tracker.activeSince = now.toISOString();
  tracker.allocation = macroSignal.targetAllocation;
  tracker.pending = null;
  tracker.pendingCycles = 0;
}

/** 같은 레짐에서는 하루 정해진 횟수까지만 리밸런싱합니다. 레짐이 바뀌면 즉시 다시 허용합니다. */
function canRebalanceToday(state, policy, regime, dateKey) {
  const limit = Math.max(1, Number(policy.maxRebalancesPerDay) || 1);
  const log = state.rebalanceLog;
  if (!log || log.date !== dateKey || log.regime !== regime) return true;
  return Number(log.count ?? 0) < limit;
}

function recordRebalance(state, regime, dateKey) {
  const log = state.rebalanceLog;
  state.rebalanceLog =
    log && log.date === dateKey && log.regime === regime
      ? { ...log, count: Number(log.count ?? 0) + 1 }
      : { date: dateKey, regime, count: 1 };
}

// 목표 비중을 밴드 이상 초과한 ETF를 목표선까지 덜어내 위험을 낮춥니다.
// 매수와 달리 방어적 레짐 전환 시 즉시 익스포저를 줄여야 하므로 1회 주문
// 상한(maxOrderUsd)과 일일 매수 한도를 적용하지 않고 초과분을 한 번에 정리합니다.
function runRebalanceSells({ state, priceMap, policy, now, decisions, macroSignal }) {
  const allocation = macroSignal.targetAllocation ?? {};
  const summary = summarizePaperState(state, priceMap);
  // 자산 대비 밴드보다 큰 초과분만 정리해 소액 잔챙이 매매를 막습니다.
  const band = tradeBand(policy, summary.equityUsd);
  let sold = 0;

  for (const symbol of state.watchlist) {
    const position = state.positions[symbol];
    // 이 에이전트가 연 포지션만 조정합니다. Toss 기존 보유분은 건드리지 않습니다.
    if (!position || !position.openedByAgent) continue;
    const market = priceMap.get(symbol);
    if (!market) continue;

    const price = market.lastPrice;
    const currentValue = position.quantity * price;
    const targetValue = summary.equityUsd * validWeight(allocation[symbol]);
    if (roundUsd(currentValue - targetValue) < band) continue;

    // 초과분만큼만 부분 매도하되, 남는 평가액이 최소 주문보다 작으면 전량 정리합니다.
    // 목표 비중이 0인 종목은 전량 매도됩니다.
    let sellQuantity = Math.min(currentValue - targetValue, currentValue) / price;
    if ((position.quantity - sellQuantity) * price < policy.minOrderUsd) {
      sellQuantity = position.quantity;
    }

    const grossUsd = sellQuantity * price;
    const feeUsd = roundUsd(grossUsd * (Number(policy.tradeCostRate) || 0));
    const proceedsUsd = roundUsd(grossUsd - feeUsd);
    // 평균 원가를 매도 수량 비율만큼 덜어내 실현손익을 정확히 계산합니다.
    const soldCostUsd = roundUsd(position.costUsd * (sellQuantity / position.quantity));
    const pnlUsd = roundUsd(proceedsUsd - soldCostUsd);

    state.cashUsd = roundUsd(state.cashUsd + proceedsUsd);
    state.realizedPnlUsd = roundUsd(state.realizedPnlUsd + pnlUsd);
    state.feesUsd = roundUsd((state.feesUsd ?? 0) + feeUsd);

    const reason = `MACRO_${macroSignal.regime}_REBALANCE_SELL`;
    state.trades.push({
      side: "SELL",
      symbol,
      quantity: sellQuantity,
      price,
      amountUsd: proceedsUsd,
      feeUsd,
      pnlUsd,
      reason,
      macroRegime: macroSignal.regime,
      macroScore: macroSignal.score,
      executedAt: now.toISOString(),
    });

    if (sellQuantity >= position.quantity) {
      // 부분 리밸런싱은 재진입 쿨다운을 걸지 않습니다. 목표 비중이 다시 늘면 곧바로 매수합니다.
      delete state.positions[symbol];
    } else {
      position.quantity -= sellQuantity;
      position.costUsd = roundUsd(position.costUsd - soldCostUsd);
      position.lastPrice = price;
      position.lastPriceAt = market.timestamp ?? now.toISOString();
    }

    decisions.push({
      symbol,
      action: "SELL",
      reason,
      amountUsd: proceedsUsd,
      targetWeight: validWeight(allocation[symbol]),
    });
    sold += 1;
  }

  return sold;
}

/**
 * 매수·매도에 공통으로 쓰는 무거래 밴드입니다.
 * 목표에서 이만큼 벗어나야 주문을 냅니다. 예전에는 매도에만 밴드가 있고 매수는
 * 결손 $1에서 트리거돼, 같은 날 매수 $10과 리밸런싱 매도 $10이 맞물렸습니다.
 */
function tradeBand(policy, equityUsd) {
  return Math.max(policy.minOrderUsd, (Number(policy.rebalanceBandRate) || 0) * equityUsd);
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
      // 매도와 같은 밴드를 적용합니다. 목표에서 조금 벗어난 정도로는 매수하지 않습니다.
      .filter((candidate) => candidate && candidate.deficitUsd >= tradeBand(policy, summary.equityUsd))
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
      costRate: Number(policy.tradeCostRate) || 0,
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
      costRate: Number(policy.tradeCostRate) || 0,
    });
    dailyBought = roundUsd(dailyBought + amountUsd);
    decisions.push({ symbol, action: "BUY", reason: "INITIAL_PAPER_ENTRY", amountUsd });
  }
  return dailyBought;
}

// 신규 포지션 생성과 기존 포지션 추가 매수를 한 함수에서 처리합니다.
function addToPosition({ state, market, symbol, amountUsd, now, reason, macroSignal, costRate = 0 }) {
  // 거래비용은 같은 현금으로 살 수 있는 수량을 줄이는 방식으로 반영합니다.
  // 현금은 amountUsd 전액이 나가고, 실제로 받는 주식은 비용만큼 적어집니다(즉시 미실현손실 = 비용).
  const feeUsd = roundUsd(amountUsd * costRate);
  const addedQuantity = (amountUsd - feeUsd) / market.lastPrice;
  const existing = state.positions[symbol];

  state.cashUsd = roundUsd(state.cashUsd - amountUsd);
  state.feesUsd = roundUsd((state.feesUsd ?? 0) + feeUsd);
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
    feeUsd,
    reason,
    macroRegime: macroSignal?.regime,
    macroScore: macroSignal?.score,
    executedAt: now.toISOString(),
  });
}

// 벤치마크는 원금 전액을 기준 종목(기본 VTI)에 한 번 넣고 그대로 두는 매수후보유입니다.
// 공정한 비교를 위해 진입 1회분 거래비용은 벤치마크도 동일하게 부담합니다.
function updateBenchmark(state, priceMap, now, costRate = 0) {
  const preferred = state.benchmark?.symbol
    ?? (priceMap.has("VTI") ? "VTI" : (state.watchlist ?? []).find((symbol) => priceMap.has(symbol)));
  if (!preferred) return;
  const market = priceMap.get(preferred);
  const price = Number(market?.lastPrice);
  if (!Number.isFinite(price) || price <= 0) return;

  if (!state.benchmark) {
    const fundedUsd = state.funding.fundedUsd;
    state.benchmark = {
      symbol: preferred,
      quantity: (fundedUsd * (1 - costRate)) / price,
      entryPriceUsd: price,
      fundedUsd,
      startedAt: now.toISOString(),
      lastPrice: price,
      lastPriceAt: market.timestamp ?? now.toISOString(),
    };
  } else if (state.benchmark.symbol === preferred) {
    state.benchmark.lastPrice = price;
    state.benchmark.lastPriceAt = market.timestamp ?? now.toISOString();
  }
}

function summarizeBenchmark(state, priceMap) {
  const benchmark = state.benchmark;
  if (!benchmark) return null;
  const price = priceMap.get(benchmark.symbol)?.lastPrice ?? benchmark.lastPrice ?? benchmark.entryPriceUsd;
  const valueUsd = roundUsd(benchmark.quantity * price);
  const pnlUsd = roundUsd(valueUsd - benchmark.fundedUsd);
  return {
    symbol: benchmark.symbol,
    valueUsd,
    pnlUsd,
    returnPct: benchmark.fundedUsd > 0 ? round3((pnlUsd / benchmark.fundedUsd) * 100) : 0,
  };
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
    trendContribution: signal.trendContribution,
    trend: signal.trend,
    macdContribution: signal.macdContribution,
    macd: signal.macd,
    volatilityAnnualized: signal.volatilityAnnualized,
    exposureMultiplier: signal.exposureMultiplier,
    layers: signal.layers,
    stale: Boolean(signal.stale),
    ...(signal.pendingRegime
      ? { pendingRegime: signal.pendingRegime, pendingRegimeCycles: signal.pendingRegimeCycles }
      : {}),
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
  const totalPnlUsd = roundUsd(equityUsd - state.funding.fundedUsd);
  const benchmark = summarizeBenchmark(state, priceMap);
  return {
    fundingKrw: state.funding.fundingKrw,
    fundedUsd: state.funding.fundedUsd,
    cashUsd: state.cashUsd,
    marketValueUsd,
    equityUsd,
    realizedPnlUsd: state.realizedPnlUsd,
    unrealizedPnlUsd,
    totalPnlUsd,
    feesUsd: roundUsd(state.feesUsd ?? 0),
    // 전략 수익률과 벤치마크 대비 초과성과(alpha)를 함께 보여줍니다.
    returnPct: state.funding.fundedUsd > 0
      ? round3((totalPnlUsd / state.funding.fundedUsd) * 100)
      : 0,
    benchmark,
    alphaUsd: benchmark ? roundUsd(totalPnlUsd - benchmark.pnlUsd) : null,
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

function round3(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}
