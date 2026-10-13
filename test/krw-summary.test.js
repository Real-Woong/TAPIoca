import test from "node:test";
import assert from "node:assert/strict";

import { APP_SELL_FX_DISCOUNT, summarizeHoldingsInKrw } from "../src/portfolio/krw-summary.js";

test("모든 계좌의 USD와 KRW 보유 평가액을 원화로 합산한다", () => {
  const portfolio = {
    accounts: [
      { accountSeq: 1, holdings: { items: [
        { symbol: "VTI", currency: "USD", marketValue: { amount: "10.25" } },
        { symbol: "005930", currency: "KRW", marketValue: { amount: "12000" } },
      ] } },
      { accountSeq: 2, holdings: { items: [
        { symbol: "AAPL", currency: "USD", marketValue: { amount: "2.50" } },
      ] } },
    ],
  };

  const summary = summarizeHoldingsInKrw(portfolio, "1400");

  assert.equal(summary.accounts[0].positions[0].valueKrw, 14350);
  assert.equal(summary.accounts[0].positions[1].valueKrw, 12000);
  assert.equal(summary.accounts[1].positions[0].valueKrw, 3500);
  assert.equal(summary.totalKrw, 29850);
  assert.equal(summary.usdKrwRate, 1400);
});

test("원화 보유만 있으면 환율 없이 합산한다", () => {
  const summary = summarizeHoldingsInKrw({ accounts: [
    { holdings: { items: [{ symbol: "KR", currency: "KRW", marketValue: { amount: "1000" } }] } },
  ] }, null);

  assert.equal(summary.totalKrw, 1000);
  assert.equal(summary.usdKrwRate, null);
});

test("환율 또는 평가액이 없을 때 불완전한 원화 합계를 출력하지 않는다", () => {
  const usd = { accounts: [{ holdings: { items: [
    { symbol: "US", currency: "USD", marketValue: { amount: "1" } },
  ] } }] };
  assert.throws(() => summarizeHoldingsInKrw(usd, null), /환율을 확인할 수 없어/);
  assert.throws(() => summarizeHoldingsInKrw(usd, 0), /환율을 확인할 수 없어/);

  const missingValue = { accounts: [{ holdings: { items: [
    { symbol: "KR", currency: "KRW", marketValue: {} },
  ] } }] };
  assert.throws(() => summarizeHoldingsInKrw(missingValue, null), /평가액을 확인할 수 없습니다/);
});

test("지원하지 않는 통화는 전체 원화 합계로 위장하지 않는다", () => {
  const other = { accounts: [{ holdings: { items: [
    { symbol: "JP", currency: "JPY", marketValue: { amount: "100" } },
  ] } }] };
  assert.throws(() => summarizeHoldingsInKrw(other, null), /지원하지 않는 평가 통화 JPY/);
});

test("앱 기준 추정은 USD 보유에만 할인을 적용하고 원화 보유는 그대로 둔다", () => {
  const summary = summarizeHoldingsInKrw({ accounts: [{ holdings: { items: [
    { symbol: "VTI", currency: "USD", marketValue: { amount: "10" } },
    { symbol: "KR", currency: "KRW", marketValue: { amount: "5000" } },
  ] } }] }, "1000");

  assert.equal(summary.totalKrw, 15000);
  assert.ok(Math.abs(summary.appEstimateKrw - (15000 - 10000 * APP_SELL_FX_DISCOUNT)) < 1e-9);
});

test("USD 보유가 없으면 앱 기준 추정은 합계와 같다", () => {
  const summary = summarizeHoldingsInKrw({ accounts: [
    { holdings: { items: [{ symbol: "KR", currency: "KRW", marketValue: { amount: "1000" } }] } },
  ] }, null);

  assert.equal(summary.appEstimateKrw, 1000);
});
