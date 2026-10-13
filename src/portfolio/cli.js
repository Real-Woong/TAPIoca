#!/usr/bin/env node

import { createTossClientFromEnv, TossApiError } from "../toss/toss-client.js";
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
    printSummary(portfolio, symbol, summarizeHoldingsInKrw(portfolio, rate));
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

function printSummary(portfolio, symbol, summary) {
  console.log(`조회 시각: ${portfolio.fetchedAt}`);
  if (symbol) console.log(`종목 필터: ${symbol}`);

  if (portfolio.accounts.length === 0) {
    console.log("조회 가능한 종합매매 계좌가 없습니다.");
    return;
  }

  if (summary.usdKrwRate !== null) {
    console.log(`적용 환율: 1 USD = ${summary.usdKrwRate.toLocaleString("ko-KR")} KRW`);
  }

  for (const { account, positions } of summary.accounts) {
    console.log(`\n계좌 ${maskAccountNo(account.accountNo)} (${account.accountType})`);
    console.log(`보유 종목: ${positions.length}개`);

    for (const { item, currency, valueKrw } of positions) {
      const profitLossRate = Number(item.profitLoss?.rate);
      const rateText = item.profitLoss?.rate === null || item.profitLoss?.rate === undefined
        || !Number.isFinite(profitLossRate)
        ? "미상" : `${(profitLossRate * 100).toFixed(2)}%`;
      const original = currency === "USD" ? ` (${item.marketValue.amount} USD)` : "";
      console.log(
        `- ${item.name} (${item.symbol}) | ${item.quantity}주 | ` +
          `평가 ${formatKrw(valueKrw)}${original} | 손익률 ${rateText}`,
      );
    }
  }
  if (!symbol) console.log(`\n전체 계좌 보유 종목 평가액 합계: ${formatKrw(summary.totalKrw)} (예수금 제외)`);
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
