import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendPaperEvent,
  buildPaperEvent,
  readPaperEvents,
} from "../src/paper/event-log.js";

test("이벤트를 덧붙이고 최근 N건을 순서대로 읽는다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "events-"));
  try {
    for (let index = 0; index < 5; index += 1) {
      await appendPaperEvent(dataDir, { at: `2026-07-25T0${index}:00:00Z`, index });
    }
    const all = await readPaperEvents(dataDir);
    assert.equal(all.length, 5);
    assert.equal(all[0].index, 0);

    const recent = await readPaperEvents(dataDir, { limit: 2 });
    assert.deepEqual(recent.map((event) => event.index), [3, 4]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("로그 파일이 없으면 빈 배열을 반환한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "events-"));
  try {
    assert.deepEqual(await readPaperEvents(dataDir), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("신호와 실행 결과에서 감사 가능한 이벤트를 만든다", () => {
  const event = buildPaperEvent({
    now: new Date("2026-07-25T14:00:00Z"),
    marketSignal: {
      regime: "RISK_OFF",
      score: -2.3,
      signalSource: "FRED_NEWS_TREND",
      macroScore: -1.5,
      sentimentContribution: -0.3,
      trendContribution: -0.5,
      macdContribution: 0,
      targetAllocation: { VTI: 0.4, SCHD: 0.2, CASH: 0.4 },
    },
    result: {
      decisions: [
        { symbol: "VTI", action: "SELL", reason: "MACRO_RISK_OFF_REBALANCE_SELL", amountUsd: 12.3 },
        { symbol: "PORTFOLIO", action: "PAUSE_BUY", reason: "DAILY_LOSS_LIMIT" },
      ],
      summary: {
        equityUsd: 66.5,
        cashUsd: 30,
        marketValueUsd: 36.5,
        realizedPnlUsd: 0.1,
        unrealizedPnlUsd: -0.6,
        totalPnlUsd: -0.5,
        returnPct: -0.746,
        benchmark: { symbol: "VTI", valueUsd: 66, pnlUsd: -1.05, returnPct: -1.566 },
        alphaUsd: 0.55,
      },
    },
  });

  assert.equal(event.regime, "RISK_OFF");
  assert.equal(event.contributions.trend, -0.5);
  assert.equal(event.decisions.length, 2);
  assert.equal(event.decisions[0].reason, "MACRO_RISK_OFF_REBALANCE_SELL");
  assert.equal(event.benchmark.symbol, "VTI");
  assert.equal(event.alphaUsd, 0.55);
});
