const TELEGRAM_API = "https://api.telegram.org";

export async function sendTelegramMessage({ token, chatId, text, fetchImpl = globalThis.fetch }) {
  // Bot Token과 Chat ID는 .env에서 전달받으며 로그나 장부에는 저장하지 않습니다.
  requireValue(token, "TELEGRAM_BOT_TOKEN");
  requireValue(chatId, "TELEGRAM_CHAT_ID");
  requireValue(text, "text");

  const response = await fetchImpl(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram 전송 실패: ${payload.description || `HTTP ${response.status}`}`);
  }
  return payload.result;
}

export async function getTelegramUpdates({ token, fetchImpl = globalThis.fetch }) {
  // /start를 보낸 채팅의 ID를 찾을 때만 사용하는 조회 함수입니다.
  requireValue(token, "TELEGRAM_BOT_TOKEN");
  const response = await fetchImpl(`${TELEGRAM_API}/bot${token}/getUpdates`, {
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram 업데이트 조회 실패: ${payload.description || `HTTP ${response.status}`}`);
  }
  return payload.result;
}

function requireValue(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`${name} 값이 필요합니다.`);
  }
}
