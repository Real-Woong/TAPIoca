import { open, readFile, stat, unlink } from "node:fs/promises";

/**
 * 실행 잠금입니다. **오래된 잠금은 스스로 풉니다.**
 *
 * `wx`는 파일이 있으면 실패하므로 실행이 겹쳐 장부가 깨지는 것을 막습니다.
 * 문제는 **푸는 쪽**입니다 — 해제는 `finally`에만 달려 있는데, SIGINT(손 실행
 * 중 Ctrl-C)·SIGTERM(systemd 정지)·SIGKILL(OOM)·전원 단절에서는 `finally`가
 * 돌지 않습니다. 그러면 잠금 파일이 영구히 남고 **이후 모든 사이클이
 * 건너뜁니다.**
 *
 * 그 상태가 위험한 이유는 멈추기 때문이 아니라 **조용하기 때문**입니다. 매매도
 * 대사도 멈추는데 보고서는 별도 타이머라 평소처럼 나가고, 대사 무중단 카운트는
 * "어긋납니다"가 없는 것을 통과로 읽습니다. **침묵이 성공처럼 보입니다** —
 * 이 저장소가 ⑬·㉖·㉘에서 반복해 겪은 모양입니다.
 *
 * 그래서 둘 중 하나면 오래된 잠금으로 봅니다.
 *   · 잡은 지 `ttlMs`를 넘겼다 — 사이클은 보통 수십 초이고 타이머 주기는 15분이다
 *   · 기록된 PID가 살아 있지 않다 (`kill(pid, 0)`)
 *
 * 풀고 나서 **한 번만** 다시 시도합니다. 두 프로세스가 동시에 같은 판단을 해도
 * `wx`가 하나만 통과시키고, 진 쪽은 평소처럼 이번 사이클을 건너뜁니다.
 */
export const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * @returns {Promise<{handle: import("node:fs/promises").FileHandle, recoveredReason: string|null}>}
 *   살아 있는 잠금이 이미 있으면 `EEXIST` 오류를 그대로 던집니다 — 부르는 쪽이
 *   "겹쳤으니 이번은 건너뛴다"로 처리합니다.
 */
export async function acquireRunLock({
  lockPath,
  ttlMs = DEFAULT_LOCK_TTL_MS,
  pid = process.pid,
  now = () => Date.now(),
  isAlive = isProcessAlive,
}) {
  try {
    return { handle: await createLock(lockPath, pid, now), recoveredReason: null };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const reason = await staleLockReason(lockPath, { ttlMs, now, isAlive });
    // 진짜로 돌고 있는 잠금입니다. EEXIST를 그대로 올려보냅니다.
    if (!reason) throw error;
    await unlink(lockPath).catch(() => {});
    return { handle: await createLock(lockPath, pid, now), recoveredReason: reason };
  }
}

async function createLock(lockPath, pid, now) {
  const handle = await open(lockPath, "wx");
  // **누가 언제 잡았는지를 적습니다.** 빈 파일이면 남은 잠금을 볼 때 나이밖에
  // 알 수 없고, 그마저 파일시스템 시각에 기댑니다.
  await handle.writeFile(
    `${JSON.stringify({ pid, startedAt: new Date(now()).toISOString() })}\n`,
  );
  return handle;
}

/** 오래된 잠금이면 사람이 읽을 사유를, 살아 있는 잠금이면 null을 냅니다. */
async function staleLockReason(lockPath, { ttlMs, now, isAlive }) {
  const info = await readLockInfo(lockPath);
  if (info.pid !== null && !isAlive(info.pid)) return `pid ${info.pid}가 없습니다`;

  const ageMs = info.startedAt === null ? null : now() - info.startedAt;
  if (ageMs !== null && ageMs > ttlMs) {
    return `${Math.round(ageMs / 60000)}분 전에 잡혔습니다 (한도 ${Math.round(ttlMs / 60000)}분)`;
  }
  // 나이도 PID도 모르면 **풀지 않습니다.** 돌고 있는 사이클을 두 번 돌리는 것이
  // 잠금이 남는 것보다 나쁩니다 — 장부가 깨집니다.
  return null;
}

/**
 * 잠금 파일에서 PID와 시작 시각을 읽습니다.
 *
 * **내용이 없거나 깨졌어도 나이는 알아야 합니다.** 이 코드 이전에 만들어진
 * 잠금과, 파일을 만들고 기록하기 전에 죽은 경우가 그렇습니다. 그때는 파일
 * 수정 시각으로 대신합니다.
 */
async function readLockInfo(lockPath) {
  let parsed = null;
  try {
    parsed = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    parsed = null;
  }
  const pid = Number.isInteger(parsed?.pid) && parsed.pid > 0 ? parsed.pid : null;
  const recorded = Date.parse(parsed?.startedAt ?? "");
  if (Number.isFinite(recorded)) return { pid, startedAt: recorded };

  const mtime = await stat(lockPath).then((stats) => stats.mtimeMs).catch(() => null);
  return { pid, startedAt: Number.isFinite(mtime) ? mtime : null };
}

export function isProcessAlive(pid) {
  try {
    // 신호 0은 보내지 않고 존재만 확인합니다. EPERM은 "있는데 권한이 없다"이므로
    // 살아 있는 것으로 봅니다. **같은 호스트라는 전제입니다** — 이 잠금은
    // `data/`에 있고 그 디렉터리는 서버 한 대에만 있습니다.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
