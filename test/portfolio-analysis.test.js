import test from "node:test";
import assert from "node:assert/strict";

import { analyzePortfolio } from "../src/portfolio/portfolio-analysis.js";

test("통화별 평가액, 비중, 집중도를 계산한다", () => {
  const result = analyzePortfolio({
    accounts: [{
      accountSeq: 1,
      holdings: { items: [
        {
          symbol: "AAA", name: "A", currency: "USD", quantity: "1",
          marketValue: { amount: "75" }, profitLoss: { rate: "0.1" },
        },
        {
          symbol: "BBB", name: "B", currency: "USD", quantity: "2",
          marketValue: { amount: "25" }, profitLoss: { rate: "-0.05" },
        },
      ] },
    }],
  });

  const usd = result.currencies[0];
  assert.equal(result.positionCount, 2);
  assert.equal(usd.totalMarketValue, 100);
  assert.equal(usd.positions[0].symbol, "AAA");
  assert.equal(usd.positions[0].weight, 0.75);
  assert.equal(usd.positions[1].weight, 0.25);
  assert.equal(usd.concentrationIndex, 0.625);
});

test("서로 다른 통화는 합산하지 않는다", () => {
  const result = analyzePortfolio({
    accounts: [{
      accountSeq: 1,
      holdings: { items: [
        {
          symbol: "KR", currency: "KRW", marketValue: { amount: "10000" },
          profitLoss: { rate: "0" },
        },
        {
          symbol: "US", currency: "USD", marketValue: { amount: "100" },
          profitLoss: { rate: "0" },
        },
      ] },
    }],
  });

  assert.equal(result.currencies.length, 2);
  assert.equal(result.currencies.find((group) => group.currency === "KRW").totalMarketValue, 10000);
  assert.equal(result.currencies.find((group) => group.currency === "USD").totalMarketValue, 100);
});
