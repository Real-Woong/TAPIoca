import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MACD_OPTIONS = Object.freeze({
  fastPeriod: 12,
  slowPeriod: 26,
  signalPeriod: 9,
  intervalMinutes: 15,
  maxSamples: 200,
  histogramScalePercent: 0.15,
});

// 일봉용 기본값입니다. 히스토그램은 가격 대비 비율로 정규화되는데, 일봉의 진폭은
// 15분 표본보다 훨씬 크므로 스케일도 그만큼 넓혀야 tanh가 즉시 포화하지 않습니다.
// 실제 값이 쌓이면 MACD_HISTOGRAM_SCALE_PERCENT로 재보정하세요.
export const DEFAULT_DAILY_MACD_OPTIONS = Object.freeze({
  ...DEFAULT_MACD_OPTIONS,
  histogramScalePercent: 0.5,
});

/**
 * PAPER 실행 때 받은 ETF 현재가를 15분 버킷별로 누적하고 MACD 시장 신호를 만듭니다.
 * 실제 봉 종가가 아니라 정기 실행 시점의 스냅샷이므로 PAPER 검증용 보조지표입니다.
 */
export async function updateMacdSignal({ dataDir, prices, now = new Date(), options = {} }) {
  const config = { ...DEFAULT_MACD_OPTIONS, ...options };
  validateOptions(config);
  const snapshotPath = path.join(dataDir, "macd-snapshot.json");
  const snapshot = (await readSnapshot(snapshotPath)) ?? { version: 1, symbols: {} };
  snapshot.symbols ??= {};
  const bucketAt = toBucket(now, config.intervalMinutes).toISOString();

  for (const price of prices ?? []) {
    const symbol = String(price?.symbol ?? "").trim().toUpperCase();
    const close = Number(price?.lastPrice);
    if (!symbol || !Number.isFinite(close) || close <= 0) continue;

    const samples = Array.isArray(snapshot.symbols[symbol])
      ? snapshot.symbols[symbol].filter(validSample)
      : [];
    const next = { at: bucketAt, close };
    if (samples.at(-1)?.at === bucketAt) samples[samples.length - 1] = next;
    else samples.push(next);
    snapshot.symbols[symbol] = samples.slice(-config.maxSamples);
  }

  snapshot.updatedAt = now.toISOString();
  await mkdir(dataDir, { recursive: true });
  await writeSnapshot(snapshotPath, snapshot);
  return buildMarketMacdSignal(snapshot, config, now);
}

/** 가격 배열 하나의 최신 12·26·9 MACD 값을 계산합니다. */
export function calculateMacd(values, options = {}) {
  const config = { ...DEFAULT_MACD_OPTIONS, ...options };
  validateOptions(config);
  const prices = (values ?? []).map(Number).filter(Number.isFinite);
  const minimumSamples = config.slowPeriod + config.signalPeriod - 1;
  if (prices.length < minimumSamples) {
    return { ready: false, sampleCount: prices.length, minimumSamples };
  }

  const fast = emaSeries(prices, config.fastPeriod);
  const slow = emaSeries(prices, config.slowPeriod);
  const macdValues = [];
  for (let index = 0; index < prices.length; index += 1) {
    if (fast[index] !== null && slow[index] !== null) {
      macdValues.push(fast[index] - slow[index]);
    }
  }
  const signalValues = emaSeries(macdValues, config.signalPeriod);
  const macd = macdValues.at(-1);
  const signal = signalValues.at(-1);
  if (!Number.isFinite(macd) || !Number.isFinite(signal)) {
    return { ready: false, sampleCount: prices.length, minimumSamples };
  }

  const histogram = macd - signal;
  const latestPrice = prices.at(-1);
  const histogramPercent = (histogram / latestPrice) * 100;
  const score = Math.tanh(histogramPercent / config.histogramScalePercent);
  return {
    ready: true,
    sampleCount: prices.length,
    minimumSamples,
    latestPrice: round(latestPrice),
    macd: round(macd),
    signal: round(signal),
    histogram: round(histogram),
    histogramPercent: round(histogramPercent),
    score: round(score),
    direction: score > 0 ? "BULLISH" : score < 0 ? "BEARISH" : "FLAT",
  };
}

/**
 * 일봉 종가로 MACD를 계산합니다. 판단에 쓰는 기본 경로입니다.
 *
 * 15분 스냅샷 방식은 12·26·9에 34표본이 필요해 8.5시간을 보는데 정규장은 6.5시간뿐이라,
 * 밤 갭을 한 칸 점프로 이어붙인 인트라데이 지표로 하루 단위 자산배분을 정하고 있었습니다.
 * 그 결과 부호가 관측 기간 6회 중 4회 뒤집혔습니다. 추세 신호가 이미 받아둔
 * Stooq 일봉 종가를 그대로 쓰면 새 요청 없이 시계열 정합성을 맞출 수 있습니다.
 */
export function buildDailyMacdSignal(closesBySymbol = {}, options = {}, now = new Date()) {
  const config = { ...DEFAULT_DAILY_MACD_OPTIONS, ...options };
  const indicators = {};
  for (const [symbol, closes] of Object.entries(closesBySymbol)) {
    indicators[symbol] = calculateMacd(closes, config);
  }
  return aggregate(indicators, config, now, "DAILY_CLOSE");
}

function buildMarketMacdSignal(snapshot, config, now) {
  const indicators = {};
  for (const [symbol, samples] of Object.entries(snapshot.symbols ?? {})) {
    indicators[symbol] = calculateMacd(samples.map((sample) => sample.close), config);
  }
  return aggregate(indicators, config, now, "INTRADAY_SNAPSHOT");
}

function aggregate(indicators, config, now, source) {
  const all = Object.values(indicators);
  const ready = all.filter((indicator) => indicator.ready);
  if (ready.length === 0) {
    return {
      available: false,
      // 가격 스냅샷 자체가 없는 것과, 쌓이는 중이라 34개에 못 미치는 것은 다릅니다.
      reason: all.length === 0 ? "NO_PRICE_SNAPSHOTS" : "INSUFFICIENT_SAMPLES",
      source,
      evaluatedAt: now.toISOString(),
      score: 0,
      confidence: 0,
      readySymbols: 0,
      totalSymbols: all.length,
      indicators,
    };
  }

  const score = ready.reduce((sum, indicator) => sum + indicator.score, 0) / ready.length;
  const directionalAgreement = Math.abs(
    ready.reduce((sum, indicator) => sum + Math.sign(indicator.score), 0) / ready.length,
  );
  const coverage = all.length > 0 ? ready.length / all.length : 0;
  return {
    available: true,
    source,
    evaluatedAt: now.toISOString(),
    score: round(score),
    confidence: round(coverage * directionalAgreement),
    readySymbols: ready.length,
    totalSymbols: all.length,
    indicators,
  };
}

function emaSeries(values, period) {
  const result = Array(values.length).fill(null);
  if (values.length < period) return result;
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = ema;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    ema = (values[index] - ema) * multiplier + ema;
    result[index] = ema;
  }
  return result;
}

function toBucket(date, intervalMinutes) {
  const bucketMs = intervalMinutes * 60 * 1000;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs);
}

function validSample(sample) {
  return Boolean(sample?.at) && Number.isFinite(Number(sample?.close)) && Number(sample.close) > 0;
}

function validateOptions(options) {
  for (const key of ["fastPeriod", "slowPeriod", "signalPeriod", "intervalMinutes", "maxSamples"]) {
    if (!Number.isInteger(options[key]) || options[key] < 1) {
      throw new Error(`${key}는 1 이상의 정수여야 합니다.`);
    }
  }
  if (options.fastPeriod >= options.slowPeriod) {
    throw new Error("fastPeriod는 slowPeriod보다 작아야 합니다.");
  }
  if (!Number.isFinite(options.histogramScalePercent) || options.histogramScalePercent <= 0) {
    throw new Error("histogramScalePercent는 0보다 큰 숫자여야 합니다.");
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
