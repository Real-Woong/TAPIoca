export function analyzePortfolio(portfolio) {
  // 서로 다른 통화(USD/KRW)는 환산 없이 합치지 않고 통화별로 따로 분석합니다.
  const positions = (portfolio.accounts ?? []).flatMap((account) =>
    (account.holdings?.items ?? []).map((item) => ({
      accountSeq: account.accountSeq,
      symbol: item.symbol,
      name: item.name,
      currency: item.currency,
      quantity: toFiniteNumber(item.quantity),
      marketValue: toFiniteNumber(item.marketValue?.amount),
      profitLossRate: toFiniteNumber(item.profitLoss?.rate),
    })),
  );

  const currencies = Object.values(
    positions.reduce((groups, position) => {
      const currency = position.currency || "UNKNOWN";
      const group = (groups[currency] ??= {
        currency,
        totalMarketValue: 0,
        positions: [],
      });
      group.totalMarketValue += position.marketValue;
      group.positions.push(position);
      return groups;
    }, {}),
  ).map((group) => {
    const positionsWithWeight = group.positions
      .map((position) => ({
        ...position,
        weight: group.totalMarketValue > 0 ? position.marketValue / group.totalMarketValue : 0,
      }))
      .sort((a, b) => b.marketValue - a.marketValue);

    // HHI = 각 종목 비중의 제곱합. 값이 클수록 일부 종목에 더 집중된 구조입니다.
    const concentrationIndex = positionsWithWeight.reduce(
      (sum, position) => sum + position.weight ** 2,
      0,
    );

    return {
      currency: group.currency,
      totalMarketValue: group.totalMarketValue,
      positionCount: positionsWithWeight.length,
      concentrationIndex,
      largestPosition: positionsWithWeight[0] ?? null,
      positions: positionsWithWeight,
    };
  });

  return {
    analyzedAt: new Date().toISOString(),
    positionCount: positions.length,
    currencies,
  };
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
