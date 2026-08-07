#!/usr/bin/env node

import path from "node:path";

import { createTossClientFromEnv } from "../toss/toss-client.js";
import { getUsRegularSessionStatus } from "../market/us-market-session.js";
import { readEmergencyStop } from "./emergency-stop.js";
import { OUTCOMES, classifyOutcome, eventsFromLookup } from "./order-outcome.js";
import { appendOrderEvent, clientOrderId, readOrderEvents } from "./order-store.js";
import { buildOrders } from "./order-lifecycle.js";
import { createTossBroker } from "./toss-broker.js";

/**
 * 실계좌 연결을 **주문 한 건으로** 확인하는 도구입니다.
 *
 *   npm run live:probe                       확인만 한다(주문 안 냄)
 *   npm run live:probe -- --confirm          실제로 낸다
 *   npm run live:probe -- --symbol SCHD --amount 2
 *
 * **기본이 확인 전용입니다.** `--confirm` 없이는 어떤 주문도 나가지 않습니다.
 * 실제 돈이 나가는 명령의 기본값은 "아무 일도 안 함"이어야 합니다.
 *
 * 이 도구가 답하는 것은 전략이 아니라 **연결**입니다.
 *   · 토큰이 나오는가, 계좌가 보이는가
 *   · 금액 주문이 실제로 받아들여지는가 (문서가 아니라 계좌로 확인)
 *   · 사전 요건이 걸려 있지 않은가 (`prerequisite-required` 등)
 *   · 실제 수수료가 백테스트 가정(10bp) 안에 들어오는가
 *   · 체결가와 체결 수량이 어떤 모양으로 돌아오는가
 */

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

/**
 * 이 도구로 낼 수 있는 최대 금액입니다.
 *
 * **연결을 확인하는 도구이지 매매하는 도구가 아닙니다.** `--amount 200`을
 * `--amount 2000`으로 잘못 치는 것은 언제든 일어나고, 그 한 번이 시드 전체보다
 * 큽니다. 상한을 넘기면 실행 자체를 거부합니다 — 확인을 한 번 더 묻는 방식은
 * 습관이 되면 안 묻는 것과 같아집니다.
 */
const MAX_PROBE_USD = 10;

const dataDir = path.resolve(process.env.PAPER_DATA_DIR || "data");
const symbol = String(flag("symbol", "SCHD")).toUpperCase();
const amountUsd = Number(flag("amount", "2"));
const side = String(flag("side", "BUY")).toUpperCase();
const confirm = args.includes("--confirm");

if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
  console.error(`금액이 올바르지 않습니다: ${flag("amount")}`);
  process.exit(1);
}
if (amountUsd > MAX_PROBE_USD) {
  console.error(
    `이 도구는 $${MAX_PROBE_USD}까지만 냅니다(요청 $${amountUsd}).\n` +
      "  연결을 확인하는 도구이지 매매하는 도구가 아닙니다.\n" +
      "  더 큰 금액은 실행기가 신호에 따라 내야 합니다.",
  );
  process.exit(1);
}

const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);

try {
  await main();
} catch (error) {
  console.error(`\n오류: ${error.message}`);
  if (error.code) console.error(`  코드: ${error.code}`);
  if (error.requestId) console.error(`  요청 ID: ${error.requestId}`);
  if (error.data) console.error(`  상세: ${JSON.stringify(error.data)}`);
  process.exitCode = 1;
}

async function main() {
  console.log(`\n■ 실계좌 연결 확인 ${confirm ? "(실제 주문)" : "(확인 전용 — 주문 안 냄)"}`);

  // ── 0. 긴급 중지 ────────────────────────────────────────────────────
  const stop = await readEmergencyStop(dataDir);
  if (stop.stopped) {
    console.log(`\n🛑 긴급 중지가 걸려 있습니다: ${stop.reason ?? "(사유 없음)"}`);
    console.log("  풀려면: npm run stop -- --release");
    return;
  }

  const client = createTossClientFromEnv();

  // ── 1. 토큰 ────────────────────────────────────────────────────────
  console.log("\n[1] 토큰");
  const token = await client.getAccessToken();
  line("발급", `성공 (${token.slice(0, 8)}…)`);

  // ── 2. 계좌 ────────────────────────────────────────────────────────
  console.log("\n[2] 계좌");
  const accounts = await client.getAccounts();
  if (accounts.length === 0) throw new Error("계좌가 없습니다.");
  for (const account of accounts) {
    line("accountSeq", `${account.accountSeq}  ${account.name ?? account.accountName ?? ""}`);
  }
  const accountSeq = flag("account", accounts[0].accountSeq);
  line("사용할 계좌", accountSeq);

  // ── 3. 시간 ────────────────────────────────────────────────────────
  console.log("\n[3] 장 시간");
  const session = getUsRegularSessionStatus();
  line("뉴욕 시각", session.newYorkTime);
  line("정규장", session.isOpen ? "열림" : `닫힘 (${session.reason})`);
  line("금액 주문 창", session.isAmountOrderWindow ? "열림" : "닫힘 (종료 1시간 전까지)");

  // 조기 폐장일에는 우리 하드코딩이 틀립니다. 실제 달력을 함께 찍어 눈으로 봅니다.
  try {
    const calendar = await client.getUsMarketCalendar();
    line("거래소 달력", JSON.stringify(calendar).slice(0, 160));
  } catch (error) {
    line("거래소 달력", `조회 실패: ${error.message}`);
  }

  // ── 4. 비용과 잔고 ──────────────────────────────────────────────────
  console.log("\n[4] 비용과 잔고");
  try {
    const commissions = await client.getCommissions(accountSeq, { symbol });
    line("수수료", JSON.stringify(commissions).slice(0, 200));
    console.log("      ↑ 백테스트는 전 구간 10bp(0.1%)를 가정했습니다. 대조하십시오.");
  } catch (error) {
    line("수수료", `조회 실패: ${error.message}`);
  }

  try {
    const buyingPower = await client.getBuyingPower(accountSeq, { symbol, currency: "USD" });
    line("매수 가능", JSON.stringify(buyingPower).slice(0, 200));
  } catch (error) {
    line("매수 가능", `조회 실패: ${error.message}`);
  }

  const holdings = await client.getHoldings(Number(accountSeq));
  line("보유", JSON.stringify(holdings).slice(0, 200));

  // ── 5. 낼 주문 ─────────────────────────────────────────────────────
  console.log("\n[5] 낼 주문");
  const cycleAt = new Date().toISOString();
  const id = clientOrderId({ cycleAt, symbol, side });
  line("clientOrderId", id);
  line("종목 / 방향", `${symbol} / ${side}`);
  line("금액", `$${amountUsd.toFixed(2)} (orderAmount, MARKET)`);

  if (!confirm) {
    console.log("\n확인 전용이라 여기서 멈춥니다. 실제로 내려면 --confirm 을 붙이십시오.");
    console.log(`  npm run live:probe -- --symbol ${symbol} --amount ${amountUsd} --confirm`);
    return;
  }

  if (!session.isAmountOrderWindow) {
    console.log("\n금액 주문 창이 닫혀 있어 내지 않습니다. 거부만 받고 호출 한도를 씁니다.");
    return;
  }

  // ── 6. 주문 ────────────────────────────────────────────────────────
  console.log("\n[6] 주문");
  const broker = createTossBroker({
    getAccessToken: () => client.getAccessToken(),
    accountSeq,
    lookupBrokerOrderId: async (wanted) => {
      const orders = buildOrders(await readOrderEvents(dataDir));
      return orders.get(wanted)?.brokerOrderId ?? null;
    },
  });

  // **기록이 제출보다 먼저입니다.** 운영 사이클과 같은 순서를 여기서도 지킵니다.
  await appendOrderEvent(dataDir, {
    type: "PLANNED", clientOrderId: id, at: cycleAt,
    symbol, side, requestedUsd: amountUsd, source: "live-probe",
  });

  let response = null;
  let error = null;
  try {
    response = await broker.submitOrder({ clientOrderId: id, symbol, side, amountUsd });
  } catch (caught) {
    error = caught;
  }

  const outcome = classifyOutcome({ response, error });
  line("결과", outcome.outcome);
  if (outcome.why) line("사유", outcome.why);
  if (outcome.code) line("코드", outcome.code);

  if (outcome.outcome === OUTCOMES.ACCEPTED) {
    await appendOrderEvent(dataDir, {
      type: "SUBMITTED", clientOrderId: id, at: new Date().toISOString(),
      brokerOrderId: response.brokerOrderId,
    });
    line("orderId", response.brokerOrderId);
  } else if (outcome.outcome === OUTCOMES.REJECTED) {
    await appendOrderEvent(dataDir, {
      type: "REJECTED", clientOrderId: id, at: new Date().toISOString(),
      reason: outcome.why, code: outcome.code,
    });
    console.log("\n주문이 접수되지 않았습니다. 원인을 없앤 뒤 다시 시도하십시오.");
    return;
  } else {
    console.log("\n접수 여부를 알 수 없습니다. **재제출하지 마십시오.**");
    console.log("  다음 실행이 조회로 결말을 짓습니다.");
    return;
  }

  // ── 7. 체결 확인 ───────────────────────────────────────────────────
  console.log("\n[7] 체결 확인 (5초 간격 6회)");
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const detail = await broker.getOrder(id);
    if (!detail) { line(`${attempt}회`, "조회 결과 없음"); continue; }

    line(`${attempt}회`, `${detail.tossStatus} · 체결 ${detail.filledQuantity}주 / $${detail.filledUsd}`);
    if (detail.filledPrice) line("", `평균 체결가 $${detail.filledPrice} · 수수료+세금 $${detail.fees}`);

    if (detail.status === "FILLED" || detail.status === "REJECTED" || detail.status === "CANCELED") {
      for (const event of eventsFromLookup(id, detail)) await appendOrderEvent(dataDir, event);
      console.log("\n결말이 났습니다. 원장에 기록했습니다.");

      if (detail.filledUsd > 0 && detail.fees !== null) {
        const bps = (detail.fees / detail.filledUsd) * 10_000;
        console.log(`\n  실측 비용: ${bps.toFixed(1)}bp (백테스트 가정 10bp)`);
        console.log("  ※ 수수료·세금만입니다. 슬리피지와 환전 비용은 여기에 없습니다.");
      }
      return;
    }
  }

  console.log("\n아직 결말이 안 났습니다. 미결로 남았으니 다시 실행하면 조회로 이어집니다.");
}
