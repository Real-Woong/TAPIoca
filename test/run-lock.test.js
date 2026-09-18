import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { acquireRunLock } from "../src/paper/run-lock.js";

/**
 * 잠금이 남는 것 자체보다 **남은 채로 조용한 것**이 위험합니다. 해제는
 * `finally`에만 달려 있고 SIGINT·SIGTERM·SIGKILL에서는 그것이 돌지 않습니다.
 */

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), "run-lock-"));
  return path.join(dir, "paper-runner.lock");
}

const ALIVE = () => true;
const DEAD = () => false;

test("잠금을 잡고 누가 언제 잡았는지 적는다", async () => {
  const lockPath = await scratch();

  const { handle, recoveredReason } = await acquireRunLock({
    lockPath, pid: 4242, now: () => Date.parse("2026-09-18T20:00:00.000Z"),
  });
  await handle.close();

  assert.equal(recoveredReason, null);
  const written = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(written.pid, 4242);
  assert.equal(written.startedAt, "2026-09-18T20:00:00.000Z");
});

test("살아 있는 잠금은 풀지 않는다 — 겹친 실행은 건너뛰어야 한다", async () => {
  const lockPath = await scratch();
  const now = () => Date.parse("2026-09-18T20:00:00.000Z");
  const first = await acquireRunLock({ lockPath, pid: 4242, now });

  await assert.rejects(
    () => acquireRunLock({ lockPath, pid: 777, now, isAlive: ALIVE }),
    (error) => error.code === "EEXIST",
  );
  await first.handle.close();
});

test("PID가 죽었으면 해제하고 잡는다", async () => {
  const lockPath = await scratch();
  const now = () => Date.parse("2026-09-18T20:00:00.000Z");
  const first = await acquireRunLock({ lockPath, pid: 4242, now });
  await first.handle.close();

  // 1분밖에 안 지났으므로 TTL로는 못 푼다. 푸는 것은 PID다.
  const { handle, recoveredReason } = await acquireRunLock({
    lockPath, pid: 777, now: () => Date.parse("2026-09-18T20:01:00.000Z"), isAlive: DEAD,
  });
  await handle.close();

  assert.match(recoveredReason, /pid 4242가 없습니다/);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, 777);
});

test("TTL을 넘긴 잠금은 PID가 살아 있어 보여도 해제한다", async () => {
  const lockPath = await scratch();
  const first = await acquireRunLock({
    lockPath, pid: 4242, now: () => Date.parse("2026-09-18T20:00:00.000Z"),
  });
  await first.handle.close();

  // PID 재사용으로 남의 프로세스가 살아 있는 것처럼 보이는 경우를 나이가 덮는다.
  const { recoveredReason, handle } = await acquireRunLock({
    lockPath, pid: 777, now: () => Date.parse("2026-09-18T20:31:00.000Z"), isAlive: ALIVE,
  });
  await handle.close();

  assert.match(recoveredReason, /31분 전에 잡혔습니다 \(한도 10분\)/);
});

test("내용이 깨진 잠금은 파일 시각으로 나이를 잰다", async () => {
  const lockPath = await scratch();
  // 이 코드 이전에 만들어진 빈 잠금, 또는 기록 전에 죽은 경우다.
  await writeFile(lockPath, "");

  const { handle, recoveredReason } = await acquireRunLock({
    lockPath, pid: 777, now: () => Date.now() + 60 * 60 * 1000, isAlive: ALIVE,
  });
  await handle.close();

  assert.match(recoveredReason, /분 전에 잡혔습니다/);
});

test("나이도 PID도 모르면 풀지 않는다 — 두 번 도는 것이 더 나쁘다", async () => {
  const lockPath = await scratch();
  await writeFile(lockPath, "");

  await assert.rejects(
    // 방금 만들어진 빈 잠금이다. 나이가 한도 안이고 PID는 없다.
    () => acquireRunLock({ lockPath, pid: 777, isAlive: ALIVE }),
    (error) => error.code === "EEXIST",
  );
});
