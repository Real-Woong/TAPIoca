#!/usr/bin/env node

import path from "node:path";

import { readPaperEvents } from "./event-log.js";

// append-only 이벤트 로그를 사람이 읽기 좋게 최근 N건만 출력합니다. 매매는 하지 않습니다.
const dataDir = path.resolve(process.env.PAPER_DATA_DIR || "data");
const limitArg = process.argv.find((arg) => /^--limit=\d+$/.test(arg));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 20;

const events = await readPaperEvents(dataDir, { limit });
if (events.length === 0) {
  console.log("기록된 이벤트가 없습니다. 먼저 npm run paper:run을 실행하세요.");
} else {
  for (const event of events) {
    const contributions = event.contributions
      ? `거시 ${event.contributions.macro ?? "-"} / 감성 ${event.contributions.sentiment} / ` +
        `추세 ${event.contributions.trend} / MACD ${event.contributions.macd}`
      : "신호 없음";
    const trades = (event.decisions ?? [])
      .filter((decision) => decision.action === "BUY" || decision.action === "SELL")
      .map((decision) => `${decision.action} ${decision.symbol} ${decision.amountUsd ?? ""}`.trim())
      .join(", ") || "체결 없음";
    const benchmark = event.benchmark
      ? `벤치마크 ${event.benchmark.symbol} ${event.benchmark.pnlUsd} (초과 ${event.alphaUsd})`
      : "벤치마크 -";
    console.log(
      `${event.at} | ${event.regime ?? "-"} 점수 ${event.score ?? "-"} | ${contributions}\n` +
        `    자산 ${event.equityUsd} 손익 ${event.totalPnlUsd} (${event.returnPct ?? "-"}%) | ` +
        `${benchmark}\n    ${trades}`,
    );
  }
  console.log(`\n총 ${events.length}건 (최근 ${limit}건 기준). 전체 원본: data/paper-events.jsonl`);
}
