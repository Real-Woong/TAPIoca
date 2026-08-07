#!/usr/bin/env node

import path from "node:path";

import { readOrderEvents } from "./order-store.js";
import { computeSlippage, summarizeSlippage } from "./slippage.js";

/**
 * 원장에 쌓인 실제 체결로 슬리피지를 계산해 보여줍니다.
 *
 *   npm run live:slippage
 *
 * **이것이 11월 병행 운용의 결과를 읽는 도구입니다.** 백테스트는 전 구간 10bp를
 * 가정했고, 수수료는 현재 0으로 확인됐으므로(2026-08-07) 그 10bp가 실제로
 * 덮어야 하는 것은 슬리피지와 환전입니다.
 */

const dataDir = path.resolve(process.env.PAPER_DATA_DIR || "data");
const events = await readOrderEvents(dataDir);

// 주문별로 기준 호가(PLANNED)와 체결(FILL)을 짝지어 놓습니다.
const byOrder = new Map();
for (const event of events) {
  const id = event.clientOrderId;
  if (!id) continue;
  if (!byOrder.has(id)) byOrder.set(id, { clientOrderId: id });
  const order = byOrder.get(id);

  if (event.type === "PLANNED") {
    order.symbol = event.symbol;
    order.side = event.side;
    order.requestedUsd = event.requestedUsd;
    order.at = event.at;
    order.quote = event.quote ?? null;
  }
  if (event.type === "FILL") {
    order.filledPrice = event.filledPrice ?? order.filledPrice;
    order.filledUsd = (order.filledUsd ?? 0) + (Number(event.filledUsd) || 0);
    order.fees = (order.fees ?? 0) + (Number(event.fees) || 0);
  }
}

const rows = [];
for (const order of byOrder.values()) {
  if (!order.filledPrice) continue;
  const slip = computeSlippage({
    side: order.side, quote: order.quote, filledPrice: order.filledPrice,
  });
  rows.push({ ...order, ...slip });
}

if (rows.length === 0) {
  console.log("체결된 주문이 없습니다. `npm run live:probe -- --confirm` 이후에 보십시오.");
  process.exit(0);
}

console.log(`\n■ 체결 ${rows.length}건의 슬리피지\n`);
console.log("시각(UTC)          종목   방향  요청     체결가    중간가    슬리피지  반스프레드");
for (const row of rows) {
  console.log(
    `${String(row.at).slice(0, 16).replace("T", " ")}  ` +
      `${String(row.symbol ?? "?").padEnd(5)}  ${String(row.side ?? "?").padEnd(4)}  ` +
      `$${String(row.requestedUsd ?? "?").padEnd(6)} ` +
      `$${fmt(row.filledPrice, 8)} ` +
      `$${fmt(row.quote?.mid, 8)} ` +
      `${fmt(row.slippageBps, 8)}bp ${fmt(row.halfSpreadBps, 8)}bp`,
  );
}

const summary = summarizeSlippage(rows);
console.log(`\n측정 가능 ${summary.count}건 / 전체 ${rows.length}건`);

if (summary.count === 0) {
  console.log(
    "\n기준 호가가 없어 한 건도 못 쟀습니다.\n" +
      "  호가 기록은 2026-08-07 이후 주문부터 쌓입니다. 그 전 주문은 되살릴 수 없습니다.",
  );
} else if (!summary.enoughSamples) {
  // 감성 표본에서 하지 않기로 한 일을 여기서 하지 않습니다.
  console.log(
    `\n표본이 ${summary.count}건이라 **숫자를 결론으로 내지 않습니다** ` +
      `(최소 ${summary.minimumSamples}건).\n` +
      "  슬리피지는 한 건마다 크게 흔들립니다. 참고로만 봅니다:\n" +
      `    평균 ${summary.meanBps}bp · 중앙값 ${summary.medianBps}bp · ` +
      `범위 ${summary.minBps}~${summary.maxBps}bp`,
  );
} else {
  console.log(
    `\n  평균 ${summary.meanBps}bp · 중앙값 ${summary.medianBps}bp · ` +
      `범위 ${summary.minBps}~${summary.maxBps}bp`,
  );
  if (summary.meanHalfSpreadBps !== null) {
    console.log(`  이 중 반스프레드가 평균 ${summary.meanHalfSpreadBps}bp입니다.`);
  }
  const verdict = summary.medianBps <= summary.assumptionBps ? "안에 들어옵니다" : "**넘습니다**";
  console.log(`\n  백테스트 가정 ${summary.assumptionBps}bp — 중앙값 기준으로 ${verdict}.`);
  console.log("  ※ 환전 비용은 아직 이 측정에 없습니다.");
}

/**
 * 숫자를 표에 씁니다. **null은 0이 아니라 하이픈입니다.**
 *
 * `Number(null)`은 0이고 `Number.isFinite(0)`은 참이라, 그냥 넘기면 못 잰 값이
 * 0.00으로 찍힙니다. 그러면 "쟀는데 0이었다"와 "못 쟀다"가 표에서 같아지고,
 * 그 둘을 구분하려고 애써 null을 쓴 것이 무의미해집니다.
 */
function fmt(value, width) {
  if (value === null || value === undefined || value === "") return "-".padStart(width);
  const number = Number(value);
  return (Number.isFinite(number) ? number.toFixed(2) : "-").padStart(width);
}
