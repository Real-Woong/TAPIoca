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
