import test from "node:test";
import assert from "node:assert/strict";

import { computeSlippage, extractQuote, summarizeSlippage } from "../src/live/slippage.js";

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
