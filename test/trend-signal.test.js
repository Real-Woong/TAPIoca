import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildTrendSignal,
  calculateTrend,
  calculateVolatility,
  loadDailyCloses,
  loadTrendSignal,
  parseStooqCloses,
} from "../src/market/trend-signal.js";

function csvWithCloses(closes) {
  const rows = closes.map((close, index) => `2026-01-${index + 1},0,0,0,${close},0`);
  return ["Date,Open,High,Low,Close,Volume", ...rows].join("\n");
}

function mockFetch(csvBySymbol, counter) {
  return async (url) => {
    counter.calls += 1;
    const symbol = /s=([a-z]+)\.us/.exec(url)?.[1]?.toUpperCase();
    return { ok: true, status: 200, text: async () => csvBySymbol[symbol] ?? "" };
  };
}

test("표본이 200개 미만이면 추세를 아직 계산하지 않는다", () => {
  const result = calculateTrend(Array(150).fill(100), { maPeriod: 200 });
  assert.equal(result.ready, false);
  assert.equal(result.sampleCount, 150);
  assert.equal(result.minimumSamples, 200);
});

test("가격이 200일 이동평균 위면 상승 추세 양수 점수를 낸다", () => {
  // 앞의 199개는 100, 마지막만 크게 상승시켜 이동평균을 확실히 웃돌게 만듭니다.
  const closes = [...Array(199).fill(100), 130];
  const result = calculateTrend(closes, { maPeriod: 200, deviationScalePercent: 5 });
  assert.equal(result.ready, true);
  assert.equal(result.direction, "UPTREND");
  assert.ok(result.score > 0);
  assert.ok(result.price > result.movingAverage);
});

test("가격이 200일 이동평균 아래면 하락 추세 음수 점수를 낸다", () => {
  const closes = [...Array(199).fill(100), 80];
  const result = calculateTrend(closes, { maPeriod: 200, deviationScalePercent: 5 });
  assert.equal(result.direction, "DOWNTREND");
  assert.ok(result.score < 0);
});

test("여러 종목이 모두 하락 추세면 신뢰도 1의 음수 집계 신호를 만든다", () => {
  const down = [...Array(199).fill(100), 80];
  const signal = buildTrendSignal({ VTI: down, SCHD: down }, { maPeriod: 200 });
  assert.equal(signal.available, true);
  assert.equal(signal.readySymbols, 2);
  assert.equal(signal.totalSymbols, 2);
  assert.equal(signal.confidence, 1);
  assert.ok(signal.score < 0);
});

test("준비된 종목이 없으면 사용 불가 신호를 반환한다", () => {
  const signal = buildTrendSignal({ VTI: [100, 101] }, { maPeriod: 200 });
  assert.equal(signal.available, false);
  assert.equal(signal.readySymbols, 0);
  assert.equal(signal.score, 0);
});

test("Stooq에서 종가를 받아 신호를 만들고 신선한 캐시는 재요청하지 않는다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "trend-"));
  try {
    const down = [...Array(199).fill(100), 80];
    const counter = { calls: 0 };
    const fetchImpl = mockFetch({ VTI: csvWithCloses(down) }, counter);
    const now = new Date("2026-07-25T14:00:00Z");

    const first = await loadTrendSignal({ dataDir, symbols: ["VTI"], now, fetchImpl });
    assert.equal(first.available, true);
    assert.ok(first.score < 0);
    assert.equal(counter.calls, 1);

    // 20시간 안에 다시 부르면 캐시를 써서 네트워크를 호출하지 않습니다.
    const second = await loadTrendSignal({
      dataDir,
      symbols: ["VTI"],
      now: new Date("2026-07-25T20:00:00Z"),
      fetchImpl,
    });
    assert.equal(second.available, true);
    assert.equal(counter.calls, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("요청이 실패해도 이전 캐시가 있으면 그 캐시로 폴백한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "trend-"));
  try {
    const up = [...Array(199).fill(100), 130];
    const counter = { calls: 0 };
    const now = new Date("2026-07-25T14:00:00Z");
    await loadTrendSignal({
      dataDir,
      symbols: ["VTI"],
      now,
      fetchImpl: mockFetch({ VTI: csvWithCloses(up) }, counter),
    });

    // 캐시가 오래된 뒤 네트워크가 실패해도 이전 종가로 신호를 유지합니다.
    const failing = async () => {
      throw new Error("network down");
    };
    const later = await loadTrendSignal({
      dataDir,
      symbols: ["VTI"],
      now: new Date("2026-07-27T14:00:00Z"),
      fetchImpl: failing,
    });
    assert.equal(later.available, true);
    assert.ok(later.score > 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("표본이 부족하면 변동성을 계산하지 않는다", () => {
  const result = calculateVolatility([100, 101, 102], { window: 20 });
  assert.equal(result.ready, false);
});

test("일정한 가격은 변동성 0, 등락이 크면 변동성이 커진다", () => {
  const flat = calculateVolatility(Array(30).fill(100), { window: 20 });
  assert.equal(flat.ready, true);
  assert.equal(flat.annualized, 0);

  // ±5% 지그재그는 큰 변동성을 만든다.
  const zigzag = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 100 : 105));
  const volatile = calculateVolatility(zigzag, { window: 20 });
  assert.ok(volatile.annualized > flat.annualized);
});

test("집계 신호에 시장 변동성(연율) 대리치를 포함한다", () => {
  const zigzag = Array.from({ length: 210 }, (_, i) => (i % 2 === 0 ? 100 : 106));
  const signal = buildTrendSignal({ VTI: zigzag }, { maPeriod: 200 });
  assert.ok(signal.volatility);
  assert.ok(signal.volatility.annualized > 0);
});

test("Stooq CSV에서 종가 열만 추출한다", () => {
  const csv = [
    "Date,Open,High,Low,Close,Volume",
    "2026-01-02,100,101,99,100.5,1000",
    "2026-01-03,100.5,102,100,101.2,1200",
    "2026-01-04,,,,,", // 결측 행은 건너뜁니다.
  ].join("\n");
  assert.deepEqual(parseStooqCloses(csv), [100.5, 101.2]);
});

test("모든 종목의 일봉 수집이 실패하면 예외를 던지고 빈 캐시를 남기지 않는다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "trend-"));
  try {
    const now = new Date("2026-07-25T14:00:00Z");
    // Stooq가 차단할 때 실제로 오는 응답: HTTP 200 + CSV가 아닌 본문.
    const blocked = async () => ({ ok: true, status: 200, text: async () => "" });

    await assert.rejects(
      loadTrendSignal({ dataDir, symbols: ["VTI", "SCHD"], now, fetchImpl: blocked }),
      /한 종목도 받지 못했습니다/,
    );

    // 빈 결과가 캐시로 남으면 20시간 동안 신호가 조용히 꺼집니다.
    await assert.rejects(
      readFile(path.join(dataDir, "trend-snapshot.json"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("일부 종목만 실패하면 나머지로 신호를 만들고 실패 내역을 남긴다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "trend-"));
  try {
    const down = [...Array(199).fill(100), 80];
    const fetchImpl = async (url) => ({
      ok: true,
      status: 200,
      text: async () => (/s=vti\.us/.test(url) ? csvWithCloses(down) : ""),
    });

    const signal = await loadTrendSignal({
      dataDir,
      symbols: ["VTI", "SCHD"],
      now: new Date("2026-07-25T14:00:00Z"),
      fetchImpl,
    });

    assert.equal(signal.available, true);
    assert.equal(signal.readySymbols, 1);
    assert.equal(signal.failures.length, 1);
    assert.match(signal.failures[0], /SCHD/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("종가가 비어 있는 캐시는 신선해도 다시 수집한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "trend-"));
  try {
    // 이전 버전이 남겼을 수 있는 빈 스냅샷입니다.
    await writeFile(
      path.join(dataDir, "trend-snapshot.json"),
      JSON.stringify({ version: 1, fetchedAt: "2026-07-25T13:00:00Z", symbols: {} }),
    );

    const down = [...Array(199).fill(100), 80];
    const counter = { calls: 0 };
    const signal = await loadTrendSignal({
      dataDir,
      symbols: ["VTI"],
      now: new Date("2026-07-25T14:00:00Z"),
      fetchImpl: mockFetch({ VTI: csvWithCloses(down) }, counter),
    });

    assert.equal(counter.calls, 1);
    assert.equal(signal.available, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("수집 실패로 오래된 캐시를 쓰면 stale 표시를 남긴다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "trend-"));
  try {
    const up = [...Array(199).fill(100), 130];
    await loadTrendSignal({
      dataDir,
      symbols: ["VTI"],
      now: new Date("2026-07-25T14:00:00Z"),
      fetchImpl: mockFetch({ VTI: csvWithCloses(up) }, { calls: 0 }),
    });

    const later = await loadTrendSignal({
      dataDir,
      symbols: ["VTI"],
      now: new Date("2026-07-27T14:00:00Z"),
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });

    assert.equal(later.available, true);
    assert.equal(later.stale, true);
    assert.match(later.fetchError, /network down/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("준비된 종목이 없는 사유를 구분해서 남긴다", () => {
  assert.equal(buildTrendSignal({}, { maPeriod: 200 }).reason, "NO_DAILY_CLOSES");
  assert.equal(buildTrendSignal({ VTI: [100, 101] }, { maPeriod: 200 }).reason, "INSUFFICIENT_HISTORY");
});

test("캐시된 일봉 종가를 MACD가 재사용할 수 있게 노출한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "trend-"));
  try {
    const down = [...Array(199).fill(100), 80];
    await loadTrendSignal({
      dataDir,
      symbols: ["VTI"],
      now: new Date("2026-07-25T14:00:00Z"),
      fetchImpl: mockFetch({ VTI: csvWithCloses(down) }, { calls: 0 }),
    });

    const closes = await loadDailyCloses({ dataDir });
    assert.deepEqual(Object.keys(closes), ["VTI"]);
    assert.equal(closes.VTI.length, 200);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("캐시가 없으면 빈 종가 묶음을 돌려준다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "trend-"));
  try {
    assert.deepEqual(await loadDailyCloses({ dataDir }), {});
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
