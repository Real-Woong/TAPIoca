#!/usr/bin/env node

import { createTossClientFromEnv, TossApiError } from "../toss/toss-client.js";
import path from "node:path";

import { fetchBaseRate } from "./base-fx.js";
import { krwReturn, loadKrwCostBasis } from "./krw-cost.js";
import { summarizeHoldingsInKrw } from "./krw-summary.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const symbol = readOption(args, "--symbol");

try {
  const client = createTossClientFromEnv();
  const portfolio = await client.getPortfolio({ symbol });

  if (json) {
    console.log(JSON.stringify(portfolio, null, 2));
  } else {
    const hasUsdHoldings = portfolio.accounts.some((account) =>
      (account.holdings?.items ?? []).some((item) => String(item.currency).toUpperCase() === "USD"),
    );
    const rate = hasUsdHoldings ? (await client.getExchangeRate("USD", "KRW")).rate : null;
    // 토스 앱 평가용 기준환율. 못 가져와도 API 환율 합계는 그대로 보여줍니다.
    let base = null;
    let baseError = null;
    if (hasUsdHoldings) {
      try {
        base = await fetchBaseRate();
      } catch (error) {
        baseError = error.message;
      }
    }
    let costBasis = null;
    try {
      costBasis = await loadKrwCostBasis(path.resolve(process.env.PAPER_DATA_DIR || "data"));
    } catch (error) {
      console.error(`원화 매입가 등록부를 읽지 못했습니다: ${error.message}`);
    }
    printSummary(portfolio, symbol, summarizeHoldingsInKrw(portfolio, rate, base?.rate ?? null), base, baseError, costBasis);
  }
} catch (error) {
  printError(error);
  process.exitCode = 1;
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} 뒤에 값을 입력하세요.`);
  }
  return value;
}

function printSummary(portfolio, symbol, summary, base, baseError, costBasis) {
  console.log(`조회 시각: ${portfolio.fetchedAt}`);
  if (symbol) console.log(`종목 필터: ${symbol}`);

  if (portfolio.accounts.length === 0) {
    console.log("조회 가능한 종합매매 계좌가 없습니다.");
    return;
  }

  if (summary.usdKrwRate !== null) {
    console.log(`적용 환율: 1 USD = ${summary.usdKrwRate.toLocaleString("ko-KR")} KRW`);
  }

  const krwTotals = { count: 0, cost: 0, profit: 0 };
  for (const { account, positions } of summary.accounts) {
    console.log(`\n계좌 ${maskAccountNo(account.accountNo)} (${account.accountType})`);
    console.log(`보유 종목: ${positions.length}개`);

    for (const { item, currency, valueKrw, valueBaseKrw } of positions) {
      // 앱 기준환율을 알면 평가도 앱과 같은 환율로 보여 줍니다. 모르면 API 환율입니다.
      const shownKrw = valueBaseKrw ?? valueKrw;
      const original = currency === "USD" ? ` (${item.marketValue.amount} USD)` : "";
      const returnText = describeReturn(item, currency, valueBaseKrw, costBasis, krwTotals);
      console.log(
        `- ${item.name} (${item.symbol}) | ${item.quantity}주 | ` +
          `평가 ${formatKrw(shownKrw)}${original} | ${returnText}`,
      );
    }
  }
  if (!symbol) {
    const rateLabel = summary.usdKrwRate === null ? "" : ` (API 환율 ${summary.usdKrwRate.toLocaleString("ko-KR")})`;
    console.log(`\n전체 계좌 보유 종목 평가액 합계${rateLabel}: ${formatKrw(summary.totalKrw)} (예수금 제외)`);
    if (summary.appEstimateKrw !== null) {
      console.log(
        `토스 앱 기준 평가액 (기준환율 ${base.rate.toLocaleString("ko-KR")} · 한국은행 매매기준율 ${base.date}): ` +
          formatKrw(summary.appEstimateKrw),
      );
    } else if (baseError) {
      console.log(`토스 앱 기준 평가액: 기준환율을 가져오지 못해 생략합니다 (${baseError})`);
    }
    if (krwTotals.count > 0) {
      const pct = (krwTotals.profit / krwTotals.cost) * 100;
      console.log(
        `원화 손익 (매입가 등록 ${krwTotals.count}종목): ${signedKrw(krwTotals.profit)} ` +
          `(${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`,
      );
    }
  }
}

/** 원화 손익률을 앞에, USD 손익률을 뒤에 둡니다. 원화를 못 구하면 이유를 적습니다. */
function describeReturn(item, currency, valueBaseKrw, costBasis, krwTotals) {
  const usdRate = Number(item.profitLoss?.rate);
  const usdText = item.profitLoss?.rate === null || item.profitLoss?.rate === undefined
    || !Number.isFinite(usdRate)
    ? "미상" : `${(usdRate * 100).toFixed(2)}%`;
  if (currency === "KRW") return `손익률 ${usdText}`;

  if (valueBaseKrw === null) return `손익률 USD ${usdText} (기준환율 없음)`;
  const result = krwReturn({ symbol: item.symbol, quantity: item.quantity, valueKrw: valueBaseKrw }, costBasis);
  if (result.status === "ok") {
    krwTotals.count += 1;
    krwTotals.cost += result.costKrw;
    krwTotals.profit += result.profitKrw;
    return `손익률 ${(result.rate * 100).toFixed(2)}% (USD ${usdText})`;
  }
  const why = result.status === "stale" ? "수량이 늘어 원화 매입가 갱신 필요" : "원화 매입가 미등록";
  return `손익률 USD ${usdText} (${why})`;
}

function signedKrw(value) {
  return `${value >= 0 ? "+" : "-"}${Math.abs(Math.round(value)).toLocaleString("ko-KR")}원`;
}

function formatKrw(value) {
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function maskAccountNo(accountNo = "") {
  if (accountNo.length <= 4) return "****";
  return `${"*".repeat(accountNo.length - 4)}${accountNo.slice(-4)}`;
}

function printError(error) {
  if (error instanceof TossApiError) {
    console.error(`오류: ${error.message}`);
    if (error.code) console.error(`코드: ${error.code}`);
    if (error.requestId) console.error(`요청 ID: ${error.requestId}`);
    if (error.status === 403) {
      console.error("현재 실행 환경의 공인 IP가 Toss Open API 허용 IP에 등록됐는지 확인하세요.");
    }
    return;
  }
  console.error(`오류: ${error.message}`);
}
