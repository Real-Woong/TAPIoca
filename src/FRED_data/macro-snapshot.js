import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { fetchMacroData } from "./fred-client.js";
import { evaluateMacroRegime } from "./macro-regime.js";

// FRED 지표는 분 단위 데이터가 아니므로 PAPER가 실행될 때마다 다시 받을 필요가 없습니다.
// 기본 6시간 동안 같은 스냅샷을 사용해 API 호출량과 외부 장애 영향을 줄입니다.
export const DEFAULT_MACRO_CACHE_MS = 6 * 60 * 60 * 1000;

/**
 * 캐시가 최신이면 파일에서 읽고, 오래됐으면 FRED에서 새로 받아 저장합니다.
 * 새 요청이 실패해도 기존 캐시가 있으면 stale 표시와 함께 마지막 값을 반환합니다.
 */
export async function loadMacroSignal({
  dataDir,
  apiKey,
  now = new Date(),
  maxAgeMs = DEFAULT_MACRO_CACHE_MS,
  fetchImpl = fetch,
}) {
  const snapshotPath = path.join(dataDir, "macro-snapshot.json");
  const cached = await readSnapshot(snapshotPath);

  if (cached && isFresh(cached, now, maxAgeMs)) {
    return { ...cached, source: "CACHE", stale: false };
  }

  try {
    const macroData = await fetchMacroData(apiKey, fetchImpl);
    const evaluated = evaluateMacroRegime(macroData, now);
    const snapshot = {
      version: 1,
      fetchedAt: macroData.fetchedAt,
      ...evaluated,
    };

    await mkdir(dataDir, { recursive: true });
    await writeSnapshot(snapshotPath, snapshot);
    return { ...snapshot, source: "FRED", stale: false };
  } catch (error) {
    // 일시적인 FRED 장애가 기존 PAPER 청산 판단까지 막지 않도록 마지막 캐시를 사용합니다.
    if (cached) {
      return {
        ...cached,
        source: "STALE_CACHE",
        stale: true,
        warning: error.message,
      };
    }
    throw error;
  }
}

async function readSnapshot(snapshotPath) {
  try {
    return JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isFresh(snapshot, now, maxAgeMs) {
  const timestamp = new Date(snapshot.fetchedAt).getTime();
  return Number.isFinite(timestamp) && now.getTime() - timestamp <= maxAgeMs;
}

async function writeSnapshot(snapshotPath, snapshot) {
  // 임시 파일을 완성한 뒤 rename하여 저장 중 종료돼도 기존 캐시가 깨지지 않게 합니다.
  const temporaryPath = `${snapshotPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, snapshotPath);
}
