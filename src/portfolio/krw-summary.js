/** 모든 계좌의 보유 종목 평가액을 원화로 환산합니다. 예수금은 포함하지 않습니다. */
export function summarizeHoldingsInKrw(portfolio, usdKrwRate) {
  const accounts = portfolio.accounts ?? [];
  const holdings = accounts.flatMap((account) => account.holdings?.items ?? []);
  const needsUsdRate = holdings.some((item) => String(item.currency).toUpperCase() === "USD");
  const rate = Number(usdKrwRate);
  if (needsUsdRate && !(Number.isFinite(rate) && rate > 0)) {
    throw new Error("USD/KRW 환율을 확인할 수 없어 원화 평가액을 계산하지 않았습니다.");
  }

  let totalKrw = 0;
  const summarizedAccounts = accounts.map((account) => {
    const positions = (account.holdings?.items ?? []).map((item) => {
      const currency = String(item.currency ?? "").toUpperCase();
      if (currency !== "KRW" && currency !== "USD") {
        throw new Error(`${item.symbol ?? "(종목 미상)"}: 지원하지 않는 평가 통화 ${currency || "(없음)"}입니다.`);
      }
      const amount = item.marketValue?.amount;
      const value = amount === null || amount === undefined || amount === "" ? NaN : Number(amount);
      if (!Number.isFinite(value)) {
        throw new Error(`${item.symbol ?? "(종목 미상)"}: 평가액을 확인할 수 없습니다.`);
      }
      const valueKrw = currency === "USD" ? value * rate : value;
      if (!Number.isFinite(valueKrw)) {
        throw new Error(`${item.symbol ?? "(종목 미상)"}: 원화 평가액을 계산할 수 없습니다.`);
      }
      totalKrw += valueKrw;
      return { item, currency, valueKrw };
    });
    return { account, positions };
  });

  return { accounts: summarizedAccounts, totalKrw, usdKrwRate: needsUsdRate ? rate : null };
}
