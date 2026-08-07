import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 실주문 원장입니다. 한 줄 JSON(JSONL)으로 덧붙이기만 하고 절대 고치지 않습니다.
 *
 * **PAPER 장부와 나눠 두는 이유가 있습니다.** PAPER의 `paper-state.json`은 가변
 * 스냅샷이라 "지금 얼마를 들고 있나"만 답합니다. 실주문에서 답해야 하는 질문은
 * 다릅니다 — **"내가 낸 주문이 지금 어떤 상태인가"**이고, 그것은 프로세스가
 * 죽었다 살아나도 답할 수 있어야 합니다.
 *
 * 그래서 규칙 하나가 다른 모든 것보다 앞섭니다.
 *
 *   **브로커에 주문을 내기 전에 반드시 PLANNED를 먼저 기록한다.**
 *
 * 이것을 write-ahead라고 부릅니다. 기록과 제출 사이에서 죽으면 "냈는지 안 냈는지
 * 모르는 주문"이 남는데, 기록이 먼저 있으면 재시작 때 그 주문을 **조회해서**
 * 확인할 수 있습니다. 반대 순서면 확인할 방법이 없고, 그 상태로 새 주문을 내면
 * 같은 매수를 두 번 하게 됩니다.
 */

const ORDER_LOG_FILE = "live-orders.jsonl";

export function orderLogPath(dataDir) {
  return path.join(dataDir, ORDER_LOG_FILE);
}

export async function appendOrderEvent(dataDir, event) {
  await mkdir(dataDir, { recursive: true });
  await appendFile(orderLogPath(dataDir), `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

export async function readOrderEvents(dataDir) {
  let text;
  try {
    text = await readFile(orderLogPath(dataDir), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * 주문 하나를 식별하는 아이디입니다. **우리가 만들고 브로커에 넘깁니다.**
 *
 * 브로커가 만들어 주는 아이디는 응답을 받아야 알 수 있는데, 응답을 못 받는
 * 상황(타임아웃·크래시)이 바로 우리가 대비해야 하는 상황입니다. 그때 조회할
 * 열쇠가 없으면 중복 주문을 막을 수 없습니다.
 *
 * 사이클 시각과 종목·방향을 섞어 만들면 같은 사이클이 재실행돼도 같은 값이
 * 나오므로, 재시도가 새 주문이 되지 않습니다.
 */
export function clientOrderId({ cycleAt, symbol, side, sequence = 0 }) {
  const stamp = String(cycleAt).replace(/[^0-9]/g, "").slice(0, 14);
  return `${stamp}-${symbol}-${side}-${sequence}`;
}
