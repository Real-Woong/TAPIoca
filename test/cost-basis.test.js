import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCostBasisSnapshot,
  latestByTradingDate,
  normalizeHoldings,
  planCostBasisSnapshot,
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

// ㊱ 안 남는 경우가 셋인데 전에는 셋 다 조용히 돌아섰다. PAPER만 정상이고
// 나머지 둘은 그 거래일이 영구히 비는 사고다.
test("PAPER는 줄이 안 남는 것이 정상이라 경고가 아니다", () => {
  const plan = planCostBasisSnapshot({ account: null, krwPerUsd: 1391.4 });

  assert.equal(plan.skipped, "PAPER");
  assert.equal(plan.missing, undefined);
  assert.equal(plan.write, undefined);
});

test("계좌 조회가 실패하면 그 거래일이 비므로 말해야 한다", () => {
  const plan = planCostBasisSnapshot({
    account: { error: "계좌 조회가 15초 안에 안 왔습니다" },
    krwPerUsd: 1391.4,
  });

  assert.equal(plan.missing, "실계좌를 조회하지 못했습니다");
  // 원문은 안 싣는다 — 보고서의 「실계좌 보유」 칸이 이미 적는다.
  assert.doesNotMatch(plan.missing, /15초/);
  assert.equal(plan.write, undefined);
});

// 전량 매도라면 `purchaseAmount`가 0으로 떨어진 날이고, 그 줄이 가장 필요하다.
test("관리 종목 보유가 0건이면 조용히 넘기지 않는다", () => {
  for (const holdings of [[], undefined, null]) {
    const plan = planCostBasisSnapshot({ account: { positions: {}, holdings } });
    assert.equal(plan.missing, "관리 종목 보유가 0건입니다");
  }
});

test("남길 수 있으면 환율과 조회 시각을 그대로 넘긴다", () => {
  const holdings = normalizeHoldings(TOSS_ITEMS, ["VTI", "SCHD", "IWM"]);
  const plan = planCostBasisSnapshot({
    account: { holdings, at: "2026-09-19T00:35:00.514Z" },
    krwPerUsd: 1391.4,
  });

  assert.equal(plan.write.krwPerUsd, 1391.4);
  assert.equal(plan.write.at, "2026-09-19T00:35:00.514Z");
  assert.equal(plan.write.holdings, holdings);
  assert.equal(plan.missing, undefined);
});

// 환율이 없어도 줄은 남는다. 달러 원가는 가격과 무관해 안 틀리고, 원화만 빈다.
test("환율을 못 읽어도 남기는 것을 막지 않고 null로 넘긴다", () => {
  const holdings = normalizeHoldings(TOSS_ITEMS, ["SCHD"]);
  const plan = planCostBasisSnapshot({ account: { holdings } });

  assert.equal(plan.write.krwPerUsd, null);
  assert.equal(plan.write.holdings.length, 1);
});
