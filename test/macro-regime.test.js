import test from "node:test";
import assert from "node:assert/strict";

import { evaluateMacroRegime } from "../src/FRED_data/macro-regime.js";

function item(id, values) {
  return { id, observations: values.map(([date, value]) => ({ date, value })) };
}

function macroData(overrides = {}) {
  return { series: {
    fedLower: item("DFEDTARL", [["2026-07-15", 3.5]]),
    fedUpper: item("DFEDTARU", [["2026-07-15", 3.75], ["2026-04-01", 3.75]]),
    corePce: item("PCEPILFE", [
      ["2026-06-01", 2.6], ["2026-05-01", 2.75],
      ["2026-04-01", 2.8], ["2026-03-01", 2.9],
    ]),
    unemployment: item("UNRATE", [
      ["2026-06-01", 4.3], ["2026-05-01", 4.3],
      ["2026-04-01", 4.2], ["2026-03-01", 4.2],
    ]),
    sahm: item("SAHMREALTIME", [["2026-06-01", 0.07]]),
    yieldCurve: item("T10Y2Y", [["2026-07-14", 0.3]]),
    ...overrides,
  } };
}

test("침체 신호가 없고 물가가 둔화하면 위험선호 상태를 계산한다", () => {
  const result = evaluateMacroRegime(macroData(), new Date("2026-07-15T00:00:00Z"));
  assert.equal(result.regime, "RISK_ON");
  assert.equal(result.targetAllocation.VTI, 0.7);
  assert.ok(result.reasons.includes("Sahm 경기침체 신호 없음"));
});

test("Sahm 신호와 금리역전이 겹치면 위험회피 비중을 계산한다", () => {
  const result = evaluateMacroRegime(macroData({
    sahm: item("SAHMREALTIME", [["2026-06-01", 0.55]]),
    yieldCurve: item("T10Y2Y", [["2026-07-14", -0.2]]),
  }), new Date("2026-07-15T00:00:00Z"));

  assert.equal(result.regime, "RISK_OFF");
  assert.equal(result.targetAllocation.CASH, 0.4);
  assert.equal(result.targetAllocation.IWM, 0);
});
