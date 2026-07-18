#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

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
    const text = formatDailyReport(paperState, tradingDate);
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
