import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 실거래를 시작하는 순간의 **보유 기준선**입니다.
 *
 * 이 시스템은 계좌 전체가 자기 것이라고 가정하고 만들어졌습니다. 실제 계좌에는
 * **이미 다른 자산이 있습니다**(2026-08-07 확인). 그 상태로 대사하면
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

/** 수량 비교에서 0으로 볼 오차입니다. 체결 수량이 소수점 여섯째 자리까지 옵니다. */
const QUANTITY_EPSILON = 1e-6;

/**
 * **지금 보유에서 우리가 체결시킨 것을 빼서** 기준선을 되살립니다.
 *
 * 이 함수가 필요한 이유가 있습니다 — 기준선은 "우리가 손대기 전"이어야 하는데,
 * 실제로 그것을 기록하려는 시점에는 **이미 손을 댄 뒤**인 경우가 많습니다.
 * 2026-08-07에 수동 `live:probe`로 네 건이 나갔고, 기준선은 그 뒤에 만듭니다.
 *
 * 그때 "지금 보유"를 그대로 기준선으로 삼으면 **우리가 산 것이 '원래 있던 것'으로
 * 편입됩니다.** 그러면 `expectedPositions`가 기준선에 체결분을 또 더해 같은
 * 수량을 두 번 세고, 대사는 영원히 어긋납니다.
 *
 *   기준선 = 지금 브로커 보유 − 우리 원장의 실현 체결
 *
 * 이렇게 하면 `expectedPositions(기준선, 체결) == 지금 보유`가 되어 처음부터
 * 아귀가 맞습니다. 원장이 비어 있으면 빼는 것이 없으므로 그냥 현재 보유입니다.
 *
 * @param {object} currentPositions 브로커가 말하는 지금 수량
 * @param {Map}    realized `realizedFills()` 결과
 * @returns {{positions: object, warnings: string[]}}
 */
export function baselineFromCurrent(currentPositions, realized) {
  const positions = { ...(currentPositions ?? {}) };
  const warnings = [];

  for (const [symbol, fill] of realized ?? new Map()) {
    const now = Number(positions[symbol]) || 0;
    const ours = Number(fill.quantity) || 0;
    const before = now - ours;

    // **음수는 그냥 넘길 수 없습니다.** 우리 원장이 브로커보다 많이 샀다고
    // 말하는 상태이고, 그것은 사용자가 우리 종목을 손수 팔았거나 원장이 실제와
    // 다르다는 뜻입니다. 어느 쪽이든 사람이 봐야 합니다.
    if (before < -QUANTITY_EPSILON) {
      warnings.push(
        `${symbol}: 지금 보유(${now})보다 우리 체결(${ours})이 많습니다. `
        + "사용자가 손수 팔았거나 원장이 실제와 다릅니다. 0으로 두지만 확인이 필요합니다.",
      );
    }

    positions[symbol] = Math.abs(before) < QUANTITY_EPSILON ? 0 : Math.max(0, before);
  }

  return { positions, warnings };
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
