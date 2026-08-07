import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { FRED_SERIES, fetchFredSeries, fetchFredVintageDates } from "../FRED_data/fred-client.js";

/**
 * FRED 개정 이력(vintage) 캐시입니다.
 *
 * 일봉 캐시와 나눠둔 이유는 갱신 주기가 다르기 때문입니다. 일봉은 매일 바뀌지만
 * 개정 이력은 지표가 발표·개정될 때만 늘어나므로 한 번 받아두면 오래 씁니다.
 *
 * **realtime 범위를 넓게 줘서 모든 개정본을 받습니다.** 그래야 관측마다
 * `realtimeStart`(= 그 값이 세상에 알려진 날)가 함께 오고, 과거 어느 날의
 * 판단을 그날 알 수 있었던 것만으로 되살릴 수 있습니다.
 *
 * FRED의 제약 둘을 여기서 흡수합니다(2026-08-07 실측).
 *
 * 1. **한 요청에 vintage 날짜는 2000개까지.** T10Y2Y는 3094개, DFEDTARL은
 *    5067개라 한 번에 못 받습니다. 그래서 vintage 날짜 목록을 먼저 받아
 *    2000개 미만으로 잘라 나눠 요청하고 합칩니다.
 * 2. **`units`가 `lin`이 아니면 realtime 범위를 하나로 고정해야 합니다.**
 *    근원 PCE는 `pc1`(전년 대비)이 필요한데 개정 이력과 같이 못 받습니다.
 *    그래서 **원지수를 받아 전년 대비를 우리가 계산합니다**(`macro-history.js`).
 *    이쪽이 오히려 정확합니다 — 변환을 그 시점에 알려진 데이터 안에서 해야
 *    개정된 미래 값이 섞이지 않습니다.
 */

const CACHE_FILE = "macro-vintages.json";

// FRED가 "가장 이른 realtime"으로 쓰는 날짜입니다.
const REALTIME_BEGIN = "1776-07-04";
const REALTIME_END = "9999-12-31";
// 한 요청의 vintage 날짜 상한은 2000입니다. 경계에 붙이지 않고 여유를 둡니다.
const VINTAGE_CHUNK = 1900;

export async function loadMacroVintages({ dataDir }) {
  try {
    return JSON.parse(await readFile(path.join(dataDir, CACHE_FILE), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** vintage 날짜 목록을 2000개 미만의 realtime 창으로 자릅니다. */
export function chunkVintageWindows(vintageDates, size = VINTAGE_CHUNK) {
  if (!vintageDates?.length) return [{ start: REALTIME_BEGIN, end: REALTIME_END }];
  const windows = [];
  for (let index = 0; index < vintageDates.length; index += size) {
    const slice = vintageDates.slice(index, index + size);
    windows.push({
      start: slice[0],
      // 마지막 창은 끝을 열어둬야 이후에 나올 개정본까지 들어옵니다.
      end: index + size >= vintageDates.length ? REALTIME_END : slice[slice.length - 1],
    });
  }
  return windows;
}

export async function fetchAndCacheMacroVintages({
  dataDir,
  apiKey,
  now = new Date(),
  fetchImpl = fetch,
  limit = 100_000,
  log = () => {},
}) {
  if (!apiKey) throw new Error("FRED_API_KEY가 필요합니다.");

  const series = {};
  const failures = [];
  for (const [key, config] of Object.entries(FRED_SERIES)) {
    try {
      // pc1 같은 변환은 개정 이력과 같이 못 받으므로 원지수로 받고 변환은
      // 되살릴 때 합니다. 무엇을 해야 하는지는 transform으로 남깁니다.
      const needsTransform = config.units && config.units !== "lin";
      const vintageDates = await fetchFredVintageDates({
        apiKey, seriesId: config.id, fetchImpl,
      });
      const windows = chunkVintageWindows(vintageDates);
      log(`  ${config.id}: vintage ${vintageDates.length}개 → ${windows.length}회 요청`);

      const merged = new Map();
      for (const window of windows) {
        const observations = await fetchFredSeries({
          apiKey,
          seriesId: config.id,
          units: needsTransform ? "lin" : config.units,
          limit,
          fetchImpl,
          realtimeStart: window.start,
          realtimeEnd: window.end,
        });
        for (const item of observations) {
          // 창이 겹쳐 같은 (관측일, 공개일)이 두 번 오면 하나만 남깁니다.
          merged.set(`${item.date}|${item.realtimeStart ?? ""}`, item);
        }
      }

      const observations = [...merged.values()];
      const withVintage = observations.filter((item) => item.realtimeStart).length;
      if (withVintage === 0) {
        failures.push(`${config.id}: 개정 이력이 없습니다(realtime_start 없음)`);
        continue;
      }
      series[key] = {
        ...config,
        // 받은 단위와 되살릴 때 적용할 변환을 나눠 적습니다.
        units: needsTransform ? "lin" : config.units,
        transform: needsTransform ? config.units : null,
        observations,
        vintageCount: withVintage,
      };
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
  const snapshot = { version: 2, fetchedAt: now.toISOString(), series };
  await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  await rename(temporaryPath, cachePath);
  return { series, failures };
}
