#!/usr/bin/env node

import { sendTelegramMessage } from "./telegram-client.js";

try {
  await sendTelegramMessage({
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    text: "✅ Toss ETF PAPER Agent Telegram 연결 테스트 성공\n실제 주문은 실행하지 않았습니다.",
  });
  console.log("Telegram 테스트 메시지를 전송했습니다.");
} catch (error) {
  console.error(`오류: ${error.message}`);
  process.exitCode = 1;
}
