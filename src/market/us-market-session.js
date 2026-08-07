const NEW_YORK_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

export function getUsRegularSessionStatus(now = new Date()) {
  // 서버가 UTC로 실행돼도 뉴욕 현지 시간으로 변환합니다.
  // America/New_York가 서머타임 전환도 자동으로 반영합니다.
  const parts = Object.fromEntries(
    NEW_YORK_TIME.formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const isWeekday = WEEKDAYS.has(parts.weekday);
  // 미국 정규장 09:30 이상, 16:00 미만에만 true입니다.
  // 현재는 거래소 휴장일과 조기 폐장일 달력까지는 판별하지 않습니다.
  const isRegularHours = minutes >= 9 * 60 + 30 && minutes < 16 * 60;
  // 토스증권의 **미국주식 금액 주문**은 정규장 종료 1시간 전까지만 접수됩니다.
  // 그래서 정규장보다 한 시간 좁습니다(09:30~15:00). 이 창이 닫힌 뒤에 내면
  // `amount-order-outside-regular-hours`로 거부되는데, 거부를 받고 나서 아는
  // 것보다 아예 안 내는 편이 낫습니다 — 거부도 호출 한도를 씁니다.
  const isAmountOrderWindow = minutes >= 9 * 60 + 30 && minutes < 15 * 60;
  const newYorkTime = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;

  return {
    isOpen: isWeekday && isRegularHours,
    isWeekday,
    isRegularHours,
    // 금액 주문을 낼 수 있는 시간인가. 시드가 작아 금액 주문만 쓰므로
    // 실거래에서는 `isOpen`이 아니라 **이 값**이 매매 가능 여부입니다.
    isAmountOrderWindow: isWeekday && isAmountOrderWindow,
    newYorkTime,
    timeZone: "America/New_York",
    reason: !isWeekday ? "WEEKEND" : !isRegularHours ? "OUTSIDE_REGULAR_HOURS" : "REGULAR_SESSION",
    // 조기 폐장일(13:00 마감)에는 이 계산이 틀립니다 — 그날의 창은 12:00까지입니다.
    // 거래소 휴장·조기폐장 달력을 아직 안 보므로, 마지막 방어선은 토스의
    // `amount-order-outside-regular-hours` 거부입니다.
    amountOrderCutoffEt: "15:00",
  };
}
