#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildOrders, unresolvedOrders } from "../live/order-lifecycle.js";
import { readOrderEvents } from "../live/order-store.js";
import { loadTradingPolicy } from "../paper/trading-policy.js";
import { formatDailyReport } from "./daily-report-format.js";
import { sendTelegramMessage } from "./telegram-client.js";

const dataDir = path.resolve(process.env.PAPER_DATA_DIR || "data");
const paperStatePath = path.join(dataDir, "paper-state.json");
const reportStatePath = path.join(dataDir, "telegram-report-state.json");

// 미국 장 종료 후 systemd 타이머가 실행하는 일일 보고서 진입점입니다.
try {
  const paperState = JSON.parse(await readFile(paperStatePath, "utf8"));
  const tradingDate = newYorkDate(new Date());
  const reportState = await readReportState();
  const forced = process.argv.includes("--force");

  // 같은 뉴욕 거래일에 재실행되어도 Telegram 메시지는 한 번만 보냅니다.
  if (reportState.lastReportedTradingDate === tradingDate && !forced) {
    console.log(`${tradingDate} 보고서는 이미 전송했습니다.`);
  } else {
    // **보고서가 스스로 모드를 압니다.** 여기서 정책을 안 읽으면 실거래를 켠
    // 뒤에도 메시지는 계속 "PAPER 모드 — 실제 주문 없음"이라고 적습니다.
    const policy = loadTradingPolicy(process.env);
    const live = policy.mode === "LIVE" ? await readLiveSummary(tradingDate) : null;
    const text = formatDailyReport(paperState, tradingDate, { live });
    await sendTelegramMessage({
      token: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
      text,
    });
    await writeReportState({
      lastReportedTradingDate: tradingDate,
      sentAt: new Date().toISOString(),
    });
    console.log(`Telegram 일일 보고서 전송 완료: ${tradingDate}`);
  }
} catch (error) {
  if (error.code === "ENOENT") {
    console.error("PAPER 장부가 없습니다. 먼저 npm run paper:run을 실행하세요.");
  } else {
    console.error(`오류: ${error.message}`);
  }
  process.exitCode = 1;
}

/**
 * 오늘 낸 실주문을 원장에서 읽습니다. **조회도 주문도 하지 않습니다** — 파일만
 * 봅니다. 보고서는 장이 닫힌 뒤에 도는데, 거기서 브로커를 두드리면 보고서가
 * 네트워크 사정으로 안 오게 됩니다.
 *
 * **`at`이 아니라 주문이 계획된 날로 고릅니다.** FILL 이벤트의 `at`은 우리가
 * 그것을 기록한 시각이라, 몇 주 전 체결을 오늘 재조회하면 오늘 것처럼 보입니다.
 * 2026-09-01에 실제로 그랬습니다(8/07 체결이 9/1 타임스탬프로 다시 실려 왔다).
 * 읽는 사람이 알고 싶은 것은 "오늘 내 돈이 움직였나"이므로 첫 이벤트,
 * 즉 PLANNED가 찍힌 날을 기준으로 삼습니다.
 */
async function readLiveSummary(tradingDate) {
  try {
    const orders = buildOrders(await readOrderEvents(dataDir));
    const placedToday = [...orders.values()].filter((order) => {
      const first = order.events[0];
      return first?.at && newYorkDate(new Date(first.at)) === tradingDate;
    });

    return {
      orders: placedToday.map((order) => ({
        symbol: order.symbol,
        side: order.side,
        state: order.state,
        requestedUsd: order.requestedUsd,
        filledUsd: order.filledUsd,
        filledQuantity: order.filledQuantity,
      })),
      unresolvedCount: unresolvedOrders(orders).length,
    };
  } catch (error) {
    // **보고서는 나가야 합니다.** 원장을 못 읽는다고 하루치 보고를 통째로
    // 잃으면, 사람이 아무것도 모르는 채로 다음 장을 맞습니다. 못 읽었다는
    // 사실을 메시지에 적어서 보냅니다.
    return { error: error.message };
  }
}

async function readReportState() {
  try {
    return JSON.parse(await readFile(reportStatePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeReportState(state) {
  // PAPER 장부와 마찬가지로 임시 파일 + rename 방식으로 전송 기록을 안전하게 저장합니다.
  await mkdir(dataDir, { recursive: true });
  const temporaryPath = `${reportStatePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, reportStatePath);
}

function newYorkDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
