#!/usr/bin/env node

import { analyzePortfolio } from "./portfolio-analysis.js";
import { createTossClientFromEnv, TossApiError } from "../toss/toss-client.js";

const json = process.argv.slice(2).includes("--json");

try {
  const client = createTossClientFromEnv();
  const portfolio = await client.getPortfolio();
  const analysis = analyzePortfolio(portfolio);

  if (json) {
    console.log(JSON.stringify(analysis, null, 2));
  } else {
    printAnalysis(analysis);
  }
} catch (error) {
  if (error instanceof TossApiError) {
    console.error(`오류: ${error.message}`);
    if (error.code) console.error(`코드: ${error.code}`);
    if (error.requestId) console.error(`요청 ID: ${error.requestId}`);
  } else {
    console.error(`오류: ${error.message}`);
  }
  process.exitCode = 1;
}

function printAnalysis(analysis) {
  console.log(`분석 시각: ${analysis.analyzedAt}`);
  console.log(`전체 보유 종목: ${analysis.positionCount}개`);

  for (const group of analysis.currencies) {
    console.log(`\n${group.currency} 평가액 합계: ${formatAmount(group.totalMarketValue)}`);
    console.log(`집중도 지수(HHI): ${(group.concentrationIndex * 10_000).toFixed(0)}`);

    for (const position of group.positions) {
      console.log(
        `- ${position.name} (${position.symbol}) | 비중 ${formatPercent(position.weight)} | ` +
          `평가 ${formatAmount(position.marketValue)} ${group.currency} | ` +
          `손익률 ${formatPercent(position.profitLossRate)}`,
      );
    }

    if (group.largestPosition?.weight >= 0.4) {
      console.log(
        `주의: ${group.largestPosition.symbol} 비중이 ${formatPercent(group.largestPosition.weight)}로 ` +
          "단일 종목 40%를 넘습니다.",
      );
    }
  }

  console.log("\n이 결과는 포트폴리오 구조 분석이며 매수·매도 추천이 아닙니다.");
}

function formatAmount(value) {
  return new Intl.NumberFormat("ko-KR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value) {
  return new Intl.NumberFormat("ko-KR", {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
