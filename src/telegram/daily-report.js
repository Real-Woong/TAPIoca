#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  appendCostBasisSnapshot,
  buildCostBasisSnapshot,
  normalizeHoldings,
} from "../live/cost-basis.js";
import { buildOrders, unresolvedOrders } from "../live/order-lifecycle.js";
import { readOrderEvents } from "../live/order-store.js";
import { restrictToManaged } from "../live/position-baseline.js";
import { createTossBroker } from "../live/toss-broker.js";
import { loadTradingPolicy } from "../paper/trading-policy.js";
import { createTossClientFromEnv } from "../toss/toss-client.js";
import { formatDailyReport } from "./daily-report-format.js";
import { hasPostCloseReport, newYorkDate } from "./report-window.js";
import { sendTelegramMessage } from "./telegram-client.js";

const dataDir = path.resolve(process.env.PAPER_DATA_DIR || "data");
const watchlist = (process.env.ETF_WATCHLIST || "VTI,SCHD,IWM")
  .split(",")
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);
/** 계좌 조회에 이보다 오래 걸리면 포기합니다. 보고서가 그것 때문에 늦으면 안 됩니다. */
const ACCOUNT_TIMEOUT_MS = 15_000;
const paperStatePath = path.join(dataDir, "paper-state.json");
const reportStatePath = path.join(dataDir, "telegram-report-state.json");

// 미국 장 종료 후 systemd 타이머가 실행하는 일일 보고서 진입점입니다.
try {
  const paperState = JSON.parse(await readFile(paperStatePath, "utf8"));
  const tradingDate = newYorkDate(new Date());
  const reportState = await readReportState();
  const forced = process.argv.includes("--force");

  // **마감 뒤에 한 번**만 보냅니다. 같은 거래일이라도 개장 전에 돌린 것은
  // 하루치 보고가 아니므로 막지 않습니다 — 그것이 2026-09-18 마감 보고서를
  // 통째로 삼켰습니다(`report-window.js`에 그날 시간표가 있습니다).
  if (hasPostCloseReport(reportState, tradingDate) && !forced) {
    console.log(`${tradingDate} 마감 보고서는 이미 전송했습니다.`);
  } else {
    // **보고서가 스스로 모드를 압니다.** 여기서 정책을 안 읽으면 실거래를 켠
    // 뒤에도 메시지는 계속 "PAPER 모드 — 실제 주문 없음"이라고 적습니다.
    const policy = loadTradingPolicy(process.env);
    const live = policy.mode === "LIVE" ? await readLiveSummary(tradingDate) : null;
    const account = policy.mode === "LIVE" ? await readAccountPositions() : null;
    const fx = await readExchangeRate();
    await recordCostBasis({ tradingDate, account, fx });
    const text = formatDailyReport(paperState, tradingDate, { live, account, fx });
    await sendTelegramMessage({
      token: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
      text,
    });
    await writeReportState({
      lastReportedTradingDate: tradingDate,
      sentAt: new Date().toISOString(),
    });
    console.log(`Telegram 일일 보고서 전송 완료: ${tradingDate}`);
  }
} catch (error) {
  if (error.code === "ENOENT") {
    console.error("PAPER 장부가 없습니다. 먼저 npm run paper:run을 실행하세요.");
  } else {
    console.error(`오류: ${error.message}`);
  }
  process.exitCode = 1;
}

/**
 * 오늘 낸 실주문을 원장에서 읽습니다. **여기서는 조회도 주문도 하지 않습니다**
 * — 파일만 봅니다. 원장에 다 있는 것을 네트워크로 다시 물을 이유가 없습니다.
 * (계좌 보유는 원장에 없으므로 `readAccountPositions`가 따로 조회합니다.
 * 그쪽은 실패해도 보고서가 나가도록 시간 제한과 함께 감싸 두었습니다.)
 *
 * **`at`이 아니라 주문이 계획된 날로 고릅니다.** FILL 이벤트의 `at`은 우리가
 * 그것을 기록한 시각이라, 몇 주 전 체결을 오늘 재조회하면 오늘 것처럼 보입니다.
 * 2026-09-01에 실제로 그랬습니다(8/07 체결이 9/1 타임스탬프로 다시 실려 왔다).
 * 읽는 사람이 알고 싶은 것은 "오늘 내 돈이 움직였나"이므로 첫 이벤트,
 * 즉 PLANNED가 찍힌 날을 기준으로 삼습니다.
 */
async function readLiveSummary(tradingDate) {
  try {
    const orders = buildOrders(await readOrderEvents(dataDir));
    const placedToday = [...orders.values()].filter((order) => {
      const first = order.events[0];
      return first?.at && newYorkDate(new Date(first.at)) === tradingDate;
    });

    return {
      orders: placedToday.map((order) => ({
        symbol: order.symbol,
        side: order.side,
        state: order.state,
        requestedUsd: order.requestedUsd,
        filledUsd: order.filledUsd,
        filledQuantity: order.filledQuantity,
      })),
      unresolvedCount: unresolvedOrders(orders).length,
    };
  } catch (error) {
    // **보고서는 나가야 합니다.** 원장을 못 읽는다고 하루치 보고를 통째로
    // 잃으면, 사람이 아무것도 모르는 채로 다음 장을 맞습니다. 못 읽었다는
    // 사실을 메시지에 적어서 보냅니다.
    return { error: error.message };
  }
}

/**
 * **실계좌에 지금 무엇이 있는지 조회합니다.** 이 파일에서 유일하게 네트워크를
 * 타는 곳입니다.
 *
 * 원래 이 보고서는 브로커를 아예 안 두드렸습니다 — "장 닫힌 뒤에 도는데 거기서
 * 브로커를 두드리면 보고서가 네트워크 사정으로 안 오게 된다"가 그 이유였고,
 * 그 이유는 지금도 맞습니다. **그래서 조회를 더하되 그 위험은 그대로 막습니다**
 * — 실패도 지연도 보고서를 못 나가게 하지 않고, 못 읽었다는 사실이 메시지에
 * 적혀 나갑니다.
 *
 * **더한 이유는 2026-09-12에 드러났습니다.** 보고서는 장부 $65.62를 찍고
 * 있었는데 계좌의 관리 3종목은 $20.13이었습니다. 조회를 안 하면 그 차이는
 * 사람이 앱을 직접 열어 보기 전에는 영원히 안 보입니다.
 *
 * 관리 종목만 남깁니다(`restrictToManaged`). 나머지는 사장님 자산이고 이
 * 시스템이 보고할 것이 아닙니다 — 대사가 그것을 빼는 것과 같은 이유입니다.
 */
async function readAccountPositions() {
  try {
    const client = createTossClientFromEnv();
    const broker = createTossBroker({
      getAccessToken: () => client.getAccessToken(),
      accountSeq: await resolveAccountSeq(client),
    });
    // **한 번만 부릅니다.** `getPositions`가 버리던 부분을 같이 받습니다.
    const result = await withTimeout(broker.getHoldings(), ACCOUNT_TIMEOUT_MS);
    const items = result?.items ?? [];
    const positions = {};
    for (const item of items) {
      if (item?.symbol) positions[item.symbol] = Number(item.quantity ?? 0);
    }
    return {
      positions: restrictToManaged(positions, watchlist),
      holdings: normalizeHoldings(items, watchlist),
      at: new Date().toISOString(),
    };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * 실계좌 원가와 그날 환율을 하루 한 줄 남깁니다 (2026-09-18).
 *
 * **계산이 아니라 기록이 급했습니다.** 실현손익은 토스가 안 주고, 우리가 세면
 * lot 방식이 달라 어긋납니다. `purchaseAmount`가 줄어든 만큼이 판 원가이므로
 * 이 줄들만 있으면 다음 매도부터 **토스 숫자로** 실현손익과 환차가 나옵니다.
 * 자세한 것은 `cost-basis.js`에 있습니다.
 *
 * **실패해도 보고서는 나갑니다.**
 *
 * **같은 거래일에 두 줄이 남는 것을 막지 않습니다.** 막았다가 되돌렸습니다 —
 * 뉴욕 거래일은 한국 새벽에 이미 바뀌어 있어서, 개장 전에 한 번 돌리면 그날 줄이
 * 먼저 박히고 **마감 뒤 타이머가 돌 때 건너뛰었습니다.** 읽을 때 그 거래일의
 * 마지막 줄을 쓰면 됩니다(`latestByTradingDate`).
 */
async function recordCostBasis({ tradingDate, account, fx }) {
  const holdings = account?.holdings;
  if (!Array.isArray(holdings) || holdings.length === 0) return;

  try {
    await appendCostBasisSnapshot(dataDir, buildCostBasisSnapshot({
      tradingDate,
      holdings,
      krwPerUsd: Number.isFinite(Number(fx?.rate)) ? Number(fx.rate) : null,
      at: account.at,
    }));
  } catch (error) {
    console.error(`원가 스냅샷을 못 남겼습니다: ${error.message}`);
  }
}

/**
 * 오늘 환율을 읽습니다 (2026-09-18).
 *
 * **보고서가 원금은 원화로, 수익률은 달러로 적고 있었습니다.** 둘을 곱하면
 * 24배 틀립니다(9/17 기준 -343원 대 실제 -8,231원). 원화 줄을 적으려면 오늘
 * 환율 하나가 필요하고, 개설 환율은 이미 장부에 있습니다.
 *
 * **`readAccountPositions`와 같은 모양입니다** — 실패해도 보고서는 나갑니다.
 * 환율 때문에 아침 보고서를 못 받는 것이 환율을 모르는 것보다 나쁩니다.
 *
 * **모드와 무관하게 조회합니다.** 원금이 10만 원인 것은 PAPER도 LIVE도 같습니다.
 */
async function readExchangeRate() {
  try {
    const client = createTossClientFromEnv();
    const rate = await withTimeout(client.getExchangeRate("USD", "KRW"), ACCOUNT_TIMEOUT_MS);
    return { rate: rate.rate, at: new Date().toISOString() };
  } catch (error) {
    return { error: error.message };
  }
}

/** `reconcile-cli.js`와 같은 규칙입니다. 계좌가 둘 이상이면 사람이 지정해야 합니다. */
async function resolveAccountSeq(client) {
  const configured = Number(process.env.TOSS_ACCOUNT_SEQ);
  if (Number.isInteger(configured) && configured > 0) return configured;

  const accounts = await client.getAccounts();
  if (accounts.length === 0) throw new Error("계좌를 찾지 못했습니다.");
  if (accounts.length === 1) return accounts[0].accountSeq;
  throw new Error(
    `계좌가 ${accounts.length}개입니다. TOSS_ACCOUNT_SEQ로 어느 계좌인지 지정하십시오 `
    + `(${accounts.map((account) => account.accountSeq).join(", ")}).`,
  );
}

/** 응답이 안 오는 것과 거절당하는 것은 다릅니다. 안 오는 쪽도 실패로 만듭니다. */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`계좌 조회가 ${ms / 1000}초 안에 안 왔습니다`)), ms);
    }),
  ]);
}

async function readReportState() {
  try {
    return JSON.parse(await readFile(reportStatePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeReportState(state) {
  // PAPER 장부와 마찬가지로 임시 파일 + rename 방식으로 전송 기록을 안전하게 저장합니다.
  await mkdir(dataDir, { recursive: true });
  const temporaryPath = `${reportStatePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, reportStatePath);
}
