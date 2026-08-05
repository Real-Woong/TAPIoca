import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_TREND_OPTIONS, fetchDailyCloses } from "../market/trend-signal.js";

/**
 * 백테스트용 일봉 캐시입니다.
 *
 * 운영 코드와 같은 소스 체인(Twelve Data → Yahoo → Stooq)을 씁니다.
 * 무료 소스는 자주 막히므로(2026-08-05 기준 Yahoo는 IP 단위 429, Stooq는
 * JavaScript proof-of-work 차단) 한 번 받은 종가는 파일로 남겨 재사용합니다.
 * 캐시가 없으면 백테스터는 합성 경로로 폴백합니다.
 */

const CACHE_FILE = "backtest-closes.json";

export async function loadCachedCloses({ dataDir, symbols }) {
  const cachePath = path.join(dataDir, CACHE_FILE);
  let cache;
  try {
    cache = JSON.parse(await readFile(cachePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  const closesBySymbol = {};
  for (const symbol of symbols) {
    const closes = cache?.symbols?.[symbol];
    if (!Array.isArray(closes) || closes.length === 0) return null;
    closesBySymbol[symbol] = closes;
  }
  return { closesBySymbol, fetchedAt: cache.fetchedAt, sources: cache.sources ?? {} };
}

/**
 * 일봉을 받아 캐시에 저장합니다.
 * 한 종목이라도 실패하면 그 종목만 건너뛰고 나머지는 저장합니다.
 * 무료 소스는 종목별로 따로 막히는 일이 흔하기 때문입니다.
 */
export async function fetchAndCacheCloses({
  dataDir,
  symbols,
  now = new Date(),
  fetchImpl = fetch,
  apiKey = undefined,
  maxSamples = 5000,
}) {
  const config = { ...DEFAULT_TREND_OPTIONS, maxSamples };
  const existing = await loadCachedCloses({ dataDir, symbols }).catch(() => null);
  const closesBySymbol = { ...(existing?.closesBySymbol ?? {}) };
  const sources = { ...(existing?.sources ?? {}) };
  const failures = [];

  for (const symbol of symbols) {
    try {
      const { closes, source } = await fetchDailyCloses(symbol, config, fetchImpl, apiKey);
      closesBySymbol[symbol] = closes;
      sources[symbol] = source;
    } catch (error) {
      failures.push(`${symbol}: ${error.message}`);
    }
  }

  if (Object.keys(closesBySymbol).length === 0) {
    throw new Error(`일봉을 한 종목도 받지 못했습니다 — ${failures.join(" | ")}`);
  }

  await mkdir(dataDir, { recursive: true });
  const cachePath = path.join(dataDir, CACHE_FILE);
  const temporaryPath = `${cachePath}.tmp`;
  const snapshot = {
    version: 1,
    fetchedAt: now.toISOString(),
    sources,
    symbols: closesBySymbol,
  };
  await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  await rename(temporaryPath, cachePath);
  return { closesBySymbol, sources, failures };
}
