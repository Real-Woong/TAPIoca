#!/usr/bin/env node

import { getTelegramUpdates } from "./telegram-client.js";

try {
  const updates = await getTelegramUpdates({ token: process.env.TELEGRAM_BOT_TOKEN });
  const chats = new Map();
  for (const update of updates) {
    const chat = update.message?.chat ?? update.channel_post?.chat;
    if (chat) chats.set(String(chat.id), chat);
  }

  if (chats.size === 0) {
    console.log("채팅을 찾지 못했습니다. Telegram에서 봇에게 /start를 보낸 뒤 다시 실행하세요.");
  } else {
    console.log("사용 가능한 Telegram 채팅:");
    for (const [id, chat] of chats) {
      const name = [chat.first_name, chat.last_name, chat.title].filter(Boolean).join(" ");
      console.log(`- chat_id=${id}${name ? ` (${name})` : ""}`);
    }
  }
} catch (error) {
  console.error(`오류: ${error.message}`);
  process.exitCode = 1;
}
