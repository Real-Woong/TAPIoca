import test from "node:test";
import assert from "node:assert/strict";

import {
  ABSOLUTE_BUDGET_CAP_KRW,
  createUsdBudget,
  sizePaperOrder,
} from "../src/paper/trading-budget.js";

test("최초 USD 배정액은 어떤 환율에서도 10만 원을 넘지 않는다", () => {
  for (const rate of [1200, 1357.25, 1500, 2000]) {
    const budget = createUsdBudget(rate);
    assert.equal(budget.fundingKrw, ABSOLUTE_BUDGET_CAP_KRW);
    assert.ok(budget.fundedKrwActual <= ABSOLUTE_BUDGET_CAP_KRW);
    assert.ok(budget.reserveKrw >= 0);
    assert.ok(budget.reserveKrw < rate / 100 + Number.EPSILON);
  }
});

test("10만 원이 아닌 원금으로 초기화할 수 없다", () => {
  assert.throws(() => createUsdBudget(1400, 100001), /100000원으로 고정/);
  assert.throws(() => createUsdBudget(1400, 99999), /100000원으로 고정/);
});

test("주문액은 현금, 주문 한도, 요청액 중 가장 작은 값을 넘지 않는다", () => {
  assert.equal(sizePaperOrder({ cashUsd: 70, maxOrderUsd: 5 }), 5);
  assert.equal(sizePaperOrder({ cashUsd: 3.456, maxOrderUsd: 5 }), 3.45);
  assert.equal(sizePaperOrder({ cashUsd: 70, maxOrderUsd: 5, requestedUsd: 2.999 }), 2.99);
});
