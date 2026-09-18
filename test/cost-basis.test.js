import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCostBasisSnapshot,
  latestByTradingDate,
  normalizeHoldings,
  summarizeHoldings,
} from "../src/live/cost-basis.js";

/** 2026-09-18에 서버에서 실제로 받은 `/api/v1/holdings` 응답입니다. */
const TOSS_ITEMS = [
  { symbol: "SCHD", quantity: "0.402434", lastPrice: "33.92", averagePurchasePrice: "33.611039",
    marketValue: { purchaseAmount: "13.526225", amount: "13.650561", amountAfterCost: "13.640561" },
    profitLoss: { amount: "0.124336", amountAfterCost: "0.114336", rate: "0.0091" },
    cost: { commission: "0.01", tax: null } },
  { symbol: "IWM", quantity: "0.006665", lastPrice: "285.67", averagePurchasePrice: "300.047561",
    marketValue: { purchaseAmount: "1.999817", amount: "1.90399", amountAfterCost: "1.90399" },
    profitLoss: { amount: "-0.095827", amountAfterCost: "-0.095827", rate: "-0.0479" },
    cost: { commission: "0", tax: null } },
  { symbol: "GOOGL", quantity: "2.236649", lastPrice: "200", averagePurchasePrice: "190",
    marketValue: { purchaseAmount: "424.96", amount: "447.33" },
    profitLoss: { amount: "22.37", rate: "0.0526" }, cost: {} },
];

test("토스가 문자열로 주는 값을 숫자로 편다", () => {
  const [iwm, schd] = normalizeHoldings(TOSS_ITEMS, ["VTI", "SCHD", "IWM"]);

  assert.equal(schd.symbol, "SCHD");
  assert.equal(schd.quantity, 0.402434);
  assert.equal(schd.purchaseAmountUsd, 13.526225);
  assert.equal(schd.unrealizedRate, 0.0091);
  assert.equal(iwm.symbol, "IWM");
});

test("모르는 값은 0이 아니라 null이다", () => {
  const [, schd] = normalizeHoldings(TOSS_ITEMS, ["SCHD", "IWM"]);

  // `cost.tax`가 실제로 null로 온다. 0으로 바꾸면 "세금이 0이다"와
  // "세금을 모른다"가 한 칸에 섞인다.
  assert.equal(schd.taxUsd, null);
  assert.equal(schd.commissionUsd, 0.01);
});

test("관리 종목만 남긴다 — 나머지는 사장님 자산이다", () => {
  const rows = normalizeHoldings(TOSS_ITEMS, ["VTI", "SCHD", "IWM"]);

  assert.deepEqual(rows.map((row) => row.symbol), ["IWM", "SCHD"]);
});

test("합계는 계좌 전체가 아니라 관리 종목만 더한다", () => {
  const total = summarizeHoldings(normalizeHoldings(TOSS_ITEMS, ["SCHD", "IWM"]));

  assert.equal(total.purchaseUsd.toFixed(6), "15.526042");
  assert.equal(total.unrealizedUsd.toFixed(6), "0.028509");
  assert.equal(total.symbols, 2);
});

test("같은 거래일이 여러 줄이면 마지막 줄이 이긴다", () => {
  // 뉴욕 거래일은 한국 새벽에 이미 바뀌어 있다. 개장 전에 한 번 돌리면 그날 줄이
  // 먼저 박히고, 마감 뒤 타이머가 도는 줄이 뒤에 온다. 뒤엣것이 그날의 값이다.
  const snapshots = [
    buildCostBasisSnapshot({ tradingDate: "2026-09-18", holdings: [], krwPerUsd: 1383.1, at: "2026-09-18T06:30:00Z" }),
    buildCostBasisSnapshot({ tradingDate: "2026-09-18", holdings: [], krwPerUsd: 1380.5, at: "2026-09-18T20:10:00Z" }),
    buildCostBasisSnapshot({ tradingDate: "2026-09-19", holdings: [], krwPerUsd: 1379.0, at: "2026-09-19T20:10:00Z" }),
  ];

  const latest = latestByTradingDate(snapshots);

  assert.equal(latest.size, 2);
  assert.equal(latest.get("2026-09-18").krwPerUsd, 1380.5);
  assert.equal(latest.get("2026-09-18").at, "2026-09-18T20:10:00Z");
});

test("환율을 못 읽은 날은 null로 남는다 — 지어내지 않는다", () => {
  const snapshot = buildCostBasisSnapshot({ tradingDate: "2026-09-18", holdings: [] });

  assert.equal(snapshot.krwPerUsd, null);
});
