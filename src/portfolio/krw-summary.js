/**
 * 토스 앱은 USD 보유를 API 환율보다 낮은 «팔 때» 환율로 평가합니다 — 2026-10-13 실측
 * (앱 1,335.8원 대 API 1,342.6원 등) 약 0.5~0.6% 낮았습니다. API는 이 환율을 주지 않으므로
 * 관측에서 정한 **추정치**이고, 토스가 공개한 규칙이 아닙니다. 데이터가 쌓이면 고칩니다.
 */
export const APP_SELL_FX_DISCOUNT = 0.0055;

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
  let usdValueKrw = 0;
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
      if (currency === "USD") usdValueKrw += valueKrw;
      return { item, currency, valueKrw };
    });
    return { account, positions };
  });

  // 원화 보유는 그대로, USD 보유 몫에만 앱의 «팔 때» 환율 할인을 적용한 추정 합계입니다.
  const appEstimateKrw = totalKrw - usdValueKrw * APP_SELL_FX_DISCOUNT;

  return {
    accounts: summarizedAccounts,
    totalKrw,
    appEstimateKrw,
    usdKrwRate: needsUsdRate ? rate : null,
  };
}
