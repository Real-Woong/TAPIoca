import test from "node:test";
import assert from "node:assert/strict";

import { formatDailyReport } from "../src/telegram/daily-report-format.js";

test("일일 보고서에 원금, 손익, 보유종목과 당일 거래를 포함한다", () => {
  const state = {
    funding: { fundingKrw: 100000, fundedUsd: 67.03 },
    cashUsd: 62.03,
    realizedPnlUsd: 0,
    positions: {
      VTI: { symbol: "VTI", quantity: 0.05, entryPrice: 100, lastPrice: 102, costUsd: 5 },
    },
    trades: [{
      side: "BUY", symbol: "VTI", amountUsd: 5, reason: "INITIAL_PAPER_ENTRY",
      executedAt: "2026-07-14T14:00:00Z",
    }],
  };

  const report = formatDailyReport(state, "2026-07-14");

  assert.match(report, /100,000원/);
  assert.match(report, /VTI/);
  assert.match(report, /BUY VTI/);
  assert.match(report, /실현손익/);
  assert.match(report, /미실현손익/);
  assert.match(report, /PAPER 모드/);
});

test("손실 안전장치가 작동하면 보고서에 신규 매수 중단을 표시한다", () => {
  const state = {
    funding: { fundingKrw: 100000, fundedUsd: 67.03 },
    cashUsd: 67.03,
    realizedPnlUsd: 0,
    positions: {},
    trades: [],
    risk: {
      lastCheck: { buyPaused: true, reason: "DAILY_LOSS_LIMIT" },
    },
  };

  const report = formatDailyReport(state, "2026-07-14");

  assert.match(report, /일일 손실 한도 도달/);
  assert.match(report, /신규 매수 중단/);
});
