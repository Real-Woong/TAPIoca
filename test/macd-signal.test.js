import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { calculateMacd, updateMacdSignal } from "../src/market/macd-signal.js";

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
