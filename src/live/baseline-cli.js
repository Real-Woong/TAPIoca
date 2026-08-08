#!/usr/bin/env node

import path from "node:path";

import { createTossClientFromEnv } from "../toss/toss-client.js";
import { buildOrders, realizedFills } from "./order-lifecycle.js";
import { readOrderEvents } from "./order-store.js";
import {
  baselineFromCurrent,
  baselinePath,
  expectedPositions,
  readBaseline,
  saveBaseline,
} from "./position-baseline.js";
import { createTossBroker } from "./toss-broker.js";

/**
 * 보유 기준선을 **한 번** 기록합니다.
 *
 *   npm run live:baseline              무엇을 저장할지 보여주기만 한다
 *   npm run live:baseline -- --confirm 실제로 저장한다
 *
 * `live-cycle.js`는 기준선이 없으면 대사를 못 해 멈춥니다. 그 파일을 만드는
 * 곳이 지금까지 없었습니다 — 읽는 쪽만 있고 쓰는 쪽이 없었습니다.
 *
 * **왜 자동으로 만들지 않는가.** 사이클이 기준선을 알아서 만들게 하면, 우리가
 * 이미 산 것이 있는 상태에서 처음 돌 때 그것까지 "원래 있던 것"으로 삼습니다.
 * 잘못 산 것이 영영 대사에서 사라지므로, 이 판단은 사람이 한 번 내립니다.
 *
 * **왜 지금 보유를 그대로 쓰지 않는가.** 기준선은 "우리가 손대기 전"이어야 하는데
 * 이미 손을 댄 뒤입니다(2026-08-07 수동 주문 4건). 그래서 원장의 실현 체결을
 * 빼서 그때를 되살립니다. 자세한 것은 `baselineFromCurrent`에 적혀 있습니다.
 */

const args = process.argv.slice(2);
const confirm = args.includes("--confirm");
const dataDir = path.resolve(process.env.PAPER_DATA_DIR || "data");

const line = (label, value) => console.log(`  ${String(label).padEnd(22)} ${value}`);
const fmt = (n) => (Math.round(Number(n) * 1e6) / 1e6).toString();

async function main() {
  console.log(`\n보유 기준선 — ${dataDir}\n`);

  // ── 1. 이미 있으면 여기서 끝냅니다 ────────────────────────────────────
  const existing = await readBaseline(dataDir);
  if (existing) {
    console.log(`이미 기준선이 있습니다 (${existing.at}).\n`);
    for (const [symbol, quantity] of Object.entries(existing.positions ?? {})) {
      line(symbol, fmt(quantity));
    }
    console.log(
      "\n덮어쓰지 않습니다. 다시 잡으면 우리가 만든 포지션까지 '원래 있던 것'으로"
      + "\n편입되어 잘못 산 것이 대사에서 사라집니다."
      + `\n정말 다시 잡아야 한다면 먼저 지우십시오:\n  ${baselinePath(dataDir)}\n`,
    );
    return;
  }

  // ── 2. 브로커가 말하는 지금 보유 ──────────────────────────────────────
  const client = createTossClientFromEnv();
  const accounts = await client.getAccounts();
  const accountSeq = accounts?.[0]?.accountSeq ?? accounts?.[0]?.accountNumber;
  if (!accountSeq) throw new Error("계좌를 찾지 못했습니다. npm run doctor 로 연결을 먼저 확인하세요.");

  const broker = createTossBroker({
    getAccessToken: () => client.getAccessToken(),
    accountSeq,
    lookupBrokerOrderId: async () => null,
  });

  const current = await broker.getPositions();
  console.log("[1] 지금 계좌 보유");
  const held = Object.entries(current).filter(([, q]) => Number(q) > 0);
  if (held.length === 0) console.log("  (없음)");
  for (const [symbol, quantity] of held) line(symbol, fmt(quantity));

  // ── 3. 우리가 체결시킨 것 ─────────────────────────────────────────────
  const orders = buildOrders(await readOrderEvents(dataDir));
  const realized = realizedFills(orders);
  console.log("\n[2] 우리 원장의 실현 체결");
  if (realized.size === 0) console.log("  (없음 — 아직 실주문을 낸 적이 없습니다)");
  for (const [symbol, fill] of realized) line(symbol, `${fmt(fill.quantity)} 주`);

  // ── 4. 되살린 기준선 ──────────────────────────────────────────────────
  const { positions, warnings } = baselineFromCurrent(current, realized);
  console.log("\n[3] 기록할 기준선  (= 지금 보유 − 우리 체결)");
  const baselineHeld = Object.entries(positions).filter(([, q]) => Number(q) > 0);
  if (baselineHeld.length === 0) console.log("  (없음 — 우리가 손대기 전 계좌는 비어 있었습니다)");
  for (const [symbol, quantity] of baselineHeld) line(symbol, fmt(quantity));

  for (const warning of warnings) console.log(`\n  ⚠ ${warning}`);

  // 저장하기 전에 아귀가 맞는지 스스로 확인합니다. 기준선 + 체결이 지금 보유와
  // 같아야 합니다 — 다르면 저장해 봐야 첫 사이클에서 멈춥니다.
  const check = expectedPositions(positions, realized);
  const mismatched = Object.keys({ ...check, ...current }).filter((symbol) => {
    const gap = Math.abs((Number(check[symbol]) || 0) - (Number(current[symbol]) || 0));
    return gap > 1e-6;
  });
  if (mismatched.length > 0) {
    throw new Error(
      `기준선 + 체결이 지금 보유와 맞지 않습니다: ${mismatched.join(", ")}. `
      + "저장하지 않습니다 — 저장해도 첫 사이클에서 대사가 깨집니다.",
    );
  }
  console.log("\n  ✓ 기준선 + 우리 체결 = 지금 보유 (아귀가 맞습니다)");

  if (!confirm) {
    console.log(
      "\n저장하지 않았습니다. 위 내용이 맞으면 --confirm 을 붙여 다시 실행하세요:"
      + "\n  npm run live:baseline -- --confirm\n",
    );
    return;
  }

  const snapshot = await saveBaseline(dataDir, positions);
  console.log(`\n✓ 기준선을 기록했습니다 (${snapshot.at})`);
  console.log(`  ${baselinePath(dataDir)}\n`);
}

main().catch((error) => {
  console.error(`\n실패: ${error.message}\n`);
  process.exitCode = 1;
});
