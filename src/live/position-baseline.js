import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 실거래를 시작하는 순간의 **보유 기준선**입니다.
 *
 * 이 시스템은 계좌 전체가 자기 것이라고 가정하고 만들어졌습니다. 실제 계좌에는
 * **이미 다른 자산이 있습니다**(2026-08-07 확인: 평가 [가림]). 그 상태로 대사하면
 * 우리 장부(비어 있음)와 브로커가 어긋나 영구 정지합니다.
 *
 * 그래서 대사 대상을 바꿉니다.
 *
 *   ❌ 브로커 보유 == 우리 장부
 *   ✅ 브로커 보유 == **기준선 + 우리가 체결시킨 것**
 *
 * 기준선은 "우리가 손대기 전의 계좌"이고 그 뒤로 고정입니다. 우리가 만든 변화만
 * 우리 책임이고, 나머지는 사용자의 것입니다.
 *
 * **기준선을 다시 잡는 것은 위험합니다.** 그 순간 우리가 만든 포지션까지
 * "원래 있던 것"으로 편입되어, 잘못 산 것이 영영 대사에서 사라집니다. 그래서
 * 덮어쓰기를 막고 사람이 명시적으로 지우게 합니다.
 */

const BASELINE_FILE = "live-position-baseline.json";

export function baselinePath(dataDir) {
  return path.join(dataDir, BASELINE_FILE);
}

export async function readBaseline(dataDir) {
  try {
    return JSON.parse(await readFile(baselinePath(dataDir), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 기준선을 처음 한 번 기록합니다. **이미 있으면 덮어쓰지 않고 거부합니다.**
 */
export async function saveBaseline(dataDir, positions, { at = new Date().toISOString() } = {}) {
  const existing = await readBaseline(dataDir);
  if (existing) {
    throw new Error(
      `기준선이 이미 있습니다(${existing.at}). 덮어쓰면 우리가 만든 포지션까지 ` +
        "'원래 있던 것'으로 편입되어 잘못 산 것이 대사에서 사라집니다.\n" +
        `  정말 다시 잡으려면 먼저 지우십시오: ${baselinePath(dataDir)}`,
    );
  }

  await mkdir(dataDir, { recursive: true });
  const snapshot = { version: 1, at, positions: { ...positions } };
  await writeFile(baselinePath(dataDir), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  return snapshot;
}

/**
 * 지금 브로커에 있어야 할 수량을 계산합니다 — **기준선 + 우리가 체결시킨 것**.
 *
 * @param {object} baselinePositions 시작 시점 수량
 * @param {Map}    realized `realizedFills()` 결과 (종목 → {quantity, usd})
 */
export function expectedPositions(baselinePositions, realized) {
  const expected = { ...(baselinePositions ?? {}) };
  for (const [symbol, fill] of realized ?? new Map()) {
    expected[symbol] = (Number(expected[symbol]) || 0) + (Number(fill.quantity) || 0);
  }
  return expected;
}

/**
 * 우리가 관리하는 종목만 남깁니다.
 *
 * 사용자가 우리 워치리스트 밖의 종목을 사고팔아도 우리 대사가 깨지면 안 됩니다.
 * **다만 워치리스트 안의 종목을 손수 매매하면 그것은 잡혀야 합니다** — 그 경우
 * 우리 계산과 실제가 정말로 어긋나기 때문입니다.
 */
export function restrictToManaged(positions, managedSymbols) {
  const managed = new Set(managedSymbols ?? []);
  const restricted = {};
  for (const [symbol, value] of Object.entries(positions ?? {})) {
    if (managed.has(symbol)) restricted[symbol] = value;
  }
  return restricted;
}
