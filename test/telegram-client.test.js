import test from "node:test";
import assert from "node:assert/strict";

import { sendTelegramMessage } from "../src/telegram/telegram-client.js";

test("Telegram sendMessage에 chat_id와 본문을 JSON으로 전송한다", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };

  await sendTelegramMessage({ token: "test-token", chatId: "123", text: "hello", fetchImpl });

  assert.match(request.url, /bottest-token\/sendMessage$/);
  assert.deepEqual(JSON.parse(request.options.body), { chat_id: "123", text: "hello" });
});
