import test from "node:test";
import assert from "node:assert/strict";

import { getUsRegularSessionStatus } from "../src/market/us-market-session.js";

test("서머타임 중 뉴욕 09:30부터 정규장으로 판단한다", () => {
  const before = getUsRegularSessionStatus(new Date("2026-07-14T13:29:00Z"));
  const open = getUsRegularSessionStatus(new Date("2026-07-14T13:30:00Z"));
  const close = getUsRegularSessionStatus(new Date("2026-07-14T20:00:00Z"));

  assert.equal(before.isOpen, false);
  assert.equal(open.isOpen, true);
  assert.equal(open.newYorkTime, "2026-07-14 09:30");
  assert.equal(close.isOpen, false);
});

test("비서머타임에도 뉴욕 현지 09:30을 자동 적용한다", () => {
  const open = getUsRegularSessionStatus(new Date("2026-01-14T14:30:00Z"));
  assert.equal(open.isOpen, true);
  assert.equal(open.newYorkTime, "2026-01-14 09:30");
});

test("주말에는 정규장 시각이어도 실행하지 않는다", () => {
  const saturday = getUsRegularSessionStatus(new Date("2026-07-18T14:00:00Z"));
  assert.equal(saturday.isOpen, false);
  assert.equal(saturday.reason, "WEEKEND");
});

// ── 2026-11-01(일) 서머타임 종료 — 실거래 중 처음 겪는 전환 ─────────────────
// 같은 UTC 시각이 전환 전후로 한 시간씩 다른 뉴욕 시각이 된다. 전환 전 마지막
// 거래일(10/30 금)과 전환 후 첫 거래일(11/2 월)을 **같은 UTC 시각**으로 나란히
// 세워, 시각을 UTC로 박아 둔 곳이 있으면 여기서 깨지게 한다.
const LAST_EDT_DAY = "2026-10-30"; // 금, UTC−4
const FIRST_EST_DAY = "2026-11-02"; // 월, UTC−5

test("서머타임 종료 — 개장은 13:30Z에서 14:30Z로 한 시간 밀린다", () => {
  assert.equal(getUsRegularSessionStatus(new Date(`${LAST_EDT_DAY}T13:30:00Z`)).isOpen, true);

  const early = getUsRegularSessionStatus(new Date(`${FIRST_EST_DAY}T13:30:00Z`));
  assert.equal(early.isOpen, false, "전환 뒤 13:30Z는 08:30 ET — 아직 장 전이다");
  assert.equal(early.newYorkTime, `${FIRST_EST_DAY} 08:30`);

  const open = getUsRegularSessionStatus(new Date(`${FIRST_EST_DAY}T14:30:00Z`));
  assert.equal(open.isOpen, true);
  assert.equal(open.newYorkTime, `${FIRST_EST_DAY} 09:30`);
});

test("서머타임 종료 — 금액 주문 창 마감은 19:00Z에서 20:00Z로 밀린다", () => {
  // 같은 19:30Z가 전환 전엔 15:30 ET(창 닫힘), 전환 뒤엔 14:30 ET(창 열림)이다.
  const before = getUsRegularSessionStatus(new Date(`${LAST_EDT_DAY}T19:30:00Z`));
  assert.equal(before.newYorkTime, `${LAST_EDT_DAY} 15:30`);
  assert.equal(before.isAmountOrderWindow, false);
  assert.equal(before.isOpen, true, "정규장은 아직 열려 있다 — 창만 닫혔다");

  const after = getUsRegularSessionStatus(new Date(`${FIRST_EST_DAY}T19:30:00Z`));
  assert.equal(after.newYorkTime, `${FIRST_EST_DAY} 14:30`);
  assert.equal(after.isAmountOrderWindow, true);

  assert.equal(getUsRegularSessionStatus(new Date(`${FIRST_EST_DAY}T20:00:00Z`)).isAmountOrderWindow, false);
});

test("서머타임 종료 당일 새벽(일) 반복되는 01시대는 주말이라 매매가 없다", () => {
  // 01:30 ET가 두 번 온다 — 05:30Z(EDT)와 06:30Z(EST). 둘 다 같은 날짜·같은 판정이어야 한다.
  const first = getUsRegularSessionStatus(new Date("2026-11-01T05:30:00Z"));
  const second = getUsRegularSessionStatus(new Date("2026-11-01T06:30:00Z"));
  assert.equal(first.newYorkTime, "2026-11-01 01:30");
  assert.equal(second.newYorkTime, "2026-11-01 01:30");
  assert.equal(first.reason, "WEEKEND");
  assert.equal(second.reason, "WEEKEND");
});
