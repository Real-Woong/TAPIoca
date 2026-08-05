const DAY_MS = 24 * 60 * 60 * 1000;

export function evaluateExit(position, currentPrice, policy, now = new Date()) {
  // 이 에이전트가 PAPER 장부에서 직접 만든 포지션만 청산 대상으로 봅니다.
  // Toss 계좌의 기존 QQQ, SPY 등은 이 함수로 들어와도 매도하지 않습니다.
  if (!position?.openedByAgent) {
    return decision("HOLD", "PROTECTED_EXISTING_POSITION");
  }

  const entryPrice = positiveNumber(position.entryPrice, "entryPrice");
  const price = positiveNumber(currentPrice, "currentPrice");
  const previousPeak = positiveNumber(position.peakPrice ?? entryPrice, "peakPrice");
  const peakPrice = Math.max(previousPeak, price);
  const returnRate = price / entryPrice - 1;
  const peakReturnRate = peakPrice / entryPrice - 1;
  const drawdownFromPeak = 1 - price / peakPrice;
  const holdingDays = Math.max(0, (now.getTime() - new Date(position.openedAt).getTime()) / DAY_MS);

  // 1순위: 진입가 기준 손절선에 도달하면 손실을 제한합니다.
  if (returnRate <= -policy.stopLossRate) {
    return decision("SELL", "STOP_LOSS", {
      peakPrice,
      returnRate,
      drawdownFromPeak,
      holdingDays,
    });
  }

  // 2순위: 일정 수익에 도달한 뒤 고점에서 밀리면 이익을 실현합니다.
  // 지수 ETF에서는 기본 비활성입니다. 목표 비중 레이어가 익스포저를 관리하는데
  // 여기서 전량 매도해 버리면 두 레이어가 서로를 되돌립니다.
  if (
    enabled(policy.trailingActivationRate) &&
    enabled(policy.trailingDrawdownRate) &&
    peakReturnRate >= policy.trailingActivationRate &&
    drawdownFromPeak >= policy.trailingDrawdownRate
  ) {
    return decision("SELL", "TRAILING_PROFIT", {
      peakPrice,
      returnRate,
      drawdownFromPeak,
      holdingDays,
    });
  }

  // 3순위: 너무 오래 묶인 포지션은 최대 보유기간에 맞춰 정리합니다.
  // 지수 ETF에서는 기본 비활성입니다. 장기 보유 자산에 만기를 붙이면 복리 포지션이
  // 엣지 없는 왕복매매로 바뀝니다.
  if (enabled(policy.maxHoldingDays) && holdingDays >= policy.maxHoldingDays) {
    return decision("SELL", "MAX_HOLDING_PERIOD", {
      peakPrice,
      returnRate,
      drawdownFromPeak,
      holdingDays,
    });
  }

  return decision("HOLD", "NO_EXIT_SIGNAL", {
    peakPrice,
    returnRate,
    drawdownFromPeak,
    holdingDays,
  });
}

// null이거나 설정되지 않은 청산 규칙은 계산에서 통째로 빠집니다.
function enabled(value) {
  return Number.isFinite(Number(value)) && value !== null;
}

function decision(action, reason, metrics = {}) {
  return { action, reason, ...metrics };
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name}는 양수여야 합니다.`);
  return number;
}
