import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Faber(2007) "A Quantitative Approach to Tactical Asset Allocation"의 이동평균 추세 필터입니다.
// 논문은 월말 가격이 10개월 이동평균 위면 보유, 아래면 현금으로 판단합니다.
// 여기서는 일봉 종가와 200거래일(≈10개월) 이동평균을 사용하고, 이진 판정 대신
// tanh로 연속 점수화해 경계선 근처의 급격한 신호 반전(채찍질)을 줄입니다.
export const DEFAULT_TREND_OPTIONS = Object.freeze({
  maPeriod: 200,
  // 이동평균 대비 이 편차(%)에서 점수가 tanh로 ±0.76 수준에 도달합니다.
  deviationScalePercent: 5,
  maxSamples: 300,
});

/** 일봉 종가 배열 하나의 200일 이동평균 대비 위치를 연속 점수로 계산합니다. */
export function calculateTrend(values, options = {}) {
  const config = { ...DEFAULT_TREND_OPTIONS, ...options };
  validateOptions(config);
  const closes = (values ?? []).map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (closes.length < config.maPeriod) {
    return { ready: false, sampleCount: closes.length, minimumSamples: config.maPeriod };
  }

  const window = closes.slice(-config.maPeriod);
  const movingAverage = window.reduce((sum, value) => sum + value, 0) / window.length;
  const price = closes.at(-1);
  const deviationPercent = (price / movingAverage - 1) * 100;
  const score = Math.tanh(deviationPercent / config.deviationScalePercent);
  return {
    ready: true,
    sampleCount: closes.length,
    minimumSamples: config.maPeriod,
    price: round(price),
    movingAverage: round(movingAverage),
    deviationPercent: round(deviationPercent),
    score: round(score),
    // 가격이 이동평균 위면 상승 추세(보유), 아래면 하락 추세(방어)입니다.
    direction: score > 0 ? "UPTREND" : score < 0 ? "DOWNTREND" : "FLAT",
  };
}

/** 여러 종목의 종가를 모아 하나의 시장 추세 신호로 집계합니다. */
export function buildTrendSignal(closesBySymbol = {}, options = {}, now = new Date()) {
  const config = { ...DEFAULT_TREND_OPTIONS, ...options };
  const indicators = {};
  for (const [symbol, closes] of Object.entries(closesBySymbol)) {
    indicators[symbol] = calculateTrend(closes, config);
  }

  const all = Object.values(indicators);
  const ready = all.filter((indicator) => indicator.ready);
  if (ready.length === 0) {
    return {
      available: false,
      evaluatedAt: now.toISOString(),
      score: 0,
      confidence: 0,
      readySymbols: 0,
      totalSymbols: all.length,
      indicators,
    };
  }

  const score = ready.reduce((sum, indicator) => sum + indicator.score, 0) / ready.length;
  // MACD 집계와 같은 방식: 준비된 종목 비율 × 방향 일치도로 신뢰도를 만듭니다.
  const directionalAgreement = Math.abs(
    ready.reduce((sum, indicator) => sum + Math.sign(indicator.score), 0) / ready.length,
  );
  const coverage = all.length > 0 ? ready.length / all.length : 0;
  return {
    available: true,
    evaluatedAt: now.toISOString(),
    score: round(score),
    confidence: round(coverage * directionalAgreement),
    readySymbols: ready.length,
    totalSymbols: all.length,
    indicators,
  };
}

/**
 * Stooq 무료 일봉 CSV에서 종가를 받아 추세 신호를 만듭니다.
 * 일봉 데이터는 하루 한 번만 갱신하면 되므로 캐시가 신선하면 재요청하지 않고,
 * 요청이 실패하면 이전 캐시로 폴백합니다. API 키가 필요 없습니다.
 */
export async function loadTrendSignal({
  dataDir,
  symbols,
  now = new Date(),
  fetchImpl = fetch,
  maxAgeHours = 20,
  options = {},
}) {
  const config = { ...DEFAULT_TREND_OPTIONS, ...options };
  const snapshotPath = path.join(dataDir, "trend-snapshot.json");
  const cached = await readSnapshot(snapshotPath);
  const isFresh = cached?.fetchedAt && ageHours(cached.fetchedAt, now) < maxAgeHours;

  if (isFresh) {
    return buildTrendSignal(cached.symbols ?? {}, config, now);
  }

  try {
    const closesBySymbol = await fetchAllCloses(symbols ?? [], config, fetchImpl);
    await mkdir(dataDir, { recursive: true });
    await writeSnapshot(snapshotPath, {
      version: 1,
      fetchedAt: now.toISOString(),
      symbols: closesBySymbol,
    });
    return buildTrendSignal(closesBySymbol, config, now);
  } catch (error) {
    // 신선한 캐시가 없고 요청도 실패하면, 오래된 캐시라도 있으면 그걸로 진행합니다.
    if (cached?.symbols) return buildTrendSignal(cached.symbols, config, now);
    throw error;
  }
}

async function fetchAllCloses(symbols, config, fetchImpl) {
  const entries = await Promise.all(
    symbols.map(async (rawSymbol) => {
      const symbol = String(rawSymbol).trim().toUpperCase();
      const closes = await fetchStooqCloses(symbol, config, fetchImpl);
      return [symbol, closes];
    }),
  );
  return Object.fromEntries(entries.filter(([, closes]) => closes.length > 0));
}

async function fetchStooqCloses(symbol, config, fetchImpl) {
  // 미국 ETF는 Stooq에서 "vti.us" 형태의 일봉 CSV로 제공됩니다.
  const url = `https://stooq.com/q/d/l/?s=${symbol.toLowerCase()}.us&i=d`;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Stooq 응답 오류 ${response.status} (${symbol})`);
  const csv = await response.text();
  return parseStooqCloses(csv).slice(-config.maxSamples);
}

/** Stooq CSV(Date,Open,High,Low,Close,Volume)에서 종가 열만 추출합니다. */
export function parseStooqCloses(csv) {
  const lines = String(csv).trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",");
  const closeIndex = header.findIndex((name) => name.trim().toLowerCase() === "close");
  const index = closeIndex >= 0 ? closeIndex : 4;
  const closes = [];
  for (const line of lines.slice(1)) {
    const close = Number(line.split(",")[index]);
    if (Number.isFinite(close) && close > 0) closes.push(close);
  }
  return closes;
}

function ageHours(isoString, now) {
  const then = new Date(isoString).getTime();
  if (!Number.isFinite(then)) return Infinity;
  return (now.getTime() - then) / (60 * 60 * 1000);
}

function validateOptions(options) {
  if (!Number.isInteger(options.maPeriod) || options.maPeriod < 2) {
    throw new Error("maPeriod는 2 이상의 정수여야 합니다.");
  }
  if (!Number.isFinite(options.deviationScalePercent) || options.deviationScalePercent <= 0) {
    throw new Error("deviationScalePercent는 0보다 큰 숫자여야 합니다.");
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

async function writeSnapshot(snapshotPath, snapshot) {
  const temporaryPath = `${snapshotPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, snapshotPath);
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1_000_000) / 1_000_000;
}
