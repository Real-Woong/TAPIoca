import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  engageEmergencyStop,
  readEmergencyStop,
  releaseEmergencyStop,
} from "../src/live/emergency-stop.js";
import { createFakeBroker } from "../src/live/fake-broker.js";
import {
  DEFAULT_LIMITS,
  createRateLimiter,
  isNarrowWindow,
} from "../src/live/rate-limiter.js";

const scratch = () => mkdtemp(path.join(tmpdir(), "live-safety-"));

/**
 * 긴급 중지와 호출 제한을 고정합니다.
 *
 * 둘 다 "잘 될 때"는 아무 일도 하지 않는 장치입니다. 값을 하는 순간은 뭔가
 * 잘못 돌고 있을 때뿐이고, 그때 동작하지 않으면 없는 것과 같습니다.
 */

test("파일이 없으면 멈춤이 아니다", async () => {
  assert.equal((await readEmergencyStop(await scratch())).stopped, false);
});

test("파일이 있으면 멈춤이다 — 내용이 깨져 있어도", async () => {
  const dataDir = await scratch();
  await writeFile(path.join(dataDir, "EMERGENCY_STOP"), "이건 JSON이 아님");

  const state = await readEmergencyStop(dataDir);
  assert.equal(state.stopped, true, "스위치는 내용과 무관하게 들어야 한다");
  assert.match(state.reason, /JSON이 아님/);
});

test("읽을 수 없으면 멈춤으로 본다 — 안전 스위치는 안전한 쪽으로 넘어진다", async () => {
  // 디렉터리를 파일 경로로 주면 EISDIR가 납니다(ENOENT가 아닌 오류).
  const dataDir = await scratch();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(dataDir, "EMERGENCY_STOP"));

  const state = await readEmergencyStop(dataDir);
  assert.equal(state.stopped, true, "판단할 수 없으면 멈춘다");
  assert.match(state.reason, /읽을 수 없습니다/);
});

test("멈추면 이미 낸 주문도 거둔다", async () => {
  const dataDir = await scratch();
  const broker = createFakeBroker({ behaviors: [{ accept: true }, { accept: true }] });
  await broker.submitOrder({ clientOrderId: "A", symbol: "VTI", side: "BUY", amountUsd: 5 });
  await broker.submitOrder({ clientOrderId: "B", symbol: "IWM", side: "BUY", amountUsd: 3 });

  const result = await engageEmergencyStop(dataDir, { reason: "테스트", broker });

  assert.equal(result.canceled.length, 2, "신규 차단만으로는 실효가 없다");
  assert.equal((await broker.listOpenOrders()).length, 0);
  assert.equal((await readEmergencyStop(dataDir)).stopped, true);
});

test("취소가 실패해도 플래그는 남는다", async () => {
  const dataDir = await scratch();
  const broker = createFakeBroker({ behaviors: [{ accept: true }] });
  await broker.submitOrder({ clientOrderId: "A", symbol: "VTI", side: "BUY", amountUsd: 5 });
  broker.cancelOrder = async () => { throw new Error("취소 API 장애"); };

  const result = await engageEmergencyStop(dataDir, { broker });

  assert.equal(result.failed.length, 1);
  // 플래그를 먼저 쓰므로 취소 도중에 죽어도 다음 사이클이 멈춥니다.
  assert.equal((await readEmergencyStop(dataDir)).stopped, true);
});

test("미체결 목록 조회가 실패해도 플래그는 남는다", async () => {
  const dataDir = await scratch();
  const broker = createFakeBroker();
  broker.listOpenOrders = async () => { throw new Error("목록 API 장애"); };

  await engageEmergencyStop(dataDir, { broker });
  assert.equal((await readEmergencyStop(dataDir)).stopped, true);
});

test("중지 사유와 시각을 남긴다", async () => {
  const dataDir = await scratch();
  await engageEmergencyStop(dataDir, { reason: "체결가 이상", at: "2026-08-07T14:30:00Z" });

  const state = await readEmergencyStop(dataDir);
  assert.equal(state.reason, "체결가 이상");
  assert.equal(state.since, "2026-08-07T14:30:00Z");
  // 파일에도 사람이 읽을 수 있게 남습니다.
  assert.match(await readFile(path.join(dataDir, "EMERGENCY_STOP"), "utf8"), /체결가 이상/);
});

test("중지 해제는 사람이 명시적으로 한다", async () => {
  const dataDir = await scratch();
  await engageEmergencyStop(dataDir);
  assert.equal((await releaseEmergencyStop(dataDir)).released, true);
  assert.equal((await readEmergencyStop(dataDir)).stopped, false);
  // 두 번 풀면 이미 풀렸다고 알려 줍니다.
  assert.equal((await releaseEmergencyStop(dataDir)).released, false);
});

/** ── 호출 제한 ─────────────────────────────────────────────────────────── */

/** 시계를 직접 돌려 실제로 기다리지 않고 검증합니다. */
function fakeClock(start = new Date("2026-08-07T14:00:00Z")) {
  let time = start.getTime();
  return {
    now: () => new Date(time),
    sleep: async (ms) => { time += ms; },
    advance: (ms) => { time += ms; },
    elapsed: () => time - start.getTime(),
  };
}

test("초당 한도를 넘기면 다음 창까지 기다린다", async () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep });

  // 주문 한도는 6이므로 일곱 번째에서 기다립니다.
  for (let index = 0; index < 6; index += 1) await limiter.acquire("order");
  assert.equal(clock.elapsed(), 0, "한도 안에서는 기다리지 않는다");

  await limiter.acquire("order");
  assert.ok(clock.elapsed() >= 1000, `1초 창이 지나야 한다: ${clock.elapsed()}ms`);
});

test("카테고리마다 한도를 따로 센다", async () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep });

  // 계좌 목록은 초당 1회입니다. 주문 한도를 다 써도 영향을 주지 않습니다.
  for (let index = 0; index < 6; index += 1) await limiter.acquire("order");
  await limiter.acquire("accounts");
  assert.equal(clock.elapsed(), 0);

  await limiter.acquire("accounts");
  assert.ok(clock.elapsed() >= 1000, "계좌 목록은 초당 1회다");
});

test("429를 맞으면 Retry-After만큼 전면 차단한다", async () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep });

  const result = limiter.observeResponse("order", {
    status: 429,
    headers: { "Retry-After": "3" },
  });
  assert.equal(result.blockedForMs, 3000);

  // 다른 카테고리도 함께 막힙니다 — 한도를 넘긴 상태에서 계속 두드리면
  // 차단이 길어질 수 있습니다.
  await limiter.acquire("holdings");
  assert.ok(clock.elapsed() >= 3000, `전면 차단이어야 한다: ${clock.elapsed()}ms`);
});

test("Retry-After가 없으면 1초를 쓴다 — 0으로 두면 곧바로 다시 맞는다", () => {
  const limiter = createRateLimiter({ now: fakeClock().now });
  assert.equal(limiter.observeResponse("order", { status: 429, headers: {} }).blockedForMs, 1000);
});

test("응답 헤더의 한도를 우리 상수보다 믿는다", async () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep });
  assert.equal(limiter.currentLimits().order, DEFAULT_LIMITS.order);

  // 운영 중 제한이 바뀌면 우리 상수는 낡은 값이 됩니다.
  limiter.observeResponse("order", { status: 200, headers: { "X-RateLimit-Limit": "2" } });
  assert.equal(limiter.currentLimits().order, 2);

  for (let index = 0; index < 2; index += 1) await limiter.acquire("order");
  assert.equal(clock.elapsed(), 0);
  await limiter.acquire("order");
  assert.ok(clock.elapsed() >= 1000, "새 한도 2가 적용돼야 한다");
});

test("Headers 객체로 와도 읽는다", () => {
  const limiter = createRateLimiter({ now: fakeClock().now });
  limiter.observeResponse("order", { status: 200, headers: new Headers({ "X-RateLimit-Limit": "4" }) });
  assert.equal(limiter.currentLimits().order, 4);
});

test("한국시간 09:00~09:10에는 주문 한도가 3으로 좁아진다", async () => {
  // KST 09:05 = UTC 00:05
  const clock = fakeClock(new Date("2026-08-07T00:05:00Z"));
  assert.equal(isNarrowWindow(clock.now()), true);

  const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep });
  for (let index = 0; index < 3; index += 1) await limiter.acquire("order");
  assert.equal(clock.elapsed(), 0);
  await limiter.acquire("order");
  assert.ok(clock.elapsed() >= 1000, "좁은 창에서는 3회가 상한이다");
});

test("좁은 창은 우리 매매 시간과 겹치지 않는다", () => {
  // 미국 정규장은 한국시간 밤~새벽이라 09:00~09:10과 겹칠 일이 없습니다.
  // 그래도 넣어 두는 이유는 이 사실이 바뀌었을 때 조용히 틀리지 않기 위해서입니다.
  assert.equal(isNarrowWindow(new Date("2026-08-07T14:30:00Z")), false, "미국 장중(KST 23:30)");
  assert.equal(isNarrowWindow(new Date("2026-08-07T20:00:00Z")), false, "미국 장중(KST 05:00)");
});

test("데이터 디렉터리가 없어도 중지를 걸 수 있다", async () => {
  // 갓 배포한 호스트에는 data/가 아직 없을 수 있습니다. 긴급 중지가 정작
  // 필요한 순간에 실패하는 종류의 실패라 따로 고정합니다.
  const missing = path.join(await scratch(), "아직", "없는", "경로");
  await engageEmergencyStop(missing, { reason: "새 호스트" });
  assert.equal((await readEmergencyStop(missing)).stopped, true);
});
