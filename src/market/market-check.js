#!/usr/bin/env node

import { createTossClientFromEnv, TossApiError } from "../toss/toss-client.js";

const symbols = (process.env.ETF_WATCHLIST || "VTI,SCHD,IWM")
  .split(",")
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);

try {
  const client = createTossClientFromEnv();
  const exchangeRate = await runCheck("환율", () => client.getExchangeRate());
  const prices = await runCheck("ETF 현재가", () => client.getPrices(symbols));

  console.log(JSON.stringify({ symbols, exchangeRate, prices }, null, 2));
  console.log("\n조회 전용 진단입니다. 계좌 조회나 주문 API를 호출하지 않았습니다.");
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

async function runCheck(label, request) {
  try {
    return await request();
  } catch (error) {
    if (error instanceof TossApiError) {
      console.error(`${label} 조회 실패: ${error.message}`);
      if (error.code) console.error(`코드: ${error.code}`);
      const hint = error.details?.error?.data;
      if (hint) console.error(`요청 힌트: ${JSON.stringify(hint)}`);
    }
    throw error;
  }
}
