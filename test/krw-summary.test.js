import test from "node:test";
import assert from "node:assert/strict";

import { summarizeHoldingsInKrw } from "../src/portfolio/krw-summary.js";

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

test("앱 기준 평가액은 USD 보유만 기준환율로 환산하고 원화 보유는 그대로 둔다", () => {
  const summary = summarizeHoldingsInKrw({ accounts: [{ holdings: { items: [
    { symbol: "VTI", currency: "USD", marketValue: { amount: "10" } },
    { symbol: "KR", currency: "KRW", marketValue: { amount: "5000" } },
  ] } }] }, "1000", "990");

  assert.equal(summary.totalKrw, 15000);
  assert.equal(summary.appEstimateKrw, 14900);
});

test("기준환율이 없거나 잘못되면 앱 기준 평가액은 null이다", () => {
  const portfolio = { accounts: [{ holdings: { items: [
    { symbol: "VTI", currency: "USD", marketValue: { amount: "10" } },
  ] } }] };

  for (const bad of [undefined, null, 0, -1, "abc"]) {
    assert.equal(summarizeHoldingsInKrw(portfolio, "1000", bad).appEstimateKrw, null);
  }
});

test("기준환율을 주면 종목별 앱 기준 평가액을 함께 담는다", () => {
  const summary = summarizeHoldingsInKrw({ accounts: [{ holdings: { items: [
    { symbol: "VTI", currency: "USD", marketValue: { amount: "10" } },
    { symbol: "KR", currency: "KRW", marketValue: { amount: "5000" } },
  ] } }] }, "1000", "990");

  assert.equal(summary.accounts[0].positions[0].valueBaseKrw, 9900);
  assert.equal(summary.accounts[0].positions[1].valueBaseKrw, 5000);
  assert.equal(summarizeHoldingsInKrw({ accounts: [{ holdings: { items: [
    { symbol: "VTI", currency: "USD", marketValue: { amount: "10" } },
  ] } }] }, "1000").accounts[0].positions[0].valueBaseKrw, null);
});
