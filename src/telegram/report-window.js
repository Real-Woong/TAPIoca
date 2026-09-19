/**
 * 하루치 보고서를 **이미 보냈는지** 판정합니다 (2026-09-19).
 *
 * ── 왜 날짜만으로는 안 되는가 ──────────────────────────────────────────────
 *
 * 처음에는 "같은 뉴욕 거래일이면 안 보낸다"였는데 **틀렸습니다.** 뉴욕 거래일은
 * 한국 새벽에 이미 바뀌어 있습니다. 2026-09-18 15:30 KST(02:30 ET)에 보고서를
 * 한 번 강제로 돌렸더니 `lastReportedTradingDate`가 `2026-09-18`로 박혔고,
 * **정작 마감 뒤 16:10 ET에 타이머가 돌 때 "이미 전송했습니다"만 찍고 끝났습니다.**
 * 그날 거래 결과는 아무 데도 안 갔습니다 — 사장님은 개장 전 숫자를 하루치
 * 보고서로 받은 셈입니다.
 *
 * 같은 버그를 원가 스냅샷에서 하루 먼저 잡았습니다(㉝ 보완). 그쪽은 덧붙이기라
 * *마지막 줄이 이긴다*로 풀었지만, 전송은 덧붙일 수가 없으니 **언제 보냈는지**를
 * 같이 봐야 합니다.
 *
 * ── 그래서 무엇으로 판정하는가 ────────────────────────────────────────────
 *
 * **그 거래일의 정규장 마감(16:00 ET) 뒤에 나간 기록**만 "보냈다"로 칩니다.
 * 개장 전이나 장중에 돌린 것은 하루치 보고가 아니므로 마감 보고서를 막지
 * 않습니다. 타이머가 재부팅으로 늦게 한 번 더 도는 것(`Persistent=true`)은
 * 그대로 막힙니다 — 그것은 마감 뒤라 같은 거래일의 두 번째 전송이 됩니다.
 *
 * **`sentAt`이 없거나 읽히지 않으면 보냅니다.** 침묵보다 한 통 더가 낫습니다 —
 * 이 파일 전체가 침묵 때문에 생겼습니다.
 */

/** 미국 정규장 마감 시각(뉴욕 현지 기준)입니다. 타이머는 이보다 10분 뒤에 돕니다. */
const NEW_YORK_CLOSE_HOUR = 16;

export function newYorkDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** 뉴욕 현지 시(0~23)입니다. `hourCycle`을 못 박습니다 — 자정을 24로 적는 조합이 있습니다. */
export function newYorkHour(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Number(parts.find((part) => part.type === "hour")?.value);
}

/**
 * `reportState`에 그 거래일의 **마감 뒤** 전송 기록이 있습니까.
 *
 * 없으면 보내야 한다는 뜻입니다. 위 주석에 그 이유가 다 있습니다.
 */
export function hasPostCloseReport(reportState, tradingDate) {
  if (!reportState || reportState.lastReportedTradingDate !== tradingDate) return false;

  const sentAt = new Date(reportState.sentAt ?? "");
  if (Number.isNaN(sentAt.getTime())) return false;

  const sentOn = newYorkDate(sentAt);
  if (sentOn > tradingDate) return true;
  if (sentOn < tradingDate) return false;
  return newYorkHour(sentAt) >= NEW_YORK_CLOSE_HOUR;
}
