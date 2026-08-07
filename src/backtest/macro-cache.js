import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { FRED_SERIES, fetchFredSeries } from "../FRED_data/fred-client.js";

/**
 * FRED 개정 이력(vintage) 캐시입니다.
 *
 * 일봉 캐시와 나눠둔 이유는 갱신 주기가 다르기 때문입니다. 일봉은 매일 바뀌지만
 * 개정 이력은 지표가 발표·개정될 때만 늘어나므로 한 번 받아두면 오래 씁니다.
 *
 * **realtime 범위를 넓게 줘서 모든 개정본을 받습니다.** 그래야 관측마다
 * `realtimeStart`(= 그 값이 세상에 알려진 날)가 함께 오고, 과거 어느 날의
 * 판단을 그날 알 수 있었던 것만으로 되살릴 수 있습니다. 기본 조회는 개정된
 * 최신값만 주므로 그대로 쓰면 look-ahead입니다.
 */

const CACHE_FILE = "macro-vintages.json";

// FRED가 "가장 이른 realtime"으로 쓰는 날짜입니다.
const REALTIME_BEGIN = "1776-07-04";
const REALTIME_END = "9999-12-31";

export async function loadMacroVintages({ dataDir }) {
  try {
    return JSON.parse(await readFile(path.join(dataDir, CACHE_FILE), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function fetchAndCacheMacroVintages({
  dataDir,
  apiKey,
  now = new Date(),
  fetchImpl = fetch,
  // 20년 백테스트에 필요한 관측 수입니다. 개정본이 관측마다 여러 줄이므로
  // 원 관측 수보다 훨씬 큽니다.
  limit = 100_000,
}) {
  if (!apiKey) throw new Error("FRED_API_KEY가 필요합니다.");

  const series = {};
  const failures = [];
  for (const [key, config] of Object.entries(FRED_SERIES)) {
    try {
      const observations = await fetchFredSeries({
        apiKey,
        seriesId: config.id,
        units: config.units,
        limit,
        fetchImpl,
        realtimeStart: REALTIME_BEGIN,
        realtimeEnd: REALTIME_END,
      });
      // realtimeStart가 없으면 되살리기에 못 씁니다. 조용히 통과시키면 나중에
      // "관측이 하나도 안 남는" 형태로만 드러나므로 여기서 잡습니다.
      const withVintage = observations.filter((item) => item.realtimeStart).length;
      if (withVintage === 0) {
        failures.push(`${config.id}: 개정 이력이 없습니다(realtime_start 없음)`);
        continue;
      }
      series[key] = { ...config, observations, vintageCount: withVintage };
    } catch (error) {
      failures.push(`${config.id}: ${error.message}`);
    }
  }

  if (Object.keys(series).length !== Object.keys(FRED_SERIES).length) {
    throw new Error(`거시 개정 이력을 다 받지 못했습니다 — ${failures.join(" | ")}`);
  }

  await mkdir(dataDir, { recursive: true });
  const cachePath = path.join(dataDir, CACHE_FILE);
  const temporaryPath = `${cachePath}.tmp`;
  const snapshot = { version: 1, fetchedAt: now.toISOString(), series };
  await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  await rename(temporaryPath, cachePath);
  return { series, failures };
}
