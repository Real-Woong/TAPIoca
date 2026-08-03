import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { buildDailyMacdSignal, calculateMacd, updateMacdSignal } from "../src/market/macd-signal.js";

test("표본이 34개보다 적으면 MACD를 준비 중으로 반환한다", () => {
  const result = calculateMacd(Array.from({ length: 33 }, (_, index) => 100 + index));

  assert.equal(result.ready, false);
  assert.equal(result.minimumSamples, 34);
});

test("상승 속도가 빨라지는 가격에서는 양의 MACD histogram을 계산한다", () => {
  const prices = Array.from({ length: 50 }, (_, index) => 100 + index + index ** 2 * 0.03);
  const result = calculateMacd(prices);

  assert.equal(result.ready, true);
  assert.ok(result.macd > result.signal);
  assert.ok(result.histogram > 0);
  assert.ok(result.score > 0 && result.score <= 1);
  assert.equal(result.direction, "BULLISH");
});

test("같은 15분 버킷의 가격은 새 표본을 추가하지 않고 덮어쓴다", async () => {
  const dataDir = await mkdtemp(path.join(process.cwd(), ".macd-test-"));
  const first = new Date("2026-07-22T01:01:00.000Z");
  const second = new Date("2026-07-22T01:14:00.000Z");

  try {
    await updateMacdSignal({ dataDir, prices: [{ symbol: "VTI", lastPrice: 100 }], now: first });
    await updateMacdSignal({ dataDir, prices: [{ symbol: "VTI", lastPrice: 101 }], now: second });
    const snapshot = JSON.parse(await readFile(path.join(dataDir, "macd-snapshot.json"), "utf8"));

    assert.equal(snapshot.symbols.VTI.length, 1);
    assert.equal(snapshot.symbols.VTI[0].close, 101);
    assert.equal(snapshot.symbols.VTI[0].at, "2026-07-22T01:00:00.000Z");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("일봉 종가로 MACD를 계산하고 출처를 표시한다", () => {
  // 34개 이상이면 계산됩니다. 등속 상승은 히스토그램이 0에 수렴하므로
  // 상승이 가팔라지는 종가를 써서 양수 히스토그램을 만듭니다.
  const rising = Array.from({ length: 60 }, (_, index) => 100 + index ** 2 / 20);
  const signal = buildDailyMacdSignal({ VTI: rising, SCHD: rising });

  assert.equal(signal.available, true);
  assert.equal(signal.source, "DAILY_CLOSE");
  assert.equal(signal.readySymbols, 2);
  assert.equal(signal.confidence, 1);
  assert.ok(signal.score > 0);
});

test("일봉이 34개에 못 미치면 사유와 함께 사용 불가로 둔다", () => {
  const signal = buildDailyMacdSignal({ VTI: Array.from({ length: 20 }, (_, i) => 100 + i) });

  assert.equal(signal.available, false);
  assert.equal(signal.reason, "INSUFFICIENT_SAMPLES");
  assert.equal(signal.source, "DAILY_CLOSE");
});

test("일봉 스케일은 15분 스냅샷보다 넓어 같은 히스토그램에서 덜 포화한다", () => {
  const wobbly = Array.from({ length: 60 }, (_, index) => 100 + Math.sin(index / 3) * 2);
  const daily = buildDailyMacdSignal({ VTI: wobbly });
  const intraday = buildDailyMacdSignal({ VTI: wobbly }, { histogramScalePercent: 0.15 });

  assert.ok(Math.abs(daily.score) < Math.abs(intraday.score));
});
