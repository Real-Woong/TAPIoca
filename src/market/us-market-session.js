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
  const newYorkTime = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;

  return {
    isOpen: isWeekday && isRegularHours,
    isWeekday,
    isRegularHours,
    newYorkTime,
    timeZone: "America/New_York",
    reason: !isWeekday ? "WEEKEND" : !isRegularHours ? "OUTSIDE_REGULAR_HOURS" : "REGULAR_SESSION",
  };
}
