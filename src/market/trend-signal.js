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

// 두 소스 모두 기본 Node User-Agent를 자주 차단합니다. 차단되면 HTTP 오류가 아니라
// 200과 함께 빈 본문이나 안내 페이지를 돌려주므로, 브라우저 UA를 명시해 요청합니다.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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

/**
 * 일봉 종가의 최근 변동성(연율화)을 계산합니다.
 * Moreira & Muir(2017) "Volatility-Managed Portfolios"의 변동성 타이밍에 사용합니다.
 */
export function calculateVolatility(values, options = {}) {
  const window = Number(options.window ?? 20);
  const tradingDays = Number(options.tradingDays ?? 252);
  const closes = (values ?? []).map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (closes.length < window + 1) {
    return { ready: false, sampleDays: Math.max(0, closes.length - 1), minimumDays: window };
  }

  const recent = closes.slice(-(window + 1));
  const returns = [];
  for (let index = 1; index < recent.length; index += 1) {
    returns.push(recent[index] / recent[index - 1] - 1);
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  const dailyStdev = Math.sqrt(variance);
  return {
    ready: true,
    annualized: round(dailyStdev * Math.sqrt(tradingDays)),
    dailyStdev: round(dailyStdev),
    sampleDays: returns.length,
  };
}

/** 여러 종목의 종가를 모아 하나의 시장 추세 신호로 집계합니다. */
export function buildTrendSignal(closesBySymbol = {}, options = {}, now = new Date()) {
  const config = { ...DEFAULT_TREND_OPTIONS, ...options };
  const indicators = {};
  const annualizedVols = [];
  for (const [symbol, closes] of Object.entries(closesBySymbol)) {
    indicators[symbol] = calculateTrend(closes, config);
    const vol = calculateVolatility(closes, config);
    if (vol.ready) annualizedVols.push(vol.annualized);
  }
  // 종목별 연율화 변동성의 평균을 시장 변동성 대리치로 사용합니다.
  const volatility = annualizedVols.length
    ? { annualized: round(annualizedVols.reduce((sum, value) => sum + value, 0) / annualizedVols.length), symbols: annualizedVols.length }
    : null;

  const all = Object.values(indicators);
  const ready = all.filter((indicator) => indicator.ready);
  if (ready.length === 0) {
    return {
      available: false,
      // 사용 불가에는 두 가지 원인이 있고 대응이 다릅니다.
      // 종가를 아예 못 받은 것(수집 실패)과 아직 200개가 안 쌓인 것(준비 중)입니다.
      reason: all.length === 0 ? "NO_DAILY_CLOSES" : "INSUFFICIENT_HISTORY",
      evaluatedAt: now.toISOString(),
      score: 0,
      confidence: 0,
      readySymbols: 0,
      totalSymbols: all.length,
      volatility,
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
    volatility,
    indicators,
  };
}

/**
 * 일봉 종가(Twelve Data → Yahoo Finance → Stooq 순)로 추세 신호를 만듭니다.
 * 일봉 데이터는 하루 한 번만 갱신하면 되므로 캐시가 신선하면 재요청하지 않고,
 * 요청이 실패하면 이전 캐시로 폴백합니다.
 */
export async function loadTrendSignal({
  dataDir,
  symbols,
  now = new Date(),
  fetchImpl = fetch,
  maxAgeHours = 20,
  apiKey = undefined,
  options = {},
}) {
  const config = { ...DEFAULT_TREND_OPTIONS, ...options };
  const snapshotPath = path.join(dataDir, "trend-snapshot.json");
  const cached = await readSnapshot(snapshotPath);
  // 비어 있는 캐시는 "신선"해도 쓸 수 없습니다. 예전에는 수집이 실패해 만들어진
  // 빈 스냅샷이 신선한 것으로 취급돼, 20시간 동안 추세 신호가 조용히 꺼졌습니다.
  const cacheUsable = hasUsableCloses(cached?.symbols);
  const isFresh = cacheUsable && ageHours(cached.fetchedAt, now) < maxAgeHours;

  if (isFresh) {
    return buildTrendSignal(cached.symbols, config, now);
  }

  try {
    const { closesBySymbol, sources, failures } = await fetchAllCloses(
      symbols ?? [], config, fetchImpl, apiKey,
    );
    await mkdir(dataDir, { recursive: true });
    await writeSnapshot(snapshotPath, {
      version: 1,
      fetchedAt: now.toISOString(),
      sources,
      symbols: closesBySymbol,
    });
    const signal = { ...buildTrendSignal(closesBySymbol, config, now), sources };
    // 일부 종목만 실패한 경우는 신호를 유지하되 실패 사실을 함께 넘겨 보고서에 드러냅니다.
    return failures.length ? { ...signal, failures } : signal;
  } catch (error) {
    // 신선한 캐시가 없고 요청도 실패하면, 오래된 캐시라도 있으면 그걸로 진행합니다.
    if (cacheUsable) {
      return {
        ...buildTrendSignal(cached.symbols, config, now),
        stale: true,
        staleSince: cached.fetchedAt ?? null,
        fetchError: error.message,
      };
    }
    throw error;
  }
}

/**
 * 캐시에 저장된 종목별 일봉 종가를 읽습니다.
 * MACD도 같은 종가를 사용하므로 네트워크에 다시 요청하지 않습니다.
 * loadTrendSignal을 먼저 호출해 캐시를 갱신한 뒤 읽어야 합니다.
 */
export async function loadDailyCloses({ dataDir }) {
  const snapshot = await readSnapshot(path.join(dataDir, "trend-snapshot.json"));
  const symbols = snapshot?.symbols ?? {};
  return Object.fromEntries(
    Object.entries(symbols).filter(([, closes]) => Array.isArray(closes) && closes.length > 0),
  );
}

async function fetchAllCloses(symbols, config, fetchImpl, apiKey) {
  const results = await Promise.allSettled(
    symbols.map(async (rawSymbol) => {
      const symbol = String(rawSymbol).trim().toUpperCase();
      const { closes, source } = await fetchDailyCloses(symbol, config, fetchImpl, apiKey);
      return [symbol, closes, source];
    }),
  );

  const closesBySymbol = {};
  const sources = {};
  const failures = [];
  for (const [index, result] of results.entries()) {
    const symbol = String(symbols[index]).trim().toUpperCase();
    if (result.status === "fulfilled") {
      const [name, closes, source] = result.value;
      closesBySymbol[name] = closes;
      sources[name] = source;
    } else {
      failures.push(`${symbol}: ${result.reason?.message ?? result.reason}`);
    }
  }

  // 한 종목도 못 받았으면 실패입니다. 예전에는 이 경우에도 빈 결과를 정상으로 보고
  // 캐시에 기록해서, 호출자가 붙여둔 catch가 한 번도 걸리지 않았습니다.
  if (Object.keys(closesBySymbol).length === 0) {
    throw new Error(`일봉을 한 종목도 받지 못했습니다 — ${failures.join(" | ")}`);
  }
  return { closesBySymbol, sources, failures };
}

/**
 * 일봉 종가를 소스 순서대로 시도합니다.
 *
 * Stooq는 2026-08-03에 JavaScript proof-of-work 봇 차단을 도입해, CSV 대신
 * 검증 페이지를 200으로 돌려주기 시작했습니다. 우회 대신 API 키가 필요 없는
 * Yahoo Finance를 주 소스로 두고, Stooq는 폴백으로 남겨둡니다.
 */
export async function fetchDailyCloses(symbol, config, fetchImpl, apiKey) {
  const errors = [];
  for (const source of dailySources(apiKey)) {
    try {
      const closes = await source.fetch(symbol, config, fetchImpl);
      // 어느 소스가 실제로 응답했는지 남깁니다. 폴백으로 버티는 중인지
      // 주 소스가 살아 있는지 구분해야 다음 장애를 미리 알 수 있습니다.
      if (closes.length > 0) return { closes, source: source.name };
      errors.push(`${source.name}: 종가 없음`);
    } catch (error) {
      errors.push(`${source.name}: ${error.message}`);
    }
  }
  throw new Error(errors.join(" / "));
}

/**
 * 시도 순서를 정합니다.
 *
 * 무료 공개 소스는 2026-08-03 기준 둘 다 막혔습니다. Stooq는 JavaScript
 * proof-of-work 봇 차단을, Yahoo는 서버 IP 단위 429를 겁니다. API 키가 있으면
 * 키 기반 소스를 먼저 쓰고, 공개 소스는 키가 없거나 실패했을 때의 폴백으로 둡니다.
 */
function dailySources(apiKey) {
  return [
    ...(apiKey
      ? [{
          name: "TWELVEDATA",
          fetch: (symbol, config, fetchImpl) =>
            fetchTwelveDataCloses(symbol, config, fetchImpl, apiKey),
        }]
      : []),
    { name: "YAHOO", fetch: fetchYahooCloses },
    { name: "STOOQ", fetch: fetchStooqCloses },
  ];
}

async function fetchTwelveDataCloses(symbol, config, fetchImpl, apiKey) {
  const url =
    "https://api.twelvedata.com/time_series?" +
    new URLSearchParams({
      symbol,
      interval: "1day",
      outputsize: String(config.maxSamples),
      apikey: apiKey,
    });
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`응답 오류 ${response.status}`);
  return parseTwelveDataCloses(await response.text()).slice(-config.maxSamples);
}

/** Twelve Data time_series 응답에서 종가를 오래된 순으로 뽑습니다. */
export function parseTwelveDataCloses(body) {
  let payload;
  try {
    payload = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    throw new Error(`JSON이 아닙니다 (${describeBody(body)})`);
  }
  // 한도 초과나 잘못된 키도 HTTP 200으로 오고 status만 error입니다.
  if (payload?.status === "error") {
    throw new Error(payload.message ?? `코드 ${payload.code ?? "?"}`);
  }
  const values = payload?.values;
  if (!Array.isArray(values)) throw new Error("응답에 values 배열이 없습니다.");
  // 응답은 최신순이므로 뒤집어 오래된 순으로 만듭니다.
  return values
    .map((row) => Number(row?.close))
    .filter((close) => Number.isFinite(close) && close > 0)
    .reverse();
}

async function fetchYahooCloses(symbol, config, fetchImpl) {
  // range=2y면 약 500거래일이라 200일선(200개)과 MACD(34개) 모두 충분합니다.
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    "?range=2y&interval=1d";
  const response = await fetchImpl(url, {
    headers: { "user-agent": BROWSER_USER_AGENT, accept: "application/json,*/*" },
  });
  if (!response.ok) throw new Error(`응답 오류 ${response.status}`);
  const body = await response.text();
  return parseYahooCloses(body).slice(-config.maxSamples);
}

async function fetchStooqCloses(symbol, config, fetchImpl) {
  // 미국 ETF는 Stooq에서 "vti.us" 형태의 일봉 CSV로 제공됩니다.
  const url = `https://stooq.com/q/d/l/?s=${symbol.toLowerCase()}.us&i=d`;
  const response = await fetchImpl(url, {
    headers: { "user-agent": BROWSER_USER_AGENT, accept: "text/csv,text/plain,*/*" },
  });
  if (!response.ok) throw new Error(`응답 오류 ${response.status}`);
  const csv = await response.text();
  const closes = parseStooqCloses(csv).slice(-config.maxSamples);
  if (closes.length === 0) throw new Error(`CSV에 종가가 없습니다 (${describeBody(csv)})`);
  return closes;
}

/** Yahoo Finance chart 응답에서 일봉 종가만 뽑습니다. 휴장일의 null은 건너뜁니다. */
export function parseYahooCloses(body) {
  let payload;
  try {
    payload = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    throw new Error(`JSON이 아닙니다 (${describeBody(body)})`);
  }
  const message = payload?.chart?.error?.description;
  if (message) throw new Error(message);
  const closes = payload?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(closes)) throw new Error("응답에 종가 배열이 없습니다.");
  return closes.map(Number).filter((close) => Number.isFinite(close) && close > 0);
}

/** 차단·한도 초과 응답을 로그에서 알아볼 수 있도록 본문 앞부분을 짧게 요약합니다. */
function describeBody(body) {
  const text = String(body ?? "").trim();
  if (text.length === 0) return "빈 응답";
  return `${text.slice(0, 60).replace(/\s+/g, " ")}…`;
}

function hasUsableCloses(symbols) {
  return Object.values(symbols ?? {}).some((closes) => Array.isArray(closes) && closes.length > 0);
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
