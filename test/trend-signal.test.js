import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildTrendSignal,
  calculateTrend,
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

test("Stooq CSV에서 종가 열만 추출한다", () => {
  const csv = [
    "Date,Open,High,Low,Close,Volume",
    "2026-01-02,100,101,99,100.5,1000",
    "2026-01-03,100.5,102,100,101.2,1200",
    "2026-01-04,,,,,", // 결측 행은 건너뜁니다.
  ].join("\n");
  assert.deepEqual(parseStooqCloses(csv), [100.5, 101.2]);
});
