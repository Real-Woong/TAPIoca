import test from "node:test";
import assert from "node:assert/strict";

import { hasPostCloseReport, newYorkDate, newYorkHour } from "../src/telegram/report-window.js";

// 2026-09-18에 실제로 일어난 일입니다. 개장 전 강제 실행 한 번이 그날 마감
// 보고서를 통째로 삼켰습니다. 이 파일은 그 하루를 그대로 다시 세웁니다.
const TRADING_DATE = "2026-09-18";
const BEFORE_OPEN = "2026-09-18T06:30:00Z"; // 15:30 KST = 02:30 ET (개장 전)
const AFTER_CLOSE = "2026-09-18T20:10:00Z"; // 16:10 ET (타이머가 도는 시각)

test("개장 전에 강제로 돌린 실행은 마감 보고서를 막지 않는다", () => {
  const reportState = { lastReportedTradingDate: TRADING_DATE, sentAt: BEFORE_OPEN };

  assert.equal(hasPostCloseReport(reportState, TRADING_DATE), false);
});

test("장중에 돌린 실행도 마감 보고서를 막지 않는다", () => {
  // 13:00 ET — 날짜는 같지만 그날 거래 결과가 아직 다 나오지 않았다.
  const reportState = { lastReportedTradingDate: TRADING_DATE, sentAt: "2026-09-18T17:00:00Z" };

  assert.equal(hasPostCloseReport(reportState, TRADING_DATE), false);
});

test("마감 뒤에 한 번 나갔으면 같은 거래일에 다시 보내지 않는다", () => {
  // 서버가 늦게 켜져 타이머가 뒤늦게 또 도는 경우(Persistent=true)가 여기 걸린다.
  const reportState = { lastReportedTradingDate: TRADING_DATE, sentAt: AFTER_CLOSE };

  assert.equal(hasPostCloseReport(reportState, TRADING_DATE), true);
});

test("전송 시각이 없거나 깨졌으면 보낸다 — 침묵보다 한 통 더가 낫다", () => {
  assert.equal(hasPostCloseReport({ lastReportedTradingDate: TRADING_DATE }, TRADING_DATE), false);
  assert.equal(
    hasPostCloseReport({ lastReportedTradingDate: TRADING_DATE, sentAt: "어제" }, TRADING_DATE),
    false,
  );
  assert.equal(hasPostCloseReport(undefined, TRADING_DATE), false);
});

test("다른 거래일의 기록은 오늘 보고서와 무관하다", () => {
  const reportState = { lastReportedTradingDate: "2026-09-17", sentAt: "2026-09-17T20:10:00Z" };

  assert.equal(hasPostCloseReport(reportState, TRADING_DATE), false);
});

test("뉴욕 날짜와 시는 한국 시각이 아니라 현지 시각으로 읽는다", () => {
  // 15:30 KST는 한국에서 18일 낮이지만 뉴욕에서는 18일 새벽 2시다.
  assert.equal(newYorkDate(new Date(BEFORE_OPEN)), "2026-09-18");
  assert.equal(newYorkHour(new Date(BEFORE_OPEN)), 2);
  assert.equal(newYorkHour(new Date(AFTER_CLOSE)), 16);
  // 자정을 24로 적는 조합이 있어 hourCycle을 못 박았다. 0이어야 한다.
  assert.equal(newYorkHour(new Date("2026-09-18T04:00:00Z")), 0);
});

// ── 2026-11-01 서머타임 종료 ─────────────────────────────────────────────
// 타이머는 `16:10 America/New_York`라 전환을 따라간다(deploy/toss-ai-report.timer).
// 판정도 뉴욕 현지 시로 해야 한다. **20:10Z를 «마감 뒤»로 박아 두면** 전환 뒤엔
// 그것이 15:10 ET — 장중 — 이고, 장중 실행이 그날 마감 보고서를 삼킨다(9/18과 같은 사고).
test("서머타임 종료 뒤 20:10Z는 장중이다 — 마감 보고서를 막지 않는다", () => {
  const tradingDate = "2026-11-02";
  const midday = { lastReportedTradingDate: tradingDate, sentAt: "2026-11-02T20:10:00Z" };
  assert.equal(newYorkHour(new Date(midday.sentAt)), 15);
  assert.equal(hasPostCloseReport(midday, tradingDate), false);

  const afterClose = { lastReportedTradingDate: tradingDate, sentAt: "2026-11-02T21:10:00Z" };
  assert.equal(newYorkHour(new Date(afterClose.sentAt)), 16);
  assert.equal(hasPostCloseReport(afterClose, tradingDate), true);
});

test("서머타임 종료 전 마지막 거래일은 20:10Z가 마감 뒤다", () => {
  const tradingDate = "2026-10-30";
  const state = { lastReportedTradingDate: tradingDate, sentAt: "2026-10-30T20:10:00Z" };
  assert.equal(newYorkHour(new Date(state.sentAt)), 16);
  assert.equal(hasPostCloseReport(state, tradingDate), true);
});

test("전환 뒤 첫 마감 보고서도 그 거래일로 귀속된다 — 한국은 다음 날 아침이다", () => {
  // 16:10 EST = 21:10Z = 11/3 06:10 KST. 날짜를 한국 시각으로 읽으면 11/3이 된다.
  assert.equal(newYorkDate(new Date("2026-11-02T21:10:00Z")), "2026-11-02");
  // 금요일 마감 보고서가 주말을 건너 월요일 기록을 막지 않는다.
  const friday = { lastReportedTradingDate: "2026-10-30", sentAt: "2026-10-30T20:10:00Z" };
  assert.equal(hasPostCloseReport(friday, "2026-11-02"), false);
});
