import test from "node:test";
import assert from "node:assert/strict";

import { attributeAlpha, worstShortfallDays } from "../src/paper/alpha-attribution.js";

function event(at, { equity, bench, marketValue, targetCash = 0.1, fees = 0 }) {
  return {
    at,
    equityUsd: equity,
    marketValueUsd: marketValue,
    cashUsd: equity - marketValue,
    targetAllocation: { VTI: 1 - targetCash, CASH: targetCash },
    benchmark: { symbol: "VTI", valueUsd: bench },
    feesUsd: fees,
  };
}

// 목표를 정확히 지키며 현금 10%를 들고 있었다면, 뒤처진 만큼은 전부 "설계"여야
// 한다. 여기서 이탈이 잡히면 설계된 비용을 결함으로 오진하게 된다.
test("목표를 정확히 지키면 이탈이 아니라 구조적 드래그로만 잡힌다", () => {
  // 시장 +10%, 우리는 주식 90%만 들고 있으므로 +9%.
  const result = attributeAlpha([
    event("2026-08-01T14:00:00Z", { equity: 100, bench: 100, marketValue: 90 }),
    event("2026-08-01T14:15:00Z", { equity: 109, bench: 110, marketValue: 99 }),
  ]);

  assert.equal(result.alphaUsd, -1);
  // (0.9 − 1) × 10% × 100 = −1
  assert.equal(result.totals.structuralUsd, -1);
  assert.equal(result.totals.shortfallUsd, 0);
  assert.equal(result.totals.selectionAndCostUsd, 0);
});

// 07-29~08-04에 실제로 일어난 일이다. 목표는 90%인데 청산 규칙이 다 팔아서
// 15%만 남았다. 이 손실은 설계가 아니라 결함이며 그렇게 분류돼야 한다.
test("목표보다 적게 들고 있으면 그 몫이 이탈로 잡힌다", () => {
  const result = attributeAlpha([
    event("2026-08-01T14:00:00Z", { equity: 100, bench: 100, marketValue: 15 }),
    event("2026-08-01T14:15:00Z", { equity: 101.5, bench: 110, marketValue: 16.5 }),
  ]);

  assert.equal(result.alphaUsd, -8.5);
  // 설계된 몫: (0.9 − 1) × 10% × 100 = −1
  assert.equal(result.totals.structuralUsd, -1);
  // 결함의 몫: (0.15 − 0.9) × 10% × 100 = −7.5
  assert.equal(result.totals.shortfallUsd, -7.5);
  assert.equal(result.totals.selectionAndCostUsd, 0);
});

// 부호를 헷갈리기 쉬운 지점이다. 현금은 상승장에서만 손해다.
test("시장이 내리면 같은 현금 비중이 이득으로 잡힌다", () => {
  const result = attributeAlpha([
    event("2026-08-01T14:00:00Z", { equity: 100, bench: 100, marketValue: 90 }),
    event("2026-08-01T14:15:00Z", { equity: 91, bench: 90, marketValue: 81 }),
  ]);

  assert.equal(result.alphaUsd, 1);
  assert.equal(result.totals.structuralUsd, 1);
  assert.equal(result.totals.shortfallUsd, 0);
});

// 벤치마크가 안 움직인 구간의 차이는 현금 비중으로 설명될 수 없다.
// 남는 것은 종목 선택과 거래비용뿐이다.
test("벤치마크가 그대로인데 벌어진 차이는 종목 선택·비용으로 남는다", () => {
  const result = attributeAlpha([
    event("2026-08-01T14:00:00Z", { equity: 100, bench: 100, marketValue: 90, fees: 0 }),
    event("2026-08-01T14:15:00Z", { equity: 99.8, bench: 100, marketValue: 89.8, fees: 0.2 }),
  ]);

  assert.equal(result.totals.structuralUsd, 0);
  assert.equal(result.totals.shortfallUsd, 0);
  assert.equal(result.totals.selectionAndCostUsd, -0.2);
  assert.equal(result.totals.feesUsd, 0.2);
  // 비용을 떼어내면 종목 선택 기여는 0이다.
  assert.equal(result.totals.selectionUsd, 0);
});

// 항목 합이 alpha와 어긋나는 몫을 숨기면 분해가 틀렸는지 알 수 없게 된다.
test("항목 합과 실제 alpha의 차이를 복리 잔차로 드러낸다", () => {
  const result = attributeAlpha([
    event("2026-08-01T14:00:00Z", { equity: 100, bench: 100, marketValue: 90 }),
    event("2026-08-02T14:00:00Z", { equity: 109, bench: 110, marketValue: 99 }),
    event("2026-08-03T14:00:00Z", { equity: 118.8, bench: 121, marketValue: 108.9 }),
  ]);

  const { totals } = result;
  const parts = totals.structuralUsd + totals.shortfallUsd + totals.selectionAndCostUsd;
  assert.ok(Math.abs(parts + totals.compoundingUsd - result.alphaUsd) < 1e-6);
  assert.notEqual(totals.compoundingUsd, 0);
});

test("목표 비중이 기록되지 않은 사이클은 이탈로 세지 않는다", () => {
  const stripped = [
    event("2026-08-01T14:00:00Z", { equity: 100, bench: 100, marketValue: 15 }),
    event("2026-08-01T14:15:00Z", { equity: 101.5, bench: 110, marketValue: 16.5 }),
  ];
  delete stripped[0].targetAllocation;

  const result = attributeAlpha(stripped);
  assert.equal(result.totals.shortfallUsd, 0);
  assert.equal(result.totals.structuralUsd, -8.5);
});

test("이벤트가 한 건뿐이면 분해하지 않는다", () => {
  const result = attributeAlpha([
    event("2026-08-01T14:00:00Z", { equity: 100, bench: 100, marketValue: 90 }),
  ]);
  assert.equal(result.totals, null);
  assert.equal(result.sampleSize, 1);
});

test("벤치마크가 없는 예전 이벤트는 건너뛴다", () => {
  const result = attributeAlpha([
    { at: "2026-07-14T14:00:00Z", equityUsd: 67 },
    event("2026-08-01T14:00:00Z", { equity: 100, bench: 100, marketValue: 90 }),
    event("2026-08-01T14:15:00Z", { equity: 109, bench: 110, marketValue: 99 }),
  ]);
  assert.equal(result.sampleSize, 2);
  assert.equal(result.totals.structuralUsd, -1);
});

test("가장 나빴던 날을 초과성과 순으로 고른다", () => {
  const result = attributeAlpha([
    event("2026-08-01T14:00:00Z", { equity: 100, bench: 100, marketValue: 90 }),
    event("2026-08-02T14:00:00Z", { equity: 100, bench: 105, marketValue: 90 }),
    event("2026-08-03T14:00:00Z", { equity: 100, bench: 101, marketValue: 90 }),
  ]);

  const worst = worstShortfallDays(result.steps, 2);
  assert.equal(worst[0].day, "2026-08-02");
  assert.ok(worst[0].excessUsd < worst[1].excessUsd);
});
