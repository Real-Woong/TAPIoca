import { evaluateExit } from "./exit-strategy.js";
import { sizePaperOrder } from "./trading-budget.js";
import { ALLOCATIONS } from "../sentiment/market-signal.js";

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
    // 방어 매도로 빠져나온 현금입니다. 이 돈이 목표 비중으로 되돌아갈 때는
    // 일일 매수 한도와 1회 주문 상한을 적용하지 않습니다. 매도는 1사이클에 전량,
    // 매수는 하루 $10씩이던 비대칭이 신호 진동 위에서 확정적인 손실을 만들었습니다.
    redeployableUsd: 0,
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
  // 지키는 것은 **장부**입니다. 이 함수는 가상 지갑만 건드리므로 실계좌 장부를
  // 넘겨받으면 멈춥니다.
  //
  // **정책이 LIVE인지는 보지 않습니다.** 예전에는 봤고, 그것이 9/1에
  // `LIVE_TRADING=true`를 켠 첫 사이클을 죽였습니다. 8/19에 실행기가 LIVE에서도
  // PAPER 장부를 그대로 돌리도록 바뀌었는데(`paper-runner.js`) 이 줄이 같이
  // 안 바뀌었습니다. 두 장부를 같은 신호로 나란히 돌려 그 차이를 봐야 체결
  // 비용의 실측값이 나옵니다 — LIVE에서 이 계산을 막으면 비교 대상이 사라집니다.
  // 실주문을 낼지 말지는 여기가 아니라 `runLiveCycle`이 정합니다.
  if (state.mode !== "PAPER") {
    throw new Error("PAPER 엔진은 PAPER 장부에서만 실행할 수 있습니다.");
  }

  const dateKey = now.toISOString().slice(0, 10);
  const priceMap = new Map(prices.map((price) => [price.symbol, price]));
  const decisions = [];
  let dailyBought = Number(state.dailyBuyUsd[dateKey] ?? 0);
  prepareRiskState(state, priceMap, dateKey);
  state.symbolCooldowns ??= {};
  state.completedSymbols ??= [];
  state.feesUsd ??= 0;
  state.redeployableUsd ??= 0;
  const costRate = Number(policy.tradeCostRate) || 0;
  // 첫 실행에 벤치마크(매수후보유)를 개설하고, 이후에는 최신가로 평가액만 갱신합니다.
  updateBenchmark(state, priceMap, now, costRate);
  updatePolicyBenchmark(state, priceMap, now, costRate);

  // 손실 한도는 **경고**입니다. 매매 동작을 바꾸지 않습니다.
  //
  // 예전에는 한도에 닿으면 매매를 멈췄고, 두 방식 모두 아무것도 안 하는 것보다
  // 나빴습니다. 매수만 멈추면 매도가 자산을 현금으로 바꿔 흡수 상태가 되고
  // (20년 합성 경로에서 CAGR -0.68%, 최종 보유 0종목), 전부 멈추면 폭락 중에
  // 위험관리를 꺼버려 낙폭이 커집니다(실데이터 20년에서 MDD 29.8% → 51.6%).
  //
  // 한도는 정의상 폭락 중에만 걸리는데, 그때는 목표 비중 레이어가 익스포저를
  // 줄이며 제 일을 하고 있는 시점입니다. 그 위에 조잡한 두 번째 위험 시스템을
  // 올리면 첫 번째를 최악의 타이밍에 덮어씁니다. 그래서 판단은 사람에게 넘기고
  // 봇은 알리기만 합니다.
  const risk = evaluateRiskLimits(state, priceMap, policy, dateKey, now);
  if (risk.alert) {
    decisions.push({
      symbol: "PORTFOLIO",
      action: "RISK_ALERT",
      reason: risk.reason,
      totalPnlUsd: risk.totalPnlUsd,
      dailyPnlUsd: risk.dailyPnlUsd,
    });
  }

  // 매수보다 청산 판단을 먼저 수행해 손절/수익실현 조건을 우선 처리합니다.
  for (const [symbol, position] of Object.entries(state.positions)) {
    const market = priceMap.get(symbol);
    if (!market) continue;
    // 변동성 연동 손절을 쓰면 이번 사이클의 연율 변동성이 문턱을 정합니다.
    const exit = evaluateExit(
      position, market.lastPrice, policy, now, macroSignal?.volatilityAnnualized,
    );
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
      state.redeployableUsd = roundUsd(state.redeployableUsd + proceedsUsd);
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
    if (canRebalanceToday(state, policy, effectiveSignal.regime, dateKey)) {
      const sold = runRebalanceSells({
        state, priceMap, policy, now, decisions, macroSignal: effectiveSignal,
      });
      if (sold > 0) recordRebalance(state, effectiveSignal.regime, dateKey);
    }
  }

  if (effectiveSignal) {
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
  let sold = 0;

  for (const symbol of state.watchlist) {
    const position = state.positions[symbol];
    // 이 에이전트가 연 포지션만 조정합니다. Toss 기존 보유분은 건드리지 않습니다.
    if (!position || !position.openedByAgent) continue;
    const market = priceMap.get(symbol);
    if (!market) continue;

    const price = market.lastPrice;
    const currentValue = position.quantity * price;
    const targetValue = targetValueUsd(policy, validWeight(allocation[symbol]), summary.equityUsd);
    // 초과분이 밴드보다 클 때만 정리해 소액 잔챙이 매매를 막습니다.
    if (roundUsd(currentValue - targetValue) < exitBand(policy, summary.equityUsd, targetValue)) {
      continue;
    }

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
    // 이 매도액은 목표 비중이 다시 오르면 같은 속도로 되돌아갈 수 있어야 합니다.
    state.redeployableUsd = roundUsd((state.redeployableUsd ?? 0) + proceedsUsd);

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

/**
 * 매도 쪽 밴드입니다. 기본값은 매수와 같아 대칭 밴드가 그대로 동작합니다.
 *
 * 매수와 나눠놓은 이유는 밴드의 효과가 방향에 따라 다르기 때문입니다. 진입은
 * 목표 전체가 결손이라 밴드를 넘지만, 되돌아올 때는 목표가 내려간 만큼만
 * 초과분이라 밴드에 못 미칩니다. 매수 밴드를 좁히면 잔챙이 매매가 돌아오므로,
 * 고칠 곳은 매도 쪽뿐입니다.
 */
function exitBand(policy, equityUsd, targetValueUsd) {
  const absoluteUsd = (Number(policy.rebalanceExitBandRate) || 0) * equityUsd;
  // 자산 대비 밴드 하나로는 크기가 다른 포지션을 같이 다룰 수 없습니다. 자산의
  // 5%는 70% 포지션에는 7% 이탈이지만 1.6% 포지션에는 312% 이탈입니다.
  // 목표 대비 상한을 함께 걸면 작은 포지션에서만 이쪽이 먼저 걸립니다.
  const driftUsd = policy.targetDriftCap === null
    ? Infinity
    : Number(policy.targetDriftCap) * targetValueUsd;
  return Math.max(policy.minOrderUsd, Math.min(absoluteUsd, driftUsd));
}

/**
 * 목표 비중을 금액으로 바꾸되, 밴드보다 작은 목표는 0으로 봅니다.
 * 밴드 안에 통째로 들어가는 목표는 도달할 수도 유지할 수도 없으므로,
 * "조금 들고 있기"가 실제로는 "튀었을 때 들어가서 안 나오기"가 됩니다.
 */
function targetValueUsd(policy, weight, equityUsd) {
  const floor = policy.minPositionRate;
  if (floor !== null && weight > 0 && weight < floor) return 0;
  return equityUsd * weight;
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
  // 같은 사이클에서 한 종목을 여러 번 사면 체결 기록도 한 건으로 합칩니다.
  // $20 매수가 $5·$5·$5·$1.44로 쪼개져도 실익은 없고, 실제 증권사의 건당
  // 최소수수료에서는 그대로 비용이 됩니다.
  const boughtBySymbol = new Map();

  while (true) {
    const dailyRemaining = Math.max(0, policy.maxDailyBuyUsd - dailyBought);
    // 방어 매도로 빠져나온 현금은 되돌아올 때 한도를 적용받지 않습니다.
    // 일일 한도는 "지갑을 하루에 얼마나 새로 투입하는가"만 제한하면 됩니다.
    const redeployableUsd = Math.max(
      0,
      Math.min(Number(state.redeployableUsd) || 0, state.cashUsd),
    );
    const buyingPowerUsd = roundUsd(redeployableUsd + dailyRemaining);
    if (buyingPowerUsd < policy.minOrderUsd || state.cashUsd < policy.minOrderUsd) break;
    // 재투입분이 있으면 1회 주문 상한도 그만큼 풀어 매도와 같은 속도로 복귀합니다.
    const orderCeilingUsd = redeployableUsd >= policy.minOrderUsd
      ? buyingPowerUsd
      : policy.maxOrderUsd;

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
        // 매도와 같은 목표를 씁니다. 매수만 작은 목표를 인정하면 산 다음 날
        // 팔 수 없는 포지션이 다시 생깁니다.
        const targetValue = targetValueUsd(policy, weight, summary.equityUsd);
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
      buyingPowerUsd,
      investableRemaining,
      candidate.deficitUsd,
    );
    const amountUsd = sizePaperOrder({
      cashUsd: state.cashUsd,
      maxOrderUsd: orderCeilingUsd,
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
      mergeSameCycle: true,
    });
    // 재투입분을 먼저 쓰고, 모자란 만큼만 일일 한도에서 차감합니다.
    const fromRedeployUsd = Math.min(amountUsd, redeployableUsd);
    state.redeployableUsd = roundUsd(redeployableUsd - fromRedeployUsd);
    dailyBought = roundUsd(dailyBought + (amountUsd - fromRedeployUsd));
    boughtBySymbol.set(
      candidate.symbol,
      roundUsd((boughtBySymbol.get(candidate.symbol) ?? 0) + amountUsd),
    );
  }

  for (const [symbol, amountUsd] of boughtBySymbol) {
    decisions.push({
      symbol,
      action: "BUY",
      reason: `MACRO_${macroSignal.regime}_TARGET_BUY`,
      amountUsd,
      targetWeight: validWeight(allocation[symbol]),
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
function addToPosition({
  state, market, symbol, amountUsd, now, reason, macroSignal, costRate = 0,
  mergeSameCycle = false,
}) {
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

  const executedAt = now.toISOString();
  const twin = mergeSameCycle
    ? findSameCycleBuy(state.trades, symbol, reason, executedAt)
    : null;
  if (twin) {
    // 같은 사이클·같은 종목·같은 사유의 체결은 한 건으로 합칩니다.
    // 사이클 안에서는 가격이 동일하므로 수량과 금액만 더하면 됩니다.
    twin.quantity += addedQuantity;
    twin.amountUsd = roundUsd(twin.amountUsd + amountUsd);
    twin.feeUsd = roundUsd(twin.feeUsd + feeUsd);
    return;
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
    executedAt,
  });
}

// 같은 실행 시각(=같은 사이클)의 체결만 뒤에서부터 훑습니다.
// 시각이 달라지는 순간 이전 사이클이므로 더 볼 필요가 없습니다.
function findSameCycleBuy(trades, symbol, reason, executedAt) {
  for (let index = trades.length - 1; index >= 0; index -= 1) {
    const trade = trades[index];
    if (trade.executedAt !== executedAt) return null;
    if (trade.side === "BUY" && trade.symbol === symbol && trade.reason === reason) return trade;
  }
  return null;
}

// 벤치마크는 **개설일의 지갑 자산**을 기준 종목(기본 VTI)에 한 번 넣고 그대로
// 두는 매수후보유입니다. 공정한 비교를 위해 진입 1회분 거래비용은 벤치마크도
// 동일하게 부담합니다.
function updateBenchmark(state, priceMap, now, costRate = 0) {
  const preferred = state.benchmark?.symbol
    ?? (priceMap.has("VTI") ? "VTI" : (state.watchlist ?? []).find((symbol) => priceMap.has(symbol)));
  if (!preferred) return;
  const market = priceMap.get(preferred);
  const price = Number(market?.lastPrice);
  if (!Number.isFinite(price) || price <= 0) return;

  if (!state.benchmark) {
    // 개설 시점의 지갑 자산을 함께 남깁니다. 이 값이 없으면 초과성과를 낼 때
    // **구간이 다른 두 손익을 빼게 됩니다.** 지갑 손익은 자금 투입일부터,
    // 기준선 손익은 개설일부터라서, 그 사이에 벌어진 손익이 통째로 한쪽에만
    // 실립니다. 개설 전에 재야 하므로 state.benchmark를 넣기 전에 계산합니다.
    const walletEquityUsdAtStart = summarizePaperState(state, priceMap).equityUsd;
    const fundedUsd = benchmarkCapital(walletEquityUsdAtStart, state.funding.fundedUsd);
    state.benchmark = {
      symbol: preferred,
      quantity: (fundedUsd * (1 - costRate)) / price,
      entryPriceUsd: price,
      fundedUsd,
      startedAt: now.toISOString(),
      walletEquityUsdAtStart,
      walletEquityUsdAtStartSource: "OPEN",
      lastPrice: price,
      lastPriceAt: market.timestamp ?? now.toISOString(),
    };
  } else if (state.benchmark.symbol === preferred) {
    state.benchmark.lastPrice = price;
    state.benchmark.lastPriceAt = market.timestamp ?? now.toISOString();
  }
}

// 두 번째 벤치마크: 같은 종목·같은 비중을 신호 없이 그대로 들고 있는 경우입니다.
//
// VTI 100%와만 비교하면 "현금을 들고 있어서 뒤처진 것"과 "타이밍이 틀려서 뒤처진 것"이
// 한 숫자에 섞입니다. 그렇다고 방어 중일 때 alpha를 면제해 주면 벤치마크가 우리
// 행동에 따라 움직이게 되고, 방어가 틀렸을 때 그 사실을 영영 못 보게 됩니다.
//
// 그래서 벤치마크를 고치는 대신 **미리 정해진 벤치마크를 하나 더** 둡니다.
// 비중은 NEUTRAL 앵커(VTI 70·SCHD 20·현금 10)로, 우리 배분표에서 신호만 뺀 것입니다.
// 사후에 고를 수 없으므로 유리하게 조작할 여지가 없습니다.
//
// 리밸런싱은 하지 않습니다. 비중이 시간이 지나며 흘러가지만, 그 대가로 이 기준선은
// 매매 규칙을 전혀 포함하지 않게 됩니다. 순수한 "안 하기"의 결과입니다.
function updatePolicyBenchmark(state, priceMap, now, costRate = 0) {
  const mix = ALLOCATIONS.NEUTRAL;
  const symbols = Object.keys(mix).filter((symbol) => symbol !== "CASH" && mix[symbol] > 0);

  if (state.policyBenchmark) {
    for (const [symbol, position] of Object.entries(state.policyBenchmark.positions)) {
      const price = Number(priceMap.get(symbol)?.lastPrice);
      if (price > 0) position.lastPrice = price;
    }
    return;
  }

  // 한 종목이라도 가격이 없으면 비중이 틀어진 채로 고정되므로 개설을 미룹니다.
  if (!symbols.every((symbol) => Number(priceMap.get(symbol)?.lastPrice) > 0)) return;

  // VTI 기준선과 같은 이유로 개설 시점의 지갑 자산을 남깁니다. 이 기준선은
  // 지갑보다 한참 뒤에 열렸으므로(운영 상태에서는 20일), 이 값 없이 빼면 그
  // 20일치 손익이 통째로 초과성과에 들어갑니다.
  const walletEquityUsdAtStart = summarizePaperState(state, priceMap).equityUsd;
  const fundedUsd = benchmarkCapital(walletEquityUsdAtStart, state.funding.fundedUsd);
  const positions = {};
  for (const symbol of symbols) {
    const price = priceMap.get(symbol).lastPrice;
    const amountUsd = fundedUsd * mix[symbol];
    // 우리와 같은 진입 비용을 부담시킵니다.
    positions[symbol] = { quantity: (amountUsd * (1 - costRate)) / price, lastPrice: price };
  }
  state.policyBenchmark = {
    mix: { ...mix },
    fundedUsd,
    cashUsd: roundUsd(fundedUsd * (Number(mix.CASH) || 0)),
    positions,
    startedAt: now.toISOString(),
    walletEquityUsdAtStart,
    walletEquityUsdAtStartSource: "OPEN",
  };
}

/**
 * 기준선에 넣을 자본입니다. **투입 원금 전액이 아니라 개설일의 지갑 자산입니다.**
 *
 * 2026-08-27까지는 `funding.fundedUsd`(원금 전액)를 넣었다. 그런데 기준선은
 * 지갑보다 늦게 열린다 — VTI는 07-27, 정책믹스는 08-06인데 지갑은 07-14다.
 * 그 사이에 지갑은 이미 움직여 있었고(07-27에 $66.71 대 원금 $67.05), 그래서
 * **초과성과가 규모가 다른 둘을 뺐다.** 기준선은 0.5% 큰 자본으로 벌고 잃는다.
 *
 * ⑰에서 구간은 (b)안으로 맞췄지만(개설일부터의 지갑 손익에서만 뺀다) 규모는
 * 남겨 뒀고, 그것이 (a)안이다. **여기서 닫는다** — 개설 시점 자산으로 열면
 * 두 곡선이 같은 원금에서 출발하므로 초과성과가 순수한 차이가 된다.
 *
 * 지갑 자산을 못 재면(가격이 아직 없는 첫 사이클 같은 경우) 원금으로 물러섭니다.
 * 기준선을 아예 안 여는 것보다 낫고, 그 경우는 둘이 거의 같습니다.
 */
function benchmarkCapital(walletEquityUsdAtStart, fundedUsd) {
  return Number.isFinite(walletEquityUsdAtStart) && walletEquityUsdAtStart > 0
    ? walletEquityUsdAtStart
    : fundedUsd;
}

/**
 * 기준선이 열린 시점의 지갑 자산을 찾습니다. 초과성과를 **같은 구간에서** 빼기
 * 위한 값입니다.
 *
 * 개설 때 기록해 두는 것이 정확합니다(`walletEquityUsdAtStart`). 이미 열려 있던
 * 기준선에는 그 값이 없으므로, 위험 관리가 남긴 일별 시작 자산에서 같은 날짜를
 * 찾아 씁니다. 그 값은 개설 시각이 아니라 **그날 첫 사이클 직전**의 자산이라
 * 몇십 분 어긋나지만, 구간이 며칠~수십 일 어긋난 것을 고치는 값으로는 충분합니다.
 *
 * 둘 다 없으면 null입니다. 부르는 쪽은 그때 숫자를 만들어내지 않습니다 —
 * **틀린 숫자를 맞는 것처럼 보여주는 것이 지금 고치고 있는 문제입니다.**
 */
export function walletEquityAtBenchmarkStart(state, benchmark) {
  const recorded = Number(benchmark?.walletEquityUsdAtStart);
  if (Number.isFinite(recorded) && recorded > 0) {
    // **어떻게 알아낸 값인지 함께 돌려줍니다.** 나중에 소급해서 채운 값은
    // 개설 시각이 아니라 그날 첫 사이클 직전의 자산이라 몇십 분 어긋납니다.
    // 보고서가 그 사실을 "개설일 시작 자산 기준"으로 적으므로, 소급 기록이
    // 그 단서를 지우면 안 됩니다.
    return { equityUsd: recorded, source: benchmark.walletEquityUsdAtStartSource ?? "OPEN" };
  }

  const startedAt = benchmark?.startedAt;
  if (typeof startedAt !== "string") return null;
  // dailyStartEquityUsd의 키는 runPaperCycle과 같은 UTC 날짜입니다.
  const dayStart = Number(state.risk?.dailyStartEquityUsd?.[startedAt.slice(0, 10)]);
  if (Number.isFinite(dayStart) && dayStart > 0) return { equityUsd: dayStart, source: "DAY_START" };
  return null;
}

/**
 * 지갑과 기준선을 **겹치는 구간에서만, 같은 규모로** 뺍니다.
 *
 * 어긋남이 둘이었습니다. **구간**은 (b)안으로 닫았습니다 — 지갑 손익을 자금
 * 투입일이 아니라 기준선 개설일부터 셉니다(2026-08-27). **규모**는 (a)안으로
 * 닫았습니다 — 기준선이 원금 전액이 아니라 개설일의 지갑 자산으로 열립니다
 * (`benchmarkCapital`, 2026-09-02). 이제 두 곡선은 같은 날 같은 원금에서
 * 출발하므로 이 뺄셈이 순수한 차이입니다.
 *
 * **이미 열려 있던 기준선은 저절로 고쳐지지 않습니다.** 원금 전액으로 열린
 * 채 남아 있으므로 `paper:rebase`로 한 번 다시 재야 합니다.
 */
function alignedAlpha(state, benchmarkState, benchmarkSummary, equityUsd) {
  if (!benchmarkSummary) return null;
  const anchor = walletEquityAtBenchmarkStart(state, benchmarkState);
  if (!anchor) return { alphaUsd: null, anchorEquityUsd: null, anchorSource: null };
  return {
    alphaUsd: roundUsd((equityUsd - anchor.equityUsd) - benchmarkSummary.pnlUsd),
    anchorEquityUsd: roundUsd(anchor.equityUsd),
    anchorSource: anchor.source,
  };
}

function summarizePolicyBenchmark(state, priceMap) {
  const benchmark = state.policyBenchmark;
  if (!benchmark) return null;
  let valueUsd = Number(benchmark.cashUsd) || 0;
  for (const [symbol, position] of Object.entries(benchmark.positions)) {
    const price = Number(priceMap.get(symbol)?.lastPrice) || position.lastPrice;
    valueUsd += position.quantity * price;
  }
  valueUsd = roundUsd(valueUsd);
  const pnlUsd = roundUsd(valueUsd - benchmark.fundedUsd);
  return {
    mix: benchmark.mix,
    valueUsd,
    pnlUsd,
    returnPct: benchmark.fundedUsd > 0 ? round3((pnlUsd / benchmark.fundedUsd) * 100) : 0,
    // 이 손익이 언제부터의 것인지 함께 내보냅니다. 보고서가 이 날짜를 찍습니다.
    startedAt: benchmark.startedAt ?? null,
  };
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
    startedAt: benchmark.startedAt ?? null,
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
    sentimentFreshness: signal.sentimentFreshness,
    baseScore: signal.baseScore,
    trendContribution: signal.trendContribution,
    trend: signal.trend,
    macdContribution: signal.macdContribution,
    macd: signal.macd,
    // **가중치를 함께 남깁니다.** 보고서의 `실행 스택` 줄과 그 아래 미검증 층
    // 경고가 이 값만 읽는데(`daily-report-format.js`의 `formatStackLines`),
    // 이 화이트리스트가 2026-08-21에 그 줄이 생길 때 같이 안 바뀌어 **한 번도
    // 찍히지 않았습니다.** 기여도만 적히면 ⑬(감성 가중치가 문서는 0인데 서버만
    // 1이었던 일)을 잡으려고 만든 줄이 정작 그 상황에서 침묵합니다.
    weights: signal.weights ?? null,
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
  const policyBenchmark = summarizePolicyBenchmark(state, priceMap);
  const alphaWindow = alignedAlpha(state, state.benchmark, benchmark, equityUsd);
  const policyAlphaWindow = alignedAlpha(state, state.policyBenchmark, policyBenchmark, equityUsd);
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
    // 초과성과는 **기준선이 열린 날부터의 지갑 손익**에서 뺍니다. 예전에는
    // 자금 투입일부터의 누적손익에서 그대로 빼서, 기준선이 열리기 전 구간의
    // 손익이 초과성과로 둔갑했습니다. 구간을 못 맞추면 숫자 대신 null입니다.
    alphaUsd: alphaWindow ? alphaWindow.alphaUsd : null,
    alphaWindow,
    // 위험을 맞춘 두 번째 기준선. 이쪽 초과성과가 신호 레이어의 순수한 성적입니다.
    policyBenchmark,
    policyAlphaUsd: policyAlphaWindow ? policyAlphaWindow.alphaUsd : null,
    policyAlphaWindow,
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
    // 매매를 멈추지 않습니다. 사람이 보고 판단하라는 신호입니다.
    alert: Boolean(reason),
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
