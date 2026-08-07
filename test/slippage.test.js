import test from "node:test";
import assert from "node:assert/strict";

import {
  computeSlippage,
  extractQuote,
  impliedFillPrice,
  summarizeSlippage,
} from "../src/live/slippage.js";

/**
 * 슬리피지 측정을 고정합니다.
 *
 * 백테스트는 전 구간 10bp를 가정했고 수수료는 실측 0으로 확인됐으므로
 * (2026-08-07), 그 10bp가 실제로 덮어야 하는 것은 슬리피지와 환전입니다.
 * 그 둘 중 앞의 것을 재는 코드입니다.
 */

test("매수가 중간가보다 위에서 체결되면 손해다", () => {
  const result = computeSlippage({
    side: "BUY",
    quote: { bid: 33.50, ask: 33.54, mid: 33.52 },
    filledPrice: 33.59,
  });
  // (33.59 − 33.52) / 33.52 = 0.2088% = 20.9bp
  assert.ok(Math.abs(result.slippageBps - 20.88) < 0.1, `${result.slippageBps}`);
  // 반스프레드 = 0.02 / 33.52 = 5.97bp
  assert.ok(Math.abs(result.halfSpreadBps - 5.97) < 0.1, `${result.halfSpreadBps}`);
  assert.ok(Math.abs(result.beyondSpreadBps - 14.91) < 0.2, `${result.beyondSpreadBps}`);
});

test("매도는 부호를 뒤집어 항상 양수가 손해가 되게 한다", () => {
  // 매도는 아래로 밀리면 손해입니다. 부호를 안 맞추면 매수·매도가 섞였을 때
  // 평균이 0에 가까워져 "슬리피지가 없다"는 잘못된 결론이 납니다.
  const sell = computeSlippage({
    side: "SELL", quote: { bid: 33.50, ask: 33.54, mid: 33.52 }, filledPrice: 33.45,
  });
  assert.ok(sell.slippageBps > 0, `매도가 아래에서 체결되면 양수: ${sell.slippageBps}`);

  const good = computeSlippage({
    side: "SELL", quote: { bid: 33.50, ask: 33.54, mid: 33.52 }, filledPrice: 33.60,
  });
  assert.ok(good.slippageBps < 0, "중간가보다 위에 팔면 이득이라 음수다");
});

test("기준 호가가 없으면 0이 아니라 null이다", () => {
  // 0으로 채우면 "쟀는데 0이었다"와 구분되지 않습니다.
  const result = computeSlippage({ side: "BUY", quote: null, filledPrice: 33.59 });
  assert.equal(result.slippageBps, null);
  assert.match(result.reason, /기준 호가 없음/);
});

test("중간가만 있고 호가가 없으면 반스프레드는 못 낸다", () => {
  const result = computeSlippage({ side: "BUY", quote: { mid: 33.52 }, filledPrice: 33.59 });
  assert.ok(result.slippageBps > 0);
  assert.equal(result.halfSpreadBps, null, "나눠 볼 수 없으면 없다고 답한다");
  assert.equal(result.beyondSpreadBps, null);
});

/** ── 호가 파싱 ────────────────────────────────────────────────────────── */

test("흔한 필드 이름 몇 가지를 알아서 읽는다", () => {
  assert.equal(extractQuote({ bidPrice: "33.50", askPrice: "33.54" }).mid, 33.52);
  assert.equal(extractQuote({ result: { bestBidPrice: 10, bestAskPrice: 12 } }).mid, 11);
  assert.equal(extractQuote([{ bidPrice: 10, askPrice: 12 }]).mid, 11);
});

test("호가 단계 배열에서 최우선호가를 꺼낸다", () => {
  const quote = extractQuote({
    bids: [{ price: "33.50", quantity: "100" }, { price: "33.49" }],
    asks: [{ price: "33.54" }],
  });
  assert.equal(quote.bid, 33.5);
  assert.equal(quote.ask, 33.54);
  assert.equal(quote.mid, 33.52);
});

test("모르는 모양이면 조용히 null을 낸다 — 원본은 따로 보관한다", () => {
  const quote = extractQuote({ 어떤: "이상한", 모양: 123 });
  assert.equal(quote.mid, null);
  assert.equal(quote.bid, null);
});

/** ── 요약 ─────────────────────────────────────────────────────────────── */

test("표본이 적으면 결론을 내지 않는다", () => {
  // 감성 표본에서 하지 않기로 한 일을 여기서 하지 않습니다.
  const summary = summarizeSlippage([
    { slippageBps: 5 }, { slippageBps: 40 }, { slippageBps: 2 },
  ]);
  assert.equal(summary.count, 3);
  assert.equal(summary.enoughSamples, false);
  // 숫자는 계산하되 "충분하지 않다"는 사실을 함께 답합니다.
  assert.equal(summary.medianBps, 5);
});

test("10건이 모이면 결론을 낼 수 있다고 답한다", () => {
  const many = Array.from({ length: 10 }, (_, index) => ({ slippageBps: index }));
  assert.equal(summarizeSlippage(many).enoughSamples, true);
});

test("못 잰 건은 세지 않는다", () => {
  const summary = summarizeSlippage([
    { slippageBps: null }, { slippageBps: 5 }, { slippageBps: null },
  ]);
  assert.equal(summary.count, 1, "기준 호가가 없던 건은 표본이 아니다");
});

test("측정이 하나도 없으면 빈 요약이다", () => {
  assert.equal(summarizeSlippage([]).count, 0);
});

test("못 잰 값은 표에서 0이 아니라 하이픈이어야 한다", async () => {
  // 2026-08-07 실측에서 표가 못 잰 건을 0.00bp로 보여줬다. Number(null)이 0이고
  // Number.isFinite(0)이 참이라 그대로 통과했기 때문이다. 그러면 "쟀는데 0"과
  // "못 쟀다"가 표에서 같아지고, 둘을 구분하려고 null을 쓴 것이 무의미해진다.
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const nodePath = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");

  const dataDir = await mkdtemp(nodePath.join(tmpdir(), "slip-cli-"));
  await writeFile(
    nodePath.join(dataDir, "live-orders.jsonl"),
    [
      { type: "PLANNED", clientOrderId: "A", at: "2026-08-07T13:34:00Z", symbol: "SCHD", side: "BUY", requestedUsd: 2, quote: null },
      { type: "FILL", clientOrderId: "A", filledUsd: 1.99, filledQuantity: 0.0594, filledPrice: 33.52, terminal: true },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );

  const { stdout } = await promisify(execFile)(
    process.execPath, ["src/live/slippage-cli.js"], { env: { ...process.env, PAPER_DATA_DIR: dataDir } },
  );

  assert.doesNotMatch(stdout, /0\.00bp/, "못 잰 값이 0.00bp로 찍히면 안 된다");
  assert.match(stdout, /측정 가능 0건/);
});

/** ── 실효 체결가 역산 ─────────────────────────────────────────────────── */

test("보고 체결가는 눈금이 굵어 슬리피지를 왜곡한다", () => {
  // 2026-08-07 실측. 보고값 $33.69는 중간가 $33.695보다 낮아서, 시장가 매수가
  // 매수호가에 체결된 것처럼 보였다. 그럴 리가 없다.
  const reported = computeSlippage({
    side: "BUY", quote: { bid: 33.69, ask: 33.70, mid: 33.695 }, filledPrice: 33.69,
  });
  assert.ok(reported.slippageBps < 0, `보고값만 쓰면 이득처럼 보인다: ${reported.slippageBps}`);
  assert.equal(reported.priceSource, "reported");

  // 수량에서 역산하면 $2.00 / 0.059349 = $33.6990 — 매도호가 $33.70에 붙는다.
  // 시장가 매수의 당연한 결과이고, 보고값이 그리던 그림보다 훨씬 말이 된다.
  const implied = computeSlippage({
    side: "BUY", quote: { bid: 33.69, ask: 33.70, mid: 33.695 }, filledPrice: 33.69,
    requestedUsd: 2, filledQuantity: 0.059349, terminal: true,
  });
  assert.equal(implied.priceSource, "implied");
  assert.ok(Math.abs(implied.effectivePrice - 33.699) < 0.001, `${implied.effectivePrice}`);
  assert.ok(implied.slippageBps > 0, "매수는 중간가 위에서 체결된다");
  // 반스프레드(1.48bp)와 같은 자리 — 즉 매도호가를 친 것이다.
  assert.ok(Math.abs(implied.slippageBps - implied.halfSpreadBps) < 0.5,
    `반스프레드 근처여야 한다: ${implied.slippageBps} 대 ${implied.halfSpreadBps}`);
});

test("부분 체결이면 역산하지 않는다", () => {
  // 요청 금액이 실제로 쓰인 금액이 아니므로 나눗셈이 성립하지 않는다.
  assert.equal(impliedFillPrice({ requestedUsd: 10, filledQuantity: 0.1, terminal: false }), null);
});

test("역산에 필요한 값이 없으면 보고값으로 물러선다", () => {
  const result = computeSlippage({
    side: "BUY", quote: { mid: 33.695 }, filledPrice: 33.69, requestedUsd: 2,
  });
  assert.equal(result.priceSource, "reported", "수량이 없으면 역산할 수 없다");
});

test("어느 가격을 썼는지 요약에 남는다", () => {
  const summary = summarizeSlippage([
    { slippageBps: 1, priceSource: "implied" },
    { slippageBps: 2, priceSource: "reported" },
  ]);
  // 정밀도가 열 배 다르므로 섞였다는 사실이 드러나야 한다.
  assert.equal(summary.reportedPriceCount, 1);
});
