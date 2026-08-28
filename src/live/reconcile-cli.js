#!/usr/bin/env node

/**
 * 대사가 지금 맞는가 — **읽기만 합니다.**
 *
 * `live-cycle.js`의 2단계는 실거래를 켜야만 돌기 때문에, 켜기 전에는 대사가
 * 맞는지 볼 방법이 없었습니다. `live:baseline`은 기준선이 이미 있으면 검사
 * 전에 되돌아 나오고, PAPER 경로는 `submitLiveOrders`를 타지 않습니다.
 * **9/1에 `LIVE_TRADING=true`를 켜는 순간 처음 도는 검사를, 켜기 전에 한 번
 * 봐 두려고 만들었습니다.**
 *
 * 그래서 재구현하지 않고 `live-cycle.js`가 부르는 함수를 그대로 부릅니다 —
 * 여기서 통과하면 그 사이클에서도 통과합니다.
 *
 *   기대 = 기준선(관리 종목만) + 우리 원장의 실현 체결
 *   실제 = 브로커 보유(관리 종목만)
 *
 * 주문·저장은 하지 않습니다. 조회뿐입니다.
 */

import path from "node:path";

import { createTossClientFromEnv } from "../toss/toss-client.js";
import { createTossBroker } from "./toss-broker.js";
import { buildOrders, realizedFills, reconcile, unresolvedOrders } from "./order-lifecycle.js";
import { readOrderEvents } from "./order-store.js";
import { expectedPositions, readBaseline, restrictToManaged } from "./position-baseline.js";

// `live-cycle.js`의 기본값과 같아야 합니다. 금액 기준의 0.05를 쓰면 VTI
// 15달러어치가 통과해 검사가 사실상 꺼집니다.
const POSITION_TOLERANCE = 1e-6;

const dataDir = path.resolve(process.env.PAPER_DATA_DIR || "data");
const watchlist = (process.env.ETF_WATCHLIST || "VTI,SCHD,IWM")
  .split(",")
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);

function line(label, value) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

/** 수량은 소수점 여섯째 자리까지 옵니다. 반올림해서 보여주면 차이가 사라집니다. */
function qty(value) {
  return Number(value ?? 0).toFixed(6);
}

async function main() {
  console.log("\n■ 대사 확인 (읽기 전용)\n");
  line("데이터 디렉터리", dataDir);
  line("관리 종목", watchlist.join(", "));

  const baseline = await readBaseline(dataDir);
  if (!baseline) {
    throw new Error(
      "보유 기준선이 없습니다. `npm run live:baseline -- --confirm`으로 먼저 기록하십시오.",
    );
  }
  line("기준선 기록 시각", baseline.at);

  const orders = buildOrders(await readOrderEvents(dataDir));
  const realized = realizedFills(orders);

  // 미결 주문이 남아 있으면 대사와 별개로 `planCycle`이 멈춥니다. 같이 보여
  // 줍니다 — 대사만 통과하고 실제로는 안 도는 상태를 통과로 읽으면 안 됩니다.
  const unresolved = unresolvedOrders(orders);

  const expected = expectedPositions(restrictToManaged(baseline.positions, watchlist), realized);

  const client = createTossClientFromEnv();
  const broker = createTossBroker({
    getAccessToken: () => client.getAccessToken(),
    accountSeq: await resolveAccountSeq(client),
  });
  const actual = restrictToManaged(await broker.getPositions(), watchlist);

  console.log("\n[1] 종목별");
  const symbols = [...new Set([...watchlist, ...Object.keys(expected), ...Object.keys(actual)])];
  for (const symbol of symbols) {
    const base = Number(restrictToManaged(baseline.positions, watchlist)[symbol] ?? 0);
    const ours = Number(realized.get(symbol)?.quantity ?? 0);
    const want = Number(expected[symbol] ?? 0);
    const have = Number(actual[symbol] ?? 0);
    const mark = Math.abs(have - want) > POSITION_TOLERANCE ? "  ✗" : "";
    line(symbol, `기준선 ${qty(base)} + 우리 체결 ${qty(ours)} = ${qty(want)} / 실제 ${qty(have)}${mark}`);
  }

  const result = reconcile(expected, actual, { tolerance: POSITION_TOLERANCE });

  console.log("\n[2] 판정");
  if (result.matched) {
    console.log("  ✓ 기준선 + 우리 체결 = 브로커 보유 — 대사가 맞습니다.");
  } else {
    // `reconcile`의 차이 표는 금액용이라 소수점 둘째 자리로 반올림합니다.
    // 수량 대사에서는 0.005248이 0.01로 보이므로 여기서 원값을 다시 냅니다.
    console.log("  ✗ 어긋납니다 — 이 상태로 `LIVE_TRADING=true`를 켜면 첫 사이클에서 멈춥니다.");
    for (const item of result.differences) {
      const want = Number(expected[item.symbol] ?? 0);
      const have = Number(actual[item.symbol] ?? 0);
      line(item.symbol, `기대 ${qty(want)} / 실제 ${qty(have)} / 차이 ${qty(have - want)}`);
    }
  }

  if (unresolved.length > 0) {
    console.log("\n[3] 미결 주문");
    console.log("  ✗ 결말이 안 난 주문이 있습니다. 대사와 별개로 사이클이 멈춥니다.");
    for (const order of unresolved) line(order.clientOrderId, order.state);
  }

  console.log("");
  if (!result.matched || unresolved.length > 0) process.exitCode = 1;
}

/** `paper-runner.js`와 같은 규칙입니다. 여럿이면 고르지 않고 멈춥니다. */
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

await main();
