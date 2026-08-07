import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { engageEmergencyStop } from "../src/live/emergency-stop.js";
import { HALT_REASONS } from "../src/live/execution-plan.js";
import { createFakeBroker } from "../src/live/fake-broker.js";
import { runLiveCycle } from "../src/live/live-cycle.js";
import { ORDER_STATES } from "../src/live/order-lifecycle.js";
import { readOrderEvents } from "../src/live/order-store.js";
import { getUsRegularSessionStatus } from "../src/market/us-market-session.js";

const scratch = () => mkdtemp(path.join(tmpdir(), "live-cycle-"));
const DECISION = { symbol: "VTI", side: "BUY", amountUsd: 5 };

/**
 * 실거래 한 사이클을 통째로 밟습니다.
 *
 * 조각들(계획·멱등·대사)은 각각 테스트돼 있고, 여기서 보는 것은 **순서**입니다.
 * 순서가 틀리면 조각이 다 맞아도 사고가 납니다.
 */

test("정상 경로: 기록을 먼저 남기고 그 다음 제출한다", async () => {
  const dataDir = await scratch();
  const broker = createFakeBroker({ behaviors: [{ accept: true }] });

  const result = await runLiveCycle({ dataDir, broker, decisions: [DECISION] });

  assert.equal(result.submitted.length, 1);
  const events = await readOrderEvents(dataDir);
  // 기록이 제출보다 먼저입니다. 이 순서가 뒤집히면 기록과 제출 사이에서 죽었을 때
  // 냈는지 안 냈는지 알 방법이 없습니다.
  assert.equal(events[0].type, "PLANNED");
  assert.equal(events[1].type, "SUBMITTED");
  assert.equal(events[1].brokerOrderId, events[1].brokerOrderId);
});

test("응답을 못 받으면 미결로 두고 재제출하지 않는다", async () => {
  const dataDir = await scratch();
  const broker = createFakeBroker({ behaviors: [{ timeout: true }] });

  const result = await runLiveCycle({ dataDir, broker, decisions: [DECISION] });

  assert.deepEqual(result.submitted, []);
  assert.match(result.log.join(" "), /결말 미정/);
  // PLANNED만 남고 SUBMITTED가 없습니다 — 상태를 모르기 때문입니다.
  const events = await readOrderEvents(dataDir);
  assert.deepEqual(events.map((event) => event.type), ["PLANNED"]);
  assert.equal(broker._orders.size, 1, "재제출하지 않았다");
});

test("다음 사이클이 조회로 결말을 짓고 그 사이클에 매매를 재개한다", async () => {
  const dataDir = await scratch();
  // 첫 사이클은 타임아웃, 두 번째는 정상입니다.
  const broker = createFakeBroker({ behaviors: [{ timeout: true }, { accept: true }] });

  await runLiveCycle({ dataDir, broker, decisions: [DECISION], now: new Date("2026-08-07T14:30:00Z") });
  const second = await runLiveCycle({
    dataDir, broker, decisions: [DECISION], now: new Date("2026-08-07T14:45:00Z"),
  });

  // 조회 단계가 결말을 짓습니다.
  assert.match(second.log.join(" "), /미결 1건 조회/);
  // 첫 주문이 브로커에 살아 있었으므로 SUBMITTED로 결말이 나고, 그러면 아직
  // 미결이라 이번 사이클은 멈춥니다. **결말이 났다고 곧바로 매매하지 않습니다.**
  assert.equal(second.halted, true);
  assert.equal(second.reason, HALT_REASONS.UNRESOLVED_ORDERS);
});

test("조회에서 '없음'이 나오면 결말이 나고 매매가 재개된다", async () => {
  const dataDir = await scratch();
  const broker = createFakeBroker({ behaviors: [{ timeout: true }] });
  // 브로커에 흔적이 없는 경우로 만듭니다 — 정말 안 나간 것입니다.
  broker.getOrder = async () => null;

  await runLiveCycle({ dataDir, broker, decisions: [DECISION], now: new Date("2026-08-07T14:30:00Z") });
  const second = await runLiveCycle({
    dataDir, broker, decisions: [DECISION], now: new Date("2026-08-07T14:45:00Z"),
  });

  assert.equal(second.halted, false, "안 나간 주문은 닫고 진행한다");
  assert.equal(second.submitted.length, 1);
});

test("긴급 중지가 걸려 있으면 아무것도 내지 않는다", async () => {
  const dataDir = await scratch();
  await engageEmergencyStop(dataDir, { reason: "테스트" });

  const result = await runLiveCycle({
    dataDir, broker: createFakeBroker(), decisions: [DECISION],
  });

  assert.equal(result.reason, HALT_REASONS.EMERGENCY_STOP);
  assert.deepEqual(await readOrderEvents(dataDir), [], "PLANNED조차 남기지 않는다");
});

test("보유 조회가 실패하면 대사를 통과로 보지 않는다", async () => {
  // 못 한 대사를 통과로 보면, 어긋난 채로 매매하지 않겠다는 목적이 무너집니다.
  const dataDir = await scratch();
  const broker = createFakeBroker();
  broker.getPositions = async () => { throw new Error("보유 API 장애"); };

  const result = await runLiveCycle({ dataDir, broker, decisions: [DECISION] });
  assert.equal(result.reason, HALT_REASONS.RECONCILE_MISMATCH);
});

test("장부와 브로커가 어긋나면 멈춘다", async () => {
  const dataDir = await scratch();
  const broker = createFakeBroker({ positions: { VTI: 40 } });

  const result = await runLiveCycle({
    dataDir, broker, decisions: [DECISION], ledgerPositions: { VTI: 43.83 },
  });
  assert.equal(result.reason, HALT_REASONS.RECONCILE_MISMATCH);
});

test("금액 주문 시간창이 닫혔으면 내지 않는다", async () => {
  const dataDir = await scratch();
  const result = await runLiveCycle({
    dataDir, broker: createFakeBroker(), decisions: [DECISION],
    session: { isOpen: true, isAmountOrderWindow: false },
  });

  assert.equal(result.reason, HALT_REASONS.AMOUNT_ORDER_WINDOW_CLOSED);
  // 내봐야 거부되고 호출 한도만 씁니다.
  assert.deepEqual(await readOrderEvents(dataDir), []);
});

test("거절은 결말이므로 기록하고 다음으로 넘어간다", async () => {
  const dataDir = await scratch();
  const broker = createFakeBroker({ behaviors: [{ reject: "잔고 부족" }] });

  const result = await runLiveCycle({ dataDir, broker, decisions: [DECISION] });

  assert.deepEqual(result.submitted, []);
  assert.match(result.log.join(" "), /거절/);
  assert.equal(result.orders.get([...result.orders.keys()][0]).state, ORDER_STATES.REJECTED);
});

test("한 사이클에 하나만 내고 나머지는 미룬다", async () => {
  const dataDir = await scratch();
  const broker = createFakeBroker({ behaviors: [{ accept: true }] });

  const result = await runLiveCycle({
    dataDir, broker,
    decisions: [DECISION, { symbol: "SCHD", side: "BUY", amountUsd: 3 }],
  });

  assert.equal(result.submitted.length, 1);
  assert.match(result.log.join(" "), /다음 사이클로 미룸: SCHD/);
});

test("낼 것이 없으면 조용히 지나간다", async () => {
  const dataDir = await scratch();
  const result = await runLiveCycle({ dataDir, broker: createFakeBroker(), decisions: [] });
  assert.equal(result.halted, false);
  assert.deepEqual(result.submitted, []);
});

/** ── 금액 주문 시간창 ─────────────────────────────────────────────────── */

test("금액 주문 창은 정규장보다 한 시간 좁다", () => {
  // 2026-08-07은 금요일. ET는 EDT(UTC-4)입니다.
  const at = (hhmm) => getUsRegularSessionStatus(new Date(`2026-08-07T${hhmm}:00Z`));

  const open = at("14:00"); // 10:00 ET
  assert.equal(open.isOpen, true);
  assert.equal(open.isAmountOrderWindow, true);

  const late = at("19:30"); // 15:30 ET — 정규장이지만 금액 주문은 마감
  assert.equal(late.isOpen, true, "정규장은 아직 열려 있다");
  assert.equal(late.isAmountOrderWindow, false, "금액 주문은 15:00 ET까지다");

  const closed = at("21:00"); // 17:00 ET
  assert.equal(closed.isOpen, false);
  assert.equal(closed.isAmountOrderWindow, false);
});

test("주말에는 두 창이 모두 닫힌다", () => {
  const saturday = getUsRegularSessionStatus(new Date("2026-08-08T14:00:00Z"));
  assert.equal(saturday.isOpen, false);
  assert.equal(saturday.isAmountOrderWindow, false);
});
